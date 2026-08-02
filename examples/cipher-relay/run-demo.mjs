import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSpawnOptions, spawnAlter } from "../../packages/core/src/index.js";
import { makeFixtures } from "./tools/make-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "../../packages/cli/src/index.js");
const root = process.argv[2] ? path.resolve(process.argv[2]) : null;
const limitFlag = process.argv.indexOf("--limit");
const limit = limitFlag >= 0 ? Number(process.argv[limitFlag + 1]) : 1;
const caseFlag = process.argv.indexOf("--case");
const selectedCase = caseFlag >= 0 ? process.argv[caseFlag + 1] : null;

if (!root) throw new Error("usage: node run-demo.mjs <project-directory> [--limit <n>]");
if (!existsSync(path.join(root, ".alters", "config.json"))) {
  throw new Error(`cipher-relay is not set up at ${root}; run setup.mjs first`);
}

const readChildren = (parentHome) => {
  const runs = path.join(parentHome, ".alters", "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .sort()
    .map((folder) => {
      const home = path.join(runs, folder);
      const alter = JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8"));
      const resultPath = path.join(home, "result.json");
      if (!existsSync(resultPath)) {
        return {
          id: alter.id,
          catalog: alter.catalog,
          home: path.relative(root, home),
          state: "pending",
          session_id: null,
          event_log: null,
          tokens: null,
          steps: null,
          output: null,
        };
      }
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      return {
        id: alter.id,
        catalog: alter.catalog,
        home: path.relative(root, home),
        state: result.ok ? "succeeded" : "failed",
        session_id: result.session_id,
        event_log: result.event_log,
        tokens: result.tokens,
        steps: result.steps,
        output: result.text,
      };
    });
};

const audits = [];
const store = path.join(root, ".alters", "cipher-relay-store");
mkdirSync(store, { recursive: true });
process.env.MIND_CIPHER_RELAY_STORE = store;
const fixtures = selectedCase
  ? makeFixtures().filter((fixture) => fixture.id === selectedCase)
  : makeFixtures().slice(0, Math.max(1, limit));
if (fixtures.length === 0) throw new Error(`unknown cipher-relay case: ${selectedCase}`);
for (const fixture of fixtures) {
  const artifactId = randomUUID().replaceAll("-", "");
  const artifactPath = path.join(store, `${artifactId}.json`);
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        id: artifactId,
        current: fixture.input,
        history: [{ route: `CIPHER:${fixture.cipher}`, at: new Date().toISOString() }],
      },
      null,
      2
    ) + "\n"
  );
  const handle = `HANDLE:${artifactId}:CIPHER:${fixture.cipher}`;
  process.stdout.write(`\n[${fixture.id}] handle: ${handle}\n`);
  const spawned = await spawnAlter(root, createSpawnOptions({
    name: `relay-${fixture.id}`,
    description: null,
    model: null,
    prompt: `Recover the secret represented by this current handle and return only the final SECRET value:\n${handle}`,
    readGrants: [],
    writeGrants: [],
    bashAllow: [],
    nestable: false,
    timeout: null,
    rm: false,
    verbose: false,
    catalog: "relay-router",
    maxTokens: null,
    fallbackModel: null,
    promptPrefix: null,
    promptSuffix: null,
    webAccess: false,
    opencodeProvider: null,
    mindBinPath: cliEntry,
  }));
  const actual = spawned.result.text.trim();
  const children = readChildren(spawned.home);
  const sessionIds = [spawned.result.session_id, ...children.map((child) => child.session_id)].filter(Boolean);
  const parentTrace = spawned.result.event_log
    ? readFileSync(path.join(spawned.home, spawned.result.event_log), "utf8")
    : "";
  const specialistTools = [
    "decrypt-alpha.mjs",
    "decrypt-beta.mjs",
    "decode-base64.mjs",
    "decode-hex.mjs",
    "decode-url.mjs",
  ];
  const traceIsolated =
    parentTrace.length > 0 &&
    !parentTrace.includes(fixture.input) &&
    children.every((child) => !child.session_id || !parentTrace.includes(child.session_id)) &&
    specialistTools.every((tool) => !parentTrace.includes(tool));
  const isolated =
    children.length === 2 &&
    children.every((child) => child.state === "succeeded") &&
    new Set(sessionIds).size === sessionIds.length &&
    children.every((child) => child.home.startsWith(path.relative(root, spawned.home) + path.sep)) &&
    traceIsolated;
  const audit = {
    case_id: fixture.id,
    ok: spawned.result.ok && actual === fixture.expected && isolated,
    expected: fixture.expected,
    actual,
    handle,
    artifact_history: JSON.parse(readFileSync(artifactPath, "utf8")).history,
    relay: {
      home: path.relative(root, spawned.home),
      session_id: spawned.result.session_id,
      tokens: spawned.result.tokens,
      steps: spawned.result.steps,
      event_log: spawned.result.event_log,
    },
    children,
    context_isolation: {
      passed: isolated,
      parent_trace_excludes_child_sessions_and_tools: traceIsolated,
      evidence:
        "relay and child session IDs are distinct; child runs, event streams, tool calls, and token accounts are stored in separate homes",
    },
  };
  audits.push(audit);
  process.stdout.write(`[${fixture.id}] output: ${actual}\n`);
  process.stdout.write(`[${fixture.id}] isolated sessions: ${isolated ? "yes" : "no"}\n`);
  if (!audit.ok) process.exitCode = 1;
}

const auditPath = path.join(root, ".alters", "cipher-relay-audit.json");
writeFileSync(auditPath, JSON.stringify(audits, null, 2) + "\n");
process.stdout.write(`\nAudit: ${auditPath}\n`);
