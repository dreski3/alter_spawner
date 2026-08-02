import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setupCipherRelay } from "../../../../examples/cipher-relay/setup.mjs";
import { makeFixtures } from "../../../../examples/cipher-relay/tools/make-fixtures.mjs";

const example = fileURLToPath(new URL("../../../../examples/cipher-relay/", import.meta.url));
const tools = path.join(example, "tools");

test("cipher relay fixtures require the matching isolated decryptor and decoder tools", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mind-cipher-relay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  setupCipherRelay(root, { model: "test/model" });
  const routes = {
    alpha: path.join(tools, "decrypt-alpha.mjs"),
    beta: path.join(tools, "decrypt-beta.mjs"),
    base64: path.join(tools, "decode-base64.mjs"),
    hex: path.join(tools, "decode-hex.mjs"),
    url: path.join(tools, "decode-url.mjs"),
  };
  const store = path.join(root, ".alters", "cipher-relay-store");
  mkdirSync(store);
  for (const [index, fixture] of makeFixtures().entries()) {
    const decrypted = execFileSync("node", [routes[fixture.cipher], fixture.input], { encoding: "utf8" });
    assert.match(decrypted, new RegExp(`^ENCODING:${fixture.encoding}:`));
    const decoded = execFileSync("node", [routes[fixture.encoding], decrypted], { encoding: "utf8" });
    assert.equal(decoded, fixture.expected);
    const wrongCipher = fixture.cipher === "alpha" ? "beta" : "alpha";
    const rejected = spawnSync("node", [routes[wrongCipher], fixture.input], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    const artifactId = `fixture${index}`;
    const artifact = path.join(store, `${artifactId}.json`);
    writeFileSync(
      artifact,
      JSON.stringify({ id: artifactId, current: fixture.input, history: [{ route: `CIPHER:${fixture.cipher}` }] })
    );
    const firstHandle = `HANDLE:${artifactId}:CIPHER:${fixture.cipher}`;
    const secondHandle = execFileSync("node", [routes[fixture.cipher], firstHandle], {
      encoding: "utf8",
      env: { ...process.env, MIND_CIPHER_RELAY_STORE: store },
    });
    assert.equal(secondHandle, `HANDLE:${artifactId}:ENCODING:${fixture.encoding}`);
    const secret = execFileSync("node", [routes[fixture.encoding], secondHandle], {
      encoding: "utf8",
      env: { ...process.env, MIND_CIPHER_RELAY_STORE: store },
    });
    assert.equal(secret, fixture.expected);
    assert.equal(JSON.parse(readFileSync(artifact, "utf8")).current, fixture.expected);
  }
  const router = JSON.parse(
    readFileSync(path.join(root, ".alters", "catalog", "relay-router", "manifest.json"), "utf8")
  );
  assert.equal(router.nestable, true);
  assert.deepEqual(router.bash_allow, []);
  for (const name of ["alpha-decryptor", "beta-decryptor", "base64-decoder", "hex-decoder", "url-decoder"]) {
    const specialist = JSON.parse(
      readFileSync(path.join(root, ".alters", "catalog", name, "manifest.json"), "utf8")
    );
    assert.equal(specialist.nestable, false);
    assert.equal(specialist.bash_only, true);
    assert.equal(specialist.bash_allow.length, 1);
  }
});
