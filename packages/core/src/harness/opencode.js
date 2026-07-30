import { spawn } from "node:child_process";
import { registerHarness } from "./adapter.js";

const parseLine = (line, acc) => {
  const t = line.trim();
  if (!t) return;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    return;
  }
  if (obj.type === "step_finish") {
    const tk = obj.part?.tokens || {};
    acc.tokens.input += tk.input || 0;
    acc.tokens.output += tk.output || 0;
    acc.tokens.reasoning += tk.reasoning || 0;
    acc.tokens.cache_read += tk.cache?.read || 0;
    acc.tokens.total += tk.total || 0;
    acc.steps += 1;
  } else if (obj.type === "text") {
    acc.text += obj.part?.text || "";
  }
  if (!acc.sessionID && obj.sessionID) acc.sessionID = obj.sessionID;
};

const newAcc = () => ({
  tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, total: 0 },
  text: "",
  sessionID: null,
  steps: 0,
});

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
export const classify = ({ exitCode, killed, budgetExceeded, text }) => {
  const clean = exitCode === 0 && !killed && !budgetExceeded;
  const empty_output = clean && String(text || "").trim() === "";
  return { ok: clean && !empty_output, empty_output, budget_exceeded: !!budgetExceeded };
};

// Token-budget enforcement kills the child as soon as usage becomes visible on stdout.
// Whether that is genuinely mid-run or only once opencode has already finished and flushed
// everything at once depends on opencode's own buffering for --format json, which this tool
// does not control. In the worst case, enforcement is equivalent to "reject after the fact":
// the run has already spent its tokens, and the only effect is result.json recording
// ok:false, budget_exceeded:true with no further retries proceeding.
const run = (home, prompt, { timeout, depth, alterId, maxTokens }) =>
  new Promise((resolve) => {
    const child = spawn(
      "opencode",
      ["run", "--agent", "alter", "--dir", home, "--format", "json", prompt],
      {
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ALTER_DEPTH: String(depth),
          ALTER_ID: alterId || "",
        },
      }
    );
    let buf = "";
    const acc = newAcc();
    let settled = false;
    let timer;
    let budgetExceeded = false;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        parseLine(line, acc);
        if (!budgetExceeded && maxTokens && acc.tokens.total > maxTokens) {
          budgetExceeded = true;
          try {
            child.kill("SIGKILL");
          } catch {}
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
      if (buf.trim()) parseLine(buf, acc);
      resolve({
        tokens: acc.tokens,
        text: acc.text,
        sessionID: acc.sessionID,
        steps: acc.steps,
        exitCode,
        killed,
        ...classify({ exitCode, killed, budgetExceeded, text: acc.text }),
      });
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(-1, true);
    }, timeout);
    child.on("error", (e) => {
      process.stderr.write("alter spawn error: " + e.message + "\n");
      finish(-2, false);
    });
    child.on("close", (code) => finish(code, budgetExceeded));
  });

registerHarness("opencode", { run });
