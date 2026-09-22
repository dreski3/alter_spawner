import { spawn } from "node:child_process";
import { canonicalJson, validateStructuredInput } from "./structured-data.js";
import { fail } from "./util.js";

export const MAX_VALIDATION_COMMANDS = 8;
export const MAX_VALIDATION_OUTPUT_BYTES = 64 * 1024;

export const parseValidationCommand = (value, label = "validation command") => {
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    fail(`${label} must be a JSON argv array, for example '["npm","test"]'.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32 || parsed.some((part) => typeof part !== "string" || !part || part.includes("\0") || part.length > 1000)) {
    fail(`${label} must contain 1-32 non-empty string arguments without NUL bytes.`);
  }
  return Object.freeze([...parsed]);
};

const contractSchema = {
  type: "object",
  required: ["summary", "commands", "relevant_files", "negative_cases"],
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    commands: {
      type: "array", minItems: 1, maxItems: MAX_VALIDATION_COMMANDS,
      items: {
        type: "object",
        required: ["argv", "purpose", "expected_exit_code", "timeout_ms"],
        additionalProperties: false,
        properties: {
          argv: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 1000 } },
          purpose: { type: "string", minLength: 1, maxLength: 2000 },
          expected_exit_code: { type: "integer", minimum: 0, maximum: 255 },
          timeout_ms: { type: "integer", minimum: 1, maximum: 3_600_000 },
        },
      },
    },
    relevant_files: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 500 } },
    negative_cases: {
      type: "array", minItems: 1, maxItems: 32,
      items: {
        type: "object",
        required: ["case", "expected"],
        additionalProperties: false,
        properties: {
          case: { type: "string", minLength: 1, maxLength: 2000 },
          expected: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
  },
};

const within = (root, target) => target === root || target.startsWith(root + "/") || target.startsWith(root + "\\");

export const validateAcceptanceContract = (value, {
  root,
  allowedCommands,
  allowedFiles = [],
  commandTimeoutMs,
  resolvePath,
} = {}) => {
  // Negative cases are descriptive evidence, not executable authority. Models often
  // return a concise string list even when asked for case/expected objects, so accept
  // that harmless shorthand and normalize it before the strict schema check. Commands,
  // paths, exit codes, and timeouts remain exact and receive no such coercion.
  const candidate = value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.negative_cases)
    ? {
      ...value,
      negative_cases: value.negative_cases.map((entry) => typeof entry === "string"
        ? { case: entry, expected: "The stated invariant must hold." }
        : entry),
    }
    : value;
  const contract = validateStructuredInput(contractSchema, candidate, "acceptance contract");
  if (!Array.isArray(allowedCommands) || allowedCommands.length === 0 || allowedCommands.length > MAX_VALIDATION_COMMANDS) {
    fail(`validate requires between 1 and ${MAX_VALIDATION_COMMANDS} allowed commands.`);
  }
  const expected = allowedCommands.map((argv, index) => parseValidationCommand(argv, `allowed command ${index + 1}`));
  if (contract.commands.length !== expected.length) fail("acceptance contract must contain every allowed command exactly once and in order.");
  contract.commands.forEach((command, index) => {
    if (canonicalJson(command.argv) !== canonicalJson(expected[index])) {
      fail(`acceptance contract command ${index + 1} is not the operator-approved argv.`);
    }
    if (command.expected_exit_code !== 0) fail(`acceptance contract command ${index + 1} must expect exit code 0.`);
    if (command.timeout_ms > commandTimeoutMs) fail(`acceptance contract command ${index + 1} exceeds the ${commandTimeoutMs}ms timeout ceiling.`);
  });
  if (resolvePath) {
    const canonicalRoot = resolvePath(root);
    const permitted = new Set(allowedFiles.map((file) => resolvePath(root, file)));
    for (const file of contract.relevant_files) {
      const candidate = resolvePath(root, file);
      if (!within(canonicalRoot, candidate)) fail(`acceptance contract relevant file is outside the project: ${file}`);
      if (!permitted.has(candidate)) fail(`acceptance contract relevant file was not supplied as context: ${file}`);
    }
  }
  return contract;
};

const appendBounded = (state, chunk, limit) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limit - state.bytes);
  if (remaining) state.chunks.push(buffer.subarray(0, remaining));
  state.bytes += Math.min(remaining, buffer.length);
  if (buffer.length > remaining) state.truncated = true;
};

export const runValidationCommand = (root, argv, {
  timeoutMs,
  signal,
  env = process.env,
  maxOutputBytes = MAX_VALIDATION_OUTPUT_BYTES,
  now = Date.now,
} = {}) => new Promise((resolve) => {
  const started = now();
  const stdout = { chunks: [], bytes: 0, truncated: false };
  const stderr = { chunks: [], bytes: 0, truncated: false };
  let child;
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let timer;

  const finish = (exitCode, childSignal, error = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    resolve({
      argv: [...argv],
      exit_code: exitCode,
      signal: childSignal || null,
      timed_out: timedOut,
      aborted,
      error: error?.message || null,
      duration_ms: Math.max(0, now() - started),
      stdout: Buffer.concat(stdout.chunks).toString("utf8"),
      stderr: Buffer.concat(stderr.chunks).toString("utf8"),
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
    });
  };
  const kill = () => {
    try {
      if (process.platform !== "win32" && child?.pid) process.kill(-child.pid, "SIGKILL");
      else child?.kill("SIGKILL");
    } catch {}
  };
  const onAbort = () => { aborted = true; kill(); };

  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (error) {
    finish(null, null, error);
    return;
  }
  child.stdout.on("data", (chunk) => appendBounded(stdout, chunk, maxOutputBytes));
  child.stderr.on("data", (chunk) => appendBounded(stderr, chunk, maxOutputBytes));
  child.on("error", (error) => finish(null, null, error));
  child.on("close", (code, childSignal) => finish(code, childSignal));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  timer.unref?.();
});
