import { runAlterGraph } from "./graph.js";
import { writeOpinionReport } from "./opinion-report.js";
import { fail } from "./util.js";

export const validateModels = (models, workflow = "opinion") => {
  if (!Array.isArray(models) || models.length < 2 || models.length > 5) {
    fail(`${workflow} requires between 2 and 5 models.`);
  }
  if (models.some((model) => {
    if (typeof model !== "string") return true;
    const normalized = model.trim();
    const slash = normalized.indexOf("/");
    return !normalized || slash <= 0 || slash === normalized.length - 1;
  })) {
    fail(`${workflow} models must be non-empty provider/model strings.`);
  }
  const normalized = models.map((model) => model.trim());
  if (new Set(normalized).size !== normalized.length) fail(`${workflow} models must be distinct.`);
  return normalized;
};

const validateMaxTokens = (maxTokens) => {
  if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
    fail("opinion maxTokens must be a positive integer or null.");
  }
  return maxTokens;
};

const validateTask = (task) => {
  if (typeof task !== "string" || !task.trim()) fail("opinion requires a task.");
  return task.trim();
};

export const buildOpinionGraph = ({ task, models, context = "", maxTokens = null } = {}) => {
  const prompt = [
    "Give an independent engineering opinion using only the task and supplied context.",
    "Do not claim to have inspected files, run commands, changed anything, or consulted sources that are not in the context.",
    "State your recommendation, key evidence, risks, and the most useful next validation.",
    "",
    "## Task",
    validateTask(task),
    ...(context ? ["", "## Supplied context", context] : []),
  ].join("\n");
  return {
    id: "opinion",
    nodes: validateModels(models).map((model, index) => ({
      id: `opinion_${index + 1}`,
      description: "Independent read-only engineering reviewer.",
      model,
      prompt,
      textOnly: true,
      maxTokens: validateMaxTokens(maxTokens),
    })),
  };
};

export const runOpinion = async (root, options, runOptions = {}) => {
  const models = validateModels(options?.models);
  const graph = buildOpinionGraph({ ...options, models });
  const { home, result } = await runAlterGraph(root, graph, {
    ...runOptions,
    concurrency: runOptions.concurrency ?? models.length,
  });
  const report = writeOpinionReport(home, result, { env: runOptions.env });
  return {
    home,
    result,
    report,
    opinions: models.map((model, index) => {
      const node = result.nodes[`opinion_${index + 1}`];
      return { model, state: node.state, text: node.result?.text || null, error: node.error || null };
    }),
  };
};
