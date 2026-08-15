/**
 * DAILY SNAPSHOT COMPILE — the daily picture of the observed sample.
 *
 * Owner decision (2026-08-14): data compiles DAILY on an automated schedule and
 * publishes monthly. This module computes ONE day's snapshot from the live
 * tracking store and persists it to the `daily_snapshots` table (date PK,
 * JSONB snapshot; re-running a date REPLACES it — idempotent).
 *
 * A snapshot is a COMPLETE daily picture:
 *   (a) industries hiring (postings per industry via industryForCompany on the
 *       posting's company; companies outside the curated map and postings with
 *       no company name land in "Unclassified", counted separately),
 *   (b) most popular job titles (normalized via engine/titles.ts, top 10),
 *   (c) requirement shares (requiresBachelor / requiresMasters /
 *       requires5PlusYears) — denominator is LIVE postings with a READ
 *       description (descriptionPresent=true); counts of read / fetch-error /
 *       not-yet-extracted live postings are reported alongside so the
 *       denominator is honest,
 *   (d) the existing ghost-job metrics (live/removed/relisted counts, board
 *       split, score distribution, median days listed),
 *   (e) trends vs the previous stored daily snapshot: delta + direction
 *       (up/down/flat/n-a) per headline metric.
 *
 * HONESTY RULES (same spirit as engine/report.ts):
 *   - Every figure is the OBSERVED SAMPLE of tracked postings, labeled with
 *     sample sizes. Never "X% of all jobs".
 *   - Sandbox-local fixture postings (loopback hosts) are excluded.
 *   - Requirement flags only exist where a description was actually read;
 *     shares are computed over the read-description denominator only.
 *   - Score buckets are recomputed at compile time for all currently-live
 *     tracked postings (method note included in the snapshot).
 *   - All dates UTC.
 */

import { Store } from "./store";
import { buildSignals, type SignalContext } from "./signals";
import { scoreCore } from "./score";
import { industryForCompany, FALLBACK_INDUSTRY } from "./company-industries";
import { normalizeTitle } from "./titles";
import { companyMetrics } from "./company";
import type { PostingEvent, PostingRecord } from "./types";
import { REPORT_BOARDS } from "./report";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Sandbox-local fixture postings are test data — never surface them. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/* ------------------------------ date helpers ------------------------------ */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validate "YYYY-MM-DD" (UTC calendar date). Returns null when invalid. */
export function parseDateStr(s: string): string | null {
  const m = DATE_RE.exec(s ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null; // e.g. 2026-02-30
  }
  return s;
}

/** Today's UTC calendar date as "YYYY-MM-DD". */
export function utcDateStr(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate()
  ).padStart(2, "0")}`;
}

/* -------------------------------- snapshot -------------------------------- */

export interface IndustryRow {
  industry: string;
  count: number;
  /** share of tracked postings in this industry (0..1) */
  share: number;
}

export interface TitleRow {
  title: string;
  count: number;
  /** share of postings with a title in this bucket (0..1) */
  share: number;
}

export interface ScoreBucketRow {
  bucket: string;
  count: number;
  share: number;
}

export interface BoardRow {
  board: string;
  count: number;
  share: number;
}

export interface TrendEntry {
  /** numeric delta vs the previous snapshot (null when not comparable) */
  delta: number | null;
  /** "up" | "down" | "flat" | "n-a" (no previous snapshot / not comparable) */
  direction: "up" | "down" | "flat" | "n-a";
}

/**
 * One company's slice of a daily snapshot — the quarterly company-report
 * trend source. Only companies with real (non-fixture) tracked postings
 * appear; values use the same definitions as the company dashboard
 * (companyMetrics in engine/company.ts): live = postings live/relisted,
 * medianDaysListed = median identity-group days, relistShare = share of
 * postings with >= 1 observed relist (0..1).
 */
export interface CompanySnapshotRow {
  /** exact company name as stored on the postings */
  name: string;
  live: number;
  medianDaysListed: number | null;
  relistShare: number | null;
}

export interface DailySnapshot {
  /** "YYYY-MM-DD" (UTC) */
  date: string;
  /** ISO timestamp of the compile */
  generatedAt: string;
  postings: {
    totalTracked: number;
    live: number;
    removed: number;
    relisted: number;
    relistedAtLeastOnce: number;
    relistShare: number | null;
    medianDaysListed: number | null;
    maxDaysListed: number | null;
    daysListedSample: number;
    distinctCompanies: number;
    postingsWithCompany: number;
  };
  boards: BoardRow[];
  industries: IndustryRow[];
  /** count of postings whose industry is "Unclassified" (no company or unmapped) */
  unclassifiedCount: number;
  titles: TitleRow[];
  /** per-company slice (live count, median days listed, relist share) — the
   *  quarterly company-report trend source; absent on snapshots compiled
   *  before this block existed (trend reads then honestly report n/a) */
  companies: CompanySnapshotRow[];
  requirements: {
    /** live tracked postings (the honest universe for this day) */
    livePostings: number;
    /** live postings whose description was actually read */
    postingsWithDescriptionRead: number;
    /** live postings whose fetch failed / robots-blocked (description not readable) */
    postingsWithFetchError: number;
    /** live postings not yet extracted (no posting_requirements row) */
    postingsNotYetExtracted: number;
    requiresBachelor: number;
    requiresMasters: number;
    requires5PlusYears: number;
    /** requiresBachelor / postingsWithDescriptionRead (null when denominator 0) */
    bachelorShare: number | null;
    mastersShare: number | null;
    fivePlusShare: number | null;
    method: string;
  };
  scores: ScoreBucketRow[];
  /** trend deltas/directions vs the previous daily snapshot (see TREND_METRICS) */
  trends: Record<string, TrendEntry>;
  /** honest description of the snapshot's data provenance */
  method: string;
}

function medianSorted(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums[Math.floor((nums.length - 1) / 2)];
}

const SCORE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "0-20", min: 0, max: 20 },
  { label: "21-40", min: 21, max: 40 },
  { label: "41-60", min: 41, max: 60 },
  { label: "61-80", min: 61, max: 80 },
  { label: "81-100", min: 81, max: 100 },
];

/**
 * Compute one day's snapshot from the live store. Everything derives from
 * stored observations. Loopback fixture postings are excluded. `now` is
 * injectable for deterministic tests.
 */
export async function computeDailySnapshot(
  store: Store,
  date: string,
  now: Date = new Date()
): Promise<DailySnapshot> {
  const valid = parseDateStr(date);
  if (!valid) throw new Error(`invalid date: ${date} (expected YYYY-MM-DD, UTC)`);
  const nowIso = now.toISOString();

  const all = (await store.getAll()).filter((r) => !isLoopbackUrl(r.canonicalUrl));
  const total = all.length;

  const live = all.filter((r) => r.status === "live" || r.status === "relisted");
  const removed = all.filter((r) => r.status === "removed").length;
  const relisted = all.filter((r) => r.status === "relisted").length;
  const relistedAtLeastOnce = all.filter((r) => r.relistCount > 0).length;

  // ── batched signal context (same pattern as engine/report.ts) ──
  const byPostingId = new Map<string, PostingRecord>();
  const identityGroups = new Map<string, PostingRecord[]>();
  for (const r of all) {
    byPostingId.set(r.postingId, r);
    const key = r.identityKey || r.postingId;
    const list = identityGroups.get(key) ?? [];
    list.push(r);
    identityGroups.set(key, list);
  }
  const eventsByPosting = new Map<string, PostingEvent[]>();
  for (const e of await store.allEvents()) {
    const list = eventsByPosting.get(e.postingId) ?? [];
    list.push(e);
    eventsByPosting.set(e.postingId, list);
  }
  const payByPosting = new Map<string, import("./types").PayInfo>();
  for (const p of await store.allPay()) payByPosting.set(p.postingId, p);
  const ctx: SignalContext = { identityGroups, eventsByPosting, payByPosting };
  const checkCounts = new Map((await store.checksByPosting()).map((c) => [c.postingId, c.count]));

  // ── ghost-job metrics: days listed + score distribution across LIVE postings
  const days: number[] = [];
  const bucketCounts = new Map(SCORE_BUCKETS.map((b) => [b.label, 0]));
  for (const rec of live) {
    const signals = await buildSignals(store, rec, ctx);
    days.push(signals.daysListed);
    const score = scoreCore(signals, checkCounts.get(rec.postingId) ?? 0).score;
    const bucket = SCORE_BUCKETS.find((b) => score >= b.min && score <= b.max) ?? SCORE_BUCKETS[SCORE_BUCKETS.length - 1];
    bucketCounts.set(bucket.label, (bucketCounts.get(bucket.label) ?? 0) + 1);
  }
  days.sort((a, b) => a - b);

  // ── boards (fixed tracked set; 0 counts are honest facts)
  const boards: BoardRow[] = REPORT_BOARDS.map((board) => {
    const count = all.filter((r) => (r.sourceBoard || "web").toLowerCase() === board).length;
    return { board, count, share: total ? count / total : 0 };
  });

  // ── per-company slice (same metric definitions as the company dashboard:
  //    companyMetrics in engine/company.ts) — the quarterly report trend source
  const byCompany = new Map<string, PostingRecord[]>();
  for (const r of all) {
    if (!r.company) continue;
    const list = byCompany.get(r.company) ?? [];
    list.push(r);
    byCompany.set(r.company, list);
  }
  const companies: CompanySnapshotRow[] = [...byCompany.entries()]
    .map(([name, recs]) => {
      const m = companyMetrics(recs, now.getTime());
      return {
        name,
        live: m.livePostings,
        medianDaysListed: m.medianDaysListed,
        relistShare: m.relistShare,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── industries (curated single-label map; "Unclassified" counted separately)
  const industryCounts = new Map<string, number>();
  for (const r of all) {
    const ind = industryForCompany(r.company ?? "");
    industryCounts.set(ind, (industryCounts.get(ind) ?? 0) + 1);
  }
  const industries: IndustryRow[] = [...industryCounts.entries()]
    .map(([industry, count]) => ({ industry, count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count || a.industry.localeCompare(b.industry));
  const unclassifiedCount = industryCounts.get(FALLBACK_INDUSTRY) ?? 0;

  // ── titles (normalized, top 10, exact-frequency)
  const titleCounts = new Map<string, number>();
  for (const r of all) {
    const t = normalizeTitle(r.title);
    if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
  }
  const titled = all.filter((r) => r.title && r.title.trim()).length;
  const titles: TitleRow[] = [...titleCounts.entries()]
    .map(([title, count]) => ({ title, count, share: titled ? count / titled : 0 }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 10);

  // ── requirements (denominator: live postings with a READ description)
  const liveIds = live.map((r) => r.postingId);
  const reqRows = await store.getRequirementsForPostingIds(liveIds);
  const reqByPosting = new Map(reqRows.map((r) => [r.postingId, r]));
  let postingsWithDescriptionRead = 0;
  let postingsWithFetchError = 0;
  let postingsNotYetExtracted = 0;
  let requiresBachelor = 0;
  let requiresMasters = 0;
  let requires5PlusYears = 0;
  for (const id of liveIds) {
    const row = reqByPosting.get(id);
    if (!row) {
      postingsNotYetExtracted++;
    } else if (row.descriptionPresent) {
      postingsWithDescriptionRead++;
      if (row.requiresBachelor) requiresBachelor++;
      if (row.requiresMasters) requiresMasters++;
      if (row.requires5PlusYears) requires5PlusYears++;
    } else if (row.fetchError) {
      postingsWithFetchError++;
    } else {
      postingsNotYetExtracted++;
    }
  }
  const share = (n: number): number | null =>
    postingsWithDescriptionRead ? Math.round((n / postingsWithDescriptionRead) * 10000) / 10000 : null;

  const named = all.filter((r) => r.company);
  const distinctCompanies = new Set(named.map((r) => r.company as string)).size;

  const snapshot: DailySnapshot = {
    date,
    generatedAt: nowIso,
    postings: {
      totalTracked: total,
      live: live.length,
      removed,
      relisted,
      relistedAtLeastOnce,
      relistShare: total ? relistedAtLeastOnce / total : null,
      medianDaysListed: medianSorted(days),
      maxDaysListed: days.length ? days[days.length - 1] : null,
      daysListedSample: days.length,
      distinctCompanies,
      postingsWithCompany: named.length,
    },
    boards,
    industries,
    unclassifiedCount,
    titles,
    companies,
    requirements: {
      livePostings: live.length,
      postingsWithDescriptionRead,
      postingsWithFetchError,
      postingsNotYetExtracted,
      requiresBachelor,
      requiresMasters,
      requires5PlusYears,
      bachelorShare: share(requiresBachelor),
      mastersShare: share(requiresMasters),
      fivePlusShare: share(requires5PlusYears),
      method:
        "Requirement shares are computed over the live tracked postings whose description was actually read this cycle (descriptionPresent=true). A posting whose page could not be read is counted under fetch errors / not-yet-extracted — never as a zero.",
    },
    scores: SCORE_BUCKETS.map((b) => ({
      bucket: b.label,
      count: bucketCounts.get(b.label) ?? 0,
      share: live.length ? (bucketCounts.get(b.label) ?? 0) / live.length : 0,
    })),
    trends: {},
    method:
      "Daily snapshot of the observed tracked sample (all dates UTC). Ghost-job metrics and score buckets are computed at compile time from stored observations; the score distribution is recomputed for all currently-live tracked postings.",
  };

  // ── trends vs the previous stored daily snapshot
  const prev = await store.getPreviousDailySnapshot(date);
  snapshot.trends = computeTrends(prev ? (prev.snapshot as DailySnapshot) : null, snapshot);
  return snapshot;
}

/* --------------------------------- trends --------------------------------- */

/** Headline metrics that get a delta + direction in every snapshot. */
export const TREND_METRICS: { key: string; label: string; pick: (s: DailySnapshot) => number | null }[] = [
  { key: "totalTracked", label: "postings tracked", pick: (s) => s.postings.totalTracked },
  { key: "live", label: "live postings", pick: (s) => s.postings.live },
  { key: "removed", label: "removed postings", pick: (s) => s.postings.removed },
  { key: "relisted", label: "relisted postings", pick: (s) => s.postings.relisted },
  { key: "relistShare", label: "relist share", pick: (s) => s.postings.relistShare },
  { key: "medianDaysListed", label: "median days listed", pick: (s) => s.postings.medianDaysListed },
  { key: "distinctCompanies", label: "distinct companies", pick: (s) => s.postings.distinctCompanies },
  { key: "bachelorShare", label: "bachelor share", pick: (s) => s.requirements.bachelorShare },
  { key: "mastersShare", label: "masters share", pick: (s) => s.requirements.mastersShare },
  { key: "fivePlusShare", label: "5+ years share", pick: (s) => s.requirements.fivePlusShare },
  { key: "postingsWithDescriptionRead", label: "descriptions read", pick: (s) => s.requirements.postingsWithDescriptionRead },
  { key: "topIndustryCount", label: "top industry postings", pick: (s) => s.industries[0]?.count ?? null },
  { key: "topTitleCount", label: "top title postings", pick: (s) => s.titles[0]?.count ?? null },
];

function roundDelta(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Pure trend logic (exported for fixture testing): compares each metric of
 * `curr` against `prev` (using the caller-provided metric list) and produces
 * delta + direction. Direction is the literal change of the value (up = the
 * metric went up); it is NOT a good/bad judgment — the report UI decides how to
 * read a rising relist share vs a rising description-read count. "n-a" when
 * there is no previous snapshot or a metric is not comparable.
 */
export function computeTrendsFor(
  metrics: { key: string; pick: (s: DailySnapshot) => number | null }[],
  prev: DailySnapshot | null,
  curr: DailySnapshot
): Record<string, TrendEntry> {
  const out: Record<string, TrendEntry> = {};
  for (const m of metrics) {
    const p = prev ? m.pick(prev) : null;
    const c = m.pick(curr);
    if (p === null || c === null || prev === null) {
      out[m.key] = { delta: null, direction: "n-a" };
      continue;
    }
    const delta = roundDelta(c - p);
    out[m.key] = { delta, direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat" };
  }
  return out;
}

/**
 * Same as computeTrendsFor but over the headline TREND_METRICS list — the
 * daily snapshot's own trend block. The report layer calls computeTrendsFor
 * with its own EXTENDED list (headlines + boards + score buckets).
 */
export function computeTrends(
  prev: DailySnapshot | null,
  curr: DailySnapshot
): Record<string, TrendEntry> {
  return computeTrendsFor(TREND_METRICS, prev, curr);
}

/* ------------------------------- persistence ------------------------------- */

/** Persist a daily snapshot (idempotent: re-running a date replaces it). */
export async function saveDailySnapshot(store: Store, snapshot: DailySnapshot): Promise<void> {
  await store.saveDailySnapshot(snapshot.date, snapshot);
}

/* ---------------------------------- CLI ----------------------------------- */

/** Human-readable summary for the CLI and the cron's JSON response. */
export function dailySummaryLine(s: DailySnapshot): string {
  const p = s.postings;
  const r = s.requirements;
  const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 1000) / 10}%`);
  const indTop = s.industries[0] ? `${s.industries[0].industry} (${s.industries[0].count})` : "n/a";
  const titleTop = s.titles[0] ? `"${s.titles[0].title}" (${s.titles[0].count})` : "n/a";
  return [
    `${s.date} — ${p.totalTracked} postings tracked (${p.live} live, ${p.removed} removed, ${p.relisted} relisted)`,
    `  top industry: ${indTop}; unclassified: ${s.unclassifiedCount}`,
    `  top title: ${titleTop}`,
    `  requirements (of ${r.postingsWithDescriptionRead} live postings with a read description): bachelor ${pct(r.bachelorShare)} (${r.requiresBachelor}), masters ${pct(r.mastersShare)} (${r.requiresMasters}), 5+ years ${pct(r.fivePlusShare)} (${r.requires5PlusYears}); not readable: ${r.postingsWithFetchError}, not yet extracted: ${r.postingsNotYetExtracted}`,
    `  median days listed: ${p.medianDaysListed ?? "n/a"}; relist share: ${pct(p.relistShare)}; companies: ${p.distinctCompanies}`,
  ].join("\n");
}
