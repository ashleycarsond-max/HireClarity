/**
 * PAY EXTRACTION + CONSISTENCY — the Confidence-score pay signal
 * (owner decision 2026-08-15).
 *
 * Two observations feed the score, both shown in the per-signal breakdown:
 *   1. pay_listed — does the posting state a salary/compensation range at all?
 *   2. pay_consistent — when the same role is tracked across multiple boards
 *      or URLs, does the pay match on every listing we track? A real role has
 *      one real salary band, so cross-listing pay conflicts are a ghost-job
 *      tell.
 *
 * EXTRACTION is conservative and honest, like the rest of the engine:
 *   - Structured ATS fields are preferred when the board API or page declares
 *     them: Greenhouse `compensation`, Ashby/Lever `salaryRange`, schema.org
 *     JSON-LD `baseSalary` ({min,max,currency,interval}).
 *   - Otherwise the visible description text is scanned for a salary phrase
 *     ("$120,000 – $150,000 per year", "€70k", "£50-60 per hour", ...). A
 *     phrase without a currency symbol/code is NOT treated as pay, and an
 *     amount under 1,000 with no declared period is NOT treated as a salary
 *     (guards against "$10 Uber credits" style false positives).
 *   - No salary found → hasPay=false with the honest "not stated" reading.
 *     That is NEVER a guess and NEVER a score deduction.
 *   - A posting that hasn't been re-read since pay tracking started has NO row
 *     at all — "pay not checked yet" is distinguishable from "not stated".
 *
 * CONSISTENCY ("real role = one real salary band"): the same-role comparison
 * group is the engine's identity group (normalized title + company), further
 * narrowed to listings that share this posting's location when both declare
 * one (a company hiring the same title in two cities legitimately pays
 * differently — we must not call that a ghost tell). Bands are annualized with
 * DOCUMENTED factors (hour×2080, day×260, week×52, month×12; an undeclared
 * period is compared as-is) and two bands are CONSISTENT when they overlap or
 * their midpoints are within 10% of each other — anything further apart, or
 * pay declared in different currencies, is a CONFLICT. Missing pay is never a
 * zero and never a conflict.
 */

import type { PayConsistencyVerdict, PayInfo, PayPeriod } from "./types";
import { decodeEntities, extractVisibleText } from "./requirements";

/* ------------------------------ text extraction ------------------------------ */

const CURRENCY_RE = "(?:USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|CNY|SEK|DKK|NOK|HKD|SGD|\\$|€|£|¥)";
/** 120,000 | 120000 | 120.5  (the [kK] suffix is captured separately) */
const NUM = "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?";
const NUM_K = `(${NUM})\\s*([kK])?`;

/** Range: "$120,000 - $150,000", "$120k–$150k", "USD 120,000 to 150,000". */
const RANGE_RE = new RegExp(
  `(?<![A-Za-z0-9])(${CURRENCY_RE})\\s*${NUM_K}\\s*(?:-|–|—|to)\\s*(?:${CURRENCY_RE})?\\s*${NUM_K}(?![A-Za-z0-9])`,
  "gi"
);
/** Single: "$120,000", "€70k", "up to $150,000", "starting at $80,000". */
const SINGLE_RE = new RegExp(`(?<![A-Za-z0-9])(${CURRENCY_RE})\\s*${NUM_K}(?![A-Za-z0-9])`, "gi");

const PERIOD_PATTERNS: { period: PayPeriod; re: RegExp }[] = [
  { period: "hour", re: /\b(?:per\s+)?(?:hour|hr|an\s+hour)\b|\/hr\b|hourly|\bh\/?r\b/i },
  { period: "day", re: /\b(?:per\s+)?day\b|\/day\b|daily\b/i },
  { period: "week", re: /\b(?:per\s+)?(?:week|wk)\b|\/wk\b|weekly\b/i },
  { period: "month", re: /\b(?:per\s+)?(?:month|mo)\b|\/mo\b|monthly\b/i },
  { period: "year", re: /\b(?:per\s+)?(?:year|yr|annum|annually|annual|a\s+year)\b|\/yr\b|\/year\b/i },
];

/** The nearest declared period within ±90 chars of a salary phrase (null = undeclared). */
function periodNear(text: string, from: number, to: number): PayPeriod | null {
  const start = Math.max(0, from - 90);
  const end = Math.min(text.length, to + 90);
  const window = text.slice(start, end);
  let best: { period: PayPeriod; dist: number } | null = null;
  for (const p of PERIOD_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(window)) !== null) {
      const idx = start + m.index;
      const dist = Math.min(Math.abs(idx - from), Math.abs(idx + m[0].length - to));
      if (!best || dist < best.dist) best = { period: p.period, dist };
    }
  }
  return best?.period ?? null;
}

function parseAmount(raw: string, k: string | undefined): number {
  let n = Number(raw.replace(/,/g, ""));
  if (/^[kK]$/.test(k ?? "")) n *= 1000;
  return Number.isFinite(n) ? n : NaN;
}

function currencyLabel(cur: string): string {
  const map: Record<string, string> = {
    "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY",
  };
  return map[cur] ?? cur.toUpperCase();
}

/** A readable pay figure — the extraction result before it becomes a PayInfo row. */
export interface PayExtract {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: PayPeriod | null;
  /** the raw phrase as observed, e.g. "$120,000 – $150,000 per year" */
  payText: string | null;
}

/** A PayExtract plus where it was read (structured ATS field vs description text). */
export type PayExtractWithSource = PayExtract & { source: "structured" | "description" };

/**
 * Scan visible text for a salary phrase. Requires a currency symbol/code and a
 * plausible salary magnitude (see module doc) — anything ambiguous is ignored
 * rather than guessed.
 */
export function extractPayFromText(t: string): PayExtract | null {
  // Deliberately simple and PROVABLY LINEAR: scan for currency markers one at
  // a time with anchored, single-exec regexes (a giant alternation with
  // lookarounds made bun's engine take pathological time on some inputs).
  // Every exec starts at an explicit index and must match exactly there, so
  // the pointer always moves forward — no backtracking, no infinite loops.
  const CURR = /(?:USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|CNY|SEK|DKK|NOK|HKD|SGD|[$€£¥])/gi;
  const AMT = /(\d[\d,]*(?:\.\d+)?)\s*([kK])?/g;
  const SEP = /\s*(?:-|–|—|to)\s*/gi;
  const parse = (raw: string, k: string | undefined): number => {
    const n = Number(raw.replace(/,/g, ""));
    return k ? n * 1000 : n;
  };
  const bySym: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };
  const KNOWN = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "JPY", "CNY", "SEK", "DKK", "NOK", "HKD", "SGD"]);
  const currencyOf = (s: string): string => {
    const code = bySym[s] ?? s.toUpperCase();
    return KNOWN.has(code) ? code : s;
  };
  const periodOf = (from: number, to: number): string | null => {
    const win = t.slice(Math.max(0, from - 20), Math.min(t.length, to + 90)).toLowerCase();
    if (/\byear\b|annual|annually|\byr\b|\/yr\b/.test(win)) return "year";
    if (/\bmonth\b|monthly|\/mo\b/.test(win)) return "month";
    if (/\bweek\b|weekly|\/wk\b/.test(win)) return "week";
    if (/\bday\b|daily/.test(win)) return "day";
    if (/\bhour\b|hourly|\/hr\b|\bhr\b/.test(win)) return "hour";
    return null;
  };
  const plausible = (min: number, max: number | null, period: string | null): boolean => {
    if (min < 0) return false;
    if (period === "hour") return min >= 5;
    if (period === "day") return min >= 30;
    if (period === "week") return min >= 100;
    if (period === "month") return min >= 500;
    return min >= 1000; // no period: only big numbers read as salaries
  };
  let i = 0;
  while (i < t.length) {
    CURR.lastIndex = i;
    const c = CURR.exec(t);
    if (!c) return null;
    const cur = currencyOf(c[0]);
    const after = c.index + c[0].length;
    AMT.lastIndex = after;
    const a = AMT.exec(t);
    if (!a || a.index !== after) {
      i = after;
      continue;
    }
    const min = parse(a[1], a[2]);
    const consumedBase = a.index + a[0].length;
    SEP.lastIndex = consumedBase;
    const sep = SEP.exec(t);
    let max: number | null = null;
    let consumed = consumedBase;
    if (sep && sep.index === consumedBase) {
      let amtAfter = sep.index + sep[0].length;
      // optional second currency marker ("€70k to €80k", "$120k – $150k")
      CURR.lastIndex = amtAfter;
      const c2 = CURR.exec(t);
      if (c2 && c2.index === amtAfter) amtAfter = c2.index + c2[0].length;
      AMT.lastIndex = amtAfter;
      const a2 = AMT.exec(t);
      if (a2 && a2.index === amtAfter) {
        max = parse(a2[1], a2[2]);
        consumed = a2.index + a2[0].length;
      }
    }
    const period = periodOf(c.index, consumed);
    if (!plausible(min, max, period)) {
      i = after;
      continue;
    }
    return { min, max, currency: cur, period, payText: t.slice(c.index, consumed) };
  }
  return null;
}


/** Salary-magnitude guard: an amount too small to be pay is not pay. */
function plausible(min: number | null, max: number | null, period: PayPeriod | null): boolean {
  const low = min ?? max;
  const high = max ?? min;
  if (low == null || !Number.isFinite(low)) return false;
  if (period === "hour") return low >= 5;
  if (period === "day") return low >= 40;
  if (period === "week") return low >= 200;
  if (period === "month") return low >= 800;
  // undeclared period or annual — a salary needs a meaningful magnitude
  return low >= 1000 && (high == null || high >= low);
}

/* --------------------------- structured extraction --------------------------- */

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = str(v);
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function periodFromInterval(interval: string | null): PayPeriod | null {
  const s = (interval ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/(^|[^a-z])hour/.test(s) || s === "hr") return "hour";
  if (s.startsWith("day")) return "day";
  if (s.startsWith("week")) return "week";
  if (s.startsWith("month")) return "month";
  if (/(^|[^a-z])year/.test(s) || s === "annual" || s === "annum" || s === "yr") return "year";
  return null;
}

function rawPayText(min: number | null, max: number | null, currency: string | null, period: PayPeriod | null): string {
  const cur = currency ?? "";
  const fmt = (n: number) => `${cur}${n.toLocaleString("en-US")}`;
  const band = min != null && max != null ? `${fmt(min)} – ${fmt(max)}` : fmt(min ?? max ?? 0);
  return period ? `${band} per ${period}` : band;
}

/**
 * Structured ATS compensation fields: Greenhouse `compensation`, Ashby/Lever
 * `salaryRange`, schema.org `baseSalary` ({value:{value,minValue,maxValue}}).
 */
export function extractPayFromStructured(obj: unknown): PayExtract | null {
  if (!obj || typeof obj !== "object") return null;
  return extractPayFromStructuredDepth(obj, 0);
}

/**
 * Structured pay fields may sit inside API wrappers (Greenhouse returns
 * `{jobs: [...]}`, Lever `{data: [...]}`), so after the top-level look we walk
 * nested arrays/objects with a small depth cap. Prefers the shallowest match.
 */
function extractPayFromStructuredDepth(obj: unknown, depth: number): PayExtract | null {
  if (!obj || typeof obj !== "object" || depth > 5) return null;
  const direct = structuredFromObject(obj);
  if (direct) return direct;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = extractPayFromStructuredDepth(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (val && typeof val === "object") {
      const found = extractPayFromStructuredDepth(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function structuredFromObject(obj: unknown): PayExtract | null {
  const o = obj as Record<string, unknown>;
  for (const key of ["compensation", "salaryRange", "salary_range"]) {
    const v = o[key];
    if (v && typeof v === "object") {
      const c = v as Record<string, unknown>;
      const min = toNum(c["min"]) ?? toNum(c["minValue"]) ?? toNum(c["minimum"]);
      const max = toNum(c["max"]) ?? toNum(c["maxValue"]) ?? toNum(c["maximum"]);
      const currency = str(c["currency"]);
      const period = periodFromInterval(str(c["interval"]) ?? str(c["unitText"]));
      if (min != null || max != null) {
        if (!plausible(min ?? max, max ?? min, period)) return null;
        return { min, max, currency, period, payText: rawPayText(min, max, currency, period) };
      }
    }
  }
  const bs = o["baseSalary"];
  if (bs && typeof bs === "object") {
    const b = bs as Record<string, unknown>;
    const currency = str(b["currency"]);
    const val = (b["value"] ?? b) as Record<string, unknown>;
    if (val && typeof val === "object") {
      const min = toNum(val["minValue"]) ?? toNum(val["value"]);
      const max = toNum(val["maxValue"]) ?? toNum(val["value"]);
      const period = periodFromInterval(str(val["unitText"]));
      if (min != null || max != null) {
        if (!plausible(min ?? max, max ?? min, period)) return null;
        return { min, max, currency, period, payText: rawPayText(min, max, currency, period) };
      }
    }
  }
  return null;
}

/** JSON-LD JobPosting baseSalary block from an HTML page, if declared. */
function jsonLdBaseSalary(html: string): PayExtract | null {
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
          const found = extractPayFromStructured(item);
          if (found) return found;
        }
      }
    } catch {
      // not JSON — skip
    }
  }
  return null;
}

const DESCRIPTION_KEYS = /^(description|content|descriptionHtml|descriptionPlain|jobAd|summary|additional|ad|text)$/i;

/**
 * Extract pay from a fetched page/API body: structured fields first (JSON-LD or
 * ATS JSON), then the visible description text. HTML pages use JSON-LD
 * baseSalary, then visible text; JSON payloads use structured fields, then any
 * description-like string fields, then a whole-body text scan.
 */
export function extractPayFromBody(body: string, contentType: string | null): PayExtractWithSource | null {
  const trimmed = body.trimStart();
  const isJson = (contentType && /json/i.test(contentType)) || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!isJson) {
    const ld = jsonLdBaseSalary(body);
    if (ld) return { ...ld, source: "structured" };
    const text = extractVisibleText(body);
    const t = text ? extractPayFromText(text) : null;
    if (t) return { ...t, source: "description" };
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  const structured = extractPayFromStructured(data);
  if (structured) return { ...structured, source: "structured" };
  // Description-string scan inside the payload (board APIs embed the ad copy).
  const strings = collectStrings(data, 0);
  for (const s of strings) {
    const t = extractPayFromText(s);
    if (t) return { ...t, source: "description" };
  }
  return null;
}

function collectStrings(v: unknown, depth: number, out: string[] = [], keyHint = ""): string[] {
  if (depth > 4) return out;
  if (typeof v === "string") {
    if (v.length > 20 && v.length < 300_000) out.push(v);
    return out;
  }
  if (Array.isArray(v)) {
    for (const item of v) collectStrings(item, depth + 1, out, keyHint);
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string" && DESCRIPTION_KEYS.test(k) && val.length > 20) {
        out.push(val);
      } else {
        collectStrings(val, depth + 1, out, k);
      }
    }
  }
  return out;
}

/**
 * Extract pay from a board-API job record during sync (the `raw` field the
 * board clients keep for traceability): structured compensation fields first,
 * then the embedded description text.
 */
export function extractPayFromBoardRaw(raw: unknown): PayExtractWithSource | null {
  if (!raw || typeof raw !== "object") return null;
  const structured = extractPayFromStructured(raw);
  if (structured) return { ...structured, source: "structured" };
  const strings = collectStrings(raw, 0);
  for (const s of strings) {
    const t = extractPayFromText(s);
    if (t) return { ...t, source: "description" };
  }
  return null;
}

/* ------------------------------- consistency ------------------------------- */

/** Annualization factors for comparing bands across periods (documented). */
export const ANNUAL_FACTORS: Record<PayPeriod, number> = {
  year: 1,
  month: 12,
  week: 52,
  day: 260, // documented: 260 work days
  hour: 2080, // documented: 40h × 52 weeks
};

export interface PayConsistency {
  verdict: PayConsistencyVerdict;
  /** distinct listings that stated readable pay (drives the reason text) */
  payingListings: number;
  /** listings in the comparison group (read or not) */
  comparedListings: number;
}

function bandOf(p: PayInfo): { min: number; max: number } | null {
  if (!p.hasPay || p.fetchError) return null;
  const factor = p.period ? ANNUAL_FACTORS[p.period] : 1; // undeclared period: compare as-is
  const rawMin = p.payMin ?? p.payMax;
  const rawMax = p.payMax ?? p.payMin;
  if (rawMin == null || rawMax == null) return null;
  const min = rawMin * factor;
  const max = rawMax * factor;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** Two annualized bands conflict when they don't overlap AND midpoints differ > 10%. */
export function bandsConflict(a: { min: number; max: number }, b: { min: number; max: number }): boolean {
  const overlap = Math.max(a.min, b.min) <= Math.min(a.max, b.max);
  if (overlap) return false;
  const amid = (a.min + a.max) / 2;
  const bmid = (b.min + b.max) / 2;
  const gap = Math.abs(amid - bmid);
  const tol = 0.1 * Math.max(amid, bmid); // ±10% midpoint tolerance (documented)
  return gap > tol;
}

function normCurrency(cur: string | null): string | null {
  if (!cur) return null;
  const map: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };
  return map[cur] ?? cur.trim().toUpperCase();
}

/**
 * The pay-consistency verdict over a same-role pay group (see module doc for
 * the group definition and the documented tolerance). Pure and deterministic —
 * unit-tested in engine/pay-test.ts.
 */
export function payConsistency(payRows: PayInfo[]): PayConsistency {
  const comparedListings = payRows.length;
  const readRows = payRows.filter((r) => !r.fetchError);
  const readable = readRows.filter((r) => r.hasPay);
  if (readable.length === 0) {
    return {
      verdict: readRows.length === 0 ? "not-checked" : "not-stated",
      payingListings: 0,
      comparedListings,
    };
  }
  if (readable.length === 1) {
    return { verdict: "only-one-listing", payingListings: 1, comparedListings };
  }
  // 2+ listings state pay — compare currencies first, then annualized bands.
  const currencies = new Set(readable.map((r) => normCurrency(r.currency)));
  if (currencies.size > 1) {
    return { verdict: "conflict", payingListings: readable.length, comparedListings };
  }
  const bands = readable.map(bandOf).filter((b): b is { min: number; max: number } => b !== null);
  if (bands.length < 2) return { verdict: "only-one-listing", payingListings: readable.length, comparedListings };
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      if (bandsConflict(bands[i], bands[j])) {
        return { verdict: "conflict", payingListings: readable.length, comparedListings };
      }
    }
  }
  return { verdict: "consistent", payingListings: readable.length, comparedListings };
}
