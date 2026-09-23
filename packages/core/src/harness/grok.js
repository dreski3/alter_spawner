import { spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, createWriteStream, lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "../persistence.js";
import { registerHarness } from "./adapter.js";
import {
  classifyGrokResult,
  consumeGrokEvent,
  createGrokAccumulator,
} from "./grok-events.js";

const ARGUMENT_BYTE_LIMIT = 480 * 1024;
export const GROK_SANDBOX_PROFILE = "alter";
export const GROK_SANDBOX_FALLBACK = "workspace";

export const RUNTIME_SOCKET_DENY_PATHS = Object.freeze([
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/run/podman/podman.sock",
  "/run/podman/podman.sock",
  "/var/run/containerd/containerd.sock",
  "/run/containerd/containerd.sock",
  "/run/dbus/system_bus_socket",
  "/var/run/dbus/system_bus_socket",
  "/run/systemd/private",
]);

const tomlString = (value) => JSON.stringify(String(value));

const executable = (candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const grokRuntimeDir = (home) => path.join(home, ".grok-runtime");

export const resolveGrokExecutable = (environment = process.env) => {
  if (environment.MIND_GROK_BIN) return environment.MIND_GROK_BIN;
  const name = process.platform === "win32" ? "grok.exe" : "grok";
  for (const directory of String(environment.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return "grok";
};

export const resolveGrokModel = (model) => {
  const value = String(model || "").trim();
  if (!value) return "";
  const slash = value.indexOf("/");
  if (slash < 0) return value;
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  if (provider !== "xai" || !modelId) {
    throw new Error(`Grok executor requires an xAI model reference, received "${value}".`);
  }
  return modelId;
};

export const resolveGrokAuthPath = (environment = process.env) => {
  if (environment.GROK_AUTH_PATH) return environment.GROK_AUTH_PATH;
  const base = environment.GROK_HOME || (environment.HOME ? path.join(environment.HOME, ".grok") : "");
  if (!base) return null;
  const candidate = path.join(base, "auth.json");
  try {
    accessSync(candidate, constants.R_OK);
    return candidate;
  } catch {
    return null;
  }
};

export const selectGrokSandboxProfile = ({
  sockets = RUNTIME_SOCKET_DENY_PATHS,
  stat = lstatSync,
} = {}) => {
  for (const socket of sockets) {
    try {
      if (stat(socket).isSymbolicLink()) return GROK_SANDBOX_FALLBACK;
    } catch {}
  }
  return GROK_SANDBOX_PROFILE;
};

const uniquePaths = (grants) => [...new Set(grants.filter(Boolean).map((grant) => path.resolve(grant)))];

export const buildGrokSandboxToml = ({ home, readGrants = [], writeGrants = [] }) => {
  const readWrite = uniquePaths([home, ...writeGrants]);
  const writable = new Set(readWrite);
  const readOnly = uniquePaths(readGrants).filter((grant) => !writable.has(grant));
  const list = (items) => items.map(tomlString).join(", ");
  return [
    "[profiles.alter]",
    "extends = \"strict\"",
    "restrict_network = true",
    `read_only = [${list(readOnly)}]`,
    `read_write = [${list(readWrite)}]`,
    "",
  ].join("\n");
};

const MIME_BY_EXTENSION = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});

const mimeTypeFor = (file, metadata) => {
  if (metadata?.media_type) return metadata.media_type;
  const known = MIME_BY_EXTENSION[path.extname(file).toLowerCase()];
  if (known) return known;
  throw new Error(`Grok executor cannot determine the media type for image "${file}".`);
};

const fileUri = (file) => {
  const parts = path.resolve(file).split(path.sep).map((part) => encodeURIComponent(part));
  const pathname = parts.join("/");
  return `file://${pathname.startsWith("/") ? "" : "/"}${pathname}`;
};

const imageBytes = (file) => {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new Error(`Grok executor cannot read image "${file}": ${error.message}`);
  }
};

const referenceImages = (home, images, imageMetadata) => {
  const directory = path.join(home, ".grok-inputs");
  mkdirSync(directory, { recursive: true });
  return images.map((file, index) => {
    const extension = path.extname(file).toLowerCase();
    const target = path.join(directory, `image-${index + 1}${extension}`);
    copyFileSync(file, target);
    return {
      type: "resource_link",
      uri: fileUri(target),
      name: path.basename(target),
      mimeType: mimeTypeFor(file, imageMetadata[index]),
    };
  });
};

export const prepareGrokPrompt = ({
  home,
  prompt,
  images = [],
  imageMetadata = [],
  maxPromptJsonBytes = ARGUMENT_BYTE_LIMIT,
}) => {
  if (!images.length) return null;
  const inline = JSON.stringify([
    { type: "text", text: prompt },
    ...images.map((file, index) => ({
      type: "image",
      mimeType: mimeTypeFor(file, imageMetadata[index]),
      data: imageBytes(file).toString("base64"),
    })),
  ]);
  if (Buffer.byteLength(inline) <= maxPromptJsonBytes) return inline;
  return JSON.stringify([
    { type: "text", text: prompt },
    ...referenceImages(home, images, imageMetadata),
  ]);
};

export const buildGrokRunArgs = ({
  home,
  prompt,
  model,
  sessionId = null,
  webAccess = false,
  promptJson = null,
  sandboxProfile = GROK_SANDBOX_PROFILE,
}) => {
  const args = [
    "--cwd", home,
    "--output-format", "streaming-json",
    "--always-approve",
    "--no-auto-update",
    "--no-subagents",
    "--no-plan",
    "--verbatim",
    "--sandbox", sandboxProfile,
    "--disallowed-tools", "ask_user_question",
  ];
  const modelId = resolveGrokModel(model);
  if (modelId) args.push("--model", modelId);
  if (!webAccess) args.push("--disable-web-search");
  if (sessionId) args.push("--resume", sessionId);
  if (promptJson) args.push("--prompt-json", promptJson);
  else args.push("-p", prompt);
  return args;
};

const isolatedEnvironment = (environment, home) => {
  const authPath = resolveGrokAuthPath(environment);
  return {
    ...environment,
    GROK_HOME: grokRuntimeDir(home),
    GROK_MEMORY: "0",
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_FOLDER_TRUST: "0",
    GROK_CLAUDE_AGENTS_ENABLED: "false",
    GROK_CLAUDE_HOOKS_ENABLED: "false",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CLAUDE_RULES_ENABLED: "false",
    GROK_CLAUDE_SKILLS_ENABLED: "false",
    GROK_CLAUDE_SESSIONS_ENABLED: "false",
    GROK_CURSOR_AGENTS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    GROK_CURSOR_MCPS_ENABLED: "false",
    GROK_CURSOR_RULES_ENABLED: "false",
    GROK_CURSOR_SKILLS_ENABLED: "false",
    GROK_CURSOR_SESSIONS_ENABLED: "false",
    GROK_CODEX_AGENTS_ENABLED: "false",
    GROK_CODEX_HOOKS_ENABLED: "false",
    GROK_CODEX_MCPS_ENABLED: "false",
    GROK_CODEX_RULES_ENABLED: "false",
    GROK_CODEX_SKILLS_ENABLED: "false",
    GROK_CODEX_SESSIONS_ENABLED: "false",
    ...(authPath ? { GROK_AUTH_PATH: authPath } : {}),
  };
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
    throw new Error(`executor "grok" cannot be combined with ${unsupported.join(", ")}.`);
  }
  for (const model of models) resolveGrokModel(model);
};

const failedResult = (sessionId, message) => ({
  tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
  text: "",
  sessionID: sessionId,
  steps: 0,
  tools: { calls: 0, errors: 0, byName: {} },
  exitCode: -2,
  killed: false,
  aborted: false,
  eventLog: null,
  llm_error: message,
  ok: false,
  empty_output: false,
  budget_exceeded: false,
});

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
    imageMetadata = [],
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
  let promptJson = null;
  let sandboxProfile = GROK_SANDBOX_PROFILE;
  try {
    const runtimeDir = grokRuntimeDir(home);
    mkdirSync(runtimeDir, { recursive: true });
    sandboxProfile = selectGrokSandboxProfile();
    if (sandboxProfile === GROK_SANDBOX_PROFILE) {
      writeTextAtomic(path.join(runtimeDir, "sandbox.toml"), buildGrokSandboxToml({ home, readGrants, writeGrants }));
    }
    promptJson = prepareGrokPrompt({ home, prompt, images, imageMetadata });
  } catch (error) {
    resolve(failedResult(sessionId, error.message));
    return;
  }
  const args = buildGrokRunArgs({
    home,
    prompt,
    model,
    sessionId,
    webAccess,
    promptJson,
    sandboxProfile,
  });
  const child = spawn(resolveGrokExecutable(environment), args, {
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: {
      ...isolatedEnvironment(environment, home),
      ALTER_DEPTH: String(depth),
      ALTER_ID: alterId || "",
    },
  });
  let buffer = "";
  const accumulator = createGrokAccumulator();
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
  const consume = (line) => {
    consumeGrokEvent(line, accumulator, onEvent);
    if (!budgetExceeded && maxTokens && accumulator.tokens.total > maxTokens) {
      budgetExceeded = true;
      killProcessTree("SIGKILL");
    }
  };
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
      ...classifyGrokResult({ exitCode, killed, budgetExceeded, text }),
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

registerHarness("grok", {
  run,
  supportsImages: true,
  agentHomeKind: "grok",
  regeneratesAgentFile: false,
  validateOptions,
});
