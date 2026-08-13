import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { loadModelsCatalog, modelsCatalogPath, splitModelRef } from "./providers.js";
import { fail } from "./util.js";

export const MAX_IMAGE_FILES = 8;
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 40 * 1024 * 1024;

const mediaType = (header) => {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (header.length >= 6 && ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))) {
    return "image/gif";
  }
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
};

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

const mayReadNestedImage = (root, file, readGrants) => {
  const directories = [realpathSync(root)];
  const exactFiles = [];
  for (const grant of readGrants || []) {
    try {
      const resolved = realpathSync(grant);
      if (statSync(resolved).isDirectory()) directories.push(resolved);
      else exactFiles.push(resolved);
    } catch {}
  }
  return exactFiles.includes(file) || directories.some((allowed) => inside(allowed, file));
};

export const validateImageFiles = (root, images, { readGrants = [], environment = process.env } = {}) => {
  if (!Array.isArray(images)) fail("images must be an array of file paths.");
  if (images.length > MAX_IMAGE_FILES) fail(`at most ${MAX_IMAGE_FILES} images may be attached to one Alter.`);
  const files = [];
  let totalBytes = 0;
  for (const supplied of images) {
    if (typeof supplied !== "string" || !supplied.trim()) fail("each image must be a non-empty file path.");
    let file;
    let stats;
    try {
      file = realpathSync(path.resolve(supplied));
      stats = statSync(file);
    } catch (error) {
      fail(`image is not readable: ${supplied} (${error?.code || error?.message || "unknown error"}).`);
    }
    if (!stats.isFile()) fail(`image must be a regular file: ${supplied}.`);
    if (stats.size > MAX_IMAGE_FILE_BYTES) {
      fail(`image exceeds the ${MAX_IMAGE_FILE_BYTES}-byte per-file limit: ${supplied} (${stats.size} bytes).`);
    }
    if (environment.ALTER_DEPTH !== undefined && !mayReadNestedImage(root, file, readGrants)) {
      fail(`nested Alter cannot attach an image outside its home or read grants: ${supplied}.`);
    }
    let contents;
    try {
      contents = readFileSync(file);
    } catch (error) {
      fail(`image is not readable: ${supplied} (${error?.code || error?.message || "unknown error"}).`);
    }
    if (contents.length > MAX_IMAGE_FILE_BYTES) {
      fail(`image exceeds the ${MAX_IMAGE_FILE_BYTES}-byte per-file limit: ${supplied} (${contents.length} bytes).`);
    }
    totalBytes += contents.length;
    if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
      fail(`images exceed the ${MAX_IMAGE_TOTAL_BYTES}-byte total limit.`);
    }
    const type = mediaType(contents.subarray(0, 12));
    if (!type) fail(`unsupported image format: ${supplied}; expected PNG, JPEG, GIF, or WebP.`);
    files.push({
      path: file,
      metadata: {
        name: path.basename(file),
        media_type: type,
        bytes: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
    });
  }
  return files;
};

export const modelImageSupport = (modelRef, catalog) => {
  let providerId;
  let modelId;
  try {
    ({ providerId, modelId } = splitModelRef(modelRef));
  } catch {
    return null;
  }
  const model = catalog?.[providerId]?.models?.[modelId];
  if (!model) return null;
  const input = model.modalities?.input;
  const output = model.modalities?.output;
  if (!Array.isArray(input)) return null;
  if (!input.includes("image")) return false;
  if (model.attachment === false) return false;
  if (Array.isArray(output) && !output.includes("text")) return false;
  return true;
};

export const validateImageModels = (models, environment = process.env) => {
  let catalog;
  try {
    catalog = loadModelsCatalog(modelsCatalogPath(environment));
  } catch {
    return;
  }
  for (const model of new Set(models)) {
    if (modelImageSupport(model, catalog) === false) {
      fail(`model "${model}" does not support attached image input with text output.`);
    }
  }
};
