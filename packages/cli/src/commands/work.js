import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fail, requireProjectRoot, runOpinion } from "@mind/core";

const MAX_CONTEXT_FILES = 8;
const MAX_CONTEXT_FILE_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 128 * 1024;

const usage = () => {
  console.error("usage: mind work opinion --model <provider/model> --model <provider/model> [--model <provider/model> ...]");
  console.error("                         [--context <file>]* [--max-tokens <n>] [--concurrency <n>] [--json] <task>");
  console.error("");
  console.error("  Runs 2-5 isolated, tool-free reviewers in parallel. Context files must be regular files inside the mind project.");
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

export const formatOpinions = ({ home, result, opinions }) => {
  const lines = [
    `opinion graph: ${home}`,
    `status: ${result.node_counts.succeeded}/${result.node_counts.total} completed; ${result.tokens.total} tokens`,
  ];
  for (const opinion of opinions) {
    lines.push("", `## ${opinion.model} (${opinion.state})`, opinion.text || `Error: ${opinion.error || "no output"}`);
  }
  return lines.join("\n");
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
  if (argv[0] === "opinion") return runOpinionCommand(argv.slice(1));
  fail("usage: mind work opinion ...");
};
