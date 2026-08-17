import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  activateNetworkRelease,
  applyNetworkDefinition,
  createRuntime,
  listNetworkReleases,
  listNetworkVersions,
  readActiveNetworkRelease,
  readNetworkDefinition,
  validateNetworkDefinition,
} from "../../src/index.js";

const root = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "mind-network-"));
  mkdirSync(path.join(directory, ".alters"));
  return directory;
};

const definition = () => ({
  id: "smallville-npc",
  name: "Smallville NPC",
  description: "An event-driven NPC network.",
  ego: { enabled: true, catalog: "ego", contextual: true, input_events: ["operator.message", "npc.message"] },
  interfaces: [{
    id: "smallville",
    name: "Smallville",
    observations: ["world.observation", "npc.message"],
    actions: ["smallville.action.execute"],
  }],
  components: [
    {
      id: "perception",
      role: "sensory",
      catalog: "perception",
      triggers: [{ type: "event", event: "world.observation" }],
      emits: ["perception.updated"],
      refractory: "2s",
      budget: { max_tokens: 800, max_runs_per_hour: 120 },
    },
    {
      id: "reflection",
      role: "internal",
      graph: "reflect",
      triggers: [{ type: "oscillation", oscillation: "reflection-clock" }],
      emits: ["plan.proposed"],
    },
    {
      id: "world-action",
      role: "active",
      capability: "smallville.action.execute",
      triggers: [{ type: "event", event: "plan.proposed" }],
    },
  ],
});

test("validates roles, targets, triggers, and known runtime references", () => {
  const result = validateNetworkDefinition(definition(), {
    known: {
      catalogs: ["ego", "perception"],
      graphs: ["reflect"],
      oscillations: ["reflection-clock"],
      capabilities: ["smallville.action.execute"],
    },
  });
  assert.equal(result.schema_version, 1);
  assert.equal(result.components[0].role, "sensory");
  assert.throws(
    () => validateNetworkDefinition({ ...definition(), components: [{ id: "bad", role: "active", catalog: "ego", triggers: [{ type: "manual" }] }] }),
    /active component "bad" must target a host capability/,
  );
  assert.throws(
    () => validateNetworkDefinition({ ...definition(), interfaces: [] }),
    /sensory component "perception" must consume an observation declared by an interface/,
  );
  assert.throws(
    () => validateNetworkDefinition(definition(), { known: { catalogs: ["ego", "perception"], graphs: [] } }),
    /references unknown reflect/,
  );
});

test("applies immutable revisions and rejects stale writes", () => {
  const directory = root();
  const runtime = createRuntime({ now: () => Date.UTC(2026, 7, 15, 20, 0, 0) });
  const first = applyNetworkDefinition(directory, definition(), { expectedRevision: 0, runtime });
  assert.equal(first.revision, 1);
  assert.equal(readNetworkDefinition(directory).ego.catalog, "ego");

  const second = applyNetworkDefinition(directory, { ...definition(), name: "Smallville Resident" }, { expectedRevision: 1, runtime });
  assert.equal(second.revision, 2);
  assert.deepEqual(listNetworkVersions(directory).map((entry) => entry.revision), [1, 2]);
  assert.throws(() => applyNetworkDefinition(directory, definition(), { expectedRevision: 1 }), /expected 1, found 2/);
});

test("network releases snapshot the definition and runtime inventory", () => {
  const directory = root();
  const known = {
    catalogs: ["perception", "ego"],
    graphs: ["reflect"],
    oscillations: ["reflection-clock"],
    capabilities: ["smallville.action.execute"],
  };
  const release = activateNetworkRelease(directory, definition(), {
    expectedRevision: 0,
    known,
    reconciliation: { operations: [{ kind: "create", resource: "network", id: "smallville-npc" }] },
    checks: [{ id: "references", status: "pass" }],
    resources: { catalogs: [{ id: "perception" }], oscillations: [] },
    runtime: createRuntime({ now: () => Date.UTC(2026, 7, 15, 20, 0, 0) }),
  });
  assert.equal(release.release_id, "release-000001");
  assert.equal(release.network.revision, 1);
  assert.deepEqual(release.inventory.catalogs, ["ego", "perception"]);
  assert.equal(release.resources.catalogs[0].id, "perception");
  assert.equal(listNetworkReleases(directory).length, 1);
  assert.equal(readActiveNetworkRelease(directory).release_id, "release-000001");
});
