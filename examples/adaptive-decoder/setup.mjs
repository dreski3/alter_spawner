import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADAPTIVE_DECODER_TOOL = path.join(here, "tools", "decode-caesar.mjs");
export const ADAPTIVE_CLI_ENTRY = path.resolve(here, "../../packages/cli/src/index.js");

export const setupAdaptiveDecoder = (root, { model = "opencode/deepseek-v4-flash-free" } = {}) => {
  const catalog = path.join(root, ".alters", "catalog");
  const router = path.join(catalog, "adaptive-router");
  mkdirSync(router, { recursive: true });
  writeFileSync(path.join(root, ".alters", "config.json"), JSON.stringify({
    default_model: model,
    max_depth: 4,
    run_timeout_ms: 300000,
    catalog_dir: "catalog",
    default_fallback_model: null,
    opencode_pure: true,
    opencode_event_log: true,
    retry: { same_harness_retries: 0, fallback_retries: 0 },
  }, null, 2) + "\n");
  writeFileSync(path.join(router, "manifest.json"), JSON.stringify({
    name: "adaptive-router",
    description: "Creates a missing decoder Alter definition and delegates an opaque cipher to it.",
    model,
    fallback_model: null,
    max_tokens: 80000,
    nestable: true,
    web: false,
    timeout_ms: 300000,
    read_grants: [],
    write_grants: [],
    bash_allow: [],
    bash_only: false,
    output_contract: { type: "prefix", value: "SECRET:" },
    prompt_prefix:
      `No current catalog Alter can decode CIPHER:caesar-* values. An approved deterministic decoder exists at ${ADAPTIVE_DECODER_TOOL}. ` +
      "Do not inspect files, load skills, or try to decode it yourself. Adapt by issuing exactly two bash calls. First issue: " +
      `node ${ADAPTIVE_CLI_ENTRY} catalog save caesar-decoder --description "Deterministic Caesar decoder" --bash-only ` +
      `--bash-allow "node ${ADAPTIVE_DECODER_TOOL} **" ` +
      `--prompt-prefix "Run node ${ADAPTIVE_DECODER_TOOL} with the entire CIPHER value as one quoted argument and return stdout exactly." ` +
      "--output-prefix " + '"SECRET:". ' +
      `Second issue: node ${ADAPTIVE_CLI_ENTRY} spawn --catalog caesar-decoder "<the exact CIPHER value from the user prompt>". ` +
      "Return only that second command's SECRET stdout.",
    prompt_suffix: null,
    opencode_provider: null,
    source: { type: "local", ref: null },
    created_at: new Date().toISOString(),
    created_from: "examples/adaptive-decoder",
  }, null, 2) + "\n");
  return { root, model, initial_catalog: ["adaptive-router"], decoder_tool: ADAPTIVE_DECODER_TOOL };
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!root) throw new Error("usage: node setup.mjs <project-directory>");
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  process.stdout.write(JSON.stringify(setupAdaptiveDecoder(root, { model: process.env.MIND_DEMO_MODEL }), null, 2) + "\n");
}
