/**
 * Polite HTTP fetch: HireClarity Data identity, redirect handling, size cap,
 * timeouts. No CAPTCHA bypass, no paywall bypass, no JS rendering — we only
 * read what a normal HTTP client is allowed to read.
 */

import { USER_AGENT } from "./robots";
import type { FetchResult } from "./types";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap — posting pages are well under this
const TIMEOUT_MS = 25_000;

export interface PoliteFetchOptions {
  /** Override the 2 MB body cap (board list APIs can exceed it; default 2 MB). */
  maxBytes?: number;
  /** Override the 25s request timeout (requirements extraction uses 15s to bound cron runs). */
  timeoutMs?: number;
}

export async function politeFetch(url: string, opts?: PoliteFetchOptions): Promise<FetchResult> {
  let current = url;
  const redirects: string[] = [];
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let res: Response;
    try {
      res = await fetch(current, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, status: null, finalUrl: current, contentType: null, body: null, truncated: false, note: `fetch failed: ${msg}` };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) {
        return { ok: false, status: res.status, finalUrl: current, contentType: null, body: null, truncated: false, note: `redirect without Location (HTTP ${res.status})` };
      }
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        return { ok: false, status: res.status, finalUrl: current, contentType: null, body: null, truncated: false, note: `unparseable redirect target: ${loc}` };
      }
      // Never follow https -> http downgrades.
      if (new URL(next).protocol !== "https:" && new URL(current).protocol === "https:") {
        return { ok: false, status: res.status, finalUrl: current, contentType: null, body: null, truncated: false, note: `refusing https->http redirect to ${next}` };
      }
      redirects.push(next);
      current = next;
      continue;
    }

    // Read body with a hard size cap so a pathological page can't blow memory.
    const cap = opts?.maxBytes ?? MAX_BYTES;
    const ct = res.headers.get("content-type");
    const buf = await readCapped(res, cap);
    const body = buf.text;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      finalUrl: res.url && res.url !== "about:blank" ? res.url : current,
      contentType: ct,
      body,
      truncated: buf.truncated,
      note: redirects.length ? `followed ${redirects.length} redirect(s)` : null,
    };
  }
  return { ok: false, status: null, finalUrl: current, contentType: null, body: null, truncated: false, note: `too many redirects (${MAX_REDIRECTS})` };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      truncated = true;
      // Drain the rest so the connection can be reused/pooled cleanly.
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  // Content-type charset is usually utf-8 for these pages; decode as utf-8.
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated };
}
