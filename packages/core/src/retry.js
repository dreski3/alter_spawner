import path from "node:path";
import { performance } from "node:perf_hooks";
import { iso } from "./util.js";
import { buildBody, buildFrontmatter } from "./frontmatter.js";
import { getHarness } from "./harness/adapter.js";
import { checkOutputContract } from "./output-contract.js";
import { writeTextAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";
import { snapshotPricing } from "./run-pricing.js";

// Attempt plan: initial run, then `same_harness_retries` retries on the same model, then
// `fallback_retries` retries on an escalated/fallback model (if one is available). A catalog
// entry without a fallback_model gets no fallback tier — we do not guess one for named harnesses.
export const buildAttemptPlan = (o, cfg, runtimeOverride, { allowRetries = true } = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  // An executor that declares `supportsRetry: false` runs a deterministic operation:
  // the same input gives the same answer, so a second attempt is a guaranteed-identical
  // failure, and the fallback tier — which escalates to a different *model* — is
  // incoherent for something that never called one.
  const candidates = o.plannedCandidates?.length || o.modelCandidates?.length
    ? o.plannedCandidates || o.modelCandidates
    : [{ model: o.model, id: null, executor: o.executor }];
  const primary = candidates[0] || { model: o.model, id: null, executor: o.executor };
  if (!allowRetries) {
    return [{ model: primary.model, executor: primary.executor || o.executor, reason: "initial", ...(primary.id ? { candidateId: primary.id } : {}) }];
  }
  const sameRetries = cfg.retry?.same_harness_retries ?? 1;
  const fallbackRetries = cfg.retry?.fallback_retries ?? 1;
  const plan = [{ model: primary.model, executor: primary.executor || o.executor, reason: "initial", ...(primary.id ? { candidateId: primary.id } : {}) }];
  for (let i = 0; i < sameRetries; i++) {
    plan.push({ model: primary.model, executor: primary.executor || o.executor, reason: "retry_same_model", ...(primary.id ? { candidateId: primary.id } : {}) });
  }
  const fallbacks = o.modelCandidates?.length
    ? candidates.slice(1)
    : (() => {
      const fallbackModel =
        o.fallbackModel ||
        (o.catalogName ? null : cfg.default_fallback_model || runtime.env.ALTER_MODEL || null);
      return fallbackModel && fallbackModel !== primary.model
        ? [{ model: fallbackModel, id: null, executor: o.executor }]
        : [];
    })();
  for (const candidate of fallbacks) {
    for (let i = 0; i < fallbackRetries; i++) {
      plan.push({
        model: candidate.model,
        executor: candidate.executor || o.executor,
        reason: "retry_fallback_model",
        ...(candidate.id ? { candidateId: candidate.id } : {}),
      });
    }
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
  const plan = buildAttemptPlan(o, cfg, runtime, { allowRetries });
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {}
  };
  const attempts = [];
  let res;
  for (let i = 0; i < plan.length; i++) {
    const attemptNumber = attempts.length + 1;
    const attemptModel = plan[i].model;
    const attemptExecutor = plan[i].executor || harnessName;
    const harness = getHarness(attemptExecutor);
    const candidateId = plan[i].candidateId || null;
    const pricing = snapshotPricing(attemptModel, cfg.providers);
    if (regenerateAgentFile && attemptExecutor === "opencode" && (i === 0 || attemptModel !== plan[i - 1].model || attemptExecutor !== plan[i - 1].executor)) {
      o.model = attemptModel;
      writeTextAtomic(
        path.join(home, ".opencode", "agents", "alter.md"),
        buildFrontmatter(o) + "\n\n" + buildBody(o) + "\n"
      );
    }
    const startedAt = iso(runtime.now());
    const startMs = runtime.now();
    const startPerf = performance.now();
    emit({
      type: "attempt.started",
      attempt: attemptNumber,
      model: attemptModel,
      executor: attemptExecutor,
      reason: plan[i].reason,
      ...(candidateId ? { candidate_id: candidateId } : {}),
    });
    res = await harness.run(home, prompt, {
      timeout,
      depth,
      alterId: o.id,
      maxTokens: o.maxTokens,
      model: attemptModel,
      variant: o.opencodeVariant || null,
      pure,
      recordEvents,
      attempt: attemptNumber,
      signal,
      onEvent: (event) => emit({
        ...event,
        attempt: attemptNumber,
        model: attemptModel,
        executor: attemptExecutor,
        ...(candidateId ? { candidate_id: candidateId } : {}),
      }),
      environment: runtime.env,
      agent,
      sessionId,
      // Read only by the executors that have no agent home to read them from: the
      // capability pair needs the binding, the llm executor needs the role for its
      // system prompt. Every other adapter ignores them.
      capability: o.capability || null,
      catalogName: o.catalogName || null,
      description: o.description || null,
      images: o.images || [],
      imageMetadata: o.imageMetadata || [],
      providers: cfg.providers || {},
      readGrants: o.readGrants || [],
      writeGrants: o.writeGrants || [],
      webAccess: !!o.webAccess,
    });
    if (res.ok && o.outputContract) {
      const contract = checkOutputContract(res.text, o.outputContract);
      if (!contract.ok) {
        res = { ...res, ok: false, contract_failed: true, contract_error: contract.error, retryable: true };
      }
    }
    const endedAt = iso(runtime.now());
    attempts.push({
      attempt: attemptNumber,
      model: attemptModel,
      executor: attemptExecutor,
      ...(candidateId ? { candidate_id: candidateId } : {}),
      reason: plan[i].reason,
      ok: res.ok,
      exit_code: res.exitCode,
      killed: res.killed,
      budget_exceeded: res.budget_exceeded || false,
      empty_output: res.empty_output || false,
      contract_failed: res.contract_failed || false,
      contract_error: res.contract_error || null,
      llm_error: res.llm_error || null,
      capability_error: res.capability_error || null,
      tokens: res.tokens,
      pricing,
      tools: res.tools ? { calls: res.tools.calls, errors: res.tools.errors, by_name: { ...res.tools.byName } } : null,
      tool_activity: !!res.toolActivity || (res.tools?.calls || 0) > 0,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: runtime.now() - startMs,
      elapsed_ms: performance.now() - startPerf,
      event_log: res.eventLog ? path.relative(home, res.eventLog) : null,
    });
    o.model = attemptModel;
    o.executor = attemptExecutor;
    // A budget overrun is terminal: retrying under the same fixed cap would deterministically
    // fail again regardless of model, so it doesn't advance to the fallback tier.
    // An empty result (`res.empty_output`, so `ok:false`) is *not* terminal and falls through
    // to the next attempt — returning no final message is often model-specific, so the
    // same-model retry and then the fallback model are both worth spending.
    if (
      res.ok || res.budget_exceeded || res.aborted || signal?.aborted ||
      (o.modelCandidates?.length && (res.toolActivity || (res.tools?.calls || 0) > 0))
    ) break;
    if (o.modelCandidates?.length && res.retryable === false) {
      const nextCandidate = plan.findIndex((item, index) => index > i && item.candidateId !== candidateId);
      if (nextCandidate >= 0) {
        i = nextCandidate - 1;
        continue;
      }
      break;
    }
  }
  return { res, attempts };
};
