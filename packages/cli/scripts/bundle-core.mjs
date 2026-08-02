import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.dirname(here);
const core = path.resolve(cli, "../core");
const target = path.join(cli, "node_modules", "@mind", "core");
const command = process.argv[2];

if (command === "stage") {
  if (existsSync(target)) throw new Error(`refusing to replace existing bundle target: ${target}`);
  mkdirSync(target, { recursive: true });
  cpSync(path.join(core, "src"), path.join(target, "src"), { recursive: true });
  cpSync(path.join(core, "templates"), path.join(target, "templates"), { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(core, "package.json"), "utf8"));
  delete manifest.scripts;
  writeFileSync(path.join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
} else if (command === "clean") {
  rmSync(target, { recursive: true, force: true });
} else {
  throw new Error("usage: node scripts/bundle-core.mjs <stage|clean>");
}

