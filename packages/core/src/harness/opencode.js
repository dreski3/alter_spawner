import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { registerHarness } from "./adapter.js";
import {
  classifyOpenCodeResult,
  consumeOpenCodeEvent,
  createOpenCodeAccumulator,
} from "./opencode-events.js";

// Classifies a finished run. Kept pure (and exported) so the outcome table can be
// tested without spawning a real `opencode` process.
//
// A run that exits cleanly but produces no final assistant message is its own
// failure mode, not a success: an Alter's final message *is* its result — the
// alter-home AGENTS.md tells it so explicitly ("it is all your parent will
// receive from you") — so nothing to report means nothing was delivered.
// Observed with `zai-coding-plan/glm-4.5-air`, which can return exit code 0,
// no kill, no budget overrun, with only step_start/step_finish events, no `text`
// event at all, and ~1 output token; `result.md` ends up as "(no output)".
//
// `empty_output` folds into `ok` the same way `budget_exceeded` already does, so
// the existing attempt plan in retry.js treats it as a failed attempt and
// escalates (same model, then fallback) instead of recording a silent success.
// Precedence matters: a killed or over-budget run may legitimately have no text
// yet, and its real reason is the kill/overrun — only a clean exit can be
// classified as empty.
export const classify = classifyOpenCodeResult;

// Exported for the same reason as `classify`: the argument vector decides how much
// this run costs, so it should be assertable without spawning a real `opencode`.
export const buildRunArgs = ({ home, prompt, pure, agent, sessionId, title, alterId, model }) => {
  const args = ["run"];
  if (pure) args.push("--pure");
  if (agent) args.push("--agent", agent);
  args.push("--dir", home, "--format", "json");
  // Naming the session ourselves suppresses opencode's own title generation, which
  // is a second, separately billed model call (its own ~2k-char system prompt)
  // whose only product is a label nothing here ever reads. Measured at 2,481 bytes
  // / ~620 input tokens per spawn — for a trivial leaf, 18% of the entire run.
  // Only a new session needs one; continuing with `--session` already has a title.
  if (sessionId) args.push("--session", sessionId);
  else if (title || alterId) args.push("--title", title || alterId);
  if (model) args.push("--model", model);
  args.push(prompt);
  return args;
};

// Token-budget enforcement kills the child as soon as usage becomes visible on stdout.
// Whether that is genuinely mid-run or only once opencode has already finished and flushed
// everything at once depends on opencode's own buffering for --format json, which this tool
// does not control. In the worst case, enforcement is equivalent to "reject after the fact":
// the run has already spent its tokens, and the only effect is result.json recording
// ok:false, budget_exceeded:true with no further retries proceeding.
const run = (
  home,
  prompt,
  {
    timeout,
    depth,
    alterId,
    maxTokens,
    model,
    pure,
    recordEvents,
    attempt,
    signal,
    onEvent,
    environment = process.env,
    // A single-use Alter always runs as the generated `alter` agent in a throwaway
    // home. A principal turn instead runs a project's own agent and continues one
    // long-lived session, so both are parameters rather than constants.
    agent = "alter",
    sessionId = null,
    title = null,
  }
) =>
  new Promise((resolve) => {
    const args = buildRunArgs({ home, prompt, pure, agent, sessionId, title, alterId, model });
    const child = spawn(
      "opencode",
      args,
      {
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: {
          ...environment,
          ALTER_DEPTH: String(depth),
          ALTER_ID: alterId || "",
        },
      }
    );
    let buf = "";
    const acc = createOpenCodeAccumulator();
    let settled = false;
    let timer;
    let forceKillTimer;
    let budgetExceeded = false;
    let aborted = false;
    const eventLog = recordEvents ? path.join(home, `attempt-${attempt || 1}.events.jsonl`) : null;
    const eventStream = eventLog ? createWriteStream(eventLog, { flags: "w" }) : null;
    const eventStreamDone = eventStream
      ? new Promise((done) => {
          eventStream.on("finish", done);
          eventStream.on("error", done);
        })
      : Promise.resolve();
    const killProcessTree = (signalName) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch {
        try {
          child.kill(signalName);
        } catch {}
      }
    };
    child.stdout.on("data", (d) => {
      eventStream?.write(d);
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        consumeOpenCodeEvent(line, acc, onEvent);
        if (!budgetExceeded && maxTokens && acc.tokens.total > maxTokens) {
          budgetExceeded = true;
          killProcessTree("SIGKILL");
        }
      }
    });
    child.stderr.on("data", (d) => {
      process.stderr.write("(alter stderr) " + d.toString());
    });
    const finish = (exitCode, killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      if (buf.trim()) consumeOpenCodeEvent(buf, acc, onEvent);
      const output = {
        tokens: acc.tokens,
        text: acc.text,
        sessionID: acc.sessionID,
        steps: acc.steps,
        tools: acc.tools,
        exitCode,
        killed,
        aborted,
        eventLog,
        ...classifyOpenCodeResult({ exitCode, killed, budgetExceeded, text: acc.text }),
      };
      eventStream?.end();
      eventStreamDone.then(() => resolve(output));
    };
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      killProcessTree("SIGTERM");
      forceKillTimer = setTimeout(() => {
        killProcessTree("SIGKILL");
      }, 2000);
      forceKillTimer.unref();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => {
      killProcessTree("SIGKILL");
      finish(-1, true);
    }, timeout);
    child.on("error", (e) => {
      process.stderr.write("alter spawn error: " + e.message + "\n");
      finish(-2, false);
    });
    child.on("close", (code) => finish(code, budgetExceeded || aborted));
  });

registerHarness("opencode", { run });
