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
import {
  buildGrokRunArgs,
  buildGrokSandboxToml,
  prepareGrokPrompt,
  resolveGrokAuthPath,
  resolveGrokExecutable,
  resolveGrokModel,
  selectGrokSandboxProfile,
} from "../../src/harness/grok.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

const makeProject = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-grok-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "xai/grok-4.5",
    max_depth: 5,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }));
  return root;
};

const options = (overrides = {}) => createSpawnOptions({
  id: "grok-worker",
  name: "grok-worker",
  description: "Review the implementation.",
  prompt: "Review it.",
  model: "xai/grok-4.5",
  depth: 0,
  spawned_by: "root",
  executor: "grok",
  ...overrides,
});

test("Grok model references remove the xAI provider namespace", () => {
  assert.equal(resolveGrokModel("xai/grok-4.5"), "grok-4.5");
  assert.equal(resolveGrokModel("grok-4.5"), "grok-4.5");
  assert.equal(resolveGrokModel(""), "");
  assert.throws(() => resolveGrokModel("openai/gpt-5.6-sol"), /requires an xAI model reference/);
});

test("Grok executable resolution honors an explicit binary", () => {
  assert.equal(resolveGrokExecutable({ MIND_GROK_BIN: "/opt/grok" }), "/opt/grok");
});

test("Grok authentication stays outside the isolated home", () => {
  assert.equal(resolveGrokAuthPath({ GROK_AUTH_PATH: "/secrets/auth.json" }), "/secrets/auth.json");
  assert.equal(resolveGrokAuthPath({ HOME: "/no/such/home", GROK_HOME: "" }), null);
});

test("Grok arguments isolate the session and keep the prompt last", () => {
  const args = buildGrokRunArgs({
    home: "/work/home",
    prompt: "inspect",
    model: "xai/grok-4.5",
    webAccess: false,
  });
  assert.equal(args[args.indexOf("--cwd") + 1], "/work/home");
  assert.equal(args[args.indexOf("--model") + 1], "grok-4.5");
  assert.equal(args[args.indexOf("--sandbox") + 1], "alter");
  assert.equal(args[args.indexOf("--output-format") + 1], "streaming-json");
  assert.ok(args.includes("--always-approve"));
  assert.ok(args.includes("--no-subagents"));
  assert.ok(args.includes("--no-plan"));
  assert.ok(args.includes("--disable-web-search"));
  assert.equal(args.includes("--resume"), false);
  assert.deepEqual(args.slice(-2), ["-p", "inspect"]);
});

test("Grok resume and web search stay on the headless command", () => {
  const args = buildGrokRunArgs({
    home: "/work/home",
    prompt: "continue",
    model: "xai/grok-4.5",
    sessionId: "session-1",
    webAccess: true,
    promptJson: "{\"type\":\"text\"}",
  });
  assert.equal(args.includes("--disable-web-search"), false);
  assert.ok(args.indexOf("--resume") < args.indexOf("--prompt-json"));
  assert.equal(args[args.indexOf("--resume") + 1], "session-1");
  assert.equal(args.at(-1), "{\"type\":\"text\"}");
});

test("Grok uses the workspace sandbox when a runtime socket is a symlink", () => {
  const symlink = () => ({ isSymbolicLink: () => true });
  const missing = () => {
    const error = new Error("missing");
    error.code = "ENOENT";
    throw error;
  };
  assert.equal(selectGrokSandboxProfile({ sockets: ["/var/run/docker.sock"], stat: symlink }), "workspace");
  assert.equal(selectGrokSandboxProfile({ sockets: ["/var/run/docker.sock"], stat: missing }), "alter");
});

test("Grok sandbox profile grants the home and declared paths", () => {
  const profile = buildGrokSandboxToml({
    home: "/work/home",
    readGrants: ["/work/read"],
    writeGrants: ["/work/write"],
  });
  assert.match(profile, /extends = "strict"/);
  assert.match(profile, /restrict_network = true/);
  assert.ok(profile.includes(`${JSON.stringify("/work/read")}`));
  assert.ok(profile.includes(`${JSON.stringify("/work/write")}`));
  assert.ok(profile.includes(`${JSON.stringify("/work/home")}`));
  assert.match(profile, /read_only = \[/);
  assert.match(profile, /read_write = \[/);
});

test("Grok attaches small images inline and references images past the argument limit", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "mind-grok-images-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const image = path.join(home, "sample.png");
  writeFileSync(image, PNG);
  const inline = JSON.parse(prepareGrokPrompt({
    home,
    prompt: "describe",
    images: [image],
    imageMetadata: [{ media_type: "image/png" }],
  }));
  assert.equal(inline[0].text, "describe");
  assert.equal(inline[1].type, "image");
  assert.equal(inline[1].data, PNG.toString("base64"));

  const referenced = JSON.parse(prepareGrokPrompt({
    home,
    prompt: "describe",
    images: [image],
    imageMetadata: [{ media_type: "image/png" }],
    maxPromptJsonBytes: 1,
  }));
  assert.equal(referenced[1].type, "resource_link");
  assert.match(referenced[1].uri, /^file:\/\//);
  assert.equal(existsSync(path.join(home, ".grok-inputs", "image-1.png")), true);
});

test("Grok is registered as a session-based image-capable harness", () => {
  const adapter = getHarness("grok");
  assert.equal(adapter.needsAgentHome, true);
  assert.equal(adapter.supportsImages, true);
  assert.equal(adapter.agentHomeKind, "grok");
  assert.equal(adapter.regeneratesAgentFile, false);
});

test("Grok homes carry Grok instructions and project skills without OpenCode files", (t) => {
  const root = makeProject(t);
  const entry = path.join(root, "entry");
  mkdirSync(path.join(entry, "skills", "review"), { recursive: true });
  writeFileSync(path.join(entry, "skills", "review", "SKILL.md"), "# Review\n");
  const home = scaffold(root, { max_depth: 5 }, options({
    catalogEntryDir: entry,
    catalogSkillsDir: "skills",
  }), undefined, { agentHomeKind: "grok" });

  assert.match(readFileSync(path.join(home, "AGENTS.md"), "utf8"), /Review the implementation\./);
  assert.ok(existsSync(path.join(home, ".grok", "skills", "review", "SKILL.md")));
  assert.ok(!existsSync(path.join(home, ".opencode")));
});

test("Grok rejects unsupported authority and non-xAI models before scaffolding", async (t) => {
  const root = makeProject(t);
  await assert.rejects(
    () => spawnAlter(root, options({ nestable: true }), {}),
    /executor "grok" cannot be combined with nestable/,
  );
  await assert.rejects(
    () => spawnAlter(root, options({ model: "openai/gpt-5.6-sol" }), {}),
    /requires an xAI model reference/,
  );
  assert.ok(!existsSync(path.join(root, ".alters", "runs")));
});

test("Grok process output is normalized into the shared harness result", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "mind-grok-process-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const executable = path.join(home, "fake-grok.mjs");
  const argsFile = path.join(home, "args.json");
  const envFile = path.join(home, "env.json");
  writeFileSync(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.GROK_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.GROK_ENV_FILE, JSON.stringify({
  GROK_HOME: process.env.GROK_HOME,
  GROK_MEMORY: process.env.GROK_MEMORY,
  GROK_FOLDER_TRUST: process.env.GROK_FOLDER_TRUST,
  GROK_AUTH_PATH: process.env.GROK_AUTH_PATH || "",
  GROK_CLAUDE_MCPS_ENABLED: process.env.GROK_CLAUDE_MCPS_ENABLED,
}));
console.log(JSON.stringify({ type: "text", data: "finished" }));
console.log(JSON.stringify({ type: "tool_call", toolCallId: "tool-1", toolName: "read_file", status: "completed" }));
console.log(JSON.stringify({ type: "usage", usage: { input_tokens: 7, cache_read_input_tokens: 2, output_tokens: 3, reasoning_tokens: 1, total_tokens: 12 } }));
console.log(JSON.stringify({ type: "end", sessionId: "session-fake", stopReason: "end_turn", num_turns: 1 }));
`);
  chmodSync(executable, 0o755);

  const result = await getHarness("grok").run(home, "do it", {
    timeout: 5000,
    depth: 0,
    alterId: "worker",
    maxTokens: 100,
    model: "xai/grok-4.5",
    recordEvents: true,
    attempt: 1,
    readGrants: ["/work/read"],
    writeGrants: ["/work/write"],
    environment: {
      ...process.env,
      MIND_GROK_BIN: executable,
      GROK_ARGS_FILE: argsFile,
      GROK_ENV_FILE: envFile,
      GROK_AUTH_PATH: "/secrets/auth.json",
      GROK_HOME: "/user/grok",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "finished");
  assert.equal(result.sessionID, "session-fake");
  assert.deepEqual(result.tokens, { input: 7, output: 3, reasoning: 1, cache_read: 2, total: 12 });
  assert.deepEqual(result.tools, { calls: 1, errors: 0, byName: { read_file: 1 } });
  assert.ok(existsSync(result.eventLog));
  const args = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.equal(args[args.indexOf("--model") + 1], "grok-4.5");
  assert.equal(args.at(-1), "do it");
  const sandbox = args[args.indexOf("--sandbox") + 1];
  assert.ok(sandbox === "alter" || sandbox === "workspace");
  if (sandbox === "alter") {
    const profile = readFileSync(path.join(home, ".grok-runtime", "sandbox.toml"), "utf8");
    assert.ok(profile.includes(JSON.stringify("/work/read")));
    assert.ok(profile.includes(JSON.stringify("/work/write")));
  } else {
    assert.equal(existsSync(path.join(home, ".grok-runtime", "sandbox.toml")), false);
  }
  const env = JSON.parse(readFileSync(envFile, "utf8"));
  assert.equal(env.GROK_HOME, path.join(home, ".grok-runtime"));
  assert.equal(env.GROK_MEMORY, "0");
  assert.equal(env.GROK_FOLDER_TRUST, "0");
  assert.equal(env.GROK_AUTH_PATH, "/secrets/auth.json");
  assert.equal(env.GROK_CLAUDE_MCPS_ENABLED, "false");
});
