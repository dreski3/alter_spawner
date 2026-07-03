import path from "node:path";
import { requireProjectRoot, removeHome, fail } from "@mind/core";

export const run = (argv) => {
  if (!argv[0]) fail("usage: mind rm <id-or-path>");
  const root = requireProjectRoot();
  const home = removeHome(root, argv[0]);
  console.log("removed: " + path.relative(root, home));
};
