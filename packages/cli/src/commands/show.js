import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { requireProjectRoot, resolveHome } from "@mind/core";

export const run = (argv) => {
  const root = requireProjectRoot();
  const home = resolveHome(root, argv[0]);
  const resultFile = path.join(home, "result.json");
  if (existsSync(resultFile)) {
    process.stdout.write(readFileSync(resultFile, "utf8"));
  } else {
    console.log("(no result.json yet; showing alter.json)");
    process.stdout.write(readFileSync(path.join(home, "alter.json"), "utf8"));
  }
};
