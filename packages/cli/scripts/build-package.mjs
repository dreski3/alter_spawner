import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.dirname(here);
const core = path.resolve(cli, "../core");
const dist = path.join(cli, "dist");
const cliTarget = path.join(dist, "cli");
const coreEntry = path.join(dist, "core", "src", "index.js");

const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) visit(file);
    else if (file.endsWith(".js")) {
      const relative = path.relative(path.dirname(file), coreEntry).split(path.sep).join("/");
      const specifier = relative.startsWith(".") ? relative : `./${relative}`;
      const source = readFileSync(file, "utf8")
        .replaceAll('"@mind/core"', `"${specifier}"`)
        .replaceAll("'@mind/core'", `'${specifier}'`);
      writeFileSync(file, source);
    }
  }
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(path.join(cli, "src"), cliTarget, { recursive: true });
cpSync(path.join(cli, "profiles"), path.join(dist, "profiles"), { recursive: true });
cpSync(path.join(core, "src"), path.join(dist, "core", "src"), { recursive: true });
cpSync(path.join(core, "templates"), path.join(dist, "core", "templates"), { recursive: true });
visit(cliTarget);

// A `mind` on PATH, without an install step. A host running a child process — a
// principal turn, say — prepends this directory to the child's PATH, so every
// `mind ...` command in AGENTS.md and the alter skill works verbatim instead of
// sending the agent looking for a package to install.
const binDir = path.join(dist, "bin");
const shim = path.join(binDir, "mind");
mkdirSync(binDir, { recursive: true });
writeFileSync(shim, '#!/bin/sh\nexec node "$(dirname "$0")/../cli/index.js" "$@"\n');
chmodSync(shim, 0o755);

const manifest = JSON.parse(readFileSync(path.join(cli, "package.json"), "utf8"));
writeFileSync(
  path.join(dist, "package.json"),
  JSON.stringify({ name: manifest.name, version: manifest.version, type: "module", private: true }, null, 2) + "\n",
);
