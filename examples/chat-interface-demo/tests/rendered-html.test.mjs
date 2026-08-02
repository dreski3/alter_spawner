import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Naut Relay catalog chat surface", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Naut Relay — Alter runtime chat<\/title>/i);
  assert.match(html, /Alter catalogs/);
  assert.match(html, /Adaptive relay/);
  assert.match(html, /Execution trace/);
  assert.match(html, /POST \/chat/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("keeps catalog data and runtime transport behind focused modules", async () => {
  const [page, catalogs, adapter, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/catalogs.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/chat-adapter.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /ALTER_CATALOGS/);
  assert.match(catalogs, /adaptive-router/);
  assert.match(adapter, /NEXT_PUBLIC_ALTER_API_URL/);
  assert.match(adapter, /POST/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
