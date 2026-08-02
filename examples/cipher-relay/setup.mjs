import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.join(here, "tools");

const manifest = (name, description, options = {}) => ({
  name,
  description,
  model: options.model || null,
  fallback_model: null,
  max_tokens: options.max_tokens ?? 12000,
  nestable: !!options.nestable,
  web: false,
  timeout_ms: options.timeout_ms ?? 120000,
  read_grants: [],
  write_grants: [],
  bash_allow: options.bash_allow || [],
  bash_only: !!options.bash_only,
  prompt_prefix: options.prompt_prefix || null,
  prompt_suffix: null,
  agents_md_override: null,
  skills_dir: null,
  opencode_provider: null,
  source: { type: "local", ref: null },
  created_at: new Date().toISOString(),
  created_from: "examples/cipher-relay",
});

const specialist = (name, description, script, acceptedPrefix) =>
  manifest(name, description, {
    bash_allow: [`node ${script} **`],
    bash_only: true,
    max_tokens: 30000,
    prompt_prefix:
      `You are an isolated transformation specialist. Accept only ${acceptedPrefix} or its typed HANDLE form. ` +
      `Run exactly this tool, passing the entire value as one quoted argument: node ${script} "<value>". ` +
      "In the bash tool call, omit workdir entirely; provide only command and timeout. " +
      "If a call is denied, retry the same command without workdir. " +
      "Return the tool stdout exactly, with no explanation, markdown, labels, or additional text. " +
      "Do not attempt any transformation yourself and do not invoke any other command.",
  });

export const setupCipherRelay = (root, { model = "opencode/deepseek-v4-flash-free" } = {}) => {
  const catalog = path.join(root, ".alters", "catalog");
  mkdirSync(catalog, { recursive: true });
  writeFileSync(
    path.join(root, ".alters", "config.json"),
    JSON.stringify(
      {
        default_model: model,
        max_depth: 4,
        run_timeout_ms: 300000,
        catalog_dir: "catalog",
        default_fallback_model: null,
        opencode_pure: true,
        opencode_event_log: true,
        retry: { same_harness_retries: 0, fallback_retries: 0 },
      },
      null,
      2
    ) + "\n"
  );
  const entries = [
    manifest("relay-router", "Routes an opaque cipher envelope through isolated transformation Alters.", {
      nestable: true,
      max_tokens: 24000,
      timeout_ms: 300000,
      prompt_prefix:
        "You are the relay coordinator. The prompt contains one typed HANDLE current value. Process it as a strict state machine. " +
        "For a handle ending :CIPHER:alpha, use the command tail spawn --catalog alpha-decryptor \"<current handle>\". " +
        "For a handle ending :CIPHER:beta, use spawn --catalog beta-decryptor \"<current handle>\". " +
        "For a handle ending :ENCODING:base64, use spawn --catalog base64-decoder \"<current handle>\". " +
        "For a handle ending :ENCODING:hex, use spawn --catalog hex-decoder \"<current handle>\". " +
        "For a handle ending :ENCODING:url, use spawn --catalog url-decoder \"<current handle>\". " +
        "Prepend the exact node-based mind CLI path from your AGENTS.md. The --catalog flag is mandatory. " +
        "Never substitute --name or --description and never create a generic child. " +
        "Give each child only the current value as its prompt, wait for it, and replace the current value with only its final stdout. " +
        "Never expand, alter, or invent a handle. Never decrypt or decode anything yourself. Never read specialist files. " +
        "Never send prior conversation or another child's details. " +
        "When the value starts with SECRET:, return it exactly and stop. Unknown prefixes are errors.",
    }),
    specialist(
      "alpha-decryptor",
      "Decrypts only alpha AES-GCM envelopes using its private tool.",
      path.join(tools, "decrypt-alpha.mjs"),
      "CIPHER:alpha:"
    ),
    specialist(
      "beta-decryptor",
      "Decrypts only beta AES-GCM envelopes using its private tool.",
      path.join(tools, "decrypt-beta.mjs"),
      "CIPHER:beta:"
    ),
    specialist(
      "base64-decoder",
      "Decodes only base64 relay values using its private tool.",
      path.join(tools, "decode-base64.mjs"),
      "ENCODING:base64:"
    ),
    specialist(
      "hex-decoder",
      "Decodes only hexadecimal relay values using its private tool.",
      path.join(tools, "decode-hex.mjs"),
      "ENCODING:hex:"
    ),
    specialist(
      "url-decoder",
      "Decodes only URL-encoded relay values using its private tool.",
      path.join(tools, "decode-url.mjs"),
      "ENCODING:url:"
    ),
  ];
  for (const entry of entries) {
    const dir = path.join(catalog, entry.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(entry, null, 2) + "\n");
  }
  return { root, model, catalog: entries.map((entry) => entry.name) };
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!root) throw new Error("usage: node setup.mjs <project-directory>");
  const output = setupCipherRelay(root, { model: process.env.MIND_DEMO_MODEL });
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}
