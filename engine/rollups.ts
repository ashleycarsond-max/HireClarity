/**
 * REPORT ROLLUPS + LONG-TERM TRENDS (owner direction 2026-08-15) — permanent
 * archives and day/week/month/year time trends.
 *
 * WHAT THIS LAYER ADDS
 *   (a) PERMANENT ARCHIVES: every daily snapshot (daily_snapshots table) and
 *       every report compile (report_snapshots table) is retained forever —
 *       there is NO pruning/expiry anywhere in the pipeline (the only DELETE
 *       paths are explicit fixture-cleanup / admin helpers). This module adds
 *       the `report_rollups` table (period_type + period PK, JSONB payload):
 *       week/month/year buckets aggregated FROM the stored daily snapshots
 *       (never recomputed from raw postings), so every period has a public,
 *       stable archive page.
 *   (b) ROLLUP AGGREGATION: computeRollup sums the period's daily snapshots
 *       for industries/titles (the "activity in the period" view, same as the
 *       monthly report's compile layer) and uses the period's LATEST daily
 *       snapshot for the level metrics (postings/boards/scores/requirements)
 *       so values are "as of" the last compile in the period and stay
 *       comparable across periods. Day buckets exist implicitly (the daily
 *       snapshots themselves); week/month/year are materialized here.
 *   (c) HONEST TRENDS: every rollup carries delta+direction vs the PREVIOUS
 *       same-type bucket. Views at day/week/month/year granularity show the
 *       same extended metric list as the report's day-over-day rows
 *       (REPORT_TREND_METRICS — headlines + boards + score buckets), with the
 *       honest "n/a until enough history" rule: day rows need 2+ days, week
 *       2+ weeks, month 2+ months, year 2+ years. Insufficient history shows
 *       "n/a" — never a fabricated direction.
 *
 * DATA PROVENANCE (honesty rules, same spirit as engine/daily-stats.ts):
 *   - All figures derive from stored observations of the tracked sample. A
 *     rollup is an aggregation of daily snapshots — it never invents values.
 *   - Requirements shares come from the latest day's read-description
 *     denominator, labeled "as of <date>".
 *   - All dates are UTC calendar dates; weeks are ISO-8601 weeks (YYYY-Www).
 */

// NOTE on import order: report.ts and daily-stats.ts form a pre-existing
// circular pair (daily-stats imports REPORT_BOARDS from report; report imports
// TREND_METRICS from daily-stats). The cycle only resolves when report.ts is
// EVALUATED FIRST (its body runs after daily-stats completes). Keep the
// report import ABOVE the daily-stats import — ESM evaluates dependencies in
// import-statement order, and flipping them throws "Cannot access
// 'TREND_METRICS' before initialization".
import { REPORT_TREND_METRICS, REPORT_BOARDS, periodLabel, reportTrendFormat } from "./report";
import { parseDateStr, type DailySnapshot, type TrendEntry } from "./daily-stats";
import { FALLBACK_INDUSTRY } from "./company-industries";
import type { Store } from "./store";

/* ------------------------------ period shapes ------------------------------ */

export type PeriodKind = "day" | "week" | "month" | "year";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^(\d{4})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Classify a period id: "2026-08-17" → day, "2026-W34" → week, "2026-08" →
 * month, "2026" → year. Returns null when the shape is invalid (including
 * impossible dates/weeks). Day shapes must pass parseDateStr; week shapes must
 * resolve to a real ISO week.
 */
export function periodKind(period: string): PeriodKind | null {
  const p = period ?? "";
  if (DAY_RE.test(p)) return parseDateStr(p) ? "day" : null;
  if (WEEK_RE.test(p)) return isoWeekStart(p) ? "week" : null;
  if (MONTH_RE.test(p)) {
    const m = MONTH_RE.exec(p);
    if (!m) return null;
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return "month";
  }
  if (YEAR_RE.test(p)) {
    const year = Number(p);
    if (year < 2000 || year > 2999) return null;
    return "year";
  }
  return null;
}

/* -------------------------------- date helpers ----------------------------- */

/** ISO-8601 week ("YYYY-Www") containing a UTC calendar date. */
export function isoWeekOf(dateStr: string): string | null {
  if (!parseDateStr(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const year = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(Date.UTC(year, 0, 4 - (jan4Day - 1)));
  // `date` is the ISO Thursday of the week → whole weeks since week-1 Monday
  const week = Math.floor((date.getTime() - week1Monday.getTime()) / 86400000 / 7) + 1;
  return `${year}-W${pad2(week)}`;
}

/** The Monday (UTC) of an ISO week period, as "YYYY-MM-DD". Null when invalid. */
export function isoWeekStart(period: string): string | null {
  const m = WEEK_RE.exec(period ?? "");
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(Date.UTC(year, 0, 4 - (jan4Day - 1)));
  const monday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
}

/** Bucket id a date falls into for a rollup type ("2026-08-17" → week "2026-W34"). */
export function rollupPeriodForDate(type: PeriodKind, dateStr: string): string | null {
  if (!parseDateStr(dateStr)) return null;
  if (type === "day") return dateStr;
  if (type === "week") return isoWeekOf(dateStr);
  if (type === "month") return dateStr.slice(0, 7);
  if (type === "year") return dateStr.slice(0, 4);
  return null;
}

/** The bucket immediately before `period` for the same type (trend baseline). */
export function previousRollupPeriod(type: PeriodKind, period: string): string | null {
  if (type === "week") {
    const monday = isoWeekStart(period);
    if (!monday) return null;
    const d = new Date(Date.parse(`${monday}T00:00:00.000Z`));
    d.setUTCDate(d.getUTCDate() - 7);
    return isoWeekOf(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  }
  if (type === "month") {
    const m = MONTH_RE.exec(period ?? "");
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    d.setUTCMonth(d.getUTCMonth() - 1);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
  }
  if (type === "year") {
    const m = YEAR_RE.exec(period ?? "");
    if (!m) return null;
    return String(Number(m[1]) - 1);
  }
  return null;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08-17" → "August 17, 2026" (UTC, deterministic — no locale dependence). */
export function dayLabel(dateStr: string): string {
  const m = DAY_RE.exec(dateStr ?? "");
  if (!m) return dateStr;
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** "2026-W34" → "Week of August 17, 2026" (the ISO week's Monday). */
export function weekLabel(period: string): string {
  const monday = isoWeekStart(period);
  return monday ? `Week of ${dayLabel(monday)}` : period;
}

/** Human label for a period of any kind (day/week/month/year). */
export function periodLabelFor(period: string): string {
  const kind = periodKind(period);
  if (kind === "day") return dayLabel(period);
  if (kind === "week") return weekLabel(period);
  if (kind === "month") return periodLabel(period);
  if (kind === "year") return period;
  return period;
}

/** Human label for a granularity ("day-over-day" phrasing helpers). */
export function granularityNoun(kind: PeriodKind): string {
  if (kind === "day") return "day";
  if (kind === "week") return "week";
  if (kind === "month") return "month";
  return "year";
}

/* --------------------------- the archive/rollup shape ---------------------- */

/**
 * The renderable shape of ANY archived period — a daily snapshot or a
 * week/month/year rollup — so one archive page renders every granularity.
 * Every figure is "as of" the period's last compile (the level metrics come
 * from the latest daily snapshot in the period; industries/titles are summed
 * across the period's daily snapshots, exactly like the monthly report's
 * compile layer).
 */
export interface ArchiveView {
  kind: PeriodKind;
  /** bucket id: "YYYY-MM-DD" | "YYYY-Www" | "YYYY-MM" | "YYYY" */
  period: string;
  /** human label, e.g. "August 17, 2026" */
  label: string;
  /** ISO timestamp of this archive's compile/rollup */
  generatedAt: string;
  /** how many daily snapshots feed this period (1 for a day) */
  snapshotsUsed: number;
  /** first / last daily snapshot date inside the period (null when none) */
  firstDate: string | null;
  lastDate: string | null;
  postings: DailySnapshot["postings"];
  boards: DailySnapshot["boards"];
  industries: DailySnapshot["industries"];
  unclassifiedCount: number;
  titles: DailySnapshot["titles"];
  requirements: DailySnapshot["requirements"];
  scores: DailySnapshot["scores"];
  /** delta + direction vs the previous same-type period (empty when none) */
  trends: Record<string, TrendEntry>;
  /** honest provenance note */
  method: string;
}

/** Adapt a stored daily snapshot to the shared archive shape (day bucket). */
export function archiveFromDaily(snap: DailySnapshot): ArchiveView {
  return {
    kind: "day",
    period: snap.date,
    label: dayLabel(snap.date),
    generatedAt: snap.generatedAt,
    snapshotsUsed: 1,
    firstDate: snap.date,
    lastDate: snap.date,
    postings: snap.postings,
    boards: snap.boards,
    industries: snap.industries,
    unclassifiedCount: snap.unclassifiedCount,
    titles: snap.titles,
    requirements: snap.requirements,
    scores: snap.scores,
    trends: snap.trends ?? {},
    method:
      snap.method ??
      "Daily snapshot of the observed tracked sample (all dates UTC), compiled at 02:30 UTC from stored observations.",
  };
}

/* ------------------------------ trend plumbing ----------------------------- */

/** The structural surface the trend picks read — shared by ArchiveView and DailySnapshot. */
export interface TrendSurface {
  postings: {
    totalTracked: number;
    live: number;
    removed: number;
    relisted: number;
    relistShare: number | null;
    medianDaysListed: number | null;
    distinctCompanies: number;
  };
  requirements: {
    bachelorShare: number | null;
    mastersShare: number | null;
    fivePlusShare: number | null;
    postingsWithDescriptionRead: number;
  };
  industries: { count: number }[];
  titles: { count: number }[];
  boards: { board: string; count: number }[];
  scores: { bucket: string; count: number }[];
}

/**
 * The extended metric list used for every granularity's trend rows — the SAME
 * keys/labels/formats as the report's day-over-day rows (REPORT_TREND_METRICS:
 * headline metrics + every tracked board + every score bucket), so a reader
 * sees consistent rows whether they look at day, week, month or year views.
 */
export interface PeriodTrendMetric {
  key: string;
  label: string;
  format: "count" | "percent" | "days";
  pick: (s: TrendSurface) => number | null;
}

export const PERIOD_TREND_METRICS: PeriodTrendMetric[] = REPORT_TREND_METRICS.map((m) => ({
  key: m.key,
  label: m.label,
  format: reportTrendFormat(m.key),
  pick: (s: TrendSurface) => m.pick(s as unknown as DailySnapshot),
}));

/** Literal delta + direction between two surfaces (same math as computeTrendsFor). */
export function periodDeltas(
  prev: TrendSurface | null,
  curr: TrendSurface
): Record<string, TrendEntry> {
  const out: Record<string, TrendEntry> = {};
  for (const m of PERIOD_TREND_METRICS) {
    const p = prev ? m.pick(prev) : null;
    const c = m.pick(curr);
    if (p === null || c === null || prev === null) {
      out[m.key] = { delta: null, direction: "n-a" };
      continue;
    }
    const delta = Math.round((c - p) * 10000) / 10000;
    out[m.key] = { delta, direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat" };
  }
  return out;
}

/* -------------------------------- aggregation ------------------------------ */

/**
 * Compute one week/month/year rollup from the stored daily snapshots.
 * Returns null when NO daily snapshot falls inside the period. Level metrics
 * (postings/boards/scores/requirements) come from the period's LATEST daily
 * snapshot ("as of" its date); industries and titles are summed across the
 * period's daily snapshots (a posting visible all period counts once per
 * daily snapshot — the UI labels this honestly). Trends are computed against
 * the previous same-type rollup (`prev`), never invented when absent.
 */
export function computeRollup(
  snapshots: DailySnapshot[],
  type: "week" | "month" | "year",
  period: string,
  prev: ArchiveView | null,
  now: Date = new Date()
): ArchiveView | null {
  if (periodKind(period) !== type) return null;
  const days = snapshots
    .filter((s) => rollupPeriodForDate(type, s.date) === period)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length === 0) return null;
  const last = days[days.length - 1];

  // industries: summed across days; "Unclassified" kept separate (same as the
  // monthly report's compile layer — never a row in the top list)
  const industryCounts = new Map<string, number>();
  let unclassifiedCount = 0;
  for (const s of days) {
    for (const row of s.industries ?? []) {
      if (row.industry === FALLBACK_INDUSTRY) {
        unclassifiedCount += row.count;
        continue;
      }
      industryCounts.set(row.industry, (industryCounts.get(row.industry) ?? 0) + row.count);
    }
  }
  const industries = [...industryCounts.entries()]
    .map(([industry, count]) => ({ industry, count, share: 0 }))
    .sort((a, b) => b.count - a.count || a.industry.localeCompare(b.industry))
    .slice(0, 10);
  const industryTotal = industries.reduce((n, r) => n + r.count, 0);

  // titles: summed across the period's days (already normalized, top-10 per day)
  const titleCounts = new Map<string, number>();
  for (const s of days) {
    for (const row of s.titles ?? []) {
      titleCounts.set(row.title, (titleCounts.get(row.title) ?? 0) + row.count);
    }
  }
  const titles = [...titleCounts.entries()]
    .map(([title, count]) => ({ title, count, share: 0 }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
    .slice(0, 10);
  const titleTotal = titles.reduce((n, r) => n + r.count, 0);

  const base: Omit<ArchiveView, "trends"> = {
    kind: type,
    period,
    label: periodLabelFor(period),
    generatedAt: now.toISOString(),
    snapshotsUsed: days.length,
    firstDate: days[0].date,
    lastDate: last.date,
    postings: last.postings,
    boards: last.boards,
    industries: industries.map((r) => ({ ...r, share: industryTotal ? r.count / industryTotal : 0 })),
    unclassifiedCount,
    titles: titles.map((r) => ({ ...r, share: titleTotal ? r.count / titleTotal : 0 })),
    requirements: last.requirements,
    scores: last.scores,
    method:
      `Rollup of ${days.length} daily snapshot${days.length === 1 ? "" : "s"} (${days[0].date} → ${last.date}, UTC) into ${type} ${period}. ` +
      `Level figures (postings, boards, scores, requirements) are as of the latest daily snapshot in the period (${last.date}); ` +
      `industry and title counts are summed across the period's daily snapshots, so a posting visible all period contributes once per daily snapshot. ` +
      `Trend rows compare against the previous ${type}.`,
  };
  const view: ArchiveView = { ...base, trends: periodDeltas(prev, base) };
  return view;
}

/** The period row shape for the series tables (one row per archived period). */
export interface TrendPeriodRow {
  period: string;
  label: string;
  values: Record<string, number | null>;
}

/** One compare row: current period vs previous period (same shape as the report's daily trend rows). */
export interface TrendCompareRow {
  key: string;
  label: string;
  format: "count" | "percent" | "days";
  current: number | null;
  previous: number | null;
  delta: number | null;
  direction: "up" | "down" | "flat" | "n-a";
}

/** One granularity's full trend view (series + latest-vs-previous compare). */
export interface GranularityTrendView {
  granularity: PeriodKind;
  /** every archived period of this type, oldest first (period → values) */
  periods: TrendPeriodRow[];
  /** latest vs previous period across the extended metric list ([] until 2+ periods) */
  compare: TrendCompareRow[];
  latestPeriod: string | null;
  previousPeriod: string | null;
  /** honest provenance/history-depth note rendered under the tables */
  note: string;
}

function surfaceOf(v: ArchiveView | DailySnapshot): TrendSurface {
  return v as unknown as TrendSurface;
}

function compareRows(prev: TrendSurface | null, curr: TrendSurface): TrendCompareRow[] {
  const deltas = periodDeltas(prev, curr);
  return PERIOD_TREND_METRICS.map((m) => {
    const t = deltas[m.key];
    return {
      key: m.key,
      label: m.label,
      format: m.format,
      current: m.pick(curr),
      previous: prev ? m.pick(prev) : null,
      delta: t.delta,
      direction: t.direction,
    };
  });
}

function seriesRows(views: ArchiveView[]): TrendPeriodRow[] {
  return views.map((v) => ({
    period: v.period,
    label: v.label,
    values: Object.fromEntries(
      PERIOD_TREND_METRICS.map((m) => [m.key, m.pick(surfaceOf(v))])
    ),
  }));
}

function trendNote(kind: PeriodKind, n: number, first: string | null, last: string | null): string {
  const noun = granularityNoun(kind);
  const pair = `${noun}-over-${noun}`;
  if (n === 0) {
    return `No ${noun} data yet — ${pair} rows will appear once two ${noun}s have daily snapshots.`;
  }
  if (n === 1) {
    return `${n} ${noun} recorded so far${first ? ` (${dayLabel(first)})` : ""}. ${pair} rows need a second ${noun} — nothing is shown until then, and no direction is ever invented.`;
  }
  return `${n} ${noun}s recorded${first && last ? ` (${dayLabel(first)} → ${dayLabel(last)}, UTC)` : ""}. Rows compare the two most recent ${noun}s; a direction is the literal change in the metric between them.`;
}

/**
 * Build all four granularity trend views from the stored archives (day reads
 * the daily snapshots — the implicit day buckets; week/month/year read the
 * report_rollups table). Honest insufficient-history behavior: compare rows
 * are empty until the granularity has 2+ periods.
 */
export async function buildTrendViews(store: Store): Promise<{
  day: GranularityTrendView;
  week: GranularityTrendView;
  month: GranularityTrendView;
  year: GranularityTrendView;
}> {
  const dailyRows = await store.listDailySnapshots();
  const dayViews = dailyRows.map((r) => archiveFromDaily(r.snapshot as DailySnapshot));
  const dayView: GranularityTrendView = {
    granularity: "day",
    periods: seriesRows(dayViews),
    compare: dayViews.length >= 2 ? compareRows(surfaceOf(dayViews[dayViews.length - 2]), surfaceOf(dayViews[dayViews.length - 1])) : [],
    latestPeriod: dayViews.length ? dayViews[dayViews.length - 1].period : null,
    previousPeriod: dayViews.length >= 2 ? dayViews[dayViews.length - 2].period : null,
    note: trendNote("day", dayViews.length, dayViews[0]?.firstDate ?? null, dayViews[dayViews.length - 1]?.lastDate ?? null),
  };

  const out: Record<"week" | "month" | "year", GranularityTrendView> = {} as never;
  for (const type of ["week", "month", "year"] as const) {
    const rows = await store.listRollups(type);
    const views = rows.map((r) => r.payload as ArchiveView);
    out[type] = {
      granularity: type,
      periods: seriesRows(views),
      compare: views.length >= 2 ? compareRows(surfaceOf(views[views.length - 2]), surfaceOf(views[views.length - 1])) : [],
      latestPeriod: views.length ? views[views.length - 1].period : null,
      previousPeriod: views.length >= 2 ? views[views.length - 2].period : null,
      note: trendNote(type, views.length, views[0]?.firstDate ?? null, views[views.length - 1]?.lastDate ?? null),
    };
  }
  return { day: dayView, week: out.week, month: out.month, year: out.year };
}

/* ------------------------------ persistence ------------------------------- */

/**
 * Recompute (upsert) the week/month/year buckets that contain `dateStr` from
 * the stored daily snapshots — called by the 02:30 daily cron right after a
 * snapshot is saved (and by `bun run daily-stats`), so every bucket stays
 * current incrementally. Idempotent: re-running replaces the same buckets.
 * Day buckets are the daily snapshots themselves and are never written here.
 */
export async function upsertRollupsForDate(store: Store, dateStr: string): Promise<{ type: PeriodKind; period: string }[]> {
  const valid = parseDateStr(dateStr);
  if (!valid) return [];
  const rows = await store.listDailySnapshots();
  const snapshots = rows.map((r) => r.snapshot as DailySnapshot);
  const updated: { type: PeriodKind; period: string }[] = [];
  for (const type of ["week", "month", "year"] as const) {
    const period = rollupPeriodForDate(type, dateStr);
    if (!period) continue;
    const prevPeriod = previousRollupPeriod(type, period);
    const prevRow = prevPeriod ? await store.getRollup(type, prevPeriod) : null;
    const view = computeRollup(snapshots, type, period, prevRow ? (prevRow.payload as ArchiveView) : null);
    if (view) {
      await store.saveRollup(type, period, view);
      updated.push({ type, period });
    }
  }
  return updated;
}

/** Backfill: recompute every week/month/year bucket from all stored daily snapshots (idempotent). */
export async function recomputeAllRollups(store: Store): Promise<{ type: PeriodKind; count: number }[]> {
  const rows = await store.listDailySnapshots();
  const snapshots = rows.map((r) => r.snapshot as DailySnapshot);
  const totals: { type: PeriodKind; count: number }[] = [];
  for (const type of ["week", "month", "year"] as const) {
    const periods = new Set<string>();
    for (const s of snapshots) {
      const p = rollupPeriodForDate(type, s.date);
      if (p) periods.add(p);
    }
    const sorted = [...periods].sort((a, b) => a.localeCompare(b));
    let count = 0;
    for (const period of sorted) {
      const prevPeriod = previousRollupPeriod(type, period);
      const prevRow = prevPeriod ? await store.getRollup(type, prevPeriod) : null;
      const view = computeRollup(snapshots, type, period, prevRow ? (prevRow.payload as ArchiveView) : null);
      if (view) {
        await store.saveRollup(type, period, view);
        count++;
      }
    }
    totals.push({ type, count });
  }
  return totals;
}

/** One-line summary of an archive view (for index pages). */
export function archiveSummaryLine(v: ArchiveView): string {
  const p = v.postings;
  const relistPct = p.relistShare === null ? "n/a" : `${Math.round(p.relistShare * 1000) / 10}%`;
  const med = p.medianDaysListed === null ? "n/a" : `${p.medianDaysListed} day${p.medianDaysListed === 1 ? "" : "s"}`;
  let line = `${v.label} — ${p.totalTracked.toLocaleString("en-US")} postings tracked; ${p.relistedAtLeastOnce.toLocaleString("en-US")} observed taken down and reposted (${relistPct}); median listing ${med}; ${p.distinctCompanies.toLocaleString("en-US")} companies.`;
  if (v.industries[0]) line += ` Top industry: ${v.industries[0].industry} (${v.industries[0].count.toLocaleString("en-US")}).`;
  return line;
}

/** All boards the tracker covers (re-exported for the archive pages). */
export const ARCHIVE_BOARDS = REPORT_BOARDS;
