/**
 * Tiny markdown renderer for the blog posts (no npm deps).
 *
 * Supports exactly the constructs the blog content uses:
 *   - `## ` / `### ` headings
 *   - `- ` bullet lists, `1. ` ordered lists
 *   - `**bold**` inline
 *   - bare URLs (https://…) → links (trailing sentence punctuation stripped)
 *   - bare /blog/<slug> paths → internal links
 *   - paragraphs; everything HTML-escaped
 * Anything else is rendered as plain escaped text — honest rendering, no magic.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const BLOG_PATH_RE = /(\/blog\/[a-z0-9-]+)/g;

/** Linkify bare URLs and /blog/<slug> paths inside already-escaped text. */
function linkify(escaped: string): string {
  let out = escaped.replace(URL_RE, (url) => {
    // Strip trailing sentence punctuation (.,;) from the URL, keep it as text.
    const m = /^(.+?)([.,;:!?]+)$/.exec(url);
    const href = m ? m[1] : url;
    const tail = m ? m[2] : "";
    return `<a href="${href}" rel="noopener">${href}</a>${tail}`;
  });
  out = out.replace(BLOG_PATH_RE, (path) => `<a href="${path}">${path}</a>`);
  return out;
}

/** Inline: **bold** + links. Input is raw (unescaped) text. */
function inline(text: string): string {
  const parts = text.split("**");
  return parts
    .map((part, i) => {
      const escaped = linkify(escapeHtml(part));
      return i % 2 === 1 ? `<strong>${escaped}</strong>` : escaped;
    })
    .join("");
}

interface Block {
  kind: "h2" | "h3" | "ul" | "ol" | "p";
  items?: string[];
  text?: string;
}

function parseBlocks(bodyMd: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const rawLine of bodyMd.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    const h3 = /^###\s+(.+)$/.exec(line);
    const ul = /^[-*]\s+(.+)$/.exec(line);
    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (h2) {
      flush();
      current = { kind: "h2", text: h2[1] };
      flush();
    } else if (h3) {
      flush();
      current = { kind: "h3", text: h3[1] };
      flush();
    } else if (ul) {
      if (current?.kind !== "ul") {
        flush();
        current = { kind: "ul", items: [] };
      }
      current.items!.push(ul[1]);
    } else if (ol) {
      if (current?.kind !== "ol") {
        flush();
        current = { kind: "ol", items: [] };
      }
      current.items!.push(ol[1]);
    } else {
      if (current?.kind !== "p") {
        flush();
        current = { kind: "p", items: [] };
      }
      current.items!.push(line);
    }
  }
  flush();
  return blocks;
}

/** Render the markdown body to an HTML fragment (safe, escaped). */
export function renderMarkdown(bodyMd: string): string {
  const blocks = parseBlocks(bodyMd);
  return blocks
    .map((b) => {
      switch (b.kind) {
        case "h2":
          return `<h2>${inline(b.text ?? "")}</h2>`;
        case "h3":
          return `<h3>${inline(b.text ?? "")}</h3>`;
        case "ul":
          return `<ul>${(b.items ?? []).map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`;
        case "ol":
          return `<ol>${(b.items ?? []).map((i) => `<li>${inline(i)}</li>`).join("")}</ol>`;
        case "p":
        default:
          return `<p>${(b.items ?? []).map(inline).join(" ")}</p>`;
      }
    })
    .join("\n");
}
