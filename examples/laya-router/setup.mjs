import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyNetworkDefinition } from "../../packages/core/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const setupLayaRouter = (root, {
  python = process.env.LAYA_MLX_PYTHON,
  modelDir = process.env.LAYA_MLX_MODEL_DIR,
} = {}) => {
  if (Boolean(python) !== Boolean(modelDir)) throw new Error("provide both LAYA_MLX_PYTHON and LAYA_MLX_MODEL_DIR");
  const kit = path.join(root, ".alters");
  mkdirSync(kit, { recursive: true });
  cpSync(path.join(here, "catalog"), path.join(kit, "catalog"), { recursive: true });
  writeFileSync(path.join(kit, "config.json"), JSON.stringify({
    default_model: "demo/none",
    max_depth: 3,
    max_tree_nodes: 2,
    max_concurrent_alters: 1,
    run_timeout_ms: 120000,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
    ...(python ? { decision_advisers: { "laya-mlx": { python, model_dir: modelDir, timeout_ms: 60000 } } } : {}),
  }, null, 2) + "\n");
  const network = JSON.parse(readFileSync(path.join(here, "network.json"), "utf8"));
  return applyNetworkDefinition(root, network, {
    known: {
      catalogs: ["principal", "router", "billing", "technical", "sales"],
      capabilities: ["demo.billing", "demo.technical", "demo.sales", "demo.uppercase"],
    },
  });
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!root) throw new Error("usage: node examples/laya-router/setup.mjs <project-directory>");
  const network = setupLayaRouter(root);
  process.stdout.write(`Network ${network.id} revision ${network.revision} created in ${root}\n`);
}
