import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fail, kitDir, parseValidationCommand, requireProjectRoot, runDebate, runOpinion, runFuse, runValidate, writeDebateReport, writeFuseReport, writeOpinionReport, writeValidateReport } from "@mind/core";

const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_FILE_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;

const usage = () => {
  console.error("usage: mind work fuse --model <provider/model> (2-5) --writer <provider/model> [--executor llm|opencode] [--writer-executor llm|opencode] [--context <file>]* [--max-tokens <n>] [--concurrency <n>] [--json] <task>");
  console.error("usage: mind work opinion --model <provider/model> --model <provider/model> [--model <provider/model> ...]");
  console.error("                         [--context <file>]* [--max-tokens <n>] [--concurrency <n>] [--json] <task>");
  console.error("usage: mind work debate --model <provider/model> (2-5) [--rounds <1-3>] [--executor llm|opencode]");
  console.error("                         [--context <file>]* [--max-tokens <n>] [--concurrency <n>] [--json] <task>");
  console.error("usage: mind work validate --model <provider/model> --command '[\"npm\",\"test\"]' [--command <JSON argv>]*");
  console.error("                         [--dry-run] [--executor llm|opencode] [--context <file>]* [--max-tokens <n>]");
  console.error("                         [--command-timeout-ms <n>] [--deadline-ms <n>] [--max-cost-usd <n>] [--json] <task>");
  console.error("");
  console.error("  Runs 2-5 isolated, tool-free reviewers in parallel. Context files must be regular files inside the mind project.");
  console.error("  Omit --concurrency to run the maximum ready work; OAuth/OpenCode nodes share one local server automatically.");
  console.error("");
  console.error("usage: mind work fuse report [graph-folder]  (synthesis and usage dashboard; no model calls)");
  console.error("usage: mind work opinion report [graph-folder]");
  console.error("usage: mind work debate report [graph-folder]");
  console.error("usage: mind work validate report [graph-folder]");
  console.error("  Regenerates the workflow HTML dashboard and pricing snapshot without model calls.");
};

const positiveInteger = (value, flag, { max = Infinity } = {}) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) fail(`${flag} requires a positive integer${max < Infinity ? ` no greater than ${max}` : ""}.`);
  return parsed;
};

const parseWorkArgs = (argv, workflow) => {
  let writer;
  let executor;
  let writerExecutor;
  const models = [];
  const contextFiles = [];
  const task = [];
  let maxTokens = null;
  let concurrency = null;
  let rounds = null;
  let json = false;
  let parseFlags = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (parseFlags && arg === "--") {
      parseFlags = false;
    } else if (parseFlags && arg === "--model") {
      if (!argv[i + 1]) fail("--model requires a provider/model value.");
      models.push(argv[++i].trim());
    } else if (parseFlags && arg === "--writer-executor" && workflow === "fuse") {
      writerExecutor = argv[++i];
      if (!["llm", "opencode"].includes(writerExecutor)) fail("--writer-executor must be llm or opencode.");
    } else if (parseFlags && arg === "--executor" && ["fuse", "debate"].includes(workflow)) {
      executor = argv[++i];
      if (!["llm", "opencode"].includes(executor)) fail("--executor must be llm or opencode.");
    } else if (parseFlags && arg === "--rounds" && workflow === "debate") {
      rounds = positiveInteger(argv[++i], "--rounds", { max: 3 });
    } else if (parseFlags && arg === "--writer" && workflow === "fuse") {
      if (writer !== undefined) fail("--writer must be specified exactly once.");
      writer = argv[++i]?.trim();
      if (!writer || !/^[^\s/]+\/\S+$/.test(writer)) fail("--writer requires a provider/model value.");
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
  if (!prompt) fail(`${workflow} requires a task.`);
  if (models.length < 2 || models.length > 5) fail(`${workflow} requires between 2 and 5 --model values.`);
  if (models.some((model) => {
    const slash = model.indexOf("/");
    return !model || slash <= 0 || slash === model.length - 1;
  })) fail(`${workflow} --model values must be non-empty provider/model strings.`);
  if (new Set(models).size !== models.length) fail(`${workflow} --model values must be distinct.`);
  if (contextFiles.length > MAX_CONTEXT_FILES) fail(`${workflow} accepts at most ${MAX_CONTEXT_FILES} --context files.`);
  if (workflow === "fuse" && !writer) fail("fuse requires --writer <provider/model>.");
  return {
    help: false,
    task: prompt,
    models,
    contextFiles,
    maxTokens,
    concurrency,
    json,
    ...(workflow === "fuse" ? { writer, ...(executor ? { executor } : {}), ...(writerExecutor ? { writerExecutor } : {}) } : {}),
    ...(workflow === "debate" ? { rounds: rounds ?? 1, ...(executor ? { executor } : {}) } : {}),
  };
};

export const parseOpinionArgs = (argv) => parseWorkArgs(argv, "opinion");
export const parseFuseArgs = (argv) => parseWorkArgs(argv, "fuse");
export const parseDebateArgs = (argv) => parseWorkArgs(argv, "debate");

const positiveNumber = (value, flag) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${flag} requires a positive number.`);
  return parsed;
};

export const parseValidateArgs = (argv) => {
  let model;
  let executor;
  const commands = [];
  const contextFiles = [];
  const task = [];
  let maxTokens = 4000;
  let commandTimeoutMs = 300000;
  let deadlineMs = 900000;
  let maxCostUsd = null;
  let dryRun = false;
  let json = false;
  let parseFlags = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (parseFlags && arg === "--") parseFlags = false;
    else if (parseFlags && arg === "--model") {
      if (model !== undefined) fail("validate --model must be specified exactly once.");
      model = argv[++i]?.trim();
      if (!model || !/^[^\s/]+\/\S+$/.test(model)) fail("validate --model requires a provider/model value.");
    } else if (parseFlags && arg === "--command") {
      if (!argv[i + 1]) fail("--command requires a JSON argv array.");
      commands.push(parseValidationCommand(argv[++i], `--command ${commands.length + 1}`));
    } else if (parseFlags && arg === "--executor") {
      executor = argv[++i];
      if (!["llm", "opencode"].includes(executor)) fail("--executor must be llm or opencode.");
    } else if (parseFlags && arg === "--context") {
      if (!argv[i + 1]) fail("--context requires a file path.");
      contextFiles.push(argv[++i]);
    } else if (parseFlags && arg === "--max-tokens") maxTokens = positiveInteger(argv[++i], "--max-tokens");
    else if (parseFlags && arg === "--command-timeout-ms") commandTimeoutMs = positiveInteger(argv[++i], "--command-timeout-ms", { max: 3_600_000 });
    else if (parseFlags && arg === "--deadline-ms") deadlineMs = positiveInteger(argv[++i], "--deadline-ms", { max: 3_600_000 });
    else if (parseFlags && arg === "--max-cost-usd") maxCostUsd = positiveNumber(argv[++i], "--max-cost-usd");
    else if (parseFlags && arg === "--dry-run") dryRun = true;
    else if (parseFlags && arg === "--json") json = true;
    else if (parseFlags && (arg === "--help" || arg === "-h")) return { help: true };
    else if (parseFlags && arg.startsWith("--")) fail("unknown flag: " + arg);
    else task.push(arg);
  }
  if (!model) fail("validate requires --model <provider/model>.");
  if (commands.length < 1 || commands.length > 8) fail("validate requires between 1 and 8 --command values.");
  if (contextFiles.length > MAX_CONTEXT_FILES) fail(`validate accepts at most ${MAX_CONTEXT_FILES} --context files.`);
  const prompt = task.join(" ").trim();
  if (!prompt) fail("validate requires a task.");
  return { help: false, task: prompt, model, commands, contextFiles, maxTokens, commandTimeoutMs, deadlineMs, maxCostUsd, dryRun, json, ...(executor ? { executor } : {}) };
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
      fail(`context file not found inside mind project ${projectRoot}: ${file}`);
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

export const graphHomeForReport = (root, argument, workflow = "opinion") => {
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
      .find((name) => {
        try {
          return JSON.parse(readFileSync(path.join(graphs, name, "result.json"), "utf8")).id === workflow;
        } catch {
          return false;
        }
      });
    if (!latest) fail(`no completed ${workflow} graph found.`);
    candidate = path.join(graphs, latest);
  }
  let home;
  try {
    home = realpathSync(candidate);
  } catch {
    fail(`${workflow} graph not found: ${argument}`);
  }
  const graphRoot = realpathSync(graphs);
  if (!contains(graphRoot, home)) fail(`${workflow} report graph must be inside this mind project's .alters/graphs directory.`);
  const resultFile = path.join(home, "result.json");
  if (!statSync(resultFile, { throwIfNoEntry: false })?.isFile()) fail(`${workflow} graph has no result.json: ${home}`);
  let result;
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    fail(`${workflow} graph result is not valid JSON: ${home}`);
  }
  if (result.id !== workflow) fail(`graph is not a ${workflow} workflow: ${home}`);
  return { home, result };
};

const runReportCommand = (argv, workflow) => {
  if (argv.length > 1 || argv[0] === "--help" || argv[0] === "-h") return usage();
  const root = requireProjectRoot();
  const { home, result } = graphHomeForReport(root, argv[0], workflow);
  const report = workflow === "fuse"
    ? writeFuseReport(home, result)
    : workflow === "debate" ? writeDebateReport(home, result)
      : workflow === "validate" ? writeValidateReport(home, result) : writeOpinionReport(home, result);
  console.log(`${workflow} dashboard: ${report.html}`);
  console.log(`pricing snapshot: ${report.json}`);
};

export const formatDebate = ({ home, result, report, rounds }) => {
  const critiqueRounds = Math.max(0, rounds.length - 1);
  const lines = [
    "╭─ Debate summary ────────────────────────────────────────────────────────",
    `│ Graph       ${home}`,
    `│ Completion  ${result.node_counts.succeeded}/${result.node_counts.total} nodes · ${result.ok ? result.state : "failed"}`,
    `│ Rounds      1 opening + ${critiqueRounds} critique round${critiqueRounds === 1 ? "" : "s"}`,
    `│ Wall time   ${formatDuration(result.duration_ms)}`,
    `│ Tokens      ${formatNumber(result.tokens.total)} total · ${formatNumber(result.tokens.input)} in · ${formatNumber(result.tokens.output)} out · ${formatNumber(result.tokens.reasoning)} reasoning · ${formatNumber(result.tokens.cache_read)} cached`,
    `│ Est. cost   ${formatCost(report.report.totals.estimated_api_cost_usd)} API-equivalent (not a subscription invoice)`,
    `│ Dashboard   ${report.html}`,
    `│ Pricing     ${report.json}`,
    "╰─────────────────────────────────────────────────────────────────────────",
  ];
  for (const round of rounds) {
    lines.push("", `╭─ ${round.phase === "opening" ? "Opening positions" : `Critique round ${round.round}`} ─────────────────────────────────────────────`);
    for (const entry of round.entries) {
      const detail = report.report.nodes.find((node) => node.id === entry.id);
      const tokens = detail?.tokens;
      lines.push(
        `│ Reviewer ${entry.reviewer} · ${entry.model} · ${entry.state}`,
        `│ ${detail?.executor || "—"} · ${detail?.attempts || 0} attempt${detail?.attempts === 1 ? "" : "s"} · ${formatDuration(detail?.duration_ms)} · ${formatNumber(tokens?.total)} tokens · ${formatCost(detail?.estimated_api_cost_usd)}`,
        "├─ Response",
        boxedText(entry.text || `Error: ${entry.error || "no output"}`),
      );
    }
    lines.push("╰─────────────────────────────────────────────────────────────────────────");
  }
  return lines.join("\n");
};

const runDebateCommand = async (argv) => {
  const parsed = parseDebateArgs(argv);
  if (parsed.help) return usage();
  const root = requireProjectRoot();
  const context = readOpinionContext(root, parsed.contextFiles);
  const outcome = await runDebate(root, { ...parsed, context }, { concurrency: parsed.concurrency ?? parsed.models.length });
  console.log(parsed.json ? JSON.stringify({ workflow: "debate", task: parsed.task, models: parsed.models, ...outcome }, null, 2) : formatDebate(outcome));
  if (!outcome.result.ok) process.exitCode = 1;
};

export const formatValidate = ({ home, result, audit, report, status }) => {
  const designer = report.report.designer;
  const gate = audit.gate || [];
  const lines = [
    "╭─ Validate summary ──────────────────────────────────────────────────────",
    `│ Graph       ${home}`,
    `│ Status      ${status}`,
    `│ Designer    ${result.node_counts.succeeded}/${result.node_counts.total} nodes · ${designer.model || "—"}`,
    `│ Wall time   ${formatDuration(result.duration_ms)}`,
    `│ Tokens      ${formatNumber(result.tokens.total)} total · ${formatNumber(result.tokens.input)} in · ${formatNumber(result.tokens.output)} out · ${formatNumber(result.tokens.reasoning)} reasoning · ${formatNumber(result.tokens.cache_read)} cached`,
    `│ Est. cost   ${formatCost(report.report.totals.estimated_api_cost_usd)} API-equivalent (not a subscription invoice)`,
    `│ Gate        ${gate.filter((entry) => entry.ok).length}/${audit.contract?.commands.length || 0} commands passed${audit.dry_run ? " · dry run" : ""}`,
    `│ Dashboard   ${report.html}`,
    `│ Pricing     ${report.json}`,
    `│ Audit       ${path.join(home, "validation.json")}`,
    "╰─────────────────────────────────────────────────────────────────────────",
  ];
  if (audit.contract_error) lines.push("", "╭─ Contract rejected", boxedText(audit.contract_error), "╰─────────────────────────────────────────────────────────────────────────");
  else if (audit.contract) {
    lines.push("", "╭─ Frozen acceptance contract", boxedText(audit.contract.summary));
    audit.contract.commands.forEach((command, index) => {
      const outcome = gate[index];
      lines.push(`│ ${index + 1}. ${JSON.stringify(command.argv)} · ${outcome ? (outcome.ok ? "passed" : "failed") : "not run"}`);
    });
    lines.push("╰─────────────────────────────────────────────────────────────────────────");
  }
  return lines.join("\n");
};

const runValidateCommand = async (argv) => {
  const parsed = parseValidateArgs(argv);
  if (parsed.help) return usage();
  const root = requireProjectRoot();
  const context = readOpinionContext(root, parsed.contextFiles);
  const outcome = await runValidate(root, { ...parsed, context });
  console.log(parsed.json ? JSON.stringify({ workflow: "validate", task: parsed.task, ...outcome }, null, 2) : formatValidate(outcome));
  if (!outcome.ok) process.exitCode = 1;
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

export const formatFuse = ({ home, result, analysts, writer, report, answer }) => {
  const lines = [
    "╭─ Fuse summary ──────────────────────────────────────────────────────────",
    `│ Graph       ${home}`,
    `│ Completion  ${result.node_counts.succeeded}/${result.node_counts.total} nodes · ${result.ok ? result.state : "failed"}`,
    `│ Wall time   ${formatDuration(result.duration_ms)}`,
    `│ Tokens      ${formatNumber(result.tokens.total)} total · ${formatNumber(result.tokens.input)} in · ${formatNumber(result.tokens.output)} out · ${formatNumber(result.tokens.reasoning)} reasoning · ${formatNumber(result.tokens.cache_read)} cached`,
    `│ Est. cost   ${formatCost(report.report.totals.estimated_api_cost_usd)} API-equivalent (not a subscription invoice)`,
    `│ Dashboard   ${report.html}`,
    `│ Pricing     ${report.json}`,
    "╰─────────────────────────────────────────────────────────────────────────",
  ];
  for (const entry of [writer, ...analysts]) {
    const detail = report.report.nodes.find((node) => node.id === entry.id);
    const tokens = detail?.tokens;
    lines.push(
      "",
      `╭─ ${entry.id === "writer" ? "Writer · synthesis" : entry.id.replace("analyst_", "Analyst ")} · ${entry.state}`,
      `│ Model      ${entry.model}`,
      `│ Executor   ${detail?.executor || "—"} · ${detail?.attempts || 0} attempts`,
      `│ Time       ${formatDuration(detail?.duration_ms)}`,
      `│ Tokens     ${formatNumber(tokens?.total)} total · ${formatNumber(tokens?.input)} in · ${formatNumber(tokens?.output)} out · ${formatNumber(tokens?.reasoning)} reasoning · ${formatNumber(tokens?.cache_read)} cached`,
      `│ Est. cost  ${formatCost(detail?.estimated_api_cost_usd)} API-equivalent`,
    );
    if (entry.id === "writer") lines.push("├─ Answer", boxedText(writer.state === "succeeded" ? writer.text : `Synthesis unavailable: ${writer.error || writer.state}`));
    else if (entry.error) lines.push(boxedText(`Error: ${entry.error}`));
    lines.push("╰─────────────────────────────────────────────────────────────────────────");
  }
  if (answer) lines.push("", `Answer: ${answer}`);
  return lines.join("\n");
};

const runFuseCommand = async (argv) => {
  const parsed = parseFuseArgs(argv);
  if (parsed.help) return usage();
  const root = requireProjectRoot();
  const context = readOpinionContext(root, parsed.contextFiles);
  const outcome = await runFuse(root, { ...parsed, context }, { concurrency: parsed.concurrency ?? parsed.models.length });
  console.log(parsed.json ? JSON.stringify({ workflow: "fuse", task: parsed.task, models: parsed.models, ...outcome }, null, 2) : formatFuse(outcome));
  if (!outcome.result.ok) process.exitCode = 1;
};

export const run = (argv) => {
  if (argv[0] === "validate" && argv[1] === "report") return runReportCommand(argv.slice(2), "validate");
  if (argv[0] === "validate") return runValidateCommand(argv.slice(1));
  if (argv[0] === "debate" && argv[1] === "report") return runReportCommand(argv.slice(2), "debate");
  if (argv[0] === "debate") return runDebateCommand(argv.slice(1));
  if (argv[0] === "fuse" && argv[1] === "report") return runReportCommand(argv.slice(2), "fuse");
  if (argv[0] === "fuse") return runFuseCommand(argv.slice(1));
  if (argv[0] === "opinion" && argv[1] === "report") return runReportCommand(argv.slice(2), "opinion");
  if (argv[0] === "opinion") return runOpinionCommand(argv.slice(1));
  fail("usage: mind work <opinion|debate|fuse|validate> ...");
};
