import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One attempt at the mutex, with no waiting. Returns the descriptor on success and
// `null` when someone else holds it — which is the distinction a caller that wants to
// *skip* rather than queue cannot get out of `withFileLock`, since that one blocks
// until the deadline and then throws.
//
// Reclamation has two rules because it serves two very different locked sections. A
// counter update takes milliseconds, so an mtime older than `staleMs` means the holder
// died. A rhythm's locked section can legitimately run for hours, and no `staleMs`
// generous enough for it would still catch a crash promptly — so when the lock file
// carries a live pid we trust it over the clock, and only fall back to mtime when the
// pid is unreadable or belongs to no running process.
export const claimLockOnce = (lockFile, { staleMs = 30000, now = Date.now, isProcessAlive } = {}) => {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    const descriptor = openSync(lockFile, "wx", 0o600);
    writeFileSync(descriptor, `${process.pid}\n`);
    return descriptor;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if (!holderLooksDead(lockFile, staleMs, now, isProcessAlive)) return null;
  try {
    unlinkSync(lockFile);
  } catch (error) {
    // Someone else reclaimed it first; they hold it now, so we do not.
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
  try {
    const descriptor = openSync(lockFile, "wx", 0o600);
    writeFileSync(descriptor, `${process.pid}\n`);
    return descriptor;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return null;
  }
};

const holderLooksDead = (lockFile, staleMs, now, isProcessAlive) => {
  if (isProcessAlive) {
    const pid = readLockPid(lockFile);
    if (pid !== null) return !isProcessAlive(pid);
  }
  try {
    return now() - statSync(lockFile).mtimeMs > staleMs;
  } catch (error) {
    // Released between our open and our stat — treat it as free and let the retry
    // above decide.
    if (error?.code === "ENOENT") return true;
    throw error;
  }
};

const readLockPid = (lockFile) => {
  try {
    const pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

export const releaseLock = (lockFile, descriptor) => {
  closeSync(descriptor);
  try {
    unlinkSync(lockFile);
  } catch {}
};

// A mutex between *processes*, built on O_EXCL file creation.
//
// Alters in a tree are separate OS processes with no shared memory, so anything they
// have to agree on — how many nodes the tree has already spent, how many are running
// right now — can only be serialized through the filesystem. `writeJsonAtomic` makes
// a single write atomic, which is not the same thing: two spawns that both read "12
// nodes used" and both write "13" have each done an atomic write and still lost a
// node. Read-modify-write needs the lock.
//
// A holder that is killed mid-run leaves its lock file behind, which would wedge the
// whole tree, so a lock older than `staleMs` is reclaimed. That is a real (if narrow)
// race — a holder paused longer than `staleMs` can have its lock stolen — which is
// why `staleMs` is generous relative to how long a locked section here actually
// takes: read a small JSON file, adjust counters, write it back.
//
// memory.js grows its own equivalent of this inline. Folding it onto this primitive
// is worthwhile but is a change to a separately tested subsystem, so it is not done
// here.
export const withFileLock = async (
  file,
  operation,
  { timeoutMs = 5000, staleMs = 30000, pollMs = 10 } = {},
) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lockFile, "wx", 0o600);
      writeFileSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > staleMs) {
          unlinkSync(lockFile);
          continue;
        }
      } catch (statError) {
        // The holder released it between our open and our stat — just try again.
        if (statError?.code !== "ENOENT") throw statError;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for the lock on ${path.basename(file)}`);
      }
      await wait(pollMs);
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockFile);
    } catch {}
  }
};
