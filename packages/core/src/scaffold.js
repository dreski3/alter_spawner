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
//
// The folder is claimed *by creating it*, not by checking whether it exists. Timestamp
// slugs are second-resolution and a graph node's run name is its node id, so two spikes
// released on the same tick compute a byte-identical folder name; an `existsSync` check
// followed by `mkdirSync(..., { recursive: true })` lets both through — the second run
// then overwrites the first's alter.json and result.json. `mkdirSync` *without*
// `recursive` is atomic and throws EEXIST, which is what makes this retry load-bearing
// rather than decorative.
const claimRunFolder = (root, id, runtime) => {
  mkdirSync(runsDir(root), { recursive: true });
  for (let i = 0; i < 5; i++) {
    const suffix = i === 0 ? "" : `-${runtime.randomId(4)}`;
    const folder = `${timestampSlug(runtime.now())}_${id}${suffix}`;
    try {
      mkdirSync(path.join(runsDir(root), folder));
      return folder;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  fail("could not allocate a unique run folder for: " + id);
};

// Scaffolds a new Alter home. Unlike the old vendored-kit model, a nestable
// Alter's own `.alters/` gets only *data* (config.json + a copy of the
// catalog, both cheap JSON) — never a copy of the engine itself. The engine
// is resolved from the installed `mind` package via `o.mindBinPath`, which
// the CLI layer bakes into the nestable Alter's scoped bash permission.
//
// `agentFiles: false` builds only the part of a home that is executor-independent:
// the run folder and its alter.json record, which `mind list`/`tree`/`show` and
// writeResult all read. Everything else here — the git boundary, the instruction
// files, the generated agent definition, a nestable Alter's child kit — exists for
// a harness that reads a home off disk. An adapter that declares
// `needsAgentHome: false` reads none of it, so writing it would be pure latency.
export const scaffold = (root, cfg, o, runtimeOverride, { agentFiles = true } = {}) => {
  const runtime = resolveRuntime(runtimeOverride);
  o.runFolder = claimRunFolder(root, o.id, runtime);
  const home = path.join(runsDir(root), o.runFolder);
  if (agentFiles) scaffoldAgentFiles(root, cfg, o, runtime, home);
  writeAlterJson(root, cfg, o, runtime, home);
  return home;
};

const scaffoldAgentFiles = (root, cfg, o, runtime, home) => {
  gitInit(home);
  cpSync(ALTER_HOME_TEMPLATE_DIR, home, { recursive: true });
  // The alter-spawning skill (and the "you can spawn children" framing baked
  // into AGENTS.md/alter.md below) only matters to a nestable Alter — every
  // other catalog entry is a leaf that will never call `mind`. Dropping it
  // keeps the common case's context smaller and its skill list uncluttered.
  if (!o.nestable) {
    rmSync(path.join(home, ".opencode", "skills", "alter"), { recursive: true, force: true });
  }
  if (o.catalogEntryDir && o.catalogSkillsDir && !o.textOnly) {
    const src = path.join(o.catalogEntryDir, o.catalogSkillsDir);
    if (existsSync(src)) {
      const dest = path.join(home, ".opencode", "skills");
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
    }
  }
  // opencode injects a home's AGENTS.md into the agent prompt *in addition to* the
  // agent's own body, and the two say nearly the same thing — so an ordinary Alter
  // pays for its instructions twice. Setting `instructions: []` does not suppress
  // the injection; only the file's absence does. A text_only leaf therefore ships
  // no AGENTS.md and carries its whole contract in the agent body. The `git init`
  // above matters here: it makes the home a repository root, so opencode stops
  // walking up and never reaches the project's own (parent-harness) AGENTS.md.
  if (o.textOnly) rmSync(path.join(home, "AGENTS.md"), { force: true });
  else writeTextAtomic(path.join(home, "AGENTS.md"), buildAgentsMd(o));
  const agentDir = path.join(home, ".opencode", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeTextAtomic(
    path.join(agentDir, "alter.md"),
    buildFrontmatter(o) + "\n\n" + buildBody(o) + "\n"
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
    const catalogDest = path.join(childKit, catalogDirName);
    if (existsSync(catalogSrc)) {
      // The child can only ever spawn what it can resolve, so the allowlist is
      // enforced by what lands on disk: an entry the parent did not allow is
      // never copied and `--catalog <name>` fails to resolve. Narrowing is
      // naturally transitive — each level copies from its own already-filtered
      // catalog, so a grandchild's reachable set can only shrink.
      if (o.allowedCatalogs) {
        mkdirSync(catalogDest, { recursive: true });
        for (const allowed of new Set(o.allowedCatalogs.map(sanitizeName))) {
          const entrySrc = path.join(catalogSrc, allowed);
          if (existsSync(path.join(entrySrc, "manifest.json"))) {
            cpSync(entrySrc, path.join(catalogDest, allowed), { recursive: true });
          }
        }
      } else {
        cpSync(catalogSrc, catalogDest, { recursive: true });
      }
    }
    writeJsonAtomic(
      path.join(childKit, "config.json"),
        {
          default_model: o.model,
          max_depth: cfg.max_depth ?? 12,
          // The tree limits have to reach every level: a child reads its own kit
          // config, so a limit left behind here would be silently lifted one level
          // down. The ledger they share travels separately, in the environment.
          max_tree_nodes: cfg.max_tree_nodes ?? null,
          max_tree_tokens: cfg.max_tree_tokens ?? null,
          max_concurrent_alters: cfg.max_concurrent_alters ?? null,
          run_timeout_ms: cfg.run_timeout_ms ?? 180000,
          catalog_dir: catalogDirName,
          default_fallback_model: o.fallbackModel || cfg.default_fallback_model || null,
          opencode_pure: cfg.opencode_pure !== false,
          opencode_event_log: cfg.opencode_event_log === true,
          retry: cfg.retry || { same_harness_retries: 1, fallback_retries: 1 },
        }
    );
  }
};

// The record of what this Alter is, written for every executor. `mind list`, `tree`,
// `show`, `rm`, and `runExistingAlter` all read it, and none of them care what ran.
const writeAlterJson = (root, cfg, o, runtime, home) => {
  writeJsonAtomic(
    path.join(home, "alter.json"),
      {
        schema_version: ALTER_SCHEMA_VERSION,
        // Which mind this spike belongs to. Derivable from the containing root only for
        // as long as the directory stays put — which is exactly the assumption agent_id
        // exists to remove. Null for a nestable Alter's child root, which is a run
        // artifact rather than a mind and never gets an identity of its own.
        agent_id: cfg.agent_id || null,
        id: o.id,
        name: o.name || null,
        description: o.description || null,
        model: o.model,
        executor: o.executor || null,
        capability: o.capability ? { ...o.capability } : null,
        nestable: !!o.nestable,
        web: !!o.webAccess,
        depth: o.depth,
        parent_id: o.spawned_by === "root" ? null : o.spawned_by,
        spawned_by: o.spawned_by,
        read_grants: o.readGrants,
        write_grants: o.writeGrants,
        bash_allow: o.bashAllow || [],
        bash_only: !!o.bashOnly,
        text_only: !!o.textOnly,
        allowed_catalogs: o.allowedCatalogs ? [...o.allowedCatalogs] : null,
        catalog: o.catalogName || null,
        max_tokens: o.maxTokens ?? null,
        fallback_model: o.fallbackModel || null,
        graph_id: o.graphId || null,
        depends_on: o.dependsOn || [],
        opencode_provider: o.opencodeProvider || null,
        opencode_variant: o.opencodeVariant || null,
        output_contract: o.outputContract || null,
        created_at: iso(runtime.now()),
        home: path.relative(root, home),
      }
  );
};
