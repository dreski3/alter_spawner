import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntime,
  createSpawnOptions,
  readConfig,
  registerHarness,
  spawnAlter,
} from "@mind/core";
import { makeAdaptiveFixture } from "../../../../examples/adaptive-decoder/fixture.mjs";
import {
  ADAPTIVE_DECODER_TOOL,
  setupAdaptiveDecoder,
} from "../../../../examples/adaptive-decoder/setup.mjs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const cliEntry = path.join(repo, "packages", "cli", "src", "index.js");
const fixture = makeAdaptiveFixture();

const adapterResult = (text, sessionID) => ({
  tokens: { input: 5, output: 3, reasoning: 0, cache_read: 0, total: 8 },
  text,
  sessionID,
  steps: 1,
  exitCode: 0,
  killed: false,
  ok: true,
  budget_exceeded: false,
  empty_output: false,
});

test("a running principal can define and spawn a previously unavailable Alter", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-adaptive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  setupAdaptiveDecoder(root, { model: "fake/adaptive" });
  assert.equal(existsSync(path.join(root, ".alters", "catalog", "caesar-decoder")), false);

  registerHarness("adaptive-offline", {
    async run(home, prompt, options) {
      if (options.alterId === "adaptive-principal") {
        const environment = {
          ...process.env,
          ALTER_DEPTH: String(options.depth),
          ALTER_ID: options.alterId,
          ALTER_MODEL: options.model,
        };
        execFileSync(process.execPath, [
          cliEntry,
          "catalog", "save", "caesar-decoder",
          "--description", "Decodes Caesar relay messages with one approved tool.",
          "--bash-only",
          "--bash-allow", `node ${ADAPTIVE_DECODER_TOOL} **`,
          "--prompt-prefix", `Run node ${ADAPTIVE_DECODER_TOOL} with the entire cipher as one quoted argument and return stdout exactly.`,
          "--output-prefix", "SECRET:",
        ], { cwd: home, env: environment, stdio: "pipe" });
        const child = await spawnAlter(home, createSpawnOptions({
          name: "dynamic-decoder-run",
          catalog: "caesar-decoder",
          prompt: fixture.input,
          mindBinPath: cliEntry,
        }), {
          harness: "adaptive-offline",
          runtime: createRuntime({ env: environment }),
        });
        return adapterResult(child.result.text, "principal-session");
      }
      const cipher = prompt.match(/CIPHER:caesar-\d+:[A-Za-z0-9+/=]+/)?.[0];
      assert.ok(cipher, "dynamic decoder should receive the cipher in its isolated prompt");
      const decoded = execFileSync(process.execPath, [ADAPTIVE_DECODER_TOOL, cipher], { encoding: "utf8" });
      return adapterResult(decoded, "decoder-session");
    },
  });

  const principal = await spawnAlter(root, createSpawnOptions({
    name: "adaptive-principal",
    catalog: "adaptive-router",
    prompt: `Decode this message:\n${fixture.input}`,
    mindBinPath: cliEntry,
  }), { harness: "adaptive-offline" });

  assert.equal(principal.result.text, fixture.expected);
  assert.equal(principal.result.ok, true);
  const dynamicManifestPath = path.join(
    principal.home,
    ".alters", "catalog", "caesar-decoder", "manifest.json",
  );
  assert.equal(existsSync(dynamicManifestPath), true);
  assert.equal(existsSync(path.join(root, ".alters", "catalog", "caesar-decoder")), false);
  const manifest = JSON.parse(readFileSync(dynamicManifestPath, "utf8"));
  assert.equal(manifest.bash_only, true);
  assert.deepEqual(manifest.bash_allow, [`node ${ADAPTIVE_DECODER_TOOL} **`]);
  assert.deepEqual(manifest.output_contract, { type: "prefix", value: "SECRET:" });

  const childRoot = path.join(principal.home, ".alters", "runs");
  const childFolders = readdirSync(childRoot).filter((entry) => !entry.startsWith("."));
  assert.equal(childFolders.length, 1);
  const childHome = path.join(childRoot, childFolders[0]);
  const childAlter = JSON.parse(readFileSync(path.join(childHome, "alter.json"), "utf8"));
  const childResult = JSON.parse(readFileSync(path.join(childHome, "result.json"), "utf8"));
  assert.equal(childAlter.catalog, "caesar-decoder");
  assert.equal(childAlter.parent_id, "adaptive-principal");
  assert.equal(childAlter.depth, 1);
  assert.equal(childResult.text, fixture.expected);
  assert.equal(readConfig(principal.home).catalog_dir, "catalog");
});

test("a real principal can create and use its missing decoder definition", {
  skip: process.env.MIND_LIVE_ADAPTIVE_TESTS !== "1"
    ? "set MIND_LIVE_ADAPTIVE_TESTS=1 to run against OpenCode"
    : false,
}, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-adaptive-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  setupAdaptiveDecoder(root, {
    model: process.env.MIND_LIVE_ADAPTIVE_MODEL || "opencode/deepseek-v4-flash-free",
  });
  const principal = await spawnAlter(root, createSpawnOptions({
    name: "adaptive-principal-live",
    catalog: "adaptive-router",
    prompt: `Decode this message and return only its secret:\n${fixture.input}`,
    mindBinPath: cliEntry,
  }));
  assert.equal(principal.result.text.trim(), fixture.expected);
  const manifestPath = path.join(principal.home, ".alters", "catalog", "caesar-decoder", "manifest.json");
  assert.equal(existsSync(manifestPath), true);
  const childRoot = path.join(principal.home, ".alters", "runs");
  const children = readdirSync(childRoot)
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => JSON.parse(readFileSync(path.join(childRoot, entry, "result.json"), "utf8")));
  const decoder = children.find((child) => child.catalog === "caesar-decoder");
  assert.ok(decoder, "the live principal must spawn the dynamically defined catalog Alter");
  assert.equal(decoder.ok, true);
  assert.equal(decoder.text.trim(), fixture.expected);
  assert.equal(existsSync(path.join(root, ".alters", "catalog", "caesar-decoder")), false);
  t.diagnostic(JSON.stringify({
    parent: {
      model: principal.result.model,
      tokens: principal.result.tokens,
      steps: principal.result.steps,
      duration_ms: principal.result.duration_ms,
    },
    decoder: {
      model: decoder.model,
      tokens: decoder.tokens,
      steps: decoder.steps,
      duration_ms: decoder.duration_ms,
    },
    total_tokens: principal.result.tokens.total + decoder.tokens.total,
  }));
});
