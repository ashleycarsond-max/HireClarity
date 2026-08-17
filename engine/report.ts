/**
 * JOB-MARKET REPORT LAYER — public observed-sample aggregates.
 *
 * Computes a period snapshot from the tracking store and persists it to the
 * `report_snapshots` table (one row per period, idempotent — regenerating a
 * period replaces it). The public report pages render ONLY these stored
 * snapshots, never live store data, so a published report stays stable as the
 * tracker keeps watching.
 *
 * CADENCE (owner decision 2026-08-14): during the first 6 months of the
 * business (window 2026-08-14 → DAILY_REPORT_UNTIL) the current month's report
 * refreshes DAILY from the 02:30 UTC daily snapshot, so readers see change as
 * data compiles (day-over-day trend rows + "data as of <compile date>"
 * labeling). After DAILY_REPORT_UNTIL it reverts to monthly-only refreshes on
 * the 1st. The monthly email to signups stays monthly either way.
 *
 * HONESTY RULES (hard — same spirit as engine/company.ts and engine/score.ts):
 *   - Every figure is an OBSERVED SAMPLE of the postings we track, labeled with
 *     the sample size and the observation window ("of the N postings we track
 *     (since DATE)"). We never say "X% of all jobs".
 *   - Sandbox-local fixture postings (loopback hosts) are excluded: they are
 *     test data with no reachable URL for real users.
 *   - No per-company data is published. Company names appear only inside the
 *     distinct-companies COUNT; never as rows, never per company.
 *   - The checks table stores what we OBSERVED per check (status), not a score.
 *     The score distribution is therefore recomputed at generation time for the
 *     postings that were checked in the period, and the method note says so.
 */

import { Store } from "./store";
import { buildSignals, type SignalContext } from "./signals";
import { scoreCore } from "./score";
import { TREND_METRICS, computeTrends, computeTrendsFor, type DailySnapshot } from "./daily-stats";
import { FALLBACK_INDUSTRY } from "./company-industries";
import type { PostingEvent, PostingRecord } from "./types";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Sandbox-local fixture postings are test data — never surface them. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Boards the tracker covers (observed counts may be 0 — that is honest).
 * Workable was removed 2026-08-15: its careers pages render in a browser and
 * expose no parseable public board for automated readers (widget API v1 404s
 * every account; the SPA data endpoint needs browser-session context). */
export const REPORT_BOARDS = ["greenhouse", "ashby", "lever", "web"] as const;

/* -------------------- daily-refresh window (owner decision 2026-08-14) -------------------- */

/**
 * End of the owner's 6-month DAILY-refresh window ("2027-02-14", i.e. 6 months
 * after launch 2026-08-14). While the UTC date is strictly BEFORE this date the
 * public report refreshes daily from the 02:30 UTC snapshot; on and after it the
 * report reverts to monthly-only refreshes (1st of each month). The last
 * daily-refresh day is the day BEFORE this date.
 */
export const DAILY_REPORT_UNTIL = "2027-02-14";

/** True while the daily-refresh window is open (UTC calendar date < DAILY_REPORT_UNTIL). */
export function isDailyReportWindow(now: Date = new Date()): boolean {
  return now.toISOString().slice(0, 10) < DAILY_REPORT_UNTIL;
}

export type ReportRefreshReason = "daily-window" | "first-of-month" | "skipped";

/**
 * The cron's refresh decision (pure — unit-testable):
 *   - inside the daily window → refresh every day ("daily-window"); the 1st of
 *     the month is covered by the daily refresh and ALSO triggers the one-time
 *     new-period email (handled by the caller);
 *   - after DAILY_REPORT_UNTIL → refresh ONLY on the 1st of the month
 *     ("first-of-month"), the pre-window behavior;
 *   - otherwise → skipped (idempotent no-op, honest response).
 */
export function reportRefreshDecision(now: Date = new Date()): { refresh: boolean; reason: ReportRefreshReason } {
  if (isDailyReportWindow(now)) return { refresh: true, reason: "daily-window" };
  if (now.getUTCDate() === 1) return { refresh: true, reason: "first-of-month" };
  return { refresh: false, reason: "skipped" };
}


export interface ReportBoardRow {
  board: string;
  count: number;
  /** share of tracked postings on this board (0..1) */
  share: number;
}

export interface ReportScoreBucket {
  /** human bucket label, e.g. "0-20" */
  bucket: string;
  count: number;
  /** share of scored postings in this bucket (0..1) */
  share: number;
}

export interface ReportCheckOutcome {
  observedStatus: string;
  count: number;
}

export interface ReportSnapshot {
  /** "YYYY-MM" — the period this snapshot covers */
  period: string;
  /** ISO timestamp of generation */
  generatedAt: string;
  /** Aggregates over the full tracked universe (observed sample). */
  postings: {
    totalTracked: number;
    /** currently live (live or relisted status) */
    live: number;
    /** currently removed */
    removed: number;
    /** currently live again after an observed relist */
    relisted: number;
    /** postings observed taken down and reposted at least once (relistCount >= 1) */
    relistedAtLeastOnce: number;
    /** relistedAtLeastOnce / totalTracked (null when nothing tracked) */
    relistShare: number | null;
    /** median daysListed across live postings (null when none) */
    medianDaysListed: number | null;
    /** max daysListed across live postings (null when none) */
    maxDaysListed: number | null;
    /** how many live postings contributed daysListed */
    daysListedSample: number;
    /** distinct NAMED companies tracked (names themselves are never published) */
    distinctCompanies: number;
    /** postings that carry a company name */
    postingsWithCompany: number;
  };
  /** board split by sourceBoard across tracked postings (fixed tracked set) */
  boards: ReportBoardRow[];
  checks: {
    /** observations recorded in the period [periodStart, periodEnd) */
    inPeriod: number;
    /** distinct postings observed in the period */
    distinctPostings: number;
    /** checks in the period by what we observed (live/removed/...) */
    byOutcome: ReportCheckOutcome[];
    /** score distribution across postings checked in the period (recomputed) */
    scoreBuckets: ReportScoreBucket[];
    /** honest description of how the score distribution was produced */
    scoreMethod: string;
  };
  observation: {
    /** earliest firstSeenAt across tracked postings (window start) */
    earliestFirstSeenAt: string | null;
    /** whole days from earliest firstSeenAt to generation */
    windowDays: number;
  };
  /**
   * Daily compile layer (owner decision 2026-08-14: compile daily, publish
   * monthly). Industries, titles, requirement shares and trends are aggregated
   * from the stored daily_snapshots table — NEVER recomputed from raw postings
   * here. Honest n/a when the period has no daily snapshots yet.
   */
  daily: ReportDailySection;
}

/* ------------------- daily compile layer (report-side types) ------------------- */

export interface ReportIndustryRow {
  industry: string;
  count: number;
}

export interface ReportTitleRow {
  title: string;
  count: number;
}

export interface ReportRequirementShare {
  /** date of the daily snapshot these shares come from ("as of"), null when none */
  asOf: string | null;
  /** live tracked postings on the as-of snapshot (the honest universe that day) */
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
  /** share over the READ-description denominator (null when denominator 0) */
  bachelorShare: number | null;
  mastersShare: number | null;
  fivePlusShare: number | null;
  method: string;
}

export interface ReportTrendRow {
  key: string;
  label: string;
  /** value from this period's latest daily snapshot (null when n-a) */
  current: number | null;
  /** value from the previous period's latest daily snapshot (null when n-a) */
  previous: number | null;
  /** current - previous (null when n-a) */
  delta: number | null;
  direction: "up" | "down" | "flat" | "n-a";
  /** how the UI should render values: percent vs days vs plain count */
  format: "count" | "percent" | "days";
}

export interface ReportDailySection {
  /** how many daily snapshots fall inside this period */
  snapshotsUsed: number;
  /** first / last daily snapshot date inside the period (null when none) */
  firstDate: string | null;
  lastDate: string | null;
  /** top industries by summed daily counts (curated labels; Unclassified excluded — see unclassifiedCount) */
  industries: ReportIndustryRow[];
  /** summed daily count of postings with no company / unmapped company */
  unclassifiedCount: number;
  /** top-10 normalized titles by summed daily counts */
  titles: ReportTitleRow[];
  /** requirement shares from the period's LATEST daily snapshot ("as of" its date) */
  requirements: ReportRequirementShare;
  /** DAY-OVER-DAY trends (owner decision 2026-08-14): the period's two most
   *  recent daily snapshots compared, labeled "vs previous compile". Empty
   *  until the period has 2+ snapshots — honest n/a, see dailyTrendDates. */
  dailyTrends: ReportTrendRow[];
  /** the two dates dailyTrends compares (latest, previous); null until 2+ snapshots */
  dailyTrendDates: { latest: string | null; previous: string | null };
  /** period vs previous-period latest-snapshot deltas (empty when no daily history) */
  trends: ReportTrendRow[];
  /** the calendar period before this one ("YYYY-MM"), used as the trend baseline */
  previousPeriod: string | null;
  /** honest provenance note rendered under these sections */
  note: string;
}

/* ------------------------------ period helpers ----------------------------- */

/** "YYYY-MM" → first instant of the period (UTC), or null when invalid. */
export function periodStartIso(period: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`;
}

/** "YYYY-MM" → first instant AFTER the period (exclusive end), or null. */
export function periodEndIso(period: string): string | null {
  const start = periodStartIso(period);
  if (!start) return null;
  const d = new Date(Date.parse(start));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

/** Current calendar month as "YYYY-MM" (UTC — the monthly-report period). */
export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" → the previous calendar month as "YYYY-MM", or null when invalid. */
export function previousPeriod(period: string): string | null {
  const start = periodStartIso(period);
  if (!start) return null;
  const d = new Date(Date.parse(start));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ------------------------------- aggregation ------------------------------- */

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
 * Compute a monthly snapshot from the live store. Everything derives from
 * stored observations; nothing is estimated. Loopback fixture postings are
 * excluded (test data). `now` is injectable for deterministic tests.
 */
export async function computeReportSnapshot(
  store: Store,
  period: string,
  now: Date = new Date()
): Promise<ReportSnapshot> {
  const start = periodStartIso(period);
  const end = periodEndIso(period);
  if (!start || !end) throw new Error(`invalid period: ${period} (expected YYYY-MM)`);
  const nowIso = now.toISOString();

  const all = (await store.getAll()).filter((r) => !isLoopbackUrl(r.canonicalUrl));
  const total = all.length;

  // ── Batched context (one pass over the store instead of N+1 HTTP queries) ──
  // buildSignals normally queries identity groups + events per posting; the
  // report calls it for every live posting and every checked posting, which
  // was ~2 minutes of round-trips. Prefetching keeps the EXACT same inputs
  // (same groups, same events) while the whole snapshot needs ~5 queries.
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

  const live = all.filter((r) => r.status === "live" || r.status === "relisted").length;
  const removed = all.filter((r) => r.status === "removed").length;
  const relisted = all.filter((r) => r.status === "relisted").length;
  const relistedAtLeastOnce = all.filter((r) => r.relistCount > 0).length;

  // ── daysListed across live postings (via the signals layer, same as /company)
  const liveRecords = all.filter((r) => r.status === "live" || r.status === "relisted");
  const days: number[] = [];
  for (const rec of liveRecords) {
    days.push((await buildSignals(store, rec, ctx)).daysListed);
  }
  days.sort((a, b) => a - b);

  // ── board split across the fixed tracked set (0 counts are honest facts)
  const boards: ReportBoardRow[] = REPORT_BOARDS.map((board) => {
    const count = all.filter((r) => (r.sourceBoard || "web").toLowerCase() === board).length;
    return { board, count, share: total ? count / total : 0 };
  });

  // ── companies: count only; names are never published on report pages
  const named = all.filter((r) => r.company);
  const distinctCompanies = new Set(named.map((r) => r.company as string)).size;

  // ── checks recorded in the period
  const periodChecks = await store.checksInPeriod(start, end);
  const checkedPostingIds = [...new Set(periodChecks.map((c) => c.postingId))];

  const outcomeCounts = new Map<string, number>();
  for (const c of periodChecks) {
    outcomeCounts.set(c.observedStatus, (outcomeCounts.get(c.observedStatus) ?? 0) + 1);
  }
  const byOutcome: ReportCheckOutcome[] = [...outcomeCounts.entries()]
    .map(([observedStatus, count]) => ({ observedStatus, count }))
    .sort((a, b) => b.count - a.count);

  // ── score distribution: recompute the current score of each posting that was
  //    checked in the period (the checks table stores observations, not scores).
  //    Uses scoreCore with prefetched check counts — identical math to the
  //    per-posting scorePosting path, without the reasons/company overhead.
  const bucketCounts = new Map(SCORE_BUCKETS.map((b) => [b.label, 0]));
  for (const postingId of checkedPostingIds) {
    const rec = byPostingId.get(postingId);
    if (!rec) continue;
    const signals = await buildSignals(store, rec, ctx);
    const score = scoreCore(signals, checkCounts.get(postingId) ?? 0).score;
    const bucket = SCORE_BUCKETS.find((b) => score >= b.min && score <= b.max) ?? SCORE_BUCKETS[SCORE_BUCKETS.length - 1];
    bucketCounts.set(bucket.label, (bucketCounts.get(bucket.label) ?? 0) + 1);
  }
  const scored = checkedPostingIds.length;
  const scoreBuckets: ReportScoreBucket[] = SCORE_BUCKETS.map((b) => ({
    bucket: b.label,
    count: bucketCounts.get(b.label) ?? 0,
    share: scored ? (bucketCounts.get(b.label) ?? 0) / scored : 0,
  }));

  // ── observation window
  let earliest: string | null = null;
  for (const r of all) {
    if (!earliest || r.firstSeenAt < earliest) earliest = r.firstSeenAt;
  }
  const windowDays = earliest
    ? Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(earliest)) / 86400000))
    : 0;

  // ── daily compile layer: industries / titles / requirements / trends come
  //    from the stored daily_snapshots table (the compile layer), never
  //    recomputed from raw postings here. (owner decision 2026-08-14)
  const daily = await buildDailySection(store, period);

  return {
    period,
    generatedAt: nowIso,
    postings: {
      totalTracked: total,
      live,
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
    checks: {
      inPeriod: periodChecks.length,
      distinctPostings: checkedPostingIds.length,
      byOutcome,
      scoreBuckets,
      scoreMethod:
        "Scores were recomputed at report generation for the postings checked in this period (the checks log stores what we observed, not a score). A posting's score can change as it is watched longer.",
    },
    observation: {
      earliestFirstSeenAt: earliest,
      windowDays,
    },
    daily,
  };
}

/* ---------------------- daily compile layer (aggregation) ---------------------- */

function trendFormat(key: string): "count" | "percent" | "days" {
  if (key.endsWith("Share")) return "percent";
  if (key === "medianDaysListed") return "days";
  return "count";
}

/** Public form of trendFormat — shared with the rollup/trend layer (engine/rollups.ts). */
export function reportTrendFormat(key: string): "count" | "percent" | "days" {
  return trendFormat(key);
}

/**
 * The report's day-over-day trend metrics = the daily-stats headline metrics
 * PLUS board counts (every board the tracker covers) and score-bucket counts
 * (the confidence-score distribution over live postings). The daily snapshots
 * always carry all boards and all 5 buckets (0 counts included), so these picks
 * never silently vanish — a missing row is an honest n/a.
 */
const BOARD_TREND_METRICS: { key: string; label: string; pick: (s: DailySnapshot) => number | null }[] =
  REPORT_BOARDS.map((board) => ({
    key: `board_${board}`,
    label: `${board} postings`,
    pick: (s: DailySnapshot) => s.boards.find((b) => b.board === board)?.count ?? null,
  }));

const SCORE_TREND_METRICS: { key: string; label: string; pick: (s: DailySnapshot) => number | null }[] =
  SCORE_BUCKETS.map((b) => ({
    key: `score_${b.label.replace("-", "_")}`,
    label: `score ${b.label}`,
    pick: (s: DailySnapshot) => s.scores.find((x) => x.bucket === b.label)?.count ?? null,
  }));

export const REPORT_TREND_METRICS: { key: string; label: string; pick: (s: DailySnapshot) => number | null }[] = [
  ...TREND_METRICS,
  ...BOARD_TREND_METRICS,
  ...SCORE_TREND_METRICS,
];

/**
 * Aggregate the report's new data points from the daily_snapshots table (the
 * compile layer — owner decision 2026-08-14). NEVER recomputes from raw
 * postings:
 *   (a) industries — per-day industry counts summed across the period's daily
 *       snapshots; "Unclassified" (no company / unmapped) is counted
 *       separately, never as a row in the top list;
 *   (b) titles — per-day top-10 normalized-title counts summed across the
 *       period's daily snapshots (so a posting visible all month contributes
 *       once per daily snapshot — the UI labels this honestly);
 *   (c) requirements — copied from the period's LATEST daily snapshot, labeled
 *       "as of <date>", with the read-description denominator and the
 *       not-yet-extracted count so the share is honest;
 *   (d) trends — two views:
 *       (i)  DAY-OVER-DAY (owner decision 2026-08-14): the period's two most
 *            recent daily snapshots compared across the extended metric list
 *            (headlines + boards + score buckets), labeled "vs previous
 *            compile" — n/a until the period has 2+ snapshots;
 *       (ii) MONTH OVER MONTH (preserved behavior): the period's latest daily
 *            snapshot vs the PREVIOUS period's latest daily snapshot — n/a
 *            until the previous period has snapshots.
 */
export async function buildDailySection(
  store: Store,
  period: string
): Promise<ReportDailySection> {
  const rows = await store.listDailySnapshots();
  const periodRows = rows.filter((r) => r.date.startsWith(`${period}-`));
  const prevPeriod = previousPeriod(period);
  const prevRows = prevPeriod ? rows.filter((r) => r.date.startsWith(`${prevPeriod}-`)) : [];
  const last = periodRows.length ? periodRows[periodRows.length - 1] : null;
  const prevLast = prevRows.length ? prevRows[prevRows.length - 1] : null;
  const lastSnap = last ? (last.snapshot as DailySnapshot) : null;

  // (a) industries: sum the day-level counts; Unclassified kept separate
  const industryCounts = new Map<string, number>();
  let unclassifiedCount = 0;
  for (const r of periodRows) {
    const snap = r.snapshot as DailySnapshot;
    for (const row of snap.industries ?? []) {
      if (row.industry === FALLBACK_INDUSTRY) {
        unclassifiedCount += row.count;
        continue;
      }
      industryCounts.set(row.industry, (industryCounts.get(row.industry) ?? 0) + row.count);
    }
  }
  const industries: ReportIndustryRow[] = [...industryCounts.entries()]
    .map(([industry, count]) => ({ industry, count }))
    .sort((a, b) => b.count - a.count || a.industry.localeCompare(b.industry))
    .slice(0, 10);

  // (b) titles: sum the day-level top-10 counts (already normalized)
  const titleCounts = new Map<string, number>();
  for (const r of periodRows) {
    const snap = r.snapshot as DailySnapshot;
    for (const row of snap.titles ?? []) {
      titleCounts.set(row.title, (titleCounts.get(row.title) ?? 0) + row.count);
    }
  }
  const titles: ReportTitleRow[] = [...titleCounts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 10);

  // (c) requirements: honest "as of" the period's latest daily snapshot
  const req = lastSnap?.requirements ?? null;
  const requirements: ReportRequirementShare = req
    ? {
        asOf: last ? last.date : null,
        livePostings: req.livePostings,
        postingsWithDescriptionRead: req.postingsWithDescriptionRead,
        postingsWithFetchError: req.postingsWithFetchError,
        postingsNotYetExtracted: req.postingsNotYetExtracted,
        requiresBachelor: req.requiresBachelor,
        requiresMasters: req.requiresMasters,
        requires5PlusYears: req.requires5PlusYears,
        bachelorShare: req.bachelorShare,
        mastersShare: req.mastersShare,
        fivePlusShare: req.fivePlusShare,
        method:
          req.method ??
          "Requirement shares are computed over the live tracked postings whose description was actually read this cycle. A posting whose page could not be read is counted under fetch errors / not-yet-extracted — never as a zero.",
      }
    : {
        asOf: null,
        livePostings: 0,
        postingsWithDescriptionRead: 0,
        postingsWithFetchError: 0,
        postingsNotYetExtracted: 0,
        requiresBachelor: 0,
        requiresMasters: 0,
        requires5PlusYears: 0,
        bachelorShare: null,
        mastersShare: null,
        fivePlusShare: null,
        method:
          "No daily snapshot exists for this period yet — requirement shares will appear once the daily compile has run.",
      };

  // (d) trends — TWO views (owner decision 2026-08-14):
  //   (i) DAY-OVER-DAY: the period's two most recent daily snapshots compared
  //       across the extended metric list (headlines + boards + score buckets).
  //       Honest empty/n-a until the period has 2+ snapshots.
  const dailyTrends: ReportTrendRow[] = [];
  const dailyTrendDates: { latest: string | null; previous: string | null } = { latest: null, previous: null };
  if (periodRows.length >= 2) {
    const prev = periodRows[periodRows.length - 2];
    const latest = periodRows[periodRows.length - 1];
    dailyTrendDates.latest = latest.date;
    dailyTrendDates.previous = prev.date;
    const prevSnap = prev.snapshot as DailySnapshot;
    const latestSnap = latest.snapshot as DailySnapshot;
    const deltas = computeTrendsFor(REPORT_TREND_METRICS, prevSnap, latestSnap);
    for (const m of REPORT_TREND_METRICS) {
      const t = deltas[m.key];
      dailyTrends.push({
        key: m.key,
        label: m.label,
        current: m.pick(latestSnap),
        previous: m.pick(prevSnap),
        delta: t.delta,
        direction: t.direction,
        format: trendFormat(m.key),
      });
    }
  }

  //   (ii) MONTH OVER MONTH (preserved behavior): latest-of-period vs
  //        latest-of-previous-period. n-a until the previous period exists.
  const trends: ReportTrendRow[] = [];
  if (lastSnap) {
    const prevSnap = prevLast ? (prevLast.snapshot as DailySnapshot) : null;
    const deltas = computeTrends(prevSnap, lastSnap);
    for (const m of TREND_METRICS) {
      const t = deltas[m.key];
      const current = m.pick(lastSnap);
      const previous = prevSnap ? m.pick(prevSnap) : null;
      trends.push({
        key: m.key,
        label: m.label,
        current,
        previous,
        delta: t.delta,
        direction: t.direction,
        format: trendFormat(m.key),
      });
    }
  }

  const note =
    periodRows.length === 0
      ? "These sections are compiled from our daily snapshots. This period has no daily snapshots yet — they will appear from the first day the daily pipeline runs inside the period."
      : `Compiled from ${periodRows.length} daily snapshot${periodRows.length === 1 ? "" : "s"} in ${period} (${periodRows[0].date} → ${last!.date}, UTC). Industry labels are our curated single-label classification, not a standard taxonomy; title counts are normalized exact titles. Daily figures are summed across snapshots, so a posting visible all month contributes once per daily snapshot.` +
        (dailyTrends.length
          ? ` Day-over-day trend rows compare the two most recent compiles (${dailyTrendDates.previous} → ${dailyTrendDates.latest}).`
          : "");

  return {
    snapshotsUsed: periodRows.length,
    firstDate: periodRows.length ? periodRows[0].date : null,
    lastDate: last ? last.date : null,
    industries,
    unclassifiedCount,
    titles,
    requirements,
    dailyTrends,
    dailyTrendDates,
    trends,
    previousPeriod: prevPeriod,
    note,
  };
}

/* ------------------------------- persistence ------------------------------- */

/**
 * Persist a snapshot (idempotent: regenerating a period replaces it).
 * Convenience wrapper around Store.saveReportSnapshot.
 */
export async function saveReportSnapshot(store: Store, snapshot: ReportSnapshot): Promise<void> {
  await store.saveReportSnapshot(snapshot.period, snapshot.generatedAt, snapshot);
}

/** One-line honest summary of a snapshot (for the /reports index). */
export function reportSummaryLine(s: ReportSnapshot): string {
  const p = s.postings;
  const relistPct =
    p.relistShare === null ? "n/a" : `${Math.round(p.relistShare * 1000) / 10}%`;
  const med = p.medianDaysListed === null ? "n/a" : `${p.medianDaysListed} day${p.medianDaysListed === 1 ? "" : "s"}`;
  let line = `${s.period} — ${p.totalTracked} postings tracked; ${p.relistedAtLeastOnce} observed taken down and reposted (${relistPct}); median listing ${med}; ${p.distinctCompanies} companies.`;
  if (s.daily?.snapshotsUsed > 0 && s.daily.industries[0]) {
    line += ` Top industry: ${s.daily.industries[0].industry} (${s.daily.industries[0].count.toLocaleString("en-US")}).`;
  }
  return line;
}

/** Human month label for a period, e.g. "2026-08" → "August 2026". */
export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period ?? "");
  if (!m) return period;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const month = months[Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : period;
}
