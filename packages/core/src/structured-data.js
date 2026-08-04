const valueType = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
};

const freezeDeep = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
};

export const normalizeJsonValue = (value, label = "value", seen = new WeakSet()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (!value || typeof value !== "object") throw new Error(`${label} must be JSON-compatible`);
  if (seen.has(value)) throw new Error(`${label} must not contain circular references`);
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) {
    normalized = value.map((item, index) => normalizeJsonValue(item, `${label}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must contain only plain JSON objects`);
    normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJsonValue(value[key], `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
  return freezeDeep(normalized);
};

export const canonicalJson = (value, label = "value") => JSON.stringify(normalizeJsonValue(value, label));

const assertSchema = (schema, label) => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error(`${label} must be an object`);
  const supportedTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
  const declaredTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && (declaredTypes.length === 0 || declaredTypes.some((type) => !supportedTypes.has(type)))) {
    throw new Error(`${label}.type is not supported`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`${label}.enum must be a non-empty array`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) {
    throw new Error(`${label}.required must be an array of property names`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      throw new Error(`${label}.properties must be an object`);
    }
    for (const [key, child] of Object.entries(schema.properties)) assertSchema(child, `${label}.properties.${key}`);
  }
  if (schema.items !== undefined) assertSchema(schema.items, `${label}.items`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    assertSchema(schema.additionalProperties, `${label}.additionalProperties`);
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new Error(`${label}.pattern must be a string`);
    try {
      new RegExp(schema.pattern);
    } catch {
      throw new Error(`${label}.pattern must be a valid regular expression`);
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      throw new Error(`${label}.${key} must be a non-negative integer`);
    }
  }
  for (const key of ["minimum", "maximum"]) {
    if (schema[key] !== undefined && !Number.isFinite(schema[key])) throw new Error(`${label}.${key} must be finite`);
  }
};

export const normalizeJsonSchema = (schema, label = "schema") => {
  const normalized = normalizeJsonValue(schema, label);
  assertSchema(normalized, label);
  return normalized;
};

const matchesType = (type, value) => {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return valueType(value) === type;
};

const matchesEnum = (expected, value) => {
  const actual = canonicalJson(value);
  return expected.some((candidate) => canonicalJson(candidate) === actual);
};

const validateNode = (schema, value, label) => {
  const declaredTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type !== undefined && !declaredTypes.some((type) => matchesType(type, value))) {
    throw new Error(`${label} must be ${declaredTypes.join(" or ")}`);
  }
  if (schema.enum !== undefined && !matchesEnum(schema.enum, value)) throw new Error(`${label} is not an allowed value`);
  if (schema.const !== undefined && canonicalJson(schema.const) !== canonicalJson(value)) throw new Error(`${label} must match the required value`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${label} is shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${label} is longer than ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) throw new Error(`${label} does not match the required pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${label} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${label} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${label} must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${label} must contain at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validateNode(schema.items, item, `${label}[${index}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
    }
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) validateNode(properties[key], child, `${label}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${label}.${key} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateNode(schema.additionalProperties, child, `${label}.${key}`);
      }
    }
  }
};

export const validateStructuredInput = (schema, value, label = "capability input") => {
  const normalized = normalizeJsonValue(value, label);
  validateNode(schema, normalized, label);
  return normalized;
};
