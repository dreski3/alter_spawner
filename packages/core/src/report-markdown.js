import { Marked } from "./vendor/marked/marked.js";

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!/^(https?:\/\/|mailto:|#)/i.test(href)) return label;
      return `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${label}</a>`;
    },
    image({ text }) {
      return `<span>${escapeHtml(text)}</span>`;
    },
  },
});

export const renderReportMarkdown = (text) => markdown.parse(String(text ?? ""));
