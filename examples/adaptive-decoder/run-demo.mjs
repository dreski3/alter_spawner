import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSpawnOptions, spawnAlter } from "../../packages/core/src/index.js";
import { makeAdaptiveFixture } from "./fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(here, "../../packages/cli/src/index.js");
const root = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!root) throw new Error("usage: node run-demo.mjs <project-directory>");

const fixture = makeAdaptiveFixture(process.env.MIND_ADAPTIVE_SECRET || "frameworks-can-adapt");
const spawned = await spawnAlter(root, createSpawnOptions({
  name: "adaptive-relay",
  catalog: "adaptive-router",
  prompt: `Decode this message and return only its secret:\n${fixture.input}`,
  mindBinPath: cliEntry,
}));
const dynamicManifest = path.join(spawned.home, ".alters", "catalog", "caesar-decoder", "manifest.json");
const childRuns = path.join(spawned.home, ".alters", "runs");
const children = existsSync(childRuns)
  ? readdirSync(childRuns)
      .filter((entry) => !entry.startsWith("."))
      .map((entry) => {
        const resultPath = path.join(childRuns, entry, "result.json");
        return {
          folder: entry,
          result: existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null,
        };
      })
  : [];
const childTokens = children.reduce((total, child) => total + (child.result?.tokens?.total || 0), 0);
const audit = {
  ok:
    spawned.result.ok &&
    spawned.result.text.trim() === fixture.expected &&
    existsSync(dynamicManifest) &&
    children.some((child) => child.result?.catalog === "caesar-decoder" && child.result?.ok),
  expected: fixture.expected,
  actual: spawned.result.text.trim(),
  dynamic_catalog_created: existsSync(dynamicManifest),
  dynamic_manifest: existsSync(dynamicManifest) ? JSON.parse(readFileSync(dynamicManifest, "utf8")) : null,
  child_runs: children.map((child) => ({
    folder: child.folder,
    id: child.result?.id || null,
    ok: child.result?.ok || false,
    model: child.result?.model || null,
    tokens: child.result?.tokens || null,
    steps: child.result?.steps || 0,
    duration_ms: child.result?.duration_ms || null,
  })),
  parent_tokens: spawned.result.tokens,
  total_tokens: spawned.result.tokens.total + childTokens,
  parent_attempts: spawned.result.attempts?.length || 0,
  parent_steps: spawned.result.steps,
  wall_time_ms: spawned.result.duration_ms,
  home: spawned.home,
};
process.stdout.write(JSON.stringify(audit, null, 2) + "\n");
if (!audit.ok) process.exitCode = 1;
