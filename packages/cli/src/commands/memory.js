import {
  CapabilityUnavailableError,
  fail,
  formatPutOutcome,
  formatSearchOutcome,
  putMemory,
  searchMemory,
} from "@mind/core";

const usage = () => {
  console.error("usage: mind memory search <query> [--limit <n>] [--kind <k>]* [--json]");
  console.error("       mind memory put <content> [--kind <k>] [--tag <t>]* [--confidence <0-1>]");
  console.error("                                 [--expires-at <iso>] [--json]");
  console.error("");
  console.error("  kinds: fact, preference, decision, summary");
  console.error("  The host decides the project/conversation scope and whether the operation runs at all.");
};

const parse = (argv, flags) => {
  const options = { positional: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) {
      const flag = flags[arg.slice(2)];
      if (!flag) fail(`unknown flag: ${arg}`);
      const value = argv[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      flag(options, value);
    } else options.positional.push(arg);
  }
  return options;
};

const integer = (value, label) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) fail(`${label} must be an integer`);
  return parsed;
};

const SEARCH_FLAGS = {
  limit: (o, v) => { o.limit = integer(v, "--limit"); },
  kind: (o, v) => { (o.kinds ||= []).push(v); },
  query: (o, v) => { o.query = v; },
};

const PUT_FLAGS = {
  kind: (o, v) => { o.kind = v; },
  tag: (o, v) => { (o.tags ||= []).push(v); },
  confidence: (o, v) => { o.confidence = Number(v); },
  "expires-at": (o, v) => { o.expiresAt = v; },
  content: (o, v) => { o.content = v; },
};

// A denial is reported on stdout with a zero exit status, and that is deliberate.
// The user was asked and answered; nothing went wrong. A non-zero exit reads to
// an agent as "transient, worth another go", and another go would just raise the
// same approval card at the same person. A genuine failure — no host to ask, or a
// host that could not serve the request — is the only thing that exits non-zero,
// and it never falls back to touching the store.
export const run = async (argv) => {
  const operation = argv[0];
  const rest = argv.slice(1);
  if (operation === "search" || operation === "put") {
    const flags = operation === "search" ? SEARCH_FLAGS : PUT_FLAGS;
    const options = parse(rest, flags);
    if (options.help) return usage();
    const text = [...options.positional].join(" ").trim();
    try {
      const outcome = operation === "search"
        ? await searchMemory({
          query: options.query || text,
          limit: options.limit ?? null,
          kinds: options.kinds || [],
        })
        : await putMemory({
          content: options.content || text,
          kind: options.kind || "fact",
          tags: options.tags || [],
          confidence: options.confidence ?? null,
          expiresAt: options.expiresAt ?? null,
        });
      if (options.json) console.log(JSON.stringify(outcome, null, 2));
      else console.log(operation === "search" ? formatSearchOutcome(outcome) : formatPutOutcome(outcome));
      return;
    } catch (error) {
      if (error instanceof CapabilityUnavailableError) {
        fail(
          `persistent memory is unavailable here (${error.message}). ` +
            "Nothing was read or written; continue without it.",
        );
      }
      throw error;
    }
  }
  if (operation) console.error(`mind memory: unrecognized operation "${operation}"`);
  usage();
  process.exitCode = operation ? 1 : 0;
};
