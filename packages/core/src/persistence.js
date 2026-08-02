import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ALTER_SCHEMA_VERSION = 1;
export const RESULT_SCHEMA_VERSION = 1;
export const GRAPH_RESULT_SCHEMA_VERSION = 1;

export const writeTextAtomic = (file, content) => {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
};

export const writeJsonAtomic = (file, value) => {
  writeTextAtomic(file, JSON.stringify(value, null, 2) + "\n");
};
