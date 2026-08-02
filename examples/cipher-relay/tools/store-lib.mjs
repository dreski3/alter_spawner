import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseTagged } from "./crypto-lib.mjs";

const HANDLE_PATTERN = /^HANDLE:([a-zA-Z0-9_-]+):([A-Z]+):([a-z0-9]+)$/;

const save = (state) => {
  writeFileSync(state.file, JSON.stringify(state.record, null, 2) + "\n");
};

export const resolveRelayInput = (input, family, variant) => {
  const match = input.match(HANDLE_PATTERN);
  if (!match) return { payload: parseTagged(input, family, variant), state: null };
  if (match[2] !== family || match[3] !== variant) {
    throw new Error(`handle route is ${match[2]}:${match[3]}, expected ${family}:${variant}`);
  }
  const store = process.env.MIND_CIPHER_RELAY_STORE;
  if (!store) throw new Error("MIND_CIPHER_RELAY_STORE is not set");
  const file = path.join(store, `${match[1]}.json`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  return {
    payload: parseTagged(record.current, family, variant),
    state: { id: match[1], file, record },
  };
};

export const advanceRelay = (resolved, value) => {
  if (!resolved.state) return value;
  const route = value.match(/^([A-Z]+):([a-z0-9]+):/);
  if (!route) throw new Error("transformed value has no relay route");
  resolved.state.record.current = value;
  resolved.state.record.history.push({ route: `${route[1]}:${route[2]}`, at: new Date().toISOString() });
  save(resolved.state);
  return `HANDLE:${resolved.state.id}:${route[1]}:${route[2]}`;
};

export const finishRelay = (resolved, value) => {
  if (resolved.state) {
    resolved.state.record.current = value;
    resolved.state.record.history.push({ route: "SECRET", at: new Date().toISOString() });
    save(resolved.state);
  }
  return value;
};

