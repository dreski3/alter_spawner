import { randomUUID } from "node:crypto";

// Signal 0 does no work beyond the permission and existence check the kernel runs
// first. EPERM means the process is there but owned by someone else — still alive,
// which is the question being asked.
const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

export const createRuntime = (overrides = {}) => ({
  now: overrides.now || Date.now,
  randomId: overrides.randomId || ((length = 12) => randomUUID().replaceAll("-", "").slice(0, length)),
  env: overrides.env || process.env,
  // The tree ledger records which OS process holds each live slot, so reclaiming a
  // slot after a crash means asking whether that pid is still around.
  pid: overrides.pid || process.pid,
  isProcessAlive: overrides.isProcessAlive || processIsAlive,
});

export const resolveRuntime = (runtime) => runtime || createRuntime();
