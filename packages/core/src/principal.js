import { existsSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fail } from "./util.js";
import { kitDir, readConfig } from "./config.js";
import { runWithRetries } from "./retry.js";
import { createSpawnOptions } from "./spawn-spec.js";
import { resolveRuntime } from "./runtime.js";
import { getHarness } from "./harness/adapter.js";
import { validateImageFiles, validateImageModels } from "./image-input.js";
import { measureRunCall } from "./run-measurement.js";

// A principal is the opposite of an Alter in the two ways that matter here.
//
// An Alter is single-use and stateless by design: a throwaway home, a generated
// agent definition, one prompt, one validated result. State it needs to keep has
// to be written somewhere deliberate — which is what persistent memory is for.
//
// A principal is the long-lived side of that split: a normal coding agent working
// in a real project directory (a `mind init` parent harness, with its own
// AGENTS.md, alter skill, and `.alters/` catalog), holding one harness session
// across many turns. Its continuity comes from that session, not from memory.
//
// Nothing here writes into the project. The directory belongs to the user, its
// agent definition is user-authored, and turn bookkeeping is the caller's job —
// so a principal turn reads config and returns a result, and that is all.
export const PRINCIPAL_DEPTH = -1;

export const isPrincipalProject = (projectDir) =>
  typeof projectDir === "string" &&
  !!projectDir &&
  existsSync(path.join(kitDir(projectDir), "config.json"));

export const requirePrincipalProject = (projectDir) => {
  if (!isPrincipalProject(projectDir)) {
    fail(`not a mind project (no .alters/config.json): ${projectDir}. Run \`mind init\` there first.`);
  }
  return projectDir;
};

const runPrincipalTurnInternal = async (projectDir, {
  prompt,
  images = [],
  sessionId = null,
  model = null,
  agent = null,
  maxTokens = null,
  timeout = null,
  principalId = null,
  harness = "opencode",
  // Only the harnesses with no agent home read this, and for them it is not a detail
  // but the whole persona: the `llm` adapter builds its entire system prompt from this
  // string and reads nothing off disk, so a principal running there gets no AGENTS.md,
  // no operating conventions and no skills. Left null it falls back to that adapter's
  // leaf-transformer default ("Transform the text you are given"), which would tell a
  // conversational principal it is a text filter. The opencode path ignores it — its
  // persona comes from the project's own AGENTS.md and agent definition.
  description = null,
  signal,
  onEvent,
  runtime: runtimeOverride,
} = {}) => {
  const wallStarted = performance.now();
  requirePrincipalProject(projectDir);
  if (typeof prompt !== "string" || !prompt.trim()) fail("principal turn requires a non-empty prompt");
  const runtime = resolveRuntime(runtimeOverride);
  const cfg = readConfig(projectDir);
  const options = createSpawnOptions({
    id: principalId || "principal",
    name: principalId || "principal",
    model: model || runtime.env.ALTER_MODEL || cfg.default_model,
    maxTokens,
    description,
    images,
    // No fallback tier: a principal turn is a conversation the user is watching,
    // so a silent model swap mid-turn would rewrite who they are talking to.
    fallbackModel: null,
    catalogName: null,
    outputContract: null,
  });
  const adapter = getHarness(harness);
  try {
    adapter.validateOptions?.(options, { models: [options.model] });
  } catch (error) {
    fail(error?.message || `executor "${harness}" rejected this principal configuration.`);
  }
  if (options.images.length) {
    if (!adapter.supportsImages) fail(`executor "${harness}" does not support image inputs.`);
    const prepared = validateImageFiles(projectDir, options.images, { environment: runtime.env });
    options.images = prepared.map((image) => image.path);
    options.imageMetadata = prepared.map((image) => image.metadata);
    if (harness === "opencode") validateImageModels([options.model], runtime.env);
  }
  const executionStarted = performance.now();
  const { res, attempts } = await runWithRetries({
    options,
    config: { ...cfg, retry: { same_harness_retries: cfg.retry?.same_harness_retries ?? 1, fallback_retries: 0 } },
    home: projectDir,
    prompt,
    timeout: timeout ?? cfg.run_timeout_ms ?? 180000,
    // Alters this principal spawns are the top-level Alters (depth 0), exactly as
    // they are today when the bridge spawns one directly.
    depth: PRINCIPAL_DEPTH,
    harnessName: harness,
    signal,
    onEvent,
    pure: cfg.opencode_pure !== false,
    recordEvents: cfg.opencode_event_log === true,
    runtime,
    agent,
    sessionId,
    regenerateAgentFile: false,
  });
  const executionMs = performance.now() - executionStarted;
  const wallMs = performance.now() - wallStarted;
  return {
    ok: res.ok,
    text: res.text,
    // A continued turn reports the same session it was given; a first turn reports
    // the one the harness opened, which the caller must persist to stay in it.
    sessionId: res.sessionID || sessionId || null,
    model: options.model,
    tokens: res.tokens,
    steps: res.steps,
    tools: res.tools || null,
    attempts,
    aborted: res.aborted || false,
    budgetExceeded: res.budget_exceeded || false,
    emptyOutput: res.empty_output || false,
    exitCode: res.exitCode,
    durationMs: wallMs,
    timing: {
      wall_duration_ms: wallMs,
      planning_ms: executionStarted - wallStarted,
      execution_ms: executionMs,
      attempts_ms: attempts.reduce((sum, attempt) => sum + (attempt.elapsed_ms ?? attempt.duration_ms), 0),
    },
    projectDir,
    res,
  };
};

export const runPrincipalTurn = (projectDir, options = {}) =>
  measureRunCall(projectDir, "principal", options.onEvent,
    () => runPrincipalTurnInternal(projectDir, options),
    (output, duration) => {
      output.durationMs = duration;
      output.timing.wall_duration_ms = duration;
      return output;
    });
