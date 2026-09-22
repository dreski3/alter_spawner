import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const availablePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const killTree = (child, signal) => {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
};

// One workflow-owned server is the write owner for OpenCode's session database.
// Attached clients can overlap without several OpenCode server processes racing to
// open and migrate the same SQLite store.
export const startWorkflowOpenCodeServer = async ({
  environment = process.env,
  startupTimeoutMs = 10000,
  spawnProcess = spawn,
  choosePort = availablePort,
} = {}) => {
  const port = await choosePort();
  const password = randomUUID();
  const child = spawnProcess(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: { ...environment, OPENCODE_SERVER_PASSWORD: password },
    },
  );
  const expected = `http://127.0.0.1:${port}`;
  let output = "";
  let ready = false;
  let timer;
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const consume = (chunk) => {
        output = (output + chunk.toString()).slice(-4000);
        if (output.includes(`server listening on ${expected}`)) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.once("error", reject);
      child.once("close", (code) => {
        if (!ready) reject(new Error(`OpenCode server exited before startup (code ${code}): ${output.trim() || "no output"}`));
      });
      timer = setTimeout(() => reject(new Error(`OpenCode server did not start within ${startupTimeoutMs}ms: ${output.trim() || "no output"}`)), startupTimeoutMs);
    });
  } catch (error) {
    clearTimeout(timer);
    killTree(child, "SIGTERM");
    throw error;
  }

  return {
    url: expected,
    environment: { ...environment, OPENCODE_SERVER_URL: expected, OPENCODE_SERVER_PASSWORD: password },
    async stop() {
      if (child.exitCode != null || child.signalCode != null) return;
      killTree(child, "SIGTERM");
      const stopped = await Promise.race([
        closed.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);
      if (!stopped) killTree(child, "SIGKILL");
    },
  };
};
