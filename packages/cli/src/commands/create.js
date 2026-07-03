import { run as spawnRun } from "./spawn.js";

export const run = (argv, ctx) => spawnRun(argv, ctx, { createOnly: true });
