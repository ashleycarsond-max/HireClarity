/**
 * REQUIREMENT EXTRACTION — "does this posting's description require a
 * bachelor's / master's / 5+ years of experience?"
 *
 * Pipeline: politely fetch the posting's canonical URL (robots.txt check +
 * per-host throttle via robots.ts/fetch.ts — never bypassed), reduce the page
 * to its visible description text, then apply DOCUMENTED conservative keyword
 * rules. Only a CLEAR statement in the description sets a flag true. Absence
 * with a readable description means "description read, requirement not found"
 * — never "not required" as a guess. A fetch that produced no readable
 * description sets fetchError and is reported separately ("description not
 * readable") — it is never counted as a zero.
 *
 * Rules (each is a positive statement the description text must contain):
 *
 * requiresBachelor:
 *   - "bachelor's" / "bachelors" / "bachelor degree" / "Bachelor of X" / "bachelor in X"
 *   - "B.S. degree" / "BS degree" / "B.A. degree" / "BA degree" (and "in X" variants)
 *   - "BS/BA", "BA or BS", "B.S./B.A." and similar combined forms
 *   - "undergraduate degree"
 *   Bare "undergraduate" (e.g. "undergraduate research") is deliberately NOT
 *   flagged — it does not clearly state a degree requirement.
 *
 * requiresMasters:
 *   - "master's" / "masters"
 *   - "master degree" / "Master of X" / "master in X"
 *   - "M.S. degree" / "MS degree" / "M.A. degree" / "MA degree" (and "in X")
 *   - "M.B.A." / "MBA" (with optional "degree")
 *   - "graduate degree"   <-- masters-level; deliberately does NOT also flag
 *       requiresBachelor (a "graduate degree" statement is not a bachelor
 *       statement; the bachelor rule has no "graduate" pattern).
 *   "graduate" alone is not flagged.
 *   "master" alone is NOT flagged (avoid "master data", "master plan", ...).
 *
 * requires5PlusYears:
 *   - "5 years" / "5+ years" / "5 or more years" / "5+ years of experience"
 *   - "five years" / "five+ years" / "five or more years"
 *   - "minimum of 5 years" / "at least 5 years" (digit and word forms)
 *   Deliberately NOT flagged (conservative — the text must clearly state 5+):
 *   - ranges ("3-5 years", "5-7 years" — excluded via lookbehind / following char)
 *   - "15 years" (the 5 is part of a larger number — excluded via lookbehind)
 *   - "three to five years" (a range, not a floor — excluded via lookbehind)
 *   - other numbers ("10+ years") — the metric is a stated "5+" requirement.
 *   "yrs" and "year" (singular) variants are accepted ("5+ yrs").
 */

import { politeFetch } from "./fetch";
import { checkAllowed, hostOf, throttle } from "./robots";
import type { PostingRecord, PostingRequirement } from "./types";
import { isoNow } from "./store";

/* ---------------------------------- rules ---------------------------------- */

export const REQUIREMENT_RULES: {
  field: "requiresBachelor" | "requiresMasters" | "requires5PlusYears";
  label: string;
  patterns: RegExp[];
}[] = [
  {
    field: "requiresBachelor",
    label: "bachelor's degree",
    patterns: [
      /\bbachelor'?s?(?:\s+(?:degree|of|in)\b)?\b/i,
      /\bB\.?S\.?(?:\s+degree|\s+in\b)/i,
      /\bB\.?A\.?(?:\s+degree|\s+in\b)/i,
      /\bB\.?[AS]\.?(?:\s*\/\s*|\s+or\s+)B\.?[AS]\.?\b/i,
      /\bundergraduate\s+degree\b/i,
    ],
  },
  {
    field: "requiresMasters",
    label: "master's degree",
    patterns: [
      /\bmaster's\b/i,
      /\bmasters\b/i,
      /\bmaster\s+(?:degree|of|in)\b/i,
      /\bM\.?S\.?(?:\s+degree|\s+in\b)/i,
      /\bM\.?A\.?(?:\s+degree|\s+in\b)/i,
      /\bM\.?B\.?A\.?(?:\s+degree)?\b/i,
      /\bgraduate\s+degree\b/i,
    ],
  },
  {
    field: "requires5PlusYears",
    label: "5+ years of experience",
    patterns: [
      /(?<![\d-])(?<!to )\b5\s*\+?\s*-?\s*(?:or more\s*)?(?:years?|yrs)\b/i,
      /(?<![\d-])(?<!to )\bfive\s*\+?\s*-?\s*(?:or more\s*)?(?:years?|yrs)\b/i,
      /\b(?:minimum of|at least)\s+5\s*\+?\s*(?:or more\s*)?(?:years?|yrs)\b/i,
      /\b(?:minimum of|at least)\s+five\s*\+?\s*(?:or more\s*)?(?:years?|yrs)\b/i,
    ],
  },
];

/** Apply the documented rules to visible description text. */
export function extractRequirements(text: string): {
  requiresBachelor: boolean;
  requiresMasters: boolean;
  requires5PlusYears: boolean;
} {
  const out = { requiresBachelor: false, requiresMasters: false, requires5PlusYears: false };
  for (const rule of REQUIREMENT_RULES) {
    for (const re of rule.patterns) {
      if (re.test(text)) {
        out[rule.field] = true;
        break;
      }
    }
  }
  return out;
}

/* ------------------------------ visible text ------------------------------- */

/** Decode the common HTML entities so rule text matches real characters. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

/** The description text of a JSON-LD JobPosting block, if the page declares one. */
function jsonLdDescription(html: string): string | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === "object" && (item as { "@type"?: string })["@type"] === "JobPosting") {
          const d = (item as Record<string, unknown>)["description"];
          if (typeof d === "string" && d.trim()) return d;
        }
      }
    } catch {
      // not JSON — skip
    }
  }
  return null;
}

const MAX_DESCRIPTION_CHARS = 200_000;

/**
 * Reduce a fetched posting page to its visible description text. Prefers the
 * JSON-LD JobPosting description (the page's own structured job description);
 * otherwise strips scripts/styles/tags from the whole page. Returns "" when no
 * readable text could be extracted.
 */
export function extractVisibleText(html: string): string {
  const ld = jsonLdDescription(html);
  const source = ld ?? html;
  let s = source
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, MAX_DESCRIPTION_CHARS);
}

/* --------------------------- fetch + extraction ---------------------------- */

/**
 * Polite single-posting requirement extraction: robots check + throttle (per
 * host) + capped fetch, then rules on the visible text. Never bypasses robots.
 * Always returns a PostingRequirement row — on any failure the row carries
 * fetchError and descriptionPresent=false (honest "not readable").
 */
export async function extractRequirementsForPosting(
  rec: PostingRecord,
  nowIso: string = isoNow()
): Promise<PostingRequirement> {
  const base: PostingRequirement = {
    postingId: rec.postingId,
    requiresBachelor: false,
    requiresMasters: false,
    requires5PlusYears: false,
    descriptionPresent: false,
    descriptionLen: 0,
    extractedAt: nowIso,
    fetchError: null,
  };
  const url = rec.canonicalUrl;
  try {
    const origin = new URL(url).origin;
    const host = hostOf(url);
    const allowed = await checkAllowed(url);
    if (!allowed.allowed) {
      return { ...base, fetchError: "blocked by robots.txt" };
    }
    // Throttle per host (min 2s between requests to the same host).
    await throttle(host, allowed.crawlDelay, 2000);
    // 15s request cap: posting pages are small; a short timeout bounds the
    // in-flight tail when the rolling refresh hits its wall-clock budget.
    const res = await politeFetch(url, { timeoutMs: 15_000 });
    if (!res.ok || !res.body) {
      return {
        ...base,
        fetchError: res.ok ? "empty response body" : `HTTP ${res.status ?? "?"}${res.note ? ` — ${res.note}` : ""}`,
      };
    }
    const text = extractVisibleText(res.body);
    if (!text) {
      return { ...base, fetchError: "no readable description text on the page" };
    }
    const flags = extractRequirements(text);
    return {
      ...base,
      ...flags,
      descriptionPresent: true,
      descriptionLen: text.length,
      fetchError: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, fetchError: `extraction failed: ${msg}` };
  }
}
