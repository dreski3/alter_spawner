import { registerHarness } from "./adapter.js";
import { MindError } from "../util.js";
import { resolveLlmEndpointFromDisk } from "../providers.js";

// One tool-less chat completion. No coding-agent session, no home on disk, no process.
//
// After Phase 0 this is a *latency* optimisation rather than a token one: a text_only
// leaf on the opencode executor already costs ~268 input tokens, and the residue there
// is the `<env>` preamble rather than anything this removes. What it removes is the
// ~2.7s of spawning opencode, booting a session and tearing it down, replaced by a
// single HTTP request. On a wide tree of small transforms that is the whole wall clock.
//
// Self-registering, unlike the capability executors: it needs nothing a host has to
// build, only the two files opencode already keeps on disk, and it grants a nested
// Alter no privilege it did not already have — it was making model calls through
// opencode with the same credentials a moment ago.

const ZERO = { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 };

const failed = (message, exitCode = 1) => {
  process.stderr.write(`(alter llm) ${message}\n`);
  return {
    tokens: { ...ZERO },
    text: "",
    sessionID: null,
    steps: 0,
    exitCode,
    killed: false,
    ok: false,
    budget_exceeded: false,
    // Distinct from "the model returned nothing": the call never produced a
    // completion, so retry.js should treat it as a plain failure and escalate on the
    // normal schedule rather than reading it as an empty answer.
    empty_output: false,
    llm_error: message,
  };
};

// The response shape is OpenAI's, including the optional details objects that carry
// reasoning and cache accounting. Missing fields mean zero, not unknown.
const readUsage = (usage = {}) => {
  const input = usage.prompt_tokens || 0;
  const output = usage.completion_tokens || 0;
  return {
    input,
    output,
    reasoning: usage.completion_tokens_details?.reasoning_tokens || 0,
    cache_read: usage.prompt_tokens_details?.cached_tokens || 0,
    total: usage.total_tokens || input + output,
  };
};

// A tiny system prompt is the entire point: the Alter's role, and the instruction that
// its reply *is* the result. Everything the opencode path adds — the sandbox framing,
// the operating rules, the env block — describes a situation that does not exist here.
const systemPrompt = (description) =>
  `${description?.trim() || "Transform the text you are given."}\n\nYour entire reply is captured verbatim as the result. Return only the result — no preamble, no explanation.`;

// Combines the caller's cancellation with this run's timeout. AbortSignal.any would do
// it in one line, but keeping this explicit also makes timeout attribution local.
const abortPlan = (signal, timeout) => {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timer = timeout
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout)
    : null;
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
};

const run = async (
  home,
  prompt,
  { timeout, maxTokens, model, signal, description, environment = process.env } = {},
) => {
  let endpoint;
  try {
    endpoint = resolveLlmEndpointFromDisk(model, environment);
  } catch (error) {
    // Resolution failures are configuration problems with actionable messages —
    // an unknown model, a missing credential, a protocol this does not speak.
    return failed(error instanceof MindError ? error.message : `could not resolve ${model}: ${error?.message || error}`);
  }

  // `max_tokens` here caps *output*, which is not quite what maxTokens means elsewhere
  // (a whole-run budget enforced by killing the process). For a leaf transformer the
  // two coincide in practice, and capping output is strictly better than opencode's
  // after-the-fact kill. The whole-run meaning is still honoured below, against the
  // usage the provider reports.
  const outputCap = maxTokens ?? endpoint.maxOutputTokens ?? null;
  const plan = abortPlan(signal, timeout);
  let response;
  let body;
  try {
    response = await fetch(`${endpoint.baseURL}/chat/completions`, {
      method: "POST",
      signal: plan.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({
        model: endpoint.modelId,
        messages: [
          { role: "system", content: systemPrompt(description) },
          { role: "user", content: prompt },
        ],
        ...(outputCap ? { max_tokens: outputCap } : {}),
        stream: false,
      }),
    });
    body = await response.text();
  } catch (error) {
    if (plan.timedOut()) return failed(`${endpoint.providerId}/${endpoint.modelId} timed out after ${timeout}ms`, -1);
    if (signal?.aborted) return { ...failed("run cancelled"), aborted: true, killed: true };
    return failed(`request to ${endpoint.providerId} failed: ${error?.message || error}`, -2);
  } finally {
    plan.done();
  }

  if (!response.ok) {
    // Truncated: a provider error body can be long, and it is going to stderr.
    return failed(`${endpoint.providerId} returned ${response.status}: ${body.slice(0, 400)}`, response.status);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return failed(`${endpoint.providerId} returned a non-JSON body: ${body.slice(0, 200)}`);
  }

  const text = parsed.choices?.[0]?.message?.content ?? "";
  const tokens = readUsage(parsed.usage);
  const budgetExceeded = maxTokens != null && tokens.total > maxTokens;
  // An empty completion *is* the empty-output case here, unlike a transport failure —
  // it is often model-specific, so reporting it lets retry.js spend the same-model
  // retry and then the fallback model, exactly as it does for the opencode adapter.
  const emptyOutput = !budgetExceeded && !text.trim();
  return {
    tokens,
    text,
    sessionID: null,
    steps: 1,
    exitCode: 0,
    killed: false,
    ok: !emptyOutput && !budgetExceeded,
    budget_exceeded: budgetExceeded,
    empty_output: emptyOutput,
    llm_error: null,
  };
};

// needsAgentHome: nothing here reads a directory. supportsRetry: unlike a deterministic
// function, a model call genuinely can succeed on a second attempt or a different
// model, so the full attempt plan applies.
registerHarness("llm", { run, needsAgentHome: false, supportsRetry: true });

export const __test__ = { readUsage, systemPrompt };
