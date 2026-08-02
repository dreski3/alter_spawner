import { finishRelay, resolveRelayInput } from "./store-lib.mjs";

try {
  const resolved = resolveRelayInput(process.argv[2] || "", "ENCODING", "base64");
  const secret = `SECRET:${Buffer.from(resolved.payload, "base64").toString("utf8")}`;
  process.stdout.write(finishRelay(resolved, secret));
} catch (error) {
  process.stderr.write(`base64 decode failed: ${error.message}\n`);
  process.exitCode = 1;
}
