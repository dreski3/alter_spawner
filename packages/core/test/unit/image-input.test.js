import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_IMAGE_FILES,
  modelImageSupport,
  validateImageFiles,
} from "../../src/index.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

const workspace = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mind-images-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("image files are canonicalized, inspected, bounded, and described without persisting paths", (t) => {
  const root = workspace(t);
  const file = path.join(root, "sample.png");
  writeFileSync(file, png);
  const [image] = validateImageFiles(root, [file]);
  assert.equal(image.path, realpathSync(file));
  assert.deepEqual(image.metadata, {
    name: "sample.png",
    media_type: "image/png",
    bytes: png.length,
    sha256: "1b56b50ac4e976f488f128cabdcdffb2fc9331d6974bb9968131a415d14ade24",
  });
  assert.equal("path" in image.metadata, false);
});

test("unsupported files and unbounded attachment lists are rejected", (t) => {
  const root = workspace(t);
  const text = path.join(root, "not-an-image.png");
  writeFileSync(text, "hello");
  assert.throws(() => validateImageFiles(root, [text]), /unsupported image format/);
  assert.throws(
    () => validateImageFiles(root, Array.from({ length: MAX_IMAGE_FILES + 1 }, () => text)),
    /at most 8 images/,
  );
});

test("JPEG, GIF, and WebP signatures are recognized independently of filenames", (t) => {
  const root = workspace(t);
  const fixtures = [
    ["jpeg.bin", Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg"],
    ["gif.bin", Buffer.from("GIF89a000000", "ascii"), "image/gif"],
    ["webp.bin", Buffer.from("RIFF0000WEBP", "ascii"), "image/webp"],
  ];
  for (const [name, contents, expected] of fixtures) {
    const file = path.join(root, name);
    writeFileSync(file, contents);
    assert.equal(validateImageFiles(root, [file])[0].metadata.media_type, expected);
  }
});

test("nested callers can attach only files in their home or explicit read grants", (t) => {
  const outer = workspace(t);
  const root = path.join(outer, "home");
  mkdirSync(root);
  const local = path.join(root, "local.png");
  const granted = path.join(outer, "granted.png");
  const sibling = path.join(outer, "sibling.png");
  writeFileSync(local, png);
  writeFileSync(granted, png);
  writeFileSync(sibling, png);
  const options = { environment: { ALTER_DEPTH: "0" } };
  assert.equal(validateImageFiles(root, [local], options).length, 1);
  assert.throws(() => validateImageFiles(root, [sibling], options), /outside its home or read grants/);
  assert.equal(validateImageFiles(root, [granted], { ...options, readGrants: [granted] }).length, 1);
  assert.throws(
    () => validateImageFiles(root, [sibling], { ...options, readGrants: [granted] }),
    /outside its home or read grants/,
  );
});

test("model metadata distinguishes vision, text-only, and unknown models", () => {
  const catalog = {
    p: {
      models: {
        vision: { modalities: { input: ["text", "image"], output: ["text"] }, attachment: true },
        text: { modalities: { input: ["text"], output: ["text"] }, attachment: false },
        generator: { modalities: { input: ["text", "image"], output: ["image"] }, attachment: true },
      },
    },
  };
  assert.equal(modelImageSupport("p/vision", catalog), true);
  assert.equal(modelImageSupport("p/text", catalog), false);
  assert.equal(modelImageSupport("p/generator", catalog), false);
  assert.equal(modelImageSupport("p/unknown", catalog), null);
});
