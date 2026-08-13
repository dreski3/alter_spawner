import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PRINCIPAL_DEPTH, isPrincipalProject, registerHarness, runPrincipalTurn } from "../../src/index.js";

const makeProject = (t, config = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mind-principal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, ".alters"), { recursive: true });
  writeFileSync(path.join(dir, ".alters", "config.json"), JSON.stringify({
    default_model: "test/model",
    run_timeout_ms: 1000,
    catalog_dir: "catalog",
    retry: { same_harness_retries: 1, fallback_retries: 1 },
    ...config,
  }));
  writeFileSync(path.join(dir, "AGENTS.md"), "# user authored\n");
  return dir;
};

const stubHarness = (name, responses, options = {}) => {
  const calls = [];
  registerHarness(name, {
    ...options,
    run: async (home, prompt, options) => {
      calls.push({ home, prompt, ...options });
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      return {
        tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, total: 2 },
        text: response.text ?? "answer",
        sessionID: response.sessionID ?? null,
        steps: 1,
        exitCode: response.ok === false ? 1 : 0,
        killed: false,
        ok: response.ok !== false,
        budget_exceeded: false,
        empty_output: false,
      };
    },
  });
  return calls;
};

test("a first principal turn opens a session and reports it back", async (t) => {
  const dir = makeProject(t);
  const calls = stubHarness("stub-open", [{ sessionID: "ses_first" }]);
  const turn = await runPrincipalTurn(dir, { prompt: "hello", harness: "stub-open", principalId: "conv_1" });

  assert.equal(turn.ok, true);
  assert.equal(turn.sessionId, "ses_first");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, null, "a first turn must not ask to continue a session");
  assert.equal(calls[0].home, dir, "the principal runs in the project itself, not a scaffolded home");
  assert.equal(calls[0].depth, PRINCIPAL_DEPTH, "alters it spawns land at depth 0");
  assert.equal(calls[0].alterId, "conv_1");
  assert.equal(calls[0].agent, null, "the project's own default agent runs, not the generated alter agent");
});

test("a later turn continues the session it is given", async (t) => {
  const dir = makeProject(t);
  const calls = stubHarness("stub-continue", [{ sessionID: "ses_first" }]);
  const turn = await runPrincipalTurn(dir, { prompt: "again", sessionId: "ses_first", harness: "stub-continue" });

  assert.equal(calls[0].sessionId, "ses_first");
  assert.equal(turn.sessionId, "ses_first");
});

test("a turn keeps its session even when the harness stops reporting one", async (t) => {
  const dir = makeProject(t);
  stubHarness("stub-nosession", [{ sessionID: null }]);
  const turn = await runPrincipalTurn(dir, { prompt: "again", sessionId: "ses_kept", harness: "stub-nosession" });
  assert.equal(turn.sessionId, "ses_kept", "continuity must not be dropped by a quiet harness");
});

test("a principal turn never rewrites the project's own agent definition", async (t) => {
  const dir = makeProject(t, { default_fallback_model: "test/fallback" });
  const before = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  const calls = stubHarness("stub-retry", [{ ok: false }, { ok: false }, { sessionID: "ses_x" }]);
  await runPrincipalTurn(dir, { prompt: "hello", harness: "stub-retry" });

  assert.equal(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), before);
  assert.equal(
    calls.every((call) => call.model === "test/model"),
    true,
    "a principal must not silently swap the model the user is talking to",
  );
  assert.equal(calls.length, 2, "one retry, and no fallback tier");
});

test("a directory without .alters/config.json is refused", async (t) => {
  const bare = mkdtempSync(path.join(tmpdir(), "mind-bare-"));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(isPrincipalProject(bare), false);
  await assert.rejects(
    () => runPrincipalTurn(bare, { prompt: "hello", harness: "stub-open" }),
    /not a mind project/,
  );
});

test("an empty prompt is refused before the harness is touched", async (t) => {
  const dir = makeProject(t);
  const calls = stubHarness("stub-empty", [{ sessionID: "ses" }]);
  await assert.rejects(() => runPrincipalTurn(dir, { prompt: "   ", harness: "stub-empty" }), /non-empty prompt/);
  assert.equal(calls.length, 0);
});

test("a principal turn validates and forwards image attachments", async (t) => {
  const dir = makeProject(t);
  const image = path.join(dir, "reference.png");
  writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
  const calls = stubHarness("stub-images", [{ sessionID: "ses_image" }], { supportsImages: true });

  await runPrincipalTurn(dir, { prompt: "describe it", images: [image], harness: "stub-images" });

  assert.deepEqual(calls[0].images, [realpathSync(image)]);
});

test("a principal turn rejects images for a text-only harness", async (t) => {
  const dir = makeProject(t);
  const image = path.join(dir, "reference.png");
  writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
  stubHarness("stub-no-images", [{ sessionID: "ses_text" }]);

  await assert.rejects(
    () => runPrincipalTurn(dir, { prompt: "describe it", images: [image], harness: "stub-no-images" }),
    /does not support image inputs/,
  );
});
