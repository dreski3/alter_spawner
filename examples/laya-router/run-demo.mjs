import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createCapabilityRegistry,
  createFunctionExecutor,
  HARNESS_ADAPTERS,
  registerHarness,
  runNetworkRoute,
} from "../../packages/core/src/index.js";
import { setupLayaRouter } from "./setup.mjs";

const textSchema = {
  type: "object",
  required: ["text"],
  additionalProperties: false,
  properties: { text: { type: "string" } },
};

export const createDemoRegistry = (calls = []) => createCapabilityRegistry({
  definitions: [
    ...["billing", "technical", "sales"].map((name) => ({
      id: `demo.${name}`,
      name: `${name} worker`,
      description: `Handle a ${name} request`,
      approval: "never",
      inputSchema: textSchema,
      handler: ({ input }) => {
        calls.push({ target: name, payload: input.text });
        return `${name}: ${input.text}`;
      },
    })),
    {
      id: "demo.uppercase",
      name: "Uppercase",
      description: "Convert text to uppercase",
      approval: "never",
      inputSchema: textSchema,
      handler: ({ input }) => {
        calls.push({ target: "uppercase-tool", payload: input.text });
        return input.text.toUpperCase();
      },
    },
  ],
});

export const runLayaRouterDemo = async (root, {
  routingSignal = "The customer was billed twice and requests a refund.",
  payload = "Please refund the duplicate charge of 25 euros.",
  advisers = {},
} = {}) => {
  const calls = [];
  const registry = createDemoRegistry(calls);
  const previous = HARNESS_ADAPTERS.get("function");
  registerHarness("function", createFunctionExecutor({ registry }));
  try {
    const run = await runNetworkRoute(root, {
      routerId: "router",
      routingSignal,
      payload,
      advisers,
      capabilityRegistry: registry,
    });
    return { ...run, calls };
  } finally {
    if (previous) HARNESS_ADAPTERS.set("function", previous);
    else HARNESS_ADAPTERS.delete("function");
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : mkdtempSync(path.join(tmpdir(), "mind-laya-router-"));
  setupLayaRouter(root);
  const run = await runLayaRouterDemo(root, {
    routingSignal: process.argv[3] || undefined,
    payload: process.argv[4] || undefined,
  });
  process.stdout.write(JSON.stringify({
    root,
    ok: run.result.ok,
    route: run.decision.selected_route_id,
    child: run.decision.child_component_id,
    result: run.result.text,
    decision: run.decision,
  }, null, 2) + "\n");
  if (!run.result.ok) process.exitCode = 1;
}
