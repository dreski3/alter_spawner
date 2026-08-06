// The daemon is a loop over (mind, oscillation) pairs and nothing else: it reads the
// registry, and for each due oscillation calls core with that mind's root. It holds no
// state a rescan could not rebuild, which is what these tests are really checking — that
// and the two isolation properties that matter once N minds share one process: one mind's
// broken oscillation file must not end the tick, and one mind's slow cycle must not stop
// the others being ticked at all.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRuntime,
  createSpikeRunner,
  daemonPolicyPath,
  parseDuration,
  readRegistry,
  runDaemonTick,
  scanRegistry,
} from "../../src/index.js";

const FROZEN = Date.UTC(2026, 7, 6, 12, 0, 0);

const clock = (startMs = FROZEN) => {
  let ms = startMs;
  return { advance: (delta) => (ms += delta), runtime: () => createRuntime({ now: () => ms, env: {}, pid: 4242 }) };
};

const sandbox = () => {
  const base = mkdtempSync(path.join(tmpdir(), "mind-daemon-"));
  const workspace = path.join(base, "minds");
  mkdirSync(workspace, { recursive: true });
  return { base, workspace, env: { MIND_HOME: path.join(base, ".mind"), HOME: base } };
};

const mind = (workspace, name, agentId) => {
  const root = path.join(workspace, name);
  mkdirSync(path.join(root, ".alters", "oscillations"), { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify({ catalog_dir: "catalog", agent_id: agentId, name }),
  );
  return root;
};

const withOscillation = (root, id, body) => {
  writeFileSync(path.join(root, ".alters", "oscillations", `${id}.json`), JSON.stringify(body));
  return root;
};

const spikeSpy = () => {
  const calls = [];
  return {
    calls,
    runSpike: async ({ spike, root }) => {
      calls.push({ spike: spike.id, root });
      return { ok: true };
    },
  };
};

test("a tick fires every registered mind's due oscillations", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  const chronicler = withOscillation(mind(workspace, "chronicler", "a".repeat(32)), "metabolic", {
    band: "slow",
    spikes: [{ id: "scan", graph: "memory-maintenance" }],
  });
  const scribe = withOscillation(mind(workspace, "scribe", "b".repeat(32)), "curation", {
    band: "fast",
    spikes: [{ id: "curate", catalog: "curator" }],
  });
  await scanRegistry({ env, runtime: c.runtime() });

  const spy = spikeSpy();
  const tick = await runDaemonTick({ env, runtime: c.runtime(), runSpike: spy.runSpike });

  assert.equal(tick.fired, 2);
  assert.deepEqual(
    spy.calls.map((call) => [call.spike, call.root]).sort(),
    [["curate", scribe], ["scan", chronicler]].sort(),
  );
  assert.deepEqual(
    tick.minds.map((entry) => [entry.name, entry.oscillations.map((o) => o.action)]).sort(),
    [["chronicler", ["ran"]], ["scribe", ["ran"]]].sort(),
  );
});

test("a mind with no oscillations is simply quiet", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  mind(workspace, "silent", "a".repeat(32));
  await scanRegistry({ env, runtime: c.runtime() });

  const tick = await runDaemonTick({ env, runtime: c.runtime(), runSpike: spikeSpy().runSpike });
  assert.equal(tick.fired, 0);
  assert.deepEqual(tick.minds[0].oscillations, []);
  assert.equal(tick.minds[0].error, null);
});

test("an oscillation that is not due yet is left alone", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  withOscillation(mind(workspace, "chronicler", "a".repeat(32)), "metabolic", {
    period: "6h",
    spikes: [{ id: "scan", graph: "memory-maintenance" }],
  });
  await scanRegistry({ env, runtime: c.runtime() });

  const first = spikeSpy();
  assert.equal((await runDaemonTick({ env, runtime: c.runtime(), runSpike: first.runSpike })).fired, 1);

  c.advance(parseDuration("1h"));
  const second = spikeSpy();
  const tick = await runDaemonTick({ env, runtime: c.runtime(), runSpike: second.runSpike });
  assert.equal(tick.fired, 0);
  assert.deepEqual(second.calls, [], "not-due short-circuits before the refractory lock is even taken");
  assert.equal(tick.minds[0].oscillations[0].action, "not-due");
  assert.equal(tick.minds[0].oscillations[0].dueInMs, parseDuration("5h"));

  c.advance(parseDuration("5h"));
  assert.equal((await runDaemonTick({ env, runtime: c.runtime(), runSpike: spikeSpy().runSpike })).fired, 1);
});

test("a disabled oscillation never fires", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  withOscillation(mind(workspace, "chronicler", "a".repeat(32)), "metabolic", {
    enabled: false,
    spikes: [{ id: "scan", graph: "memory-maintenance" }],
  });
  await scanRegistry({ env, runtime: c.runtime() });

  const spy = spikeSpy();
  const tick = await runDaemonTick({ env, runtime: c.runtime(), runSpike: spy.runSpike });
  assert.equal(tick.minds[0].oscillations[0].action, "disabled");
  assert.deepEqual(spy.calls, []);
});

test("--dry-run reports what would fire and touches nothing", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  withOscillation(mind(workspace, "chronicler", "a".repeat(32)), "metabolic", {
    spikes: [{ id: "scan", graph: "memory-maintenance" }],
  });
  await scanRegistry({ env, runtime: c.runtime() });
  const lastSeenBefore = readRegistry(env).agents["a".repeat(32)].last_seen;

  const spy = spikeSpy();
  c.advance(parseDuration("1h"));
  const tick = await runDaemonTick({ env, runtime: c.runtime(), dryRun: true, runSpike: spy.runSpike });

  assert.equal(tick.minds[0].oscillations[0].action, "would-run");
  assert.deepEqual(spy.calls, []);
  assert.equal(readRegistry(env).agents["a".repeat(32)].last_seen, lastSeenBefore, "a dry run is not a sighting");
});

test("a real tick records the sighting", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  mind(workspace, "chronicler", "a".repeat(32));
  await scanRegistry({ env, runtime: c.runtime() });

  c.advance(parseDuration("2h"));
  await runDaemonTick({ env, runtime: c.runtime(), runSpike: spikeSpy().runSpike });
  assert.equal(readRegistry(env).agents["a".repeat(32)].last_seen, "2026-08-06T14:00:00.000Z");
});

test("one mind's broken oscillation file does not end the tick for the others", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  const broken = mind(workspace, "broken", "a".repeat(32));
  writeFileSync(path.join(broken, ".alters", "oscillations", "bad.json"), "{ not json");
  withOscillation(mind(workspace, "healthy", "b".repeat(32)), "metabolic", {
    spikes: [{ id: "scan", graph: "memory-maintenance" }],
  });
  await scanRegistry({ env, runtime: c.runtime() });

  const spy = spikeSpy();
  const tick = await runDaemonTick({ env, runtime: c.runtime(), runSpike: spy.runSpike });
  const byName = Object.fromEntries(tick.minds.map((entry) => [entry.name, entry]));
  assert.match(byName.broken.error, /bad\.json is not valid JSON/);
  assert.equal(byName.healthy.oscillations[0].action, "ran");
  assert.deepEqual(spy.calls.map((call) => call.spike), ["scan"]);
});

test("a slow mind does not stop the others from being ticked", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  const slow = withOscillation(mind(workspace, "slow", "a".repeat(32)), "metabolic", {
    spikes: [{ id: "grind", graph: "memory-maintenance" }],
  });
  withOscillation(mind(workspace, "quick", "b".repeat(32)), "metabolic", {
    spikes: [{ id: "dash", graph: "memory-maintenance" }],
  });
  await scanRegistry({ env, runtime: c.runtime() });

  let release = null;
  const finished = [];
  const tick = runDaemonTick({
    env,
    runtime: c.runtime(),
    runSpike: async ({ spike, root }) => {
      if (root === slow) await new Promise((resolve) => (release = resolve));
      finished.push(spike.id);
      return { ok: true };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finished, ["dash"], "the quick mind completed while the slow one was still blocked");
  release();
  await tick;
  assert.deepEqual(finished.sort(), ["dash", "grind"]);
});

test("--mind restricts the tick to one mind", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  withOscillation(mind(workspace, "chronicler", "a".repeat(32)), "metabolic", {
    spikes: [{ id: "scan", graph: "memory-maintenance" }],
  });
  withOscillation(mind(workspace, "scribe", "b".repeat(32)), "metabolic", {
    spikes: [{ id: "curate", catalog: "curator" }],
  });
  await scanRegistry({ env, runtime: c.runtime() });

  const spy = spikeSpy();
  const tick = await runDaemonTick({ env, runtime: c.runtime(), only: "scribe", runSpike: spy.runSpike });
  assert.equal(tick.minds.length, 1);
  assert.deepEqual(spy.calls.map((call) => call.spike), ["curate"]);
});

// The production spike runner end to end, against a mind with no catalog and no model:
// the planner graph fails, the maintenance run reports that rather than throwing, and the
// tick *finishes*. Not hanging is the property under test — a scheduled cycle that blocks
// holds its refractory lock forever, so the rhythm stops firing and the only symptom is a
// process that looks busy. The approval half of that guarantee is covered directly in
// capabilities.test.js ("an unattended session denies immediately").
test("the production spike runner completes a tick rather than blocking on it", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  const root = withOscillation(mind(workspace, "chronicler", "a".repeat(32)), "metabolic", {
    spikes: [{ id: "scan", graph: "memory-maintenance", options: { catalog: "memory-manager" } }],
  });
  await scanRegistry({ env, runtime: c.runtime() });

  const tick = await Promise.race([
    runDaemonTick({ env, runtime: c.runtime(), runSpike: createSpikeRunner(root, { runtime: c.runtime() }) }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("the tick never returned")), 8000)),
  ]);

  const spike = tick.minds[0].oscillations[0].spikes[0];
  assert.equal(spike.result.ok, false, "the planner could not run in this bare root");
  assert.equal(spike.result.committed, false, "so nothing was committed to memory");
  // Unattended grants are per-mind and separate from the host's interactive policy on
  // purpose: approving a memory write once, with a card in front of you, is not the same
  // act as authorizing a rhythm to do it every six hours while you sleep.
  assert.equal(daemonPolicyPath(root), path.join(root, ".alters", "state", "daemon-policy.json"));
});

test("an unknown builtin graph fails the spike with the available names", async () => {
  const { env, workspace } = sandbox();
  const c = clock();
  const root = withOscillation(mind(workspace, "chronicler", "a".repeat(32)), "metabolic", {
    spikes: [{ id: "scan", graph: "no-such-graph" }],
  });
  await scanRegistry({ env, runtime: c.runtime() });

  const tick = await runDaemonTick({
    env,
    runtime: c.runtime(),
    runSpike: createSpikeRunner(root, { runtime: c.runtime() }),
  });
  const spike = tick.minds[0].oscillations[0].spikes[0];
  assert.equal(spike.state, "error");
  assert.match(spike.error, /unknown builtin graph no-such-graph \(available: memory-maintenance\)/);
});
