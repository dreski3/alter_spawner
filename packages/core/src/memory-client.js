import { MEMORY_KINDS } from "./memory.js";
import { requestCapability } from "./capability-client.js";

// Persistent memory as something a child *asks* for, rather than something done
// to it. `mind memory search|put` are thin wrappers over these two calls.
//
// Note what is absent: scope and provenance. A child does not choose which
// project or conversation it reads and writes, and it does not get to attest
// where a record came from — the host owns both and stamps them on the request
// it actually executes. So there is nothing here to pass them through, by
// design: the only thing travelling from child to host is what to look for or
// what to remember.

const memoryKinds = new Set(MEMORY_KINDS);

const requireKinds = (kinds) => {
  for (const kind of kinds) {
    if (!memoryKinds.has(kind)) throw new Error(`memory kind must be one of: ${MEMORY_KINDS.join(", ")}`);
  }
  return kinds;
};

// `tags` is deliberately not a search parameter. The store treats tags as a
// conjunctive filter — a record must carry every tag listed — so a plausible
// guess silently returns nothing, which is the worst possible failure mode for
// recall. Tag text still influences ranking through the query itself, so folding
// tags into the query costs no precision. (memory-workflows.js drops planner
// tags for the same reason.)
export const searchMemory = async ({
  query,
  limit = null,
  kinds = [],
  env,
  signal,
  fetchImpl,
} = {}) => {
  if (typeof query !== "string" || !query.trim() || query.length > 2000) {
    throw new Error("memory search query must be a non-empty string of at most 2,000 characters");
  }
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error("memory search limit must be an integer from 1 to 100");
  }
  const outcome = await requestCapability("memory.records.search", {
    env,
    signal,
    fetchImpl,
    reason: "The principal asked to search persistent memory for the current turn.",
    input: {
      query: query.trim(),
      ...(limit === null ? {} : { limit }),
      ...(kinds.length ? { kinds: requireKinds(kinds) } : {}),
    },
  });
  return { ...outcome, results: outcome.value?.results || [] };
};

export const putMemory = async ({
  content,
  kind = "fact",
  tags = [],
  confidence = null,
  expiresAt = null,
  env,
  signal,
  fetchImpl,
} = {}) => {
  if (typeof content !== "string" || !content.trim() || content.length > 20000) {
    throw new Error("memory content must be a non-empty string of at most 20,000 characters");
  }
  requireKinds([kind]);
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new Error("memory confidence must be a number between 0 and 1");
  }
  const outcome = await requestCapability("memory.records.write", {
    env,
    signal,
    fetchImpl,
    reason: "The principal proposes a durable record for persistent memory.",
    input: {
      records: [{
        kind,
        content: content.trim(),
        ...(tags.length ? { tags } : {}),
        ...(confidence === null ? {} : { confidence }),
        ...(expiresAt === null ? {} : { expiresAt }),
      }],
    },
  });
  return { ...outcome, records: outcome.value?.records || [] };
};

// Delegates the whole "is this worth remembering, or does it need recalling" decision
// to the memory-assistant alter, rather than asking the host to run one specific
// operation. `mind memory search`/`put` still exist for a caller that has already made
// that decision; this is for a caller that would rather hand over free text and let the
// alter route it — one router, one dispatch, one natural-language result — instead of
// composing the two itself. Same host boundary as every other memory call here: the
// approval card the user sees names the real operation the router picked, not this call.
export const askMemoryAssistant = async ({
  text,
  env,
  signal,
  fetchImpl,
} = {}) => {
  if (typeof text !== "string" || !text.trim() || text.length > 20000) {
    throw new Error("memory assistant text must be a non-empty string of at most 20,000 characters");
  }
  const outcome = await requestCapability("memory.assistant.handle", {
    env,
    signal,
    fetchImpl,
    reason: "The principal is delegating a memory decision to the memory assistant.",
    input: { text: text.trim() },
  });
  return {
    ...outcome,
    action: outcome.value?.action || null,
    detail: outcome.value?.detail || null,
    text: outcome.value?.text || "",
  };
};

export const inspectMemoryStorage = async ({ env, signal, fetchImpl } = {}) => {
  const outcome = await requestCapability("memory.records.stats", {
    env,
    signal,
    fetchImpl,
    reason: "The principal asked to inspect persistent memory storage consumption.",
    input: {},
  });
  return { ...outcome, stats: outcome.value?.stats || null };
};

// Written for a model to read on stdout, so a denial reads as a settled answer
// ("continue without it") rather than an error worth retrying — a retry would
// just raise the same card at the user again.
export const formatSearchOutcome = ({ decision, results }) => {
  if (decision === "deny") {
    return "denied: the user declined this memory search. Nothing was read — continue without persistent memory.";
  }
  if (!results.length) return "no records matched. Persistent memory has nothing on this.";
  const lines = results.map(({ record, score, matchedTerms }) => [
    `[${record.kind}] ${record.id} (score ${score}${record.tags.length ? `, tags: ${record.tags.join(", ")}` : ""}${
      matchedTerms?.length ? `, matched: ${matchedTerms.join(", ")}` : ""
    })`,
    record.content,
  ].join("\n"));
  return `${results.length} ${results.length === 1 ? "record" : "records"} matched.\n\n${lines.join("\n\n")}`;
};

export const formatPutOutcome = ({ decision, records }) => {
  if (decision === "deny") {
    return "denied: the user declined this write. Nothing was stored — do not try again with the same record.";
  }
  if (!records.length) return "nothing was stored.";
  // The store deduplicates by content hash within a scope, so an identical
  // record already present comes back as-is instead of being written twice —
  // which is why this reports the stored record rather than "created".
  return `stored ${records.length} ${records.length === 1 ? "record" : "records"}.\n\n${
    records.map((record) => `[${record.kind}] ${record.id} v${record.version}\n${record.content}`).join("\n\n")
  }`;
};

export const formatAssistantOutcome = ({ decision, action, detail, text }) => {
  if (decision === "deny") {
    return "denied: the user declined this memory action. Nothing was read or written — continue without it.";
  }
  if (!action) return "the memory assistant returned no decision.";
  return `${action} (${detail}).\n\n${text}`;
};

export const formatStorageOutcome = ({ decision, stats }) => {
  if (decision === "deny") return "denied: the user declined this storage inspection. Nothing was read.";
  if (!stats) return "persistent memory storage statistics are unavailable.";
  const quota = stats.quotaBytes === null
    ? "no quota"
    : `${stats.quotaBytes} byte quota (${(stats.quotaRatio * 100).toFixed(1)}% used)`;
  const namespaces = Object.entries(stats.byNamespace)
    .map(([namespace, value]) => `  ${namespace}: ${value.records} records, ${value.logicalBytes} logical bytes`)
    .join("\n");
  return [
    `${stats.recordCount} records (${stats.activeRecordCount} active, ${stats.expiredRecordCount} expired)`,
    `${stats.physicalBytes} physical bytes; ${stats.logicalBytes} logical bytes; ${quota}`,
    namespaces ? `namespaces:\n${namespaces}` : "namespaces: none",
  ].join("\n");
};
