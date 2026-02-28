import { marked } from "marked";

const HTML_TAG_RE = /<\/?[a-z][\s\S]*>/i;

export function looksLikeHtml(value: string): boolean {
  return HTML_TAG_RE.test(value);
}

export function markdownToHtml(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const rendered = marked.parse(normalized, { gfm: true, breaks: true });
  return typeof rendered === "string" ? rendered : normalized;
}

export function normalizeDocumentHtml(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (looksLikeHtml(trimmed)) return trimmed;
  return markdownToHtml(trimmed);
}
