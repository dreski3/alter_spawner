// What a leaf Alter costs before it has done any work. Every assertion here stands
// for a measured number: an unmodified trivial leaf put 13,677 bytes / ~3,419 input
// tokens on the wire across two requests; the same leaf as `text_only` puts 1,071
// bytes / ~268 tokens across one. These tests pin the mechanisms that got it there,
// since all of them are silent when they regress — the Alter still works, it just
// costs several times more.
//
// Pure and offline — no `opencode` process, no model.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyCatalog,
  buildBody,
  buildFrontmatter,
  createSpawnOptions,
  parseSpawnArgs,
  scaffold,
  validateManifest,
} from "../../src/index.js";
import { buildRunArgs } from "../../src/harness/opencode.js";

const config = { catalog_dir: "catalog", max_depth: 5 };

const makeRoot = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-leaf-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".alters"), { recursive: true });
  return root;
};

const leafOptions = (overrides = {}) =>
  createSpawnOptions({
    id: "leaf",
    name: "leaf",
    description: "Return the input text lowercased.",
    depth: 0,
    spawned_by: "root",
    model: "test/model",
    ...overrides,
  });

// --- the extra title call ------------------------------------------------------

test("a new session is named up front so the harness does not bill a call to name it", () => {
  const args = buildRunArgs({ home: "/h", prompt: "p", pure: true, agent: "alter", alterId: "leaf" });
  assert.ok(args.includes("--title"), "a titled session skips opencode's title-generator agent");
  assert.equal(args[args.indexOf("--title") + 1], "leaf");
});

test("an explicit title wins over the alter id, and either is better than none", () => {
  const args = buildRunArgs({ home: "/h", prompt: "p", alterId: "leaf", title: "custom" });
  assert.equal(args[args.indexOf("--title") + 1], "custom");
  assert.ok(!buildRunArgs({ home: "/h", prompt: "p" }).includes("--title"), "nothing to name it with");
});

test("continuing a session neither re-titles it nor opens a new one", () => {
  const args = buildRunArgs({ home: "/h", prompt: "p", alterId: "principal", sessionId: "ses_1" });
  assert.ok(args.includes("--session"));
  assert.ok(!args.includes("--title"), "the session already has a title; asking again would be a wasted flag");
});

test("the prompt stays last so no flag can swallow it", () => {
  const args = buildRunArgs({ home: "/h", prompt: "do the thing", pure: true, agent: "alter", alterId: "x", model: "p/m", variant: "minimal" });
  assert.equal(args[args.indexOf("--variant") + 1], "minimal");
  assert.equal(args[args.length - 1], "do the thing");
});

// --- tool definitions on the wire ----------------------------------------------

test("a text_only leaf denies every tool with scalars, which is what prunes them", () => {
  const frontmatter = buildFrontmatter(leafOptions({ textOnly: true }));
  // The scalar form is load-bearing: `edit:\n  "**": deny` leaves the tool's schema
  // in the request (~3k characters), a bare `deny` removes it.
  assert.match(frontmatter, /^ {2}edit: deny$/m);
  assert.match(frontmatter, /^ {2}write: deny$/m);
  for (const tool of ["read", "glob", "grep", "skill"]) {
    assert.match(frontmatter, new RegExp(`^ {2}${tool}: deny$`, "m"));
  }
  assert.match(frontmatter, /^ {2}bash: deny$/m);
  assert.doesNotMatch(frontmatter, /"\*\*": allow/);
});

test("a bash_only leaf with no grants also collapses, keeping only its one shell", () => {
  const frontmatter = buildFrontmatter(leafOptions({ bashOnly: true, bashAllow: ["node /abs/x.mjs **"] }));
  assert.match(frontmatter, /^ {2}edit: deny$/m);
  assert.match(frontmatter, /^ {2}write: deny$/m);
  assert.match(frontmatter, /node \/abs\/x\.mjs \*\*.*: allow/);
});

test("a grant forces the per-path map back, because some path really is allowed", () => {
  const frontmatter = buildFrontmatter(leafOptions({ bashOnly: true, writeGrants: ["/tmp/out"] }));
  assert.doesNotMatch(frontmatter, /^ {2}edit: deny$/m, "a scalar deny would silently drop the grant");
  assert.match(frontmatter, /"\/tmp\/out\/\*\*": allow/);
});

test("an ordinary Alter is untouched: it still gets the full toolset", () => {
  const frontmatter = buildFrontmatter(leafOptions());
  assert.match(frontmatter, /^ {2}read: allow$/m);
  assert.match(frontmatter, /"\*\*": allow/);
});

// --- duplicated instructions ---------------------------------------------------

test("a text_only leaf ships no AGENTS.md, which opencode would inject on top of its body", (t) => {
  const root = makeRoot(t);
  const home = scaffold(root, config, leafOptions({ textOnly: true }));
  assert.ok(!existsSync(path.join(home, "AGENTS.md")));
  assert.ok(existsSync(path.join(home, ".opencode", "agents", "alter.md")));
  assert.equal(JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8")).text_only, true);
});

test("an ordinary Alter keeps its AGENTS.md", (t) => {
  const root = makeRoot(t);
  const home = scaffold(root, config, leafOptions());
  assert.ok(existsSync(path.join(home, "AGENTS.md")));
});

test("a text_only body carries the role and the output contract and nothing else", () => {
  const body = buildBody(leafOptions({ textOnly: true }));
  assert.match(body, /Return the input text lowercased\./);
  assert.match(body, /captured verbatim/);
  // Boilerplate that presumes tools describes a situation this Alter is not in.
  assert.doesNotMatch(body, /home directory/);
  assert.doesNotMatch(body, /Never commit/);
  assert.doesNotMatch(body, /sandboxed coding agent/);
  assert.ok(body.length < 400, `expected a compact body, got ${body.length} chars`);
});

// --- the manifest contract -----------------------------------------------------

test("text_only travels on a manifest and through spawn arguments", () => {
  const options = createSpawnOptions({});
  applyCatalog(options, { dir: "/tmp/x", manifest: { name: "compress", description: "d", text_only: true } });
  assert.equal(options.textOnly, true);
  assert.equal(parseSpawnArgs(["--text-only", "go"]).textOnly, true);
  assert.equal(parseSpawnArgs(["go"]).textOnly, false);
});

test("text_only is rejected alongside any capability it claims not to have", () => {
  const base = { name: "compress", description: "d", text_only: true };
  for (const [field, value] of [
    ["nestable", true],
    ["web", true],
    ["bash_only", true],
    ["bash_allow", ["node x"]],
    ["read_grants", ["/tmp"]],
    ["write_grants", ["/tmp"]],
  ]) {
    assert.throws(
      () => validateManifest({ ...base, [field]: value }, "compress"),
      new RegExp(`text_only cannot be combined with .*${field}`),
      `${field} must not silently survive text_only`,
    );
  }
  assert.equal(validateManifest({ ...base }, "compress"), undefined);
  assert.throws(() => validateManifest({ ...base, text_only: "yes" }, "compress"), /text_only must be a boolean/);
});
