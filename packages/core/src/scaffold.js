import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fail, gitInit, iso, sanitizeName, timestampSlug } from "./util.js";
import { runsDir } from "./config.js";
import { ALTER_HOME_TEMPLATE_DIR } from "./paths.js";
import { buildAgentsMd, buildBody, buildFrontmatter } from "./frontmatter.js";
import { catalogDirPath } from "./catalog.js";
import { ALTER_SCHEMA_VERSION, writeJsonAtomic, writeTextAtomic } from "./persistence.js";
import { resolveRuntime } from "./runtime.js";

// The `id` is a logical identifier only (used for ALTER_ID/parent_id/spawned_by
// tracking and for `--name`-based lookups) — it is intentionally allowed to
// repeat across runs, since each run gets its own timestamped folder under
// `.alters/runs/`. No filesystem check needed here anymore.
export const resolveId = (name, runtimeOverride) => {
  const runtime = resolveRuntime(runtimeOverride);
  if (!name) return `alter_${runtime.randomId(6)}`;
  const base = sanitizeName(name);
  return base || resolveId(null, runtime);
};

// Every Alter home lives at `.alters/runs/<timestamp>_<id>/`, so re-spawning
// the same `--name` repeatedly ("reruns") never collides and naturally sorts
// chronologically instead of overwriting/cluttering `.alters/` directly.
const resolveRunFolder = (root, id, runtime) => {
  for (let i = 0; i < 5; i++) {
    const suffix = i === 0 ? "" : `-${runtime.randomId(4)}`;
    const folder = `${timestampSlug(runtime.now())}_${id}${suffix}`;
    if (!existsSync(path.join(runsDir(root), folder))) return folder;
  }
  fail("could not allocate a unique run folder for: " + id);
};

// Scaffolds a new Alter home. Unlike the old vendored-kit model, a nestable
// Alter's own `.alters/` gets only *data* (config.json + a copy of the
// catalog, both cheap JSON) — never a copy of the engine itself. The engine
// is resolved from the installed `mind` package via `o.mindBinPath`, which
// the CLI layer bakes into the nestable Alter's scoped bash permission.
export const scaffold = (root, cfg, o, runtimeOverride) => {
  const runtime = resolveRuntime(runtimeOverride);
  o.runFolder = resolveRunFolder(root, o.id, runtime);
  const home = path.join(runsDir(root), o.runFolder);
  mkdirSync(home, { recursive: true });
  gitInit(home);
  cpSync(ALTER_HOME_TEMPLATE_DIR, home, { recursive: true });
  // The alter-spawning skill (and the "you can spawn children" framing baked
  // into AGENTS.md/alter.md below) only matters to a nestable Alter — every
  // other catalog entry is a leaf that will never call `mind`. Dropping it
  // keeps the common case's context smaller and its skill list uncluttered.
  if (!o.nestable) {
    rmSync(path.join(home, ".opencode", "skills", "alter"), { recursive: true, force: true });
  }
  if (o.catalogEntryDir && o.catalogSkillsDir) {
    const src = path.join(o.catalogEntryDir, o.catalogSkillsDir);
    if (existsSync(src)) {
      const dest = path.join(home, ".opencode", "skills");
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
    }
  }
  writeTextAtomic(path.join(home, "AGENTS.md"), buildAgentsMd(o));
  const agentDir = path.join(home, ".opencode", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeTextAtomic(
    path.join(agentDir, "alter.md"),
    buildFrontmatter(o) + "\n\n" + buildBody(o) + "\n"
  );
  writeJsonAtomic(
    path.join(home, "alter.json"),
      {
        schema_version: ALTER_SCHEMA_VERSION,
        id: o.id,
        name: o.name || null,
        description: o.description || null,
        model: o.model,
        nestable: !!o.nestable,
        web: !!o.webAccess,
        depth: o.depth,
        parent_id: o.spawned_by === "root" ? null : o.spawned_by,
        spawned_by: o.spawned_by,
        read_grants: o.readGrants,
        write_grants: o.writeGrants,
        bash_allow: o.bashAllow || [],
        bash_only: !!o.bashOnly,
        catalog: o.catalogName || null,
        max_tokens: o.maxTokens ?? null,
        fallback_model: o.fallbackModel || null,
        graph_id: o.graphId || null,
        depends_on: o.dependsOn || [],
        opencode_provider: o.opencodeProvider || null,
        output_contract: o.outputContract || null,
        created_at: iso(runtime.now()),
        home: path.relative(root, home),
      }
  );
  if (o.opencodeProvider) {
    writeJsonAtomic(
      path.join(home, "opencode.json"),
        {
          $schema: "https://opencode.ai/config.json",
          provider: o.opencodeProvider,
        }
    );
  }
  if (o.nestable) {
    const childKit = path.join(home, ".alters");
    mkdirSync(childKit, { recursive: true });
    const catalogDirName = cfg.catalog_dir || "catalog";
    const catalogSrc = catalogDirPath(root, cfg);
    if (existsSync(catalogSrc)) {
      cpSync(catalogSrc, path.join(childKit, catalogDirName), { recursive: true });
    }
    writeJsonAtomic(
      path.join(childKit, "config.json"),
        {
          default_model: o.model,
          max_depth: cfg.max_depth ?? 5,
          run_timeout_ms: cfg.run_timeout_ms ?? 180000,
          catalog_dir: catalogDirName,
          default_fallback_model: o.fallbackModel || cfg.default_fallback_model || null,
          opencode_pure: cfg.opencode_pure !== false,
          opencode_event_log: cfg.opencode_event_log === true,
          retry: cfg.retry || { same_harness_retries: 1, fallback_retries: 1 },
        }
    );
  }
  return home;
};
