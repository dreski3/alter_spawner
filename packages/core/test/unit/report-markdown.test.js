import test from "node:test";
import assert from "node:assert/strict";
import { renderReportMarkdown } from "../../src/report-markdown.js";

test("report Markdown renders engineering answers with block and inline formatting", () => {
  const html = renderReportMarkdown('# Plan\n\n## Interface\n\n**Bold** and *emphasis*, `code`.\n\n1. First\n2. Second\n   - Nested\n\n> Evidence\n\n```js\nconst x = "<safe>";\n```\n\n| Step | Result |\n| --- | --- |\n| Test | Pass |\n\n[Docs](https://example.com/docs)');
  for (const tag of ["h1", "h2", "strong", "em", "code", "ol", "ul", "blockquote", "pre", "table"]) assert.match(html, new RegExp(`<${tag}[ >]`));
  assert.match(html, /&lt;safe&gt;/);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.doesNotMatch(html, /```|\*\*Bold\*\*/);
});

test("report Markdown escapes raw HTML, rejects executable links, and never loads images", () => {
  const html = renderReportMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n[encoded](javascript&#58;alert%281%29)\n\n![image](https://example.com/tracker.png)\n\n[local](file:///etc/passwd)');
  assert.doesNotMatch(html, /<script|<img|href=/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<span>image<\/span>/);
});
