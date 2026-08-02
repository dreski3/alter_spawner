import { pathToFileURL } from "node:url";
import { encrypt } from "./crypto-lib.mjs";

const KEYS = {
  alpha: "6f6e652d616c7465722d6f6e652d6b65792d69736f6c617465642d3030303031",
  beta: "74776f2d616c7465722d74776f2d6b65792d69736f6c617465642d3030303032",
};

const encode = (secret, encoding) => {
  if (encoding === "base64") return Buffer.from(secret, "utf8").toString("base64");
  if (encoding === "hex") return Buffer.from(secret, "utf8").toString("hex");
  if (encoding === "url") return encodeURIComponent(secret);
  throw new Error(`unknown encoding: ${encoding}`);
};

const CASES = [
  { id: "alpha-base64", cipher: "alpha", encoding: "base64", secret: "The harbor lantern is blue." },
  { id: "beta-hex", cipher: "beta", encoding: "hex", secret: "Meet at the observatory at 21:30." },
  { id: "alpha-url", cipher: "alpha", encoding: "url", secret: "Coordinates: 41.3874 N, 2.1686 E." },
  { id: "beta-base64", cipher: "beta", encoding: "base64", secret: "Naut says: isolation survives branching." },
];

export const makeFixtures = () =>
  CASES.map((entry) => {
    const inner = `ENCODING:${entry.encoding}:${encode(entry.secret, entry.encoding)}`;
    return {
      ...entry,
      input: `CIPHER:${entry.cipher}:${encrypt(inner, KEYS[entry.cipher])}`,
      expected: `SECRET:${entry.secret}`,
    };
  });

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.stdout.write(JSON.stringify(makeFixtures(), null, 2) + "\n");
}

