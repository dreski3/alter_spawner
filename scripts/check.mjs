import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const roots = ["packages", "examples", "scripts"];
const files = [];

const visit = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) visit(full);
    else if (entry.endsWith(".js") || entry.endsWith(".mjs")) files.push(full);
  }
};

for (const relative of roots) visit(path.join(root, relative));
for (const file of files.sort()) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
