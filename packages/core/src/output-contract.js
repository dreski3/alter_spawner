import { fail } from "./util.js";

const TYPES = new Set(["nonempty", "exact", "prefix", "regex", "json"]);

export const validateOutputContract = (contract, label = "output contract") => {
  if (contract == null) return;
  if (typeof contract !== "object" || Array.isArray(contract)) fail(`${label} must be an object or null.`);
  if (!TYPES.has(contract.type)) fail(`${label}.type must be one of: ${[...TYPES].join(", ")}.`);
  if (["exact", "prefix"].includes(contract.type) && typeof contract.value !== "string") {
    fail(`${label}.value must be a string for type "${contract.type}".`);
  }
  if (contract.type === "regex") {
    if (typeof contract.pattern !== "string" || !contract.pattern) fail(`${label}.pattern must be a non-empty string.`);
    try {
      new RegExp(contract.pattern, contract.flags || "");
    } catch (error) {
      fail(`${label}.pattern is invalid (${error.message}).`);
    }
  }
};

export const checkOutputContract = (text, contract) => {
  if (!contract) return { ok: true, error: null };
  const output = contract.trim === false ? String(text || "") : String(text || "").trim();
  let ok = false;
  if (contract.type === "nonempty") ok = output.length > 0;
  else if (contract.type === "exact") ok = output === contract.value;
  else if (contract.type === "prefix") ok = output.startsWith(contract.value);
  else if (contract.type === "regex") ok = new RegExp(contract.pattern, contract.flags || "").test(output);
  else if (contract.type === "json") {
    try {
      JSON.parse(output);
      ok = true;
    } catch {}
  }
  return { ok, error: ok ? null : `output did not satisfy ${contract.type} contract` };
};
