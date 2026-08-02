import { existsSync } from "node:fs";
import path from "node:path";
import { requireProjectRoot, kitDir, listHomes, readAlterJson } from "@mind/core";

const cmdTree = (topKit, dir, prefix, isLast, label) => {
  if (dir === topKit) {
    console.error(label);
  } else {
    console.error(prefix + (isLast ? "└─ " : "├─ ") + path.basename(dir) + "/");
  }
  const homes = listHomes(dir);
  homes.forEach((h, i) => {
    const last = i === homes.length - 1;
    const aj = readAlterJson(h.path);
    const done = existsSync(path.join(h.path, "result.json"));
    const branch = dir === topKit ? prefix : prefix + (isLast ? "   " : "│  ");
    const catalog = aj.catalog ? ` [${aj.catalog}]` : "";
    console.error(
      branch +
        (last ? "└─ " : "├─ ") +
        h.id +
        catalog +
        (aj.nestable ? " (nestable)" : "") +
        (done ? "" : " [pending]")
    );
    const childKit = path.join(h.path, ".alters");
    if (existsSync(childKit)) {
      cmdTree(topKit, childKit, branch + (last ? "   " : "│  "), true, "");
    }
  });
};

export const run = () => {
  const root = requireProjectRoot();
  const kit = kitDir(root);
  cmdTree(kit, kit, "", true, path.basename(kit) + "/");
};
