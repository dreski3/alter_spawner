import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));

test("the CLI packs and installs as one self-contained package", (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "mind-pack-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const tarballs = path.join(temp, "tarballs");
  const consumer = path.join(temp, "consumer");
  const cache = path.join(temp, "npm-cache");
  mkdirSync(tarballs);
  mkdirSync(consumer);
  execFileSync(
    "npm",
    ["pack", "--silent", "--workspace", "packages/cli", "--pack-destination", tarballs, "--cache", cache],
    { cwd: repo, stdio: "pipe" }
  );
  const tarball = path.join(tarballs, readdirSync(tarballs).find((file) => file.endsWith(".tgz")));
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache, tarball],
    { cwd: consumer, stdio: "pipe" }
  );
  const mind = path.join(consumer, "node_modules", ".bin", "mind");
  execFileSync(mind, ["init"], { cwd: consumer, stdio: "pipe" });
  assert.equal(existsSync(mind), true);
  assert.equal(existsSync(path.join(consumer, ".alters", "config.json")), true);
  assert.match(readFileSync(path.join(consumer, ".gitignore"), "utf8"), /^\.alters\/memory\/$/m);
  assert.equal(existsSync(path.join(consumer, ".alters", "catalog", "memory-recaller", "manifest.json")), true);
  assert.equal(existsSync(path.join(consumer, ".alters", "catalog", "memory-curator", "manifest.json")), true);
  assert.equal(existsSync(path.join(consumer, "node_modules", "mind", "dist", "core", "src", "index.js")), true);
  assert.equal(existsSync(path.join(consumer, "node_modules", "mind", "node_modules")), false);
  assert.equal(existsSync(path.join(consumer, "node_modules", "mind", "README.md")), true);
  assert.equal(existsSync(path.join(consumer, "node_modules", "mind", "LICENSE")), true);
  assert.match(execFileSync(mind, ["--help"], { cwd: consumer, encoding: "utf8" }), /^usage: mind/m);
  assert.equal(execFileSync(mind, ["--version"], { cwd: consumer, encoding: "utf8" }).trim(), "0.1.0");
});

test("the core package installs as an importable, documented library", (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "mind-core-pack-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const tarballs = path.join(temp, "tarballs");
  const consumer = path.join(temp, "consumer");
  const cache = path.join(temp, "npm-cache");
  mkdirSync(tarballs);
  mkdirSync(consumer);
  execFileSync(
    "npm",
    ["pack", "--silent", "--workspace", "packages/core", "--pack-destination", tarballs, "--cache", cache],
    { cwd: repo, stdio: "pipe" },
  );
  const tarball = path.join(tarballs, readdirSync(tarballs).find((file) => file.endsWith(".tgz")));
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache, tarball],
    { cwd: consumer, stdio: "pipe" },
  );
  const probe = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", "import * as core from '@mind/core'; const initialized = core.initMind('./fixture'); console.log(core.spawnAlter instanceof Function, core.runOscillation instanceof Function, initialized.profile)"],
    { cwd: consumer, encoding: "utf8" },
  );
  assert.equal(probe.trim(), "true true default");
  assert.equal(existsSync(path.join(consumer, "node_modules", "@mind", "core", "README.md")), true);
  assert.equal(existsSync(path.join(consumer, "node_modules", "@mind", "core", "LICENSE")), true);
});
