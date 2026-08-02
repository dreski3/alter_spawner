import { finishRelay, resolveRelayInput } from "./store-lib.mjs";

try {
  const resolved = resolveRelayInput(process.argv[2] || "", "ENCODING", "hex");
  const secret = `SECRET:${Buffer.from(resolved.payload, "hex").toString("utf8")}`;
  process.stdout.write(finishRelay(resolved, secret));
} catch (error) {
  process.stderr.write(`hex decode failed: ${error.message}\n`);
  process.exitCode = 1;
}
