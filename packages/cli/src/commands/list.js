import { existsSync } from "node:fs";
import path from "node:path";
import { requireProjectRoot, kitDir, listHomes, readAlterJson } from "@mind/core";

export const run = () => {
  const root = requireProjectRoot();
  const homes = listHomes(kitDir(root));
  if (!homes.length) {
    console.log("(no alters in " + path.relative(process.cwd(), kitDir(root)) + "/)");
    return;
  }
  for (const h of homes) {
    const aj = readAlterJson(h.path);
    const done = existsSync(path.join(h.path, "result.json"));
    const state = done ? "done" : "pending";
    const nest = aj.nestable ? "+nest" : "";
    console.log(`${h.id}\t${state}${nest}\td${aj.depth ?? 0}\t${path.relative(root, h.path)}`);
  }
};
