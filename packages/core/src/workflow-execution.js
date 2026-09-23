import { resolveDirectLlmEndpoint } from "./providers.js";
import { createRuntime } from "./runtime.js";
import { startWorkflowOpenCodeServer } from "./opencode-server.js";

// Workflow research/synthesis nodes are deliberately tool-free. When their model can
// be reached with the lightweight executor, prefer it: independent HTTP requests can
// overlap without making several OpenCode processes contend for its shared SQLite
// database. OAuth and unsupported provider protocols stay on OpenCode.
const directEligible = (node) =>
  node?.textOnly === true &&
  typeof node.model === "string" &&
  !node.catalog &&
  !node.capability &&
  !node.nestable &&
  !node.webAccess &&
  !node.bashOnly &&
  !(node.bashAllow?.length) &&
  !(node.readGrants?.length) &&
  !(node.writeGrants?.length);

export const selectWorkflowExecutors = (
  graph,
  {
    env = process.env,
    providers = {},
    resolveDirect = (model, environment, configuredProviders) =>
      resolveDirectLlmEndpoint(model, { env: environment, providers: configuredProviders }),
  } = {},
) => ({
  ...graph,
  nodes: graph.nodes.map((node) => {
    if (node.executor != null || !directEligible(node)) return node;
    try {
      resolveDirect(node.model, env, providers);
      return { ...node, executor: "llm" };
    } catch {
      return { ...node, executor: "opencode" };
    }
  }),
});

// OpenCode 1.18 uses one shared SQLite store. Its connection has no busy wait, so
// concurrent `opencode run` writers fail immediately with "database is locked".
// Direct LLM calls remain bounded only by the graph's overall concurrency.
export const WORKFLOW_EXECUTOR_CONCURRENCY = Object.freeze({ opencode: 1 });

export const prepareWorkflowConcurrency = async (
  graph,
  runOptions = {},
  { startServer = startWorkflowOpenCodeServer } = {},
) => {
  const opencodeNodes = graph.nodes.filter((node) => node.executor === "opencode").length;
  const baseEnvironment = runOptions.runtime?.env || process.env;
  const explicitLanes = runOptions.executorConcurrency != null;
  let server = null;
  let environment = baseEnvironment;

  if (opencodeNodes > 1 && runOptions.concurrency !== 1 && !baseEnvironment.OPENCODE_SERVER_URL) {
    try {
      server = await startServer({ environment: baseEnvironment });
      environment = server.environment;
    } catch (error) {
      process.stderr.write(`(mind workflow) OpenCode server unavailable; serializing OpenCode nodes: ${error?.message || error}\n`);
    }
  }

  const attached = Boolean(environment.OPENCODE_SERVER_URL);
  const executorConcurrency = explicitLanes
    ? runOptions.executorConcurrency
    : { ...WORKFLOW_EXECUTOR_CONCURRENCY, ...(attached ? { opencode: opencodeNodes } : {}) };
  const runtime = runOptions.runtime
    ? { ...runOptions.runtime, env: environment }
    : createRuntime({ env: environment });

  return {
    options: { ...runOptions, runtime, executorConcurrency },
    stop: () => server?.stop() || Promise.resolve(),
  };
};
