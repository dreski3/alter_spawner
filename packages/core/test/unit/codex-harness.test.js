import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSpawnOptions,
  getHarness,
  scaffold,
  spawnAlter,
} from "../../src/index.js";
import { buildCodexRunArgs, resolveCodexExecutable, resolveCodexModel } from "../../src/harness/codex.js";

const makeProject = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "openai/gpt-5.6-sol",
    max_depth: 5,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));
  return root;
};

const options = (overrides = {}) => createSpawnOptions({
  id: "codex-worker",
  name: "codex-worker",
  description: "Review the implementation.",
  prompt: "Review it.",
  model: "openai/gpt-5.6-sol",
  depth: 0,
  spawned_by: "root",
  executor: "codex",
  ...overrides,
});

test("Codex model references remove the OpenAI provider namespace", () => {
  assert.equal(resolveCodexModel("openai/gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(resolveCodexModel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.throws(() => resolveCodexModel("anthropic/claude"), /requires an OpenAI model reference/);
});

test("Codex executable resolution honors an explicit binary", () => {
  assert.equal(resolveCodexExecutable({ MIND_CODEX_BIN: "/opt/codex" }), "/opt/codex");
});

test("Codex arguments use a least-privilege permission profile", () => {
  const args = buildCodexRunArgs({
    home: "/work/home",
    prompt: "inspect",
    model: "openai/gpt-5.6-sol",
    readGrants: ["/work/read"],
    writeGrants: ["/work/write"],
    webAccess: false,
    images: ["/work/image.png"],
  });
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("--strict-config"));
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.equal(args[args.indexOf("--cd") + 1], "/work/home");
  assert.ok(args.includes('permissions.alter.network.enabled=false'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes("agents.enabled=false"));
  assert.ok(args.includes('shell_environment_policy.inherit="core"'));
  assert.ok(args.includes("shell_environment_policy.ignore_default_excludes=false"));
  const profile = args.find((arg) => arg.startsWith("permissions.alter.filesystem="));
  assert.match(profile, /"\/work\/home"="write"/);
  assert.match(profile, /"\/work\/read"="read"/);
  assert.match(profile, /"\/work\/write"="write"/);
  assert.deepEqual(args.slice(-4), ["--image", "/work/image.png", "--", "inspect"]);
});

test("Codex resume keeps shared options before the subcommand", () => {
  const args = buildCodexRunArgs({
    home: "/work/home",
    prompt: "continue",
    model: "openai/gpt-5.6-sol",
    sessionId: "thread-1",
    images: ["/work/image.png"],
  });
  const resume = args.indexOf("resume");
  assert.ok(args.indexOf("--cd") < resume);
  assert.ok(args.indexOf("--json") < resume);
  assert.deepEqual(args.slice(-5), ["--image", "/work/image.png", "thread-1", "--", "continue"]);
});

test("Codex is registered as a session-based image-capable harness", () => {
  const adapter = getHarness("codex");
  assert.equal(adapter.needsAgentHome, true);
  assert.equal(adapter.supportsImages, true);
  assert.equal(adapter.agentHomeKind, "codex");
  assert.equal(adapter.regeneratesAgentFile, false);
});

test("Codex homes carry Codex instructions and project skills without OpenCode files", (t) => {
  const root = makeProject(t);
  const entry = path.join(root, "entry");
  mkdirSync(path.join(entry, "skills", "review"), { recursive: true });
  writeFileSync(path.join(entry, "skills", "review", "SKILL.md"), "# Review\n");
  const home = scaffold(root, { max_depth: 5 }, options({
    catalogEntryDir: entry,
    catalogSkillsDir: "skills",
  }), undefined, { agentHomeKind: "codex" });

  assert.match(readFileSync(path.join(home, "AGENTS.md"), "utf8"), /Review the implementation\./);
  assert.ok(existsSync(path.join(home, ".agents", "skills", "review", "SKILL.md")));
  assert.ok(!existsSync(path.join(home, ".opencode")));
});

test("Codex rejects unsupported authority and non-OpenAI models before scaffolding", async (t) => {
  const root = makeProject(t);
  await assert.rejects(
    () => spawnAlter(root, options({ nestable: true }), {}),
    /executor "codex" cannot be combined with nestable/,
  );
  await assert.rejects(
    () => spawnAlter(root, options({ model: "anthropic/claude" }), {}),
    /requires an OpenAI model reference/,
  );
  assert.ok(!existsSync(path.join(root, ".alters", "runs")));
});

test("Codex process output is normalized into the shared harness result", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "mind-codex-process-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const executable = path.join(home, "fake-codex.mjs");
  const argsFile = path.join(home, "args.json");
  writeFileSync(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CODEX_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-fake" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "tool-1", type: "command_execution", exit_code: 0, status: "completed" } }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: "finished" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } }));
`);
  chmodSync(executable, 0o755);

  const result = await getHarness("codex").run(home, "do it", {
    timeout: 5000,
    depth: 0,
    alterId: "worker",
    maxTokens: 100,
    model: "openai/gpt-5.6-sol",
    recordEvents: true,
    attempt: 1,
    environment: { ...process.env, MIND_CODEX_BIN: executable, CODEX_ARGS_FILE: argsFile },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "finished");
  assert.equal(result.sessionID, "thread-fake");
  assert.deepEqual(result.tokens, { input: 7, output: 3, reasoning: 1, cache_read: 2, total: 10 });
  assert.deepEqual(result.tools, { calls: 1, errors: 0, byName: { shell: 1 } });
  assert.ok(existsSync(result.eventLog));
  const args = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1), "do it");
});
