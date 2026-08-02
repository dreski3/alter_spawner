import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const encrypt = (plaintext, keyHex) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
};

export const decrypt = (payload, keyHex) => {
  const envelope = Buffer.from(payload, "base64url");
  if (envelope.length < 29) throw new Error("ciphertext is too short");
  const iv = envelope.subarray(0, 12);
  const tag = envelope.subarray(12, 28);
  const ciphertext = envelope.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
};

export const parseTagged = (value, family, variant) => {
  const prefix = `${family}:${variant}:`;
  if (!value.startsWith(prefix)) throw new Error(`expected ${prefix}<payload>`);
  return value.slice(prefix.length);
};

