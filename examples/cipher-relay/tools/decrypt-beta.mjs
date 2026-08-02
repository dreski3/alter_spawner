import { decrypt } from "./crypto-lib.mjs";
import { advanceRelay, resolveRelayInput } from "./store-lib.mjs";

const BETA_KEY = "74776f2d616c7465722d74776f2d6b65792d69736f6c617465642d3030303032";
const input = process.argv[2] || "";

try {
  const resolved = resolveRelayInput(input, "CIPHER", "beta");
  process.stdout.write(advanceRelay(resolved, decrypt(resolved.payload, BETA_KEY)));
} catch (error) {
  process.stderr.write(`beta decrypt failed: ${error.message}\n`);
  process.exitCode = 1;
}
