import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.dirname(here);
const source = path.resolve(core, "../cli/profiles/default");
const target = path.join(core, "dist", "profiles", "default");

rmSync(path.join(core, "dist"), { recursive: true, force: true });
mkdirSync(path.dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
