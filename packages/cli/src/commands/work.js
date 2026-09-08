import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fail, kitDir, requireProjectRoot, runOpinion, writeOpinionReport } from "@mind/core";

const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_FILE_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;

const usage = () => {
  console.error("usage: mind work opinion --model <provider/model> --model <provider/model> [--model <provider/model> ...]");
  console.error("                         [--context <file>]* [--max-tokens <n>] [--concurrency <n>] [--json] <task>");
  console.error("");
  console.error("  Runs 2-5 isolated, tool-free reviewers in parallel. Context files must be regular files inside the mind project.");
  console.error("");
  console.error("usage: mind work opinion report [graph-folder]");
  console.error("  Writes a side-by-side opinion.html dashboard and its pricing snapshot (opinion-report.json).");
};

const positiveInteger = (value, flag, { max = Infinity } = {}) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) fail(`${flag} requires a positive integer${max < Infinity ? ` no greater than ${max}` : ""}.`);
  return parsed;
};

export const parseOpinionArgs = (argv) => {
  const models = [];
  const contextFiles = [];
  const task = [];
  let maxTokens = null;
  let concurrency = null;
  let json = false;
  let parseFlags = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (parseFlags && arg === "--") {
      parseFlags = false;
    } else if (parseFlags && arg === "--model") {
      if (!argv[i + 1]) fail("--model requires a provider/model value.");
      models.push(argv[++i].trim());
    } else if (parseFlags && arg === "--context") {
      if (!argv[i + 1]) fail("--context requires a file path.");
      contextFiles.push(argv[++i]);
    } else if (parseFlags && arg === "--max-tokens") {
      maxTokens = positiveInteger(argv[++i], "--max-tokens");
    } else if (parseFlags && arg === "--concurrency") {
      concurrency = positiveInteger(argv[++i], "--concurrency", { max: 5 });
    } else if (parseFlags && arg === "--json") {
      json = true;
    } else if (parseFlags && (arg === "--help" || arg === "-h")) {
      return { help: true };
    } else if (parseFlags && arg.startsWith("--")) {
      fail("unknown flag: " + arg);
    } else {
      task.push(arg);
    }
  }
  const prompt = task.join(" ").trim();
  if (!prompt) fail("opinion requires a task.");
  if (models.length < 2 || models.length > 5) fail("opinion requires between 2 and 5 --model values.");
  if (models.some((model) => {
    const slash = model.indexOf("/");
    return !model || slash <= 0 || slash === model.length - 1;
  })) fail("opinion --model values must be non-empty provider/model strings.");
  if (new Set(models).size !== models.length) fail("opinion --model values must be distinct.");
  if (contextFiles.length > MAX_CONTEXT_FILES) fail(`opinion accepts at most ${MAX_CONTEXT_FILES} --context files.`);
  return { help: false, task: prompt, models, contextFiles, maxTokens, concurrency, json };
};

const contains = (root, target) => target.startsWith(root + path.sep);

export const readOpinionContext = (root, files) => {
  const projectRoot = realpathSync(root);
  let total = 0;
  return files.map((file) => {
    const requested = path.resolve(root, file);
    let target;
    try {
      target = realpathSync(requested);
    } catch {
      fail(`context file not found: ${file}`);
    }
    if (!contains(projectRoot, target)) fail(`context file is outside the mind project: ${file}`);
    if (!statSync(target).isFile()) fail(`context path is not a regular file: ${file}`);
    const content = readFileSync(target, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_CONTEXT_FILE_BYTES) fail(`context file is too large: ${file} (${bytes} bytes; limit ${MAX_CONTEXT_FILE_BYTES}).`);
    total += bytes;
    if (total > MAX_CONTEXT_BYTES) fail(`combined context exceeds ${MAX_CONTEXT_BYTES} bytes.`);
    return `### ${path.relative(projectRoot, target)}\n${content}`;
  }).join("\n\n");
};

const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value || 0);
const formatCost = (value) => value == null ? "—" : `$${value.toFixed(6)}`;
const formatDuration = (ms) => {
  if (ms == null) return "—";
  if (ms < 1_000) return `${ms} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
};
const boxedText = (text) => String(text || "No output.").split("\n").map((line) => `│ ${line}`).join("\n");

export const formatOpinions = ({ home, result, report, opinions }) => {
  const totals = report?.report?.totals;
  const dashboard = report?.html || path.join(home, "opinion.html");
  const lines = [
    "╭─ Opinion panel ─────────────────────────────────────────────────────────",
    `│ Graph       ${home}`,
    `│ Completion  ${result.node_counts.succeeded}/${result.node_counts.total} reviewers · ${result.state}`,
    `│ Wall time   ${formatDuration(result.duration_ms)}`,
    `│ Tokens      ${formatNumber(result.tokens.total)}`,
    `│ Est. cost   ${formatCost(totals?.estimated_api_cost_usd)} API-equivalent`,
    `│ Dashboard   ${dashboard}`,
    "╰─────────────────────────────────────────────────────────────────────────",
  ];
  for (const [index, opinion] of opinions.entries()) {
    const detail = report?.report?.opinions.find((entry) => entry.model === opinion.model);
    const tokens = detail?.tokens;
    lines.push(
      "",
      `╭─ Reviewer ${index + 1} · ${opinion.state} ────────────────────────────────────────────`,
      `│ Model      ${opinion.model}`,
      `│ Executor   ${detail?.executor || "—"} · ${detail?.attempts || 0} attempt${detail?.attempts === 1 ? "" : "s"}`,
      `│ Time       ${formatDuration(detail?.duration_ms)}`,
      `│ Tokens     ${formatNumber(tokens?.total)} total · ${formatNumber(tokens?.input)} in · ${formatNumber(tokens?.output)} out · ${formatNumber(tokens?.reasoning)} reasoning · ${formatNumber(tokens?.cache_read)} cached`,
      `│ Est. cost  ${formatCost(detail?.estimated_api_cost_usd)} API-equivalent`,
      "├─ Opinion",
      boxedText(opinion.text || `Error: ${opinion.error || "no output"}`),
      "╰─────────────────────────────────────────────────────────────────────────",
    );
  }
  return lines.join("\n");
};

const graphHomeForReport = (root, argument) => {
  const graphs = path.join(kitDir(root), "graphs");
  let candidate = argument ? path.resolve(root, argument) : null;
  if (argument && !statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
    candidate = path.join(graphs, argument);
  }
  if (!candidate) {
    const latest = readdirSync(graphs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .find((name) => statSync(path.join(graphs, name, "result.json"), { throwIfNoEntry: false })?.isFile());
    if (!latest) fail("no completed opinion graph found.");
    candidate = path.join(graphs, latest);
  }
  let home;
  try {
    home = realpathSync(candidate);
  } catch {
    fail(`opinion graph not found: ${argument}`);
  }
  const graphRoot = realpathSync(graphs);
  if (!contains(graphRoot, home)) fail("opinion report graph must be inside this mind project's .alters/graphs directory.");
  const resultFile = path.join(home, "result.json");
  if (!statSync(resultFile, { throwIfNoEntry: false })?.isFile()) fail(`opinion graph has no result.json: ${home}`);
  let result;
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    fail(`opinion graph result is not valid JSON: ${home}`);
  }
  if (result.id !== "opinion") fail(`graph is not an opinion workflow: ${home}`);
  return { home, result };
};

const runOpinionReportCommand = (argv) => {
  if (argv.length > 1 || argv[0] === "--help" || argv[0] === "-h") return usage();
  const root = requireProjectRoot();
  const { home, result } = graphHomeForReport(root, argv[0]);
  const report = writeOpinionReport(home, result);
  console.log(`opinion dashboard: ${report.html}`);
  console.log(`pricing snapshot: ${report.json}`);
};

const runOpinionCommand = async (argv) => {
  const parsed = parseOpinionArgs(argv);
  if (parsed.help) return usage();
  const root = requireProjectRoot();
  const context = readOpinionContext(root, parsed.contextFiles);
  const opinion = await runOpinion(root, {
    task: parsed.task,
    models: parsed.models,
    context,
    maxTokens: parsed.maxTokens,
  }, { concurrency: parsed.concurrency ?? parsed.models.length });
  if (parsed.json) console.log(JSON.stringify({ workflow: "opinion", task: parsed.task, models: parsed.models, ...opinion }, null, 2));
  else console.log(formatOpinions(opinion));
  if (!opinion.result.ok) process.exitCode = 1;
};

export const run = (argv) => {
  if (argv[0] === "opinion" && argv[1] === "report") return runOpinionReportCommand(argv.slice(2));
  if (argv[0] === "opinion") return runOpinionCommand(argv.slice(1));
  fail("usage: mind work opinion ...");
};
