import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("./decision-laya.py", import.meta.url));

export const createLayaMlxAdviser = ({ env = process.env, python = env.LAYA_MLX_PYTHON || "python3", model_dir: modelDir = env.LAYA_MLX_MODEL_DIR, timeout_ms: timeoutMs = 30000 } = {}) => {
  if (typeof python !== "string" || !python.trim()) throw new Error("laya-mlx python must be a non-empty executable path");
  if (typeof modelDir !== "string" || !path.isAbsolute(modelDir) || !existsSync(path.join(modelDir, "model.safetensors"))) {
    throw new Error("laya-mlx model_dir must be an absolute path to a downloaded checkpoint");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("laya-mlx timeout_ms must be a positive integer");
  return Object.freeze({
    id: "laya-mlx",
    async decide({ signal, instructions, routes, abortSignal }) {
      const inputSize = signal.length + instructions.length + routes.reduce((size, route) => size + route.id.length + route.description.length, 0);
      if (inputSize > 1400) throw new Error("laya-mlx decision input exceeds its context budget");
      return new Promise((resolve, reject) => {
        const child = spawn(python, [bridge], { stdio: ["pipe", "pipe", "pipe"], env });
        let output = "";
        let error = "";
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          abortSignal?.removeEventListener("abort", abort);
          callback();
        };
        const abort = () => {
          child.kill("SIGTERM");
          finish(() => reject(new Error("laya-mlx decision cancelled")));
        };
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(() => reject(new Error("laya-mlx decision timed out")));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
          output += chunk.toString("utf8");
          if (output.length > 16384) {
            child.kill("SIGTERM");
            finish(() => reject(new Error("laya-mlx decision output exceeded limit")));
          }
        });
        child.stderr.on("data", (chunk) => { error = (error + chunk.toString("utf8")).slice(-4096); });
        child.stdin.on("error", () => {});
        child.on("error", (cause) => finish(() => reject(cause)));
        child.on("close", (code) => finish(() => {
          if (code !== 0) return reject(new Error(`laya-mlx decision failed: ${error.trim() || `exit ${code}`}`));
          try {
            resolve(JSON.parse(output));
          } catch {
            reject(new Error("laya-mlx returned malformed JSON"));
          }
        }));
        if (abortSignal?.aborted) abort();
        else {
          abortSignal?.addEventListener("abort", abort, { once: true });
          child.stdin.end(JSON.stringify({ model_dir: modelDir, signal, instructions, routes }));
        }
      });
    },
  });
};

export const decideRoute = async ({ adviser, signal, instructions, routes, fallbackRoute = null, abortSignal }) => {
  if (!adviser || typeof adviser.decide !== "function") throw new Error("decision adviser must provide decide");
  let recommendation;
  let reason = "adviser";
  let fallbackReason = null;
  try {
    recommendation = await adviser.decide({ signal, instructions, routes, abortSignal });
    if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation) ||
      typeof recommendation.id !== "string" || Object.keys(recommendation).length !== 1 ||
      !routes.some((route) => route.id === recommendation.id)) {
      throw new Error("decision adviser returned an invalid route id");
    }
  } catch (error) {
    if (abortSignal?.aborted || !fallbackRoute) throw error;
    recommendation = { id: fallbackRoute };
    reason = "fallback";
    fallbackReason = error?.message === "decision adviser returned an invalid route id"
      ? "invalid_choice"
      : error?.message?.includes("timed out") ? "timeout" : "adviser_unavailable";
  }
  return { id: recommendation.id, reason, fallbackReason };
};
