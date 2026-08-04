import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyCatalog, createSpawnOptions, parseSpawnArgs, scaffold, validateManifest } from "../../src/index.js";

const CATALOGS = ["researcher", "code-review", "general"];

const makeRoot = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mind-allowlist-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of CATALOGS) {
    const dir = path.join(root, ".alters", "catalog", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name, description: `${name} harness` }));
  }
  return root;
};

const config = { catalog_dir: "catalog", max_depth: 5 };

const scaffoldChild = (root, allowedCatalogs) => {
  const options = createSpawnOptions({
    id: "child",
    name: "child",
    description: "child",
    depth: 0,
    spawned_by: "root",
    model: "test/model",
    nestable: true,
    mindBinPath: "/abs/mind",
    allowedCatalogs,
  });
  const home = scaffold(root, config, options);
  return { home, options };
};

const childCatalogNames = (home) => {
  const dir = path.join(home, ".alters", "catalog");
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

test("a nestable child inherits the whole catalog when no allowlist is declared", (t) => {
  const root = makeRoot(t);
  const { home } = scaffoldChild(root, null);
  assert.deepEqual(childCatalogNames(home), [...CATALOGS].sort());
});

test("an allowlist copies only the permitted catalog entries into the child home", (t) => {
  const root = makeRoot(t);
  const { home } = scaffoldChild(root, ["researcher"]);
  assert.deepEqual(childCatalogNames(home), ["researcher"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "alter.json"), "utf8")).allowed_catalogs, ["researcher"]);
});

test("an empty allowlist leaves a nestable child with no catalog to resolve", (t) => {
  const root = makeRoot(t);
  const { home } = scaffoldChild(root, []);
  assert.deepEqual(childCatalogNames(home), []);
});

test("the allowed set is stated in the child's own instructions", (t) => {
  const root = makeRoot(t);
  const restricted = scaffoldChild(root, ["researcher"]).home;
  const agents = readFileSync(path.join(restricted, "AGENTS.md"), "utf8");
  assert.match(agents, /narrowed the catalog you may spawn from/);
  assert.match(agents, /- `researcher`/);
  assert.doesNotMatch(agents, /- `code-review`/);

  const none = scaffoldChild(root, []).home;
  assert.match(readFileSync(path.join(none, "AGENTS.md"), "utf8"), /no catalog entries/);

  const open = scaffoldChild(root, null).home;
  assert.doesNotMatch(readFileSync(path.join(open, "AGENTS.md"), "utf8"), /narrowed the catalog/);
});

test("narrowing is transitive: a grandchild cannot regain what its parent lost", (t) => {
  const root = makeRoot(t);
  const { home: childHome } = scaffoldChild(root, ["researcher", "general"]);
  const grandchild = scaffold(
    childHome,
    config,
    createSpawnOptions({
      id: "grandchild",
      name: "grandchild",
      depth: 1,
      spawned_by: "child",
      model: "test/model",
      nestable: true,
      mindBinPath: "/abs/mind",
      allowedCatalogs: ["researcher", "code-review"],
    }),
  );
  assert.deepEqual(childCatalogNames(grandchild), ["researcher"]);
});

test("manifests carry the allowlist and reject malformed ones", () => {
  const options = createSpawnOptions({});
  applyCatalog(options, { dir: "/tmp/x", manifest: { name: "router", description: "d", allowed_catalogs: ["researcher"] } });
  assert.deepEqual(options.allowedCatalogs, ["researcher"]);

  const explicit = createSpawnOptions({ allowedCatalogs: [] });
  applyCatalog(explicit, { dir: "/tmp/x", manifest: { name: "router", description: "d", allowed_catalogs: ["researcher"] } });
  assert.deepEqual(explicit.allowedCatalogs, [], "an explicit spawn-time allowlist wins over the manifest");

  assert.throws(
    () => validateManifest({ name: "router", description: "d", allowed_catalogs: "researcher" }, "router"),
    /allowed_catalogs must be an array/,
  );
  assert.throws(
    () => validateManifest({ name: "router", description: "d", allowed_catalogs: [""] }, "router"),
    /non-empty catalog names/,
  );
});

test("spawn arguments express both a narrowed and an empty allowlist", () => {
  assert.equal(parseSpawnArgs(["do a thing"]).allowedCatalogs, null);
  assert.deepEqual(
    parseSpawnArgs(["--allow-catalog", "researcher", "--allow-catalog", "general", "go"]).allowedCatalogs,
    ["researcher", "general"],
  );
  assert.deepEqual(parseSpawnArgs(["--allow-no-catalogs", "go"]).allowedCatalogs, []);
});
