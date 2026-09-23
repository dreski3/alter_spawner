import { readFileSync } from "node:fs";
import { registerHarness } from "./adapter.js";
import { MindError } from "../util.js";
import { resolveDirectLlmEndpoint } from "../providers.js";

// One tool-less chat completion. No coding-agent session, no home on disk, no process.
//
// After Phase 0 this is a *latency* optimisation rather than a token one: a text_only
// leaf on the opencode executor already costs ~268 input tokens, and the residue there
// is the `<env>` preamble rather than anything this removes. What it removes is the
// ~2.7s of spawning opencode, booting a session and tearing it down, replaced by a
// single HTTP request. On a wide tree of small transforms that is the whole wall clock.
//
// Self-registering, unlike the capability executors: it resolves project-configured
// direct providers first and retains OpenCode's catalog/auth files as a compatibility
// fallback for provider IDs the project has not configured.

const ZERO = { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 };

const failed = (message, exitCode = 1, retryable = false) => {
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
    retryable,
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

// OpenAI-compatible providers accept the same content-part shape for local image
// attachments. Images have already been size/type/containment checked by engine.js;
// the harness only turns those validated files into transport-safe data URLs.
const userContent = (prompt, images = [], imageMetadata = []) => {
  if (!images.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((file, index) => ({
      type: "image_url",
      image_url: {
        url: `data:${imageMetadata[index]?.media_type || "image/png"};base64,${readFileSync(file).toString("base64")}`,
      },
    })),
  ];
};

const imageParts = (images, imageMetadata) => images.map((file, index) => ({
  mediaType: imageMetadata[index]?.media_type || "image/png",
  data: readFileSync(file).toString("base64"),
}));

const buildRequest = (endpoint, prompt, description, images, imageMetadata, outputCap) => {
  const headers = { "content-type": "application/json" };
  if (endpoint.protocol === "anthropic-messages") {
    if (endpoint.apiKey) headers["x-api-key"] = endpoint.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const parts = imageParts(images, imageMetadata);
    return {
      url: `${endpoint.baseURL}/messages`,
      headers,
      body: {
        model: endpoint.modelId,
        system: systemPrompt(description),
        messages: [{
          role: "user",
          content: parts.length ? [
            { type: "text", text: prompt },
            ...parts.map((part) => ({
              type: "image",
              source: { type: "base64", media_type: part.mediaType, data: part.data },
            })),
          ] : prompt,
        }],
        max_tokens: outputCap || 4096,
      },
    };
  }
  if (endpoint.protocol === "gemini") {
    if (endpoint.apiKey) headers["x-goog-api-key"] = endpoint.apiKey;
    const parts = imageParts(images, imageMetadata);
    return {
      url: `${endpoint.baseURL}/models/${encodeURIComponent(endpoint.modelId)}:generateContent`,
      headers,
      body: {
        systemInstruction: { parts: [{ text: systemPrompt(description) }] },
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            ...parts.map((part) => ({ inlineData: { mimeType: part.mediaType, data: part.data } })),
          ],
        }],
        ...(outputCap ? { generationConfig: { maxOutputTokens: outputCap } } : {}),
      },
    };
  }
  if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
  if (endpoint.protocol === "openai-responses") {
    const parts = imageParts(images, imageMetadata);
    return {
      url: `${endpoint.baseURL}/responses`,
      headers,
      body: {
        model: endpoint.modelId,
        instructions: systemPrompt(description),
        input: parts.length ? [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            ...parts.map((part) => ({
              type: "input_image",
              image_url: `data:${part.mediaType};base64,${part.data}`,
            })),
          ],
        }] : prompt,
        ...(outputCap ? { max_output_tokens: outputCap } : {}),
        store: false,
      },
    };
  }
  return {
    url: `${endpoint.baseURL}/chat/completions`,
    headers,
    body: {
      model: endpoint.modelId,
      messages: [
        { role: "system", content: systemPrompt(description) },
        { role: "user", content: userContent(prompt, images, imageMetadata) },
      ],
      ...(outputCap ? { max_tokens: outputCap } : {}),
      stream: false,
    },
  };
};

const responseText = (protocol, body) => {
  if (protocol === "anthropic-messages") {
    return (body.content || []).filter((part) => part?.type === "text").map((part) => part.text || "").join("");
  }
  if (protocol === "gemini") {
    return (body.candidates?.[0]?.content?.parts || []).map((part) => part?.text || "").join("");
  }
  if (protocol === "openai-responses") {
    if (typeof body.output_text === "string") return body.output_text;
    return (body.output || []).flatMap((item) => item?.content || [])
      .filter((part) => part?.type === "output_text")
      .map((part) => part.text || "")
      .join("");
  }
  return body.choices?.[0]?.message?.content ?? "";
};

const responseUsage = (protocol, body) => {
  const usage = body.usage || body.usageMetadata || {};
  if (protocol === "anthropic-messages") {
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    return {
      input,
      output,
      reasoning: 0,
      cache_read: usage.cache_read_input_tokens || 0,
      total: input + output,
    };
  }
  if (protocol === "gemini") {
    const input = usage.promptTokenCount || 0;
    const output = usage.candidatesTokenCount || 0;
    return {
      input,
      output,
      reasoning: usage.thoughtsTokenCount || 0,
      cache_read: usage.cachedContentTokenCount || 0,
      total: usage.totalTokenCount || input + output,
    };
  }
  if (protocol === "openai-responses") {
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    return {
      input,
      output,
      reasoning: usage.output_tokens_details?.reasoning_tokens || 0,
      cache_read: usage.input_tokens_details?.cached_tokens || 0,
      total: usage.total_tokens || input + output,
    };
  }
  return readUsage(usage);
};

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
  { timeout, maxTokens, model, signal, description, images = [], imageMetadata = [], providers = {}, environment = process.env } = {},
) => {
  let endpoint;
  try {
    endpoint = resolveDirectLlmEndpoint(model, { providers, env: environment });
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
  const request = buildRequest(endpoint, prompt, description, images, imageMetadata, outputCap);
  let response;
  let body;
  try {
    response = await fetch(request.url, {
      method: "POST",
      signal: plan.signal,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    body = await response.text();
  } catch (error) {
    if (plan.timedOut()) {
      return {
        ...failed(`${endpoint.providerId}/${endpoint.modelId} timed out after ${timeout}ms`, -1, true),
        killed: true,
      };
    }
    if (signal?.aborted) return { ...failed("run cancelled"), aborted: true, killed: true };
    return failed(`request to ${endpoint.providerId} failed: ${error?.message || error}`, -2, true);
  } finally {
    plan.done();
  }

  if (!response.ok) {
    // Truncated: a provider error body can be long, and it is going to stderr.
    const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    return failed(`${endpoint.providerId} returned ${response.status}: ${body.slice(0, 400)}`, response.status, retryable);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return failed(`${endpoint.providerId} returned a non-JSON body: ${body.slice(0, 200)}`);
  }

  const text = responseText(endpoint.protocol, parsed);
  const tokens = responseUsage(endpoint.protocol, parsed);
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
    retryable: !budgetExceeded,
  };
};

// needsAgentHome: nothing here reads a directory. supportsRetry: unlike a deterministic
// function, a model call genuinely can succeed on a second attempt or a different
// model, so the full attempt plan applies.
registerHarness("llm", { run, needsAgentHome: false, supportsRetry: true, supportsImages: true });

export const __test__ = { readUsage, systemPrompt, userContent, buildRequest, responseText, responseUsage };
