import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const iso = (ms) => new Date(ms).toISOString();

// Filesystem-safe, lexicographically sortable UTC timestamp used to prefix
// run folder names, e.g. "20260703T182035Z".
export const timestampSlug = (ms = Date.now()) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
};

export class MindError extends Error {}

export const fail = (msg) => {
  throw new MindError(msg);
};

export const normPath = (p) => {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return path.resolve(p);
};

export const yq = (s) => JSON.stringify(String(s));

export const grantDir = (p) => {
  try {
    if (existsSync(p) && statSync(p).isFile()) return path.dirname(p);
  } catch {}
  return p;
};

export const sanitizeName = (n) =>
  String(n).replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[-_.]+/, "").slice(0, 64);

export const gitInit = (home) => {
  try {
    const r = spawnSync("git", ["init", "--quiet"], { cwd: home, stdio: "ignore" });
    if (r.status !== 0) {
      spawnSync("git", ["init"], { cwd: home, stdio: "ignore" });
    }
  } catch {}
};
