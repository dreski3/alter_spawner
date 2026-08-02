import { finishRelay, resolveRelayInput } from "./store-lib.mjs";

try {
  const resolved = resolveRelayInput(process.argv[2] || "", "ENCODING", "url");
  process.stdout.write(finishRelay(resolved, `SECRET:${decodeURIComponent(resolved.payload)}`));
} catch (error) {
  process.stderr.write(`URL decode failed: ${error.message}\n`);
  process.exitCode = 1;
}
