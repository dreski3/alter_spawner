import { readFileSync } from "node:fs";
import path from "node:path";
import { yq } from "./util.js";
import { TEMPLATE_AGENT, TEMPLATE_AGENTS_MD } from "./paths.js";

// Only a nestable Alter can ever run `mind spawn`, so only a nestable Alter
// needs to be told the spawn-graph mechanics exist. A leaf Alter (the common
// case — most catalog entries are single-purpose workers) gets none of this:
// less boilerplate in its context, and no `alter` skill listed for it to be
// tempted by.
// The exact literal example below matters: the two failure modes seen in
// practice are (1) a model assuming the bare `mind` command works and giving
// up when it "seems blocked" (it isn't on PATH — only `node <mindBinPath>` is
// an allowed bash pattern), and (2) a model quoting the whole invocation as
// one shell string, so `process.argv[2]` is never literally `spawn`. Spelling
// out the real, resolved path and warning about word-splitting directly
// addresses both instead of leaving the model to reconstruct this from the
// flag reference alone.
// A bounded search space is worth stating in context, not just enforcing on
// disk: told exactly which catalog entries exist, a model delegates to one of
// them instead of guessing names that were never copied into its home and
// burning turns on `catalog entry not found`.
const catalogScopeBlock = (allowedCatalogs) => {
  if (allowedCatalogs == null) return "";
  if (allowedCatalogs.length === 0) {
    return `

Your parent granted you **no catalog entries**: \`--catalog <name>\` will not
resolve for any name. Spawn ad-hoc children with \`--name\`/\`--description\`
only, or solve the task yourself.`;
  }
  return `

Your parent narrowed the catalog you may spawn from to exactly:
${allowedCatalogs.map((name) => `- \`${name}\``).join("\n")}

No other catalog entry exists in your home — \`--catalog\` with any other name
will fail to resolve. Delegate within this set or solve the task yourself.`;
};

const nestingBlock = (mindBinPath) => `

## Spawning child Alters
You were spawned as **nestable**: you have a tightly scoped shell that allows
exactly one command form — \`node ${mindBinPath} ...\`. The bare \`mind\` command
is **not** on your PATH and is **not** what your permission rule allows; using
it will be denied. A worked, copy-pasteable example:

\`\`\`bash
node ${mindBinPath} spawn --name prefilter --description "cleans up the raw input" "<task prompt>"
\`\`\`

Pass each flag and value as its own shell word. Do **not** wrap the whole
invocation (e.g. \`"spawn --name prefilter ... <task prompt>"\`) inside a single
quoted string — that makes \`spawn\` part of one opaque argument instead of the
literal first word the CLI expects, and it will fail with a usage dump instead
of running. Load the \`alter\` skill for the full flag reference. You may spawn
children to prefilter a prompt, split work, or run isolated sub-tasks; children
are sandboxed exactly like you.`;

const applyPlaceholders = (tmpl, o) => {
  const role = o.description && o.description.trim()
    ? `## Your role\n${o.description.trim()}`
    : `## Your role\nYou are a general-purpose Alter. Perform the task you were given as well as you can.`;
  let out = tmpl.replace(/\{\{ROLE_BLOCK\}\}/g, role);
  out = out.replace(
    /\n?\{\{NESTING_BLOCK\}\}/g,
    o.nestable ? nestingBlock(o.mindBinPath) + catalogScopeBlock(o.allowedCatalogs) : "",
  );
  return out;
};

// Bash access is deny-by-default and only ever opened by exact, explicit
// patterns — never a blanket allow. Two independent sources can add patterns:
//   - `nestable`: scoped to exactly the resolved, absolute path of the `mind`
//     CLI entrypoint that spawned it (`o.mindBinPath`), so it can only ever
//     spawn/manage Alters, never run arbitrary shell.
//   - `o.bashAllow`: catalog- or flag-declared literal command patterns
//     (e.g. `"python3 /abs/path/cipher.py **"`), for Alters whose catalog
//     entry needs to shell out to one specific deterministic script instead
//     of paying for an inference call. These two are independent: an Alter
//     can be nestable, have bash_allow, both, or neither.
const bashAllowRules = (o) => {
  const rules = [];
  if (o.nestable) {
    rules.push(`${yq(`node ${o.mindBinPath} **`)}: allow`);
    rules.push(`${yq(`node ${o.mindBinPath}`)}: allow`);
  }
  for (const pattern of o.bashAllow || []) {
    rules.push(`${yq(pattern)}: allow`);
  }
  return rules;
};

export const buildFrontmatter = (o) => {
  const L = [];
  L.push("---");
  L.push(`description: ${yq(o.description || "Single-use sandboxed Alter.")}`);
  L.push("mode: all");
  if (o.model) L.push(`model: ${o.model}`);
  L.push("permission:");
  L.push(o.bashOnly ? "  read: deny" : "  read: allow");
  L.push(o.bashOnly ? "  glob: deny" : "  glob: allow");
  L.push(o.bashOnly ? "  grep: deny" : "  grep: allow");
  L.push(o.bashOnly ? "  skill: deny" : "  skill: allow");
  L.push("  edit:");
  L.push(`    "**": ${o.bashOnly ? "deny" : "allow"}`);
  const readDirs = o.readGrants;
  const writeDirs = o.writeGrants;
  for (const d of readDirs) {
    L.push(`    ${yq(d + "/**")}: deny`);
    L.push(`    ${yq(d + "/*")}: deny`);
    L.push(`    ${yq(d)}: deny`);
  }
  for (const d of writeDirs) {
    L.push(`    ${yq(d + "/**")}: allow`);
    L.push(`    ${yq(d + "/*")}: allow`);
    L.push(`    ${yq(d)}: allow`);
  }
  L.push("  write:");
  L.push(`    "**": ${o.bashOnly ? "deny" : "allow"}`);
  const bashRules = bashAllowRules(o);
  if (bashRules.length) {
    L.push("  bash:");
    L.push(`    ${yq("*")}: deny`);
    for (const r of bashRules) L.push("    " + r);
  } else {
    L.push("  bash: deny");
  }
  L.push(o.webAccess ? "  webfetch: allow" : "  webfetch: deny");
  L.push(o.webAccess ? "  websearch: allow" : "  websearch: deny");
  L.push("  task: deny");
  L.push("  todowrite: deny");
  L.push("  question: deny");
  L.push("  external_directory:");
  const grantDirs = [...readDirs, ...writeDirs];
  if (grantDirs.length === 0) {
    L.push('    "**": deny');
  } else {
    L.push('    "**": deny');
    const seen = new Set();
    for (const d of grantDirs) {
      for (const pat of [d, d + "/*", d + "/**"]) {
        if (seen.has(pat)) continue;
        seen.add(pat);
        L.push(`    ${yq(pat)}: allow`);
      }
    }
  }
  L.push("---");
  return L.join("\n");
};

export const buildBody = (o) => {
  let tmpl = "";
  const overridePath =
    o.catalogEntryDir && o.catalogAgentsOverride
      ? path.join(o.catalogEntryDir, o.catalogAgentsOverride)
      : null;
  try {
    tmpl = readFileSync(overridePath || TEMPLATE_AGENT, "utf8");
  } catch {
    tmpl = "{{ROLE_BLOCK}}";
  }
  const idx = tmpl.indexOf("\n---\n");
  const body = idx >= 0 ? tmpl.slice(idx + 5) : tmpl;
  return applyPlaceholders(body, o).trimStart();
};

export const buildAgentsMd = (o) => {
  let tmpl;
  try {
    tmpl = readFileSync(TEMPLATE_AGENTS_MD, "utf8");
  } catch {
    tmpl = "";
  }
  return applyPlaceholders(tmpl, o);
};
