/**
 * URL normalization and posting-identity derivation.
 *
 * The identity anchor for a posting is its **canonical URL**: tracking params
 * stripped, redirects collapsed (redirect following happens in fetch.ts, the
 * final URL is what we normalize here). From the canonical URL we derive a
 * `postingId` — a stable key for "this posting", so the same job fetched from
 * two different URL spellings is recognized as one record.
 */

import { createHash } from "node:crypto";

/** Tracking parameters stripped from any URL (utm_*, gh_jid, etc.). */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|gh_jid|mc_cid|mc_eid|ref_|pk_|mtm_|yclid|msclkid)/i;

/** Job-board host aliases that refer to the same board. Value = canonical host. */
const HOST_ALIASES: Record<string, string> = {
  "job-boards.greenhouse.io": "boards.greenhouse.io",
  "boards.greenhouse.io": "boards.greenhouse.io",
};

export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = ""; // anchors carry no identity
  // Drop known tracking parameters, keep everything else (e.g. job ids).
  const kept: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (!TRACKING_PARAM.test(k)) kept.push(`${k}=${v}`);
  }
  u.search = kept.length ? `?${kept.join("&")}` : "";
  // Collapse host aliases so both Greenhouse board hosts map to one identity.
  const alias = HOST_ALIASES[u.hostname.toLowerCase()];
  if (alias) u.hostname = alias;
  return u.toString();
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** Recognize the board a URL belongs to, by host + path shape. */
export function detectBoard(canonicalUrl: string): string {
  try {
    const u = new URL(canonicalUrl);
    const h = u.hostname.toLowerCase();
    const p = u.pathname;
    if (h.endsWith("greenhouse.io")) return "greenhouse";
    if (h.endsWith("lever.co") && p.startsWith("/")) return "lever";
    if (h.endsWith("ashbyhq.com")) return "ashby";
    if (h.endsWith("workable.com")) return "workable";
    if (h.endsWith("smartrecruiters.com")) return "smartrecruiters";
    if (h.endsWith("jobvite.com")) return "jobvite";
    if (h.endsWith("bamboohr.com")) return "bamboohr";
    if (h.endsWith("recruitee.com")) return "recruitee";
    return "web";
  } catch {
    return "web";
  }
}

/**
 * Derive a stable posting id from the canonical URL.
 * Uses URL structure where the board exposes a job id (Greenhouse /jobs/{id},
 * Ashby+Lever /{org}/{uuid}, Workable /p/{id}), else falls back to a hash of
 * host+path so identical pages fetched twice still dedupe.
 */
export function derivePostingId(canonicalUrl: string): string {
  let u: URL;
  try {
    u = new URL(canonicalUrl);
  } catch {
    return "url:" + sha1(canonicalUrl);
  }
  const h = u.hostname.toLowerCase();
  const p = u.pathname;

  // Greenhouse: /{board}/jobs/{id}  (also /{board}/jobs/{id}/apply)
  let m = p.match(/^\/[^/]+\/jobs\/(\d+)/);
  if (m && h.endsWith("greenhouse.io")) return `greenhouse:${m[1]}`;

  // Workable: /p/{id}
  m = p.match(/^\/p\/([^/]+)/);
  if (m && h.endsWith("workable.com")) return `workable:${m[1]}`;

  // Ashby / Lever: /{org}/{uuid}
  m = p.match(/^\/([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) {
    const board = h.endsWith("ashbyhq.com") ? "ashby" : h.endsWith("lever.co") ? "lever" : "web";
    return `${board}:${m[2].toLowerCase()}`;
  }

  // Lever legacy: /{org}/{slug}-{uuid}
  m = p.match(/^\/([^/]+)\/([^/]+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m && h.endsWith("lever.co")) return `lever:${m[3].toLowerCase()}`;

  // Fallback: host+path hash (stable across query param changes after normalize).
  return `url:${sha1(h + p)}`;
}

/** Normalize a title for identity comparison. */
export function normalizeText(s: string | null): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

/** Identity key = normalized title + company. Empty → null (caller falls back). */
export function identityKey(title: string | null, company: string | null): string | null {
  const t = normalizeText(title);
  const c = normalizeText(company);
  if (!t || !c) return null;
  return `${t} ||| ${c}`;
}
