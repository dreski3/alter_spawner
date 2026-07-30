import { writeFileSync } from "node:fs";
import path from "node:path";
import { iso } from "./util.js";
import { buildBody, buildFrontmatter } from "./frontmatter.js";
import { getHarness } from "./harness/adapter.js";

// Attempt plan: initial run, then `same_harness_retries` retries on the same model, then
// `fallback_retries` retries on an escalated/fallback model (if one is available). A catalog
// entry without a fallback_model gets no fallback tier — we do not guess one for named harnesses.
export const buildAttemptPlan = (o, cfg) => {
  const sameRetries = cfg.retry?.same_harness_retries ?? 1;
  const fallbackRetries = cfg.retry?.fallback_retries ?? 1;
  const fallbackModel =
    o.fallbackModel ||
    (o.catalogName ? null : cfg.default_fallback_model || process.env.ALTER_MODEL || null);
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
export const runWithRetries = async (o, cfg, home, prompt, timeout, depth, harnessName = "opencode") => {
  const harness = getHarness(harnessName);
  const plan = buildAttemptPlan(o, cfg);
  const attempts = [];
  let res;
  for (let i = 0; i < plan.length; i++) {
    const attemptModel = plan[i].model;
    if (i > 0 && attemptModel !== plan[i - 1].model) {
      o.model = attemptModel;
      writeFileSync(
        path.join(home, ".opencode", "agents", "alter.md"),
        buildFrontmatter(o) + "\n\n" + buildBody(o) + "\n"
      );
    }
    const startedAt = iso(Date.now());
    const startMs = Date.now();
    res = await harness.run(home, prompt, { timeout, depth, alterId: o.id, maxTokens: o.maxTokens });
    const endedAt = iso(Date.now());
    attempts.push({
      attempt: i + 1,
      model: attemptModel,
      reason: plan[i].reason,
      ok: res.ok,
      exit_code: res.exitCode,
      killed: res.killed,
      budget_exceeded: res.budget_exceeded || false,
      empty_output: res.empty_output || false,
      tokens: res.tokens,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: Date.now() - startMs,
    });
    o.model = attemptModel;
    // A budget overrun is terminal: retrying under the same fixed cap would deterministically
    // fail again regardless of model, so it doesn't advance to the fallback tier.
    // An empty result (`res.empty_output`, so `ok:false`) is *not* terminal and falls through
    // to the next attempt — returning no final message is often model-specific, so the
    // same-model retry and then the fallback model are both worth spending.
    if (res.ok || res.budget_exceeded) break;
  }
  return { res, attempts };
};
