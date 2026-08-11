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
  if (o.textOnly) return rules;
  if (o.nestable) {
    rules.push(`${yq(`node ${o.mindBinPath} **`)}: allow`);
    rules.push(`${yq(`node ${o.mindBinPath}`)}: allow`);
  }
  for (const pattern of o.bashAllow || []) {
    rules.push(`${yq(pattern)}: allow`);
  }
  return rules;
};

// Denying a permission does not merely refuse the call at runtime — opencode drops
// the tool's definition from the request body entirely. That makes the permission
// block the lever for context size, not just for safety: the six file tools
// (edit/glob/grep/read/skill/write) are ~7.7k characters of schema that a leaf
// returning transformed text will never call and should never be sent.
const deniesTools = (o) => !!(o.bashOnly || o.textOnly);

// The one exception to the rule above. An Alter authored as a project ships a skills/
// directory that scaffold copies into its home, and the skill tool is the only way to
// reach it — so denying the tool for context savings would leave those files on disk,
// unreadable, and the author's intent silently dropped. A text_only entry cannot get
// here: the manifest validator rejects text_only + skills_dir outright.
const hasProjectSkills = (o) => !!(o.catalogEntryDir && o.catalogSkillsDir && !o.textOnly);

export const buildFrontmatter = (o) => {
  const L = [];
  const noTools = deniesTools(o);
  L.push("---");
  L.push(`description: ${yq(o.description || "Single-use sandboxed Alter.")}`);
  L.push("mode: all");
  if (o.model) L.push(`model: ${o.model}`);
  L.push("permission:");
  L.push(noTools ? "  read: deny" : "  read: allow");
  L.push(noTools ? "  glob: deny" : "  glob: allow");
  L.push(noTools ? "  grep: deny" : "  grep: allow");
  L.push(noTools && !hasProjectSkills(o) ? "  skill: deny" : "  skill: allow");
  const readDirs = o.readGrants;
  const writeDirs = o.writeGrants;
  // A per-path map and a bare `deny` are not equivalent to opencode. A map means
  // "consult these patterns", so the tool's definition stays on the wire even when
  // every pattern denies; only the scalar form prunes it. With no grants there are
  // no patterns to consult, so the scalar says the same thing for ~3k fewer
  // characters. Grants force the map back — they are exactly the case where some
  // path really is allowed.
  const scalarPaths = noTools && readDirs.length === 0 && writeDirs.length === 0;
  if (scalarPaths) {
    L.push("  edit: deny");
    L.push("  write: deny");
  } else {
    L.push("  edit:");
    L.push(`    "**": ${noTools ? "deny" : "allow"}`);
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
    L.push(`    "**": ${noTools ? "deny" : "allow"}`);
  }
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

// The stock body tells an Alter it is a coding agent in a home directory, to stay
// inside it, not to commit, and to verify its work. Every line of that presumes
// tools. A text_only leaf has none — so the advice is not merely wasted context,
// it describes a situation the model is not in. It gets the role and the output
// contract, and nothing else.
const textOnlyResult = `Your entire reply is captured verbatim as the result. Return only the transformed
text — no preamble, no explanation, no commentary on what you changed.`;

const textOnlyBody = (o) => {
  const role = o.description && o.description.trim()
    ? o.description.trim()
    : "Transform the text you are given.";
  return `## Your role
${role}

${textOnlyResult}`;
};

export const buildBody = (o) => {
  const hasAuthoredPersona = !!(o.catalogEntryDir && o.catalogAgentsOverride);
  if (o.textOnly && !hasAuthoredPersona) return textOnlyBody(o);
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
  const compiled = applyPlaceholders(body, o).trimStart();
  return o.textOnly ? `${compiled.trimEnd()}\n\n${textOnlyResult}` : compiled;
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
