import path from "node:path";
import { iso } from "./util.js";
import { buildBody, buildFrontmatter } from "./frontmatter.js";
import { getHarness } from "./harness/adapter.js";
import { checkOutputContract } from "./output-contract.js";
import { writeTextAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";

// Attempt plan: initial run, then `same_harness_retries` retries on the same model, then
// `fallback_retries` retries on an escalated/fallback model (if one is available). A catalog
// entry without a fallback_model gets no fallback tier — we do not guess one for named harnesses.
export const buildAttemptPlan = (o, cfg, runtimeOverride, { allowRetries = true } = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  // An executor that declares `supportsRetry: false` runs a deterministic operation:
  // the same input gives the same answer, so a second attempt is a guaranteed-identical
  // failure, and the fallback tier — which escalates to a different *model* — is
  // incoherent for something that never called one.
  if (!allowRetries) return [{ model: o.model, reason: "initial" }];
  const sameRetries = cfg.retry?.same_harness_retries ?? 1;
  const fallbackRetries = cfg.retry?.fallback_retries ?? 1;
  const fallbackModel =
    o.fallbackModel ||
    (o.catalogName ? null : cfg.default_fallback_model || runtime.env.ALTER_MODEL || null);
  const plan = [{ model: o.model, reason: "initial" }];
  for (let i = 0; i < sameRetries; i++) plan.push({ model: o.model, reason: "retry_same_model" });
  if (fallbackModel && fallbackModel !== o.model) {
    for (let i = 0; i < fallbackRetries; i++) plan.push({ model: fallbackModel, reason: "retry_fallback_model" });
  }
  return plan;
};

// Runs the attempt plan against an existing, already-scaffolded home. `o` must already carry
// description/readGrants/writeGrants/nestable/mindBinPath (needed to regenerate alter.md on a
// model swap, since the model is baked into that file's frontmatter rather than passed to the
// harness invocation directly).
export const runWithRetries = async ({
  options: o,
  config: cfg,
  home,
  prompt,
  timeout,
  depth,
  harnessName = "opencode",
  signal,
  onEvent,
  pure = true,
  recordEvents = false,
  runtime: runtimeOverride,
  agent = "alter",
  sessionId = null,
  allowRetries = true,
  // An Alter's model lives in its generated `alter.md` frontmatter, so swapping
  // models mid-plan means rewriting that file. A principal runs a project's own
  // agent definition, which is user-authored and must never be rewritten here.
  regenerateAgentFile = true,
}) => {
  const runtime = resolveRuntime(runtimeOverride);
  const harness = getHarness(harnessName);
  const plan = buildAttemptPlan(o, cfg, runtime, { allowRetries });
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {}
  };
  const attempts = [];
  let res;
  for (let i = 0; i < plan.length; i++) {
    const attemptModel = plan[i].model;
    if (regenerateAgentFile && i > 0 && attemptModel !== plan[i - 1].model) {
      o.model = attemptModel;
      writeTextAtomic(
        path.join(home, ".opencode", "agents", "alter.md"),
        buildFrontmatter(o) + "\n\n" + buildBody(o) + "\n"
      );
    }
    const startedAt = iso(runtime.now());
    const startMs = runtime.now();
    emit({ type: "attempt.started", attempt: i + 1, model: attemptModel, reason: plan[i].reason });
    res = await harness.run(home, prompt, {
      timeout,
      depth,
      alterId: o.id,
      maxTokens: o.maxTokens,
      model: attemptModel,
      variant: o.opencodeVariant || null,
      pure,
      recordEvents,
      attempt: i + 1,
      signal,
      onEvent: (event) => emit({ ...event, attempt: i + 1, model: attemptModel }),
      environment: runtime.env,
      agent,
      sessionId,
      // Read only by the executors that have no agent home to read them from: the
      // capability pair needs the binding, the llm executor needs the role for its
      // system prompt. Every other adapter ignores them.
      capability: o.capability || null,
      catalogName: o.catalogName || null,
      description: o.description || null,
    });
    if (res.ok && o.outputContract) {
      const contract = checkOutputContract(res.text, o.outputContract);
      if (!contract.ok) {
        res = { ...res, ok: false, contract_failed: true, contract_error: contract.error };
      }
    }
    const endedAt = iso(runtime.now());
    attempts.push({
      attempt: i + 1,
      model: attemptModel,
      reason: plan[i].reason,
      ok: res.ok,
      exit_code: res.exitCode,
      killed: res.killed,
      budget_exceeded: res.budget_exceeded || false,
      empty_output: res.empty_output || false,
      contract_failed: res.contract_failed || false,
      contract_error: res.contract_error || null,
      tokens: res.tokens,
      tools: res.tools ? { calls: res.tools.calls, errors: res.tools.errors, by_name: { ...res.tools.byName } } : null,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: runtime.now() - startMs,
      event_log: res.eventLog ? path.relative(home, res.eventLog) : null,
    });
    o.model = attemptModel;
    // A budget overrun is terminal: retrying under the same fixed cap would deterministically
    // fail again regardless of model, so it doesn't advance to the fallback tier.
    // An empty result (`res.empty_output`, so `ok:false`) is *not* terminal and falls through
    // to the next attempt — returning no final message is often model-specific, so the
    // same-model retry and then the fallback model are both worth spending.
    if (res.ok || res.budget_exceeded || res.aborted || signal?.aborted) break;
  }
  return { res, attempts };
};
