import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ALTER_SCHEMA_VERSION = 1;
export const RESULT_SCHEMA_VERSION = 1;
export const GRAPH_RESULT_SCHEMA_VERSION = 1;

export const writeTextAtomic = (file, content, options = {}) => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, options.mode === undefined ? undefined : { mode: options.mode });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
};

export const writeJsonAtomic = (file, value, options = {}) => {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + "\n", options);
};
