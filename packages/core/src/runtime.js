import { randomUUID } from "node:crypto";

export const createRuntime = (overrides = {}) => ({
  now: overrides.now || Date.now,
  randomId: overrides.randomId || ((length = 12) => randomUUID().replaceAll("-", "").slice(0, length)),
  env: overrides.env || process.env,
});

export const resolveRuntime = (runtime) => runtime || createRuntime();
