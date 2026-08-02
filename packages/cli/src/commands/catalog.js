import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  requireProjectRoot,
  readConfig,
  catalogDirPath,
  listCatalogEntries,
  saveCatalogEntry,
  readAlterJson,
  resolveHome,
  fail,
} from "@mind/core";
import { parseSpawnArgs } from "../parseArgs.js";

const catalogList = () => {
  const root = requireProjectRoot();
  const cfg = readConfig(root);
  const entries = listCatalogEntries(root, cfg);
  if (!entries.length) {
    console.log("(no catalog entries in " + path.relative(process.cwd(), catalogDirPath(root, cfg)) + "/)");
    return;
  }
  for (const { name, manifest: m } of entries) {
    console.log(
      `${name}\t${m.model || "(inherit)"}\t${m.max_tokens ?? "-"}\t${[m.nestable && "+nest", m.web && "+web"].filter(Boolean).join(" ")}\t${m.description || ""}`
    );
  }
};

const catalogShow = (argv) => {
  const name = argv[0];
  if (!name) fail("usage: mind catalog show <name>");
  const root = requireProjectRoot();
  const cfg = readConfig(root);
  const manifestPath = path.join(catalogDirPath(root, cfg), name, "manifest.json");
  if (!existsSync(manifestPath)) fail("catalog entry not found: " + name);
  process.stdout.write(readFileSync(manifestPath, "utf8"));
};

const catalogSave = (argv) => {
  const name = argv[0];
  if (!name) fail("usage: mind catalog save <name> [--from <alter-id>] [...spawn flags]");
  const rest = argv.slice(1);
  let fromId = null;
  let force = false;
  const passthrough = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--from") fromId = rest[++i];
    else if (rest[i] === "--force") force = true;
    else passthrough.push(rest[i]);
  }
  const root = requireProjectRoot();
  const cfg = readConfig(root);
  let o;
  if (fromId) {
    const home = resolveHome(root, fromId);
    const aj = readAlterJson(home);
    o = {
      description: aj.description,
      model: aj.model,
      fallbackModel: aj.fallback_model,
      maxTokens: aj.max_tokens,
      nestable: aj.nestable,
      webAccess: aj.web,
      timeout: null,
      readGrants: aj.read_grants || [],
      writeGrants: aj.write_grants || [],
      bashOnly: !!aj.bash_only,
      promptPrefix: null,
      promptSuffix: null,
      opencodeProvider: aj.opencode_provider || null,
      createdFrom: aj.id || fromId,
    };
  } else {
    // Flags-only mode: catalog entries don't carry a fixed prompt of their own.
    o = parseSpawnArgs(passthrough);
  }
  const dir = saveCatalogEntry(root, cfg, name, o, { force });
  console.log("saved catalog entry: " + path.relative(root, dir));
};

export const run = (argv) => {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "list") catalogList();
  else if (sub === "show") catalogShow(rest);
  else if (sub === "save") catalogSave(rest);
  else fail("usage: mind catalog <list|show|save> ...");
};
