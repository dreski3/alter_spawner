import { decrypt } from "./crypto-lib.mjs";
import { advanceRelay, resolveRelayInput } from "./store-lib.mjs";

const ALPHA_KEY = "6f6e652d616c7465722d6f6e652d6b65792d69736f6c617465642d3030303031";
const input = process.argv[2] || "";

try {
  const resolved = resolveRelayInput(input, "CIPHER", "alpha");
  process.stdout.write(advanceRelay(resolved, decrypt(resolved.payload, ALPHA_KEY)));
} catch (error) {
  process.stderr.write(`alpha decrypt failed: ${error.message}\n`);
  process.exitCode = 1;
}
