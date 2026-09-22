import { spawn } from "node:child_process";
import { accessSync, constants, createWriteStream } from "node:fs";
import path from "node:path";
import { registerHarness } from "./adapter.js";
import {
  classifyCodexResult,
  consumeCodexEvent,
  createCodexAccumulator,
} from "./codex-events.js";

const tomlString = (value) => JSON.stringify(String(value));

const executable = (candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveCodexExecutable = (environment = process.env) => {
  if (environment.MIND_CODEX_BIN) return environment.MIND_CODEX_BIN;
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  for (const directory of String(environment.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (executable(candidate)) return candidate;
  }
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      environment.HOME && path.join(environment.HOME, "Applications/ChatGPT.app/Contents/Resources/codex"),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (executable(candidate)) return candidate;
    }
  }
  return "codex";
};

export const resolveCodexModel = (model) => {
  const value = String(model || "").trim();
  const slash = value.indexOf("/");
  if (slash < 0) return value;
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  if (provider !== "openai" || !modelId) {
    throw new Error(`Codex executor requires an OpenAI model reference, received "${value}".`);
  }
  return modelId;
};

const permissionOverrides = ({ home, readGrants = [], writeGrants = [], webAccess = false }) => {
  const paths = new Map();
  for (const grant of readGrants) paths.set(path.resolve(grant), "read");
  for (const grant of writeGrants) paths.set(path.resolve(grant), "write");
  paths.set(path.resolve(home), "write");
  const filesystem = [
    `${tomlString(":root")}=${tomlString("deny")}`,
    `${tomlString(":minimal")}=${tomlString("read")}`,
    `${tomlString(":tmpdir")}=${tomlString("deny")}`,
    `${tomlString(":slash_tmp")}=${tomlString("deny")}`,
    ...[...paths].map(([grant, access]) => `${tomlString(grant)}=${tomlString(access)}`),
  ].join(",");
  return [
    "-c", `approval_policy=${tomlString("never")}`,
    "-c", `default_permissions=${tomlString("alter")}`,
    "-c", `permissions.alter.filesystem={${filesystem}}`,
    "-c", "permissions.alter.network.enabled=false",
    "-c", `web_search=${tomlString(webAccess ? "live" : "disabled")}`,
    "-c", "agents.enabled=false",
    "-c", "allow_login_shell=false",
    "-c", `shell_environment_policy.inherit=${tomlString("core")}`,
    "-c", "shell_environment_policy.ignore_default_excludes=false",
  ];
};

export const buildCodexRunArgs = ({
  home,
  prompt,
  model,
  images = [],
  sessionId = null,
  readGrants = [],
  writeGrants = [],
  webAccess = false,
}) => {
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    ...permissionOverrides({ home, readGrants, writeGrants, webAccess }),
    "--cd", home,
    "--skip-git-repo-check",
    "--json",
    "--color", "never",
  ];
  const modelId = resolveCodexModel(model);
  if (modelId) args.push("--model", modelId);
  if (sessionId) args.push("resume");
  for (const image of images) args.push("--image", image);
  if (sessionId) args.push(sessionId);
  // `codex exec --image` takes one or more files and will consume the positional
  // prompt as another path, then try to read the prompt from stdin.
  if (images.length) args.push("--");
  args.push(prompt);
  return args;
};

const validateOptions = (options, { models = [options.model] } = {}) => {
  const unsupported = [
    options.nestable && "nestable",
    options.bashOnly && "bash_only",
    options.bashAllow?.length && "bash_allow",
    options.opencodeProvider && "opencode_provider",
    options.opencodeVariant && "opencode_variant",
  ].filter(Boolean);
  if (unsupported.length) {
    throw new Error(`executor "codex" cannot be combined with ${unsupported.join(", ")}.`);
  }
  for (const model of models) resolveCodexModel(model);
};

const run = (
  home,
  prompt,
  {
    timeout,
    depth,
    alterId,
    maxTokens,
    model,
    images = [],
    recordEvents,
    attempt,
    signal,
    onEvent,
    environment = process.env,
    sessionId = null,
    readGrants = [],
    writeGrants = [],
    webAccess = false,
  },
) => new Promise((resolve) => {
  const args = buildCodexRunArgs({
    home,
    prompt,
    model,
    images,
    sessionId,
    readGrants,
    writeGrants,
    webAccess,
  });
  const child = spawn(resolveCodexExecutable(environment), args, {
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: {
      ...environment,
      ALTER_DEPTH: String(depth),
      ALTER_ID: alterId || "",
    },
  });
  let buffer = "";
  const accumulator = createCodexAccumulator();
  let settled = false;
  let timer;
  let forceKillTimer;
  let budgetExceeded = false;
  let aborted = false;
  let stderr = "";
  const eventLog = recordEvents ? path.join(home, `attempt-${attempt || 1}.events.jsonl`) : null;
  const eventStream = eventLog ? createWriteStream(eventLog, { flags: "w" }) : null;
  const eventStreamDone = eventStream
    ? new Promise((done) => {
        eventStream.on("finish", done);
        eventStream.on("error", done);
      })
    : Promise.resolve();
  const killProcessTree = (signalName) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
      else child.kill(signalName);
    } catch {
      try {
        child.kill(signalName);
      } catch {}
    }
  };
  const consume = (line) => {
    consumeCodexEvent(line, accumulator, onEvent);
    if (!budgetExceeded && maxTokens && accumulator.tokens.total > maxTokens) {
      budgetExceeded = true;
      killProcessTree("SIGKILL");
    }
  };
  child.stdout.on("data", (data) => {
    eventStream?.write(data);
    buffer += data.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) consume(line);
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  const finish = (exitCode, killed) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(forceKillTimer);
    signal?.removeEventListener("abort", onAbort);
    if (buffer.trim()) consume(buffer);
    const text = accumulator.text;
    const output = {
      tokens: accumulator.tokens,
      text,
      sessionID: accumulator.sessionID || sessionId,
      steps: accumulator.steps,
      tools: accumulator.tools,
      exitCode,
      killed,
      aborted,
      eventLog,
      llm_error: accumulator.error || (exitCode !== 0 ? stderr.trim() || null : null),
      ...classifyCodexResult({ exitCode, killed, budgetExceeded, text }),
    };
    eventStream?.end();
    eventStreamDone.then(() => resolve(output));
  };
  const onAbort = () => {
    if (settled || aborted) return;
    aborted = true;
    killProcessTree("SIGTERM");
    forceKillTimer = setTimeout(() => killProcessTree("SIGKILL"), 2000);
    forceKillTimer.unref();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  timer = setTimeout(() => {
    killProcessTree("SIGKILL");
    finish(-1, true);
  }, timeout);
  child.on("error", (error) => {
    accumulator.error = error.message;
    finish(-2, false);
  });
  child.on("close", (code) => finish(code, budgetExceeded || aborted));
});

registerHarness("codex", {
  run,
  supportsImages: true,
  agentHomeKind: "codex",
  regeneratesAgentFile: false,
  validateOptions,
});
