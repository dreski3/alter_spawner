import { createCapabilityRegistry } from "./capabilities.js";
import { deleteRunCleanupCandidates, inspectRunCleanup } from "./run-maintenance.js";

export const RUN_MAINTENANCE_CAPABILITIES = Object.freeze(["runs.maintenance.delete"]);

export const DEFAULT_RUN_CATALOG_CAPABILITIES = Object.freeze({
  "run-manager": Object.freeze(["runs.maintenance.inspect", "runs.maintenance.delete"]),
});

export const createRunCapabilityDefinitions = ({ root } = {}) => {
  if (typeof root !== "string" || !root) throw new Error("run capabilities require a project root");
  return [
    {
      id: "runs.maintenance.inspect",
      name: "Inspect run cleanup candidates",
      description: "Returns a bounded list of completed, unreferenced run folders eligible under a retention policy.",
      risk: "medium",
      approval: "always",
      executorVersion: "run-maintenance-inspect-v1",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          olderThanDays: { type: "integer", minimum: 0, maximum: 36500 },
          keepNewest: { type: "integer", minimum: 0, maximum: 100000 },
          includeFailed: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 5000 },
        },
      },
      approvalPreview: (input) => ({ operation: "inspect-run-cleanup", policy: input }),
      handler: async ({ input, signal }) => {
        if (signal?.aborted) throw new Error("Capability execution cancelled.");
        return inspectRunCleanup(root, input);
      },
    },
    {
      id: "runs.maintenance.delete",
      name: "Delete historical runs",
      description: "Permanently deletes an exact list of completed, unreferenced run folders.",
      risk: "high",
      approval: "always",
      allowedDecisions: ["allow-once", "deny"],
      executorVersion: "run-maintenance-delete-v1",
      inputSchema: {
        type: "object",
        required: ["folders"],
        additionalProperties: false,
        properties: {
          folders: { type: "array", minItems: 1, maxItems: 5000, items: { type: "string", minLength: 1, maxLength: 300 } },
        },
      },
      approvalPreview: ({ folders }) => ({ operation: "delete-runs", count: folders.length, folders }),
      handler: async ({ input, signal }) => {
        if (signal?.aborted) throw new Error("Capability execution cancelled.");
        return deleteRunCleanupCandidates(root, input.folders);
      },
    },
  ];
};

export const createRunCapabilityRegistry = ({ root, catalogCapabilities = DEFAULT_RUN_CATALOG_CAPABILITIES } = {}) =>
  createCapabilityRegistry({ definitions: createRunCapabilityDefinitions({ root }), catalogCapabilities });
