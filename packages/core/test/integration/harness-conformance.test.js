// Every built-in harness has to report the same outcome for the same situation.
// The processes and the HTTP server are fakes, so the suite never touches a real
// model, credential, or developer binary.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime, createSpawnOptions, getHarness, HARNESS_ADAPTERS, spawnAlter } from "@mind/core";

const BUILTIN_ADAPTERS = ["codex", "llm", "opencode"];
const TOKENS = { input: 11, output: 4, reasoning: 2, cache_read: 3, total: 15 };
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

const HARNESS_SCRIPT = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const kind = process.env.MIND_CONFORMANCE_KIND;
const scenario = process.env.MIND_CONFORMANCE_SCENARIO;
writeFileSync(process.env.MIND_CONFORMANCE_TRACE, JSON.stringify({ argv, kind }));

const emit = (event) => console.log(JSON.stringify(event));
const session = (() => {
  if (kind === "codex" && argv.includes("resume")) return argv.at(-2);
  if (kind === "opencode") {
    const index = argv.indexOf("--session");
    if (index >= 0) return argv[index + 1];
    return "ses_new";
  }
  return "thread_new";
})();

if (scenario === "hang") {
  process.on("SIGTERM", () => {});
  spawn(process.execPath, [process.env.MIND_CONFORMANCE_GRANDCHILD_SCRIPT], {
    stdio: "ignore",
    env: process.env,
  });
  writeFileSync(process.env.MIND_CONFORMANCE_PARENT_PID, String(process.pid));
  setInterval(() => {}, 1000);
} else if (scenario === "empty") {
  if (kind === "codex") {
    emit({ type: "thread.started", thread_id: session });
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } });
  } else {
    emit({
      type: "step_finish",
      sessionID: session,
      part: { tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0 }, total: 1 } },
    });
  }
} else if (kind === "codex") {
  emit({ type: "thread.started", thread_id: session });
  emit({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: "conformance-ok" } });
  emit({ type: "item.completed", item: { id: "tool-1", type: "command_execution", exit_code: 0, status: "completed" } });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 4,
      reasoning_output_tokens: 2,
      total_tokens: 15,
    },
  });
} else {
  emit({ type: "text", sessionID: session, part: { text: "conformance-ok" } });
  emit({
    type: "tool_use",
    sessionID: session,
    part: { type: "tool", tool: "read", callID: "call-1", state: { status: "completed" } },
  });
  emit({
    type: "step_finish",
    sessionID: session,
    part: { tokens: { input: 11, output: 4, reasoning: 2, cache: { read: 3 }, total: 15 } },
  });
}
`;

const GRANDCHILD_SCRIPT = `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(process.env.MIND_CONFORMANCE_GRANDCHILD_PID, String(process.pid));
setInterval(() => {}, 1000);
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForFile = async (file) => {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (existsSync(file)) return readFileSync(file, "utf8");
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${file}`);
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const waitUntilDead = async (pid) => {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (!alive(pid)) return;
    await sleep(20);
  }
};

const killTree = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {}
};

const tempDir = (t, prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const installFakes = (t) => {
  const dir = tempDir(t, "mind-conform-bin-");
  const harness = path.join(dir, "harness.mjs");
  const opencode = path.join(dir, "opencode");
  const grandchild = path.join(dir, "grandchild.mjs");
  writeFileSync(harness, HARNESS_SCRIPT, { mode: 0o755 });
  writeFileSync(opencode, HARNESS_SCRIPT, { mode: 0o755 });
  writeFileSync(grandchild, GRANDCHILD_SCRIPT, { mode: 0o755 });
  return { dir, harness, grandchild };
};

const project = (t, config = {}) => {
  const root = tempDir(t, "mind-conform-proj-");
  mkdirSync(path.join(root, ".alters"));
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: "openai/gpt-conformance",
    max_depth: 4,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
    ...config,
  }));
  return root;
};

const startServer = async (t, scenario) => {
  const requests = [];
  const server = createServer((request, response) => {
    const record = { url: request.url, body: "", responded: false, closedEarly: false };
    requests.push(record);
    request.on("data", (chunk) => {
      record.body += chunk;
    });
    request.on("end", () => {
      if (scenario === "hang") return;
      record.json = JSON.parse(record.body || "{}");
      const empty = scenario === "empty";
      record.responded = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: empty ? "" : "conformance-ok" } }],
        usage: empty
          ? { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }
          : {
              prompt_tokens: 11,
              completion_tokens: 4,
              total_tokens: 15,
              prompt_tokens_details: { cached_tokens: 3 },
              completion_tokens_details: { reasoning_tokens: 2 },
            },
      }));
    });
    request.on("close", () => {
      if (!record.responded) record.closedEarly = true;
    });
  });
  server.requestTimeout = 0;
  t.after(() => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { requests, origin: `http://127.0.0.1:${server.address().port}/v1` };
};

const conformanceEnv = (fakes, name, scenario, files) => ({
  PATH: `${fakes.dir}${path.delimiter}${process.env.PATH}`,
  HOME: process.env.HOME || "",
  TMPDIR: process.env.TMPDIR || "/tmp",
  LANG: process.env.LANG || "C",
  MIND_CODEX_BIN: fakes.harness,
  MIND_CONFORMANCE_KIND: name,
  MIND_CONFORMANCE_SCENARIO: scenario,
  MIND_CONFORMANCE_TRACE: files.trace,
  MIND_CONFORMANCE_PARENT_PID: files.parentPid,
  MIND_CONFORMANCE_GRANDCHILD_PID: files.grandchildPid,
  MIND_CONFORMANCE_GRANDCHILD_SCRIPT: fakes.grandchild,
});

const filesFor = (dir) => ({
  trace: path.join(dir, "trace.json"),
  parentPid: path.join(dir, "parent.pid"),
  grandchildPid: path.join(dir, "grandchild.pid"),
});

const providersFor = (origin) => ({
  local: {
    protocol: "openai-compatible",
    base_url: origin,
    api_key_env: null,
    models: { small: { input: ["text", "image"] } },
  },
});

const runAdapter = (name, home, prompt, { environment, providers, ...options } = {}) => getHarness(name).run(home, prompt, {
  timeout: 5000,
  depth: 0,
  alterId: "conform",
  model: name === "llm" ? "local/small" : "openai/gpt-conformance",
  pure: true,
  attempt: 1,
  recordEvents: false,
  description: "Conformance role.",
  environment,
  providers,
  ...options,
});

const readTrace = (file) => JSON.parse(readFileSync(file, "utf8"));

const assertTreeDead = async (files) => {
  const parent = Number(await waitForFile(files.parentPid));
  const grandchild = Number(await waitForFile(files.grandchildPid));
  await waitUntilDead(parent);
  await waitUntilDead(grandchild);
  assert.equal(alive(parent), false, "harness process is still running");
  if (process.platform !== "win32") {
    assert.equal(alive(grandchild), false, "grandchild survived the harness shutdown");
  }
  return { parent, grandchild };
};

test("the conformance matrix lists every built-in harness", () => {
  assert.deepEqual([...HARNESS_ADAPTERS.keys()].sort(), BUILTIN_ADAPTERS);
});

for (const name of BUILTIN_ADAPTERS) {
  test(`${name} cancellation stops the run and reports it`, { timeout: 20000 }, async (t) => {
    const fakes = installFakes(t);
    const dir = tempDir(t, "mind-conform-run-");
    const home = path.join(dir, "home");
    mkdirSync(home);
    const files = filesFor(dir);
    const server = name === "llm" ? await startServer(t, "hang") : null;
    const environment = conformanceEnv(fakes, name, "hang", files);
    const controller = new AbortController();
    t.after(() => {
      if (existsSync(files.parentPid)) killTree(Number(readFileSync(files.parentPid, "utf8")));
    });
    const pending = runAdapter(name, home, "cancel me", {
      environment,
      providers: server ? providersFor(server.origin) : {},
      timeout: 15000,
      signal: controller.signal,
    });
    if (name === "llm") {
      const started = Date.now();
      while (server.requests.length === 0 && Date.now() - started < 4000) await sleep(15);
    } else {
      await waitForFile(files.parentPid);
      await waitForFile(files.grandchildPid);
    }
    controller.abort();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(result.killed, true);
    assert.equal(result.empty_output, false);
    assert.equal(result.budget_exceeded, false);
    if (name === "llm") {
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0].closedEarly, true);
      assert.equal(existsSync(files.parentPid), false);
    } else {
      await assertTreeDead(files);
    }
  });

  test(`${name} timeout is not an empty result`, { timeout: 20000 }, async (t) => {
    const fakes = installFakes(t);
    const dir = tempDir(t, "mind-conform-run-");
    const home = path.join(dir, "home");
    mkdirSync(home);
    const files = filesFor(dir);
    const server = name === "llm" ? await startServer(t, "hang") : null;
    t.after(() => {
      if (existsSync(files.parentPid)) killTree(Number(readFileSync(files.parentPid, "utf8")));
    });
    const started = Date.now();
    const result = await runAdapter(name, home, "wait", {
      environment: conformanceEnv(fakes, name, "hang", files),
      providers: server ? providersFor(server.origin) : {},
      timeout: 400,
    });
    assert.ok(Date.now() - started < 4000, "timeout did not return promptly");
    assert.equal(result.ok, false);
    assert.equal(result.killed, true);
    assert.equal(Boolean(result.aborted), false);
    assert.equal(result.empty_output, false);
    assert.equal(result.budget_exceeded, false);
    assert.equal(result.exitCode, -1);
    if (name === "llm") {
      assert.match(result.llm_error, /timed out after 400ms/);
      assert.equal(server.requests[0].closedEarly, true);
    }
  });

  test(`${name} process-tree cleanup reaches descendants`, { timeout: 20000 }, async (t) => {
    const fakes = installFakes(t);
    const dir = tempDir(t, "mind-conform-run-");
    const home = path.join(dir, "home");
    mkdirSync(home);
    const files = filesFor(dir);
    if (name === "llm") {
      const server = await startServer(t, "hang");
      const result = await runAdapter(name, home, "wait", {
        environment: conformanceEnv(fakes, name, "hang", files),
        providers: providersFor(server.origin),
        timeout: 400,
      });
      assert.equal(result.killed, true);
      assert.equal(existsSync(files.parentPid), false, "the direct executor spawned a process");
      assert.equal(existsSync(files.grandchildPid), false);
      assert.equal(server.requests[0].closedEarly, true);
      return;
    }
    t.after(() => {
      if (existsSync(files.parentPid)) killTree(Number(readFileSync(files.parentPid, "utf8")));
    });
    const pending = runAdapter(name, home, "wait", {
      environment: conformanceEnv(fakes, name, "hang", files),
      timeout: 1500,
    });
    await waitForFile(files.parentPid);
    await waitForFile(files.grandchildPid);
    const result = await pending;
    assert.equal(result.killed, true);
    await assertTreeDead(files);
  });

  test(`${name} empty output is a failure`, async (t) => {
    const fakes = installFakes(t);
    const dir = tempDir(t, "mind-conform-run-");
    const home = path.join(dir, "home");
    mkdirSync(home);
    const files = filesFor(dir);
    const server = name === "llm" ? await startServer(t, "empty") : null;
    const result = await runAdapter(name, home, "say nothing", {
      environment: conformanceEnv(fakes, name, "empty", files),
      providers: server ? providersFor(server.origin) : {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.empty_output, true);
    assert.equal(result.budget_exceeded, false);
    assert.equal(result.killed, false);
    assert.equal(result.exitCode, 0);
    assert.equal(String(result.text || "").trim(), "");
  });

  test(`${name} usage accounting uses the shared token shape`, async (t) => {
    const fakes = installFakes(t);
    const dir = tempDir(t, "mind-conform-run-");
    const home = path.join(dir, "home");
    mkdirSync(home);
    const files = filesFor(dir);
    const server = name === "llm" ? await startServer(t, "success") : null;
    const events = [];
    const result = await runAdapter(name, home, "account this", {
      environment: conformanceEnv(fakes, name, "success", files),
      providers: server ? providersFor(server.origin) : {},
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, "conformance-ok");
    assert.deepEqual(result.tokens, TOKENS);
    assert.equal(result.steps, 1);
    if (name === "llm") {
      assert.equal(result.tools, undefined);
      assert.equal(events.length, 0);
      assert.equal(server.requests[0].json.tools, undefined);
    } else {
      assert.equal(result.tools.calls, 1);
      assert.equal(result.tools.errors, 0);
      const usage = events.filter((event) => event.type === "usage.updated").at(-1);
      assert.deepEqual(usage.tokens, TOKENS);
      assert.equal(usage.steps, 1);
    }
  });

  test(`${name} session continuation`, async (t) => {
    const fakes = installFakes(t);
    const dir = tempDir(t, "mind-conform-run-");
    const home = path.join(dir, "home");
    mkdirSync(home);
    const files = filesFor(dir);
    const server = name === "llm" ? await startServer(t, "success") : null;
    const providers = server ? providersFor(server.origin) : {};
    const environment = conformanceEnv(fakes, name, "success", files);
    const first = await runAdapter(name, home, "first", { environment, providers });
    if (name === "llm") {
      assert.equal(first.sessionID, null);
      const second = await runAdapter(name, home, "second", {
        environment,
        providers,
        sessionId: "prior-session",
      });
      assert.equal(second.sessionID, null);
      assert.equal(second.ok, true);
      assert.equal(server.requests[1].json.messages.at(-1).content, "second");
      assert.equal(server.requests[1].json.session, undefined);
      assert.equal(server.requests[1].json.previous_response_id, undefined);
      return;
    }
    assert.equal(first.sessionID, name === "codex" ? "thread_new" : "ses_new");
    assert.equal(readTrace(files.trace).argv.includes(name === "codex" ? "resume" : "--session"), false);
    const second = await runAdapter(name, home, "second", {
      environment,
      providers,
      sessionId: first.sessionID,
    });
    assert.equal(second.ok, true);
    assert.equal(second.sessionID, first.sessionID);
    const argv = readTrace(files.trace).argv;
    assert.equal(argv.at(-1), "second");
    if (name === "codex") {
      assert.ok(argv.includes("resume"));
      assert.equal(argv.at(-2), first.sessionID);
    } else {
      assert.equal(argv[argv.indexOf("--session") + 1], first.sessionID);
      assert.equal(argv.includes("--title"), false);
    }
  });

  test(`${name} permissions cannot exceed the declared grants`, async (t) => {
    const fakes = installFakes(t);
    const root = project(t);
    const readGrant = path.resolve(root, "readable");
    const writeGrant = path.resolve(root, "writable");
    mkdirSync(readGrant);
    mkdirSync(writeGrant);
    const files = filesFor(root);
    const environment = conformanceEnv(fakes, name, "success", files);
    const options = {
      name: "permissions",
      description: "Checks permissions.",
      prompt: "report",
      executor: name,
      model: name === "llm" ? "local/small" : "openai/gpt-conformance",
      readGrants: [readGrant],
      writeGrants: [writeGrant],
      webAccess: true,
    };
    if (name === "llm") {
      await assert.rejects(
        () => spawnAlter(root, createSpawnOptions(options), { runtime: createRuntime({ env: environment }) }),
        /executor "llm" runs without a sandbox, so it cannot be combined with web, read_grants, write_grants/,
      );
      return;
    }
    const output = await spawnAlter(root, createSpawnOptions(options), { runtime: createRuntime({ env: environment }) });
    assert.equal(output.res.ok, true);
    const recorded = JSON.parse(readFileSync(path.join(output.home, "alter.json"), "utf8"));
    assert.deepEqual(recorded.read_grants, [readGrant]);
    assert.deepEqual(recorded.write_grants, [writeGrant]);
    assert.equal(recorded.web, true);
    if (name === "codex") {
      assert.equal(existsSync(path.join(output.home, ".opencode")), false);
      const argv = readTrace(files.trace).argv.join("\n");
      assert.match(argv, /permissions\.alter\.network\.enabled=false/);
      assert.ok(argv.includes(`web_search=${JSON.stringify("live")}`));
      assert.ok(argv.includes(`${JSON.stringify(readGrant)}=${JSON.stringify("read")}`));
      assert.ok(argv.includes(`${JSON.stringify(writeGrant)}=${JSON.stringify("write")}`));
      assert.ok(argv.includes(`${JSON.stringify(output.home)}=${JSON.stringify("write")}`));
      assert.ok(argv.includes(`${JSON.stringify(":root")}=${JSON.stringify("deny")}`));
      await assert.rejects(
        () => spawnAlter(root, createSpawnOptions({
          ...options,
          webAccess: false,
          readGrants: [],
          writeGrants: [],
          nestable: true,
        }), { runtime: createRuntime({ env: environment }) }),
        /executor "codex" cannot be combined with nestable/,
      );
      await assert.rejects(
        () => spawnAlter(root, createSpawnOptions({
          ...options,
          webAccess: false,
          readGrants: [],
          writeGrants: [],
          bashAllow: ["echo ok"],
        }), { runtime: createRuntime({ env: environment }) }),
        /executor "codex" cannot be combined with bash_allow/,
      );
      return;
    }
    const agent = readFileSync(path.join(output.home, ".opencode", "agents", "alter.md"), "utf8");
    assert.ok(agent.includes("bash: deny"));
    assert.ok(agent.includes("webfetch: allow"));
    assert.ok(agent.includes("websearch: allow"));
    assert.ok(agent.includes(`${JSON.stringify(`${readGrant}/**`)}: deny`));
    assert.ok(agent.includes(`${JSON.stringify(`${writeGrant}/**`)}: allow`));
    assert.ok(agent.includes("external_directory:"));
    assert.ok(agent.includes('"**": deny'));
    assert.ok(agent.includes(`${JSON.stringify(readGrant)}: allow`));
    assert.ok(agent.includes(`${JSON.stringify(writeGrant)}: allow`));
    const argv = readTrace(files.trace).argv;
    assert.equal(argv[argv.indexOf("--dir") + 1], output.home);
  });

  test(`${name} images are attached to the native request`, async (t) => {
    const fakes = installFakes(t);
    const dir = tempDir(t, "mind-conform-run-");
    const home = path.join(dir, "home");
    mkdirSync(home);
    const image = path.join(dir, "sample.png");
    writeFileSync(image, PNG);
    const files = filesFor(dir);
    const server = name === "llm" ? await startServer(t, "success") : null;
    const result = await runAdapter(name, home, "describe", {
      environment: conformanceEnv(fakes, name, "success", files),
      providers: server ? providersFor(server.origin) : {},
      images: [image],
      imageMetadata: [{ media_type: "image/png" }],
    });
    assert.equal(result.ok, true);
    if (name === "llm") {
      const encoded = PNG.toString("base64");
      assert.match(JSON.stringify(server.requests[0].json), new RegExp(encoded));
      return;
    }
    const argv = readTrace(files.trace).argv;
    const flag = name === "codex" ? "--image" : "--file";
    assert.equal(argv[argv.indexOf(flag) + 1], image);
    assert.deepEqual(argv.slice(-2), ["--", "describe"]);
  });
}
