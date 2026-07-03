import { readFileSync } from "node:fs";
import path from "node:path";
import { yq } from "./util.js";
import { TEMPLATE_AGENT, TEMPLATE_AGENTS_MD } from "./paths.js";

// Only a nestable Alter can ever run `mind spawn`, so only a nestable Alter
// needs to be told the spawn-graph mechanics exist. A leaf Alter (the common
// case — most catalog entries are single-purpose workers) gets none of this:
// less boilerplate in its context, and no `alter` skill listed for it to be
// tempted by.
const NESTING_BLOCK = `

## Spawning child Alters
You were spawned as **nestable**: you have a tightly scoped shell that can run
only the Alter spawner (\`mind spawn ...\`). Load the \`alter\` skill for the
full reference. You may spawn children to prefilter a prompt, split work, or
run isolated sub-tasks; children are sandboxed exactly like you.`;

const applyPlaceholders = (tmpl, o) => {
  const role = o.description && o.description.trim()
    ? `## Your role\n${o.description.trim()}`
    : `## Your role\nYou are a general-purpose Alter. Perform the task you were given as well as you can.`;
  let out = tmpl.replace(/\{\{ROLE_BLOCK\}\}/g, role);
  out = out.replace(/\n?\{\{NESTING_BLOCK\}\}/g, o.nestable ? NESTING_BLOCK : "");
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
  L.push("  read: allow");
  L.push("  glob: allow");
  L.push("  grep: allow");
  L.push("  skill: allow");
  L.push("  edit:");
  L.push('    "**": allow');
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
  L.push('    "**": allow');
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
