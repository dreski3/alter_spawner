import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAlterGraph } from "@mind/core";

const LIVE = process.env.MIND_LIVE_PROVIDER_TESTS === "1";

test(
  "catalog Alters call multiple real OpenCode providers in one chain",
  { skip: !LIVE && "set MIND_LIVE_PROVIDER_TESTS=1 and MIND_LIVE_PROVIDER_MATRIX to run" },
  async (t) => {
    const matrix = JSON.parse(process.env.MIND_LIVE_PROVIDER_MATRIX || "[]");
    assert.ok(matrix.length >= 2, "MIND_LIVE_PROVIDER_MATRIX must contain at least two provider entries");
    assert.ok(
      new Set(matrix.map((entry) => entry.model.split("/")[0])).size >= 2,
      "the live matrix must use at least two distinct provider IDs"
    );
    const root = mkdtempSync(path.join(os.tmpdir(), "mind-live-providers-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, ".alters", "catalog"), { recursive: true });
    writeFileSync(
      path.join(root, ".alters", "config.json"),
      JSON.stringify({
        default_model: matrix[0].model,
        run_timeout_ms: 120000,
        retry: { same_harness_retries: 0, fallback_retries: 0 },
      })
    );
    for (let index = 0; index < matrix.length; index++) {
      const entry = matrix[index];
      const name = `provider-${index + 1}`;
      const dir = path.join(root, ".alters", "catalog", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          name,
          description: `Live routing probe for ${entry.model}`,
          model: entry.model,
          opencode_provider: entry.opencode_provider || null,
        })
      );
    }
    const nodes = matrix.map((entry, index) => {
      const id = `provider_${index + 1}`;
      if (index === 0) {
        return { id, catalog: `provider-${index + 1}`, prompt: "Reply with exactly ROUTE-1." };
      }
      const previous = `provider_${index}`;
      return {
        id,
        catalog: `provider-${index + 1}`,
        depends_on: [previous],
        prompt: `The previous provider returned {{result:${previous}}}. Reply with exactly ROUTE-${index + 1}.`,
      };
    });
    const { result } = await runAlterGraph(root, {
      id: "live-provider-routing",
      output: nodes[nodes.length - 1].id,
      nodes,
    });
    assert.equal(result.ok, true);
    assert.match(result.output, new RegExp(`ROUTE-${matrix.length}`));
    for (let index = 0; index < matrix.length; index++) {
      assert.equal(result.nodes[`provider_${index + 1}`].result.model, matrix[index].model);
    }
  }
);

