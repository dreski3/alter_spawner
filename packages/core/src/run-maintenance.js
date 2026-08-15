import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { runsDir } from "./config.js";

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const folderTime = (folder, result) => {
  const value = result?.ended_at || result?.started_at;
  const parsed = value ? Date.parse(value) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const match = folder.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_/);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : null;
};

const directorySize = (root) => {
  let bytes = 0;
  let files = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        bytes += lstatSync(full).size;
        files += 1;
      }
    }
  }
  return { bytes, files };
};

const directRunFolders = (root) => {
  const dir = runsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
};

export const inspectRunCleanup = (root, {
  olderThanDays = 30,
  keepNewest = 20,
  includeFailed = false,
  limit = 500,
  now = Date.now(),
} = {}) => {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0 || olderThanDays > 36500) throw new Error("olderThanDays must be an integer from 0 to 36500");
  if (!Number.isInteger(keepNewest) || keepNewest < 0 || keepNewest > 100000) throw new Error("keepNewest must be an integer from 0 to 100000");
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error("limit must be an integer from 1 to 5000");
  const folders = directRunFolders(root);
  const newest = new Set(keepNewest === 0 ? [] : folders.slice(-keepNewest));
  const cutoff = now - olderThanDays * 86400000;
  const candidates = [];
  const protectedCounts = { newest: 0, incomplete: 0, graph: 0, failed: 0, recent: 0, undated: 0 };
  let reclaimableBytes = 0;
  let reclaimableFiles = 0;
  for (const folder of folders) {
    const home = path.join(runsDir(root), folder);
    const result = readJson(path.join(home, "result.json"));
    let reason = null;
    const at = folderTime(folder, result);
    if (newest.has(folder)) reason = "newest";
    else if (!result || typeof result.ok !== "boolean") reason = "incomplete";
    else if (result.graph_id) reason = "graph";
    else if (!result.ok && !includeFailed) reason = "failed";
    else if (at === null) reason = "undated";
    else if (at > cutoff) reason = "recent";
    if (reason) {
      protectedCounts[reason] += 1;
      continue;
    }
    if (candidates.length >= limit) continue;
    const size = directorySize(home);
    reclaimableBytes += size.bytes;
    reclaimableFiles += size.files;
    candidates.push({
      folder,
      id: result.id || readJson(path.join(home, "alter.json"))?.id || folder,
      ok: result.ok,
      ended_at: result.ended_at || null,
      bytes: size.bytes,
      files: size.files,
    });
  }
  return {
    policy: { olderThanDays, keepNewest, includeFailed, limit },
    totalRuns: folders.length,
    candidates,
    reclaimableBytes,
    reclaimableFiles,
    protected: protectedCounts,
    truncated: candidates.length === limit && folders.length > candidates.length,
  };
};

export const deleteRunCleanupCandidates = (root, folders) => {
  if (!Array.isArray(folders) || folders.length < 1 || folders.length > 5000) throw new Error("run cleanup requires 1 to 5000 folders");
  const base = runsDir(root);
  const unique = [...new Set(folders)];
  const targets = unique.map((folder) => {
    if (typeof folder !== "string" || !/^[A-Za-z0-9._-]+$/.test(folder) || folder === "." || folder === "..") throw new Error("invalid run folder");
    const home = path.join(base, folder);
    if (!existsSync(home) || !lstatSync(home).isDirectory() || lstatSync(home).isSymbolicLink()) throw new Error(`run folder is unavailable: ${folder}`);
    const result = readJson(path.join(home, "result.json"));
    if (!result || typeof result.ok !== "boolean") throw new Error(`run is incomplete and cannot be deleted: ${folder}`);
    if (result.graph_id) throw new Error(`run is referenced by graph ${result.graph_id}: ${folder}`);
    return { folder, home, ...directorySize(home) };
  });
  let reclaimedBytes = 0;
  let removedFiles = 0;
  for (const target of targets) {
    rmSync(target.home, { recursive: true, force: false });
    reclaimedBytes += target.bytes;
    removedFiles += target.files;
  }
  return { removed: targets.map(({ folder }) => folder), reclaimedBytes, removedFiles };
};
