/**
 * Polite crawling: robots.txt checking + per-host rate limiting.
 *
 * - Fetches and caches robots.txt once per origin (process lifetime).
 * - Matches our UA (HireClarityDataBot) with the longest-match rule, falling back
 *   to `*`. Supports Disallow/Allow with `*` wildcards and `$` anchors, plus
 *   Crawl-delay.
 * - If robots.txt can't be fetched (timeout, 4xx/5xx, unparseable), we treat
 *   the site as allowed but record a note — standard practice, and the note
 *   keeps the observation honest.
 * - A global minimum interval between requests to the same host (default 2s)
 *   is enforced alongside any Crawl-delay the site declares.
 */

import type { RobotsInspection } from "./types";

export const USER_AGENT = "HireClarityDataBot/0.1 (+https://hireclarity-data.vercel.app)";

interface RobotsRules {
  allow: { pattern: RegExp; length: number }[];
  disallow: { pattern: RegExp; length: number }[];
  crawlDelay: number | null; // seconds
  note: string | null;
}

const cache = new Map<string, RobotsRules>();
const lastRequestAt = new Map<string, number>();

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Convert a robots.txt pattern (`*` wildcard, `$` anchor) to a RegExp. */
function patternToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") out += ".*";
    else if (ch === "$" && i === pattern.length - 1) out += "$";
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out);
}

function parseRobots(text: string): RobotsRules {
  const rules: RobotsRules = { allow: [], disallow: [], crawlDelay: null, note: null };
  let group: string | null = null; // current user-agent token
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      group = value.toLowerCase();
      continue;
    }
    if (!group) continue;
    // Only consider the group that matches our UA or the wildcard group.
    const relevant =
      group === "*" || group.includes("hireclarity") || group.startsWith("hireclarity");
    if (!relevant) continue;
    if (field === "disallow" && value) {
      rules.disallow.push({ pattern: patternToRegex(value), length: value.length });
    } else if (field === "allow" && value) {
      rules.allow.push({ pattern: patternToRegex(value), length: value.length });
    } else if (field === "crawl-delay") {
      const d = parseFloat(value);
      if (Number.isFinite(d) && d >= 0) rules.crawlDelay = d;
    }
  }
  if (!rules.disallow.length && !rules.allow.length) {
    rules.note = "robots.txt has no applicable rules; treating as allowed";
  }
  return rules;
}

async function loadRules(origin: string): Promise<RobotsRules> {
  const cached = cache.get(origin);
  if (cached) return cached;
  let rules: RobotsRules;
  try {
    const res = await fetch(origin + "/robots.txt", {
      headers: { "user-agent": USER_AGENT, accept: "text/plain" },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      rules = parseRobots(text);
    } else {
      rules = { allow: [], disallow: [], crawlDelay: null, note: `robots.txt unreachable (HTTP ${res.status}); treating as allowed` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rules = { allow: [], disallow: [], crawlDelay: null, note: `robots.txt fetch failed (${msg}); treating as allowed` };
  }
  cache.set(origin, rules);
  return rules;
}

/**
 * Check whether fetching `url` is allowed. Returns {allowed, note, crawlDelay}.
 */
export async function checkAllowed(url: string): Promise<{ allowed: boolean; note: string | null; crawlDelay: number | null }> {
  const origin = originOf(url);
  if (!origin) return { allowed: false, note: `unparseable URL: ${url}`, crawlDelay: null };
  const rules = await loadRules(origin);
  try {
    const path = new URL(url).pathname;
    // Longest matching rule wins; Allow beats Disallow on ties.
    let best: { kind: "allow" | "disallow"; length: number } | null = null;
    for (const r of rules.disallow) {
      if (r.pattern.test(path) && (!best || r.length > best.length)) best = { kind: "disallow", length: r.length };
    }
    for (const r of rules.allow) {
      if (r.pattern.test(path) && (!best || r.length > best.length)) best = { kind: "allow", length: r.length };
    }
    const allowed = best?.kind !== "disallow";
    return { allowed, note: rules.note, crawlDelay: rules.crawlDelay };
  } catch {
    return { allowed: false, note: `could not parse URL for robots check: ${url}`, crawlDelay: null };
  }
}

/**
 * Enforce a minimum interval between requests to the same host.
 * Returns a promise that resolves when the next request may fire.
 */
export async function throttle(host: string, crawlDelay: number | null, minIntervalMs = 2000): Promise<void> {
  const need = Math.max(minIntervalMs, (crawlDelay ?? 0) * 1000);
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + need - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/** Debug/audit helper: what robots.txt rule applied for a URL (used by `bun run robots`). */
export async function inspectRobots(url: string): Promise<RobotsInspection> {
  const origin = originOf(url);
  if (!origin) return { origin: null, rules: { allow: [], disallow: [], crawlDelay: null, note: "no origin" } };
  return { origin, rules: await loadRules(origin) };
}
