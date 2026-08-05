import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
