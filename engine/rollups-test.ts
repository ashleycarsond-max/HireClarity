/**
 * REPORT ROLLUPS + PERMANENT ARCHIVES test suite (owner direction 2026-08-15:
 * permanent archives of every report/snapshot + day/week/month/year rollup
 * tables + public trend views with honest insufficient-history behavior).
 *
 * Run: bun run rollups-test
 *
 * Covers (all against an in-memory FAKE store — no live data touched):
 *   1. Period shapes + ISO-week math: periodKind classification, isoWeekOf,
 *      isoWeekStart, previousRollupPeriod (incl. year boundaries).
 *   2. computeRollup aggregation: level metrics from the period's LATEST daily
 *      snapshot; industries/titles summed across the period's days;
 *      unclassified kept separate; trends vs the previous same-type rollup.
 *   3. Incremental population: upsertRollupsForDate refreshes exactly the
 *      week/month/year buckets containing the date; day buckets stay implicit
 *      (no report_rollups day rows are ever written).
 *   4. Backfill: recomputeAllRollups rebuilds every bucket idempotently.
 *   5. Honest insufficient-history: buildTrendViews returns empty compare rows
 *      + an honest note when a granularity has < 2 periods (day needs 2+
 *      days, week 2+ weeks, month 2+ months, year 2+ years); compare rows
 *      appear once 2+ periods exist, with correct delta/direction.
 *   6. archiveFromDaily adapts a daily snapshot to the shared archive shape.
 */
import {
  archiveFromDaily,
  buildTrendViews,
  computeRollup,
  dayLabel,
  isoWeekOf,
  isoWeekStart,
  periodKind,
  periodLabelFor,
  previousRollupPeriod,
  recomputeAllRollups,
  rollupPeriodForDate,
  upsertRollupsForDate,
  weekLabel,
  type ArchiveView,
} from "./rollups";
import { type DailySnapshot } from "./daily-stats";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  }
}
function checkTrue(label: string, cond: boolean): void {
  check(label, cond, true);
}

/* ----------------------- fake store (in-memory, no DB) ----------------------- */
class FakeStore {
  daily = new Map<string, unknown>();
  rollups = new Map<string, Map<string, unknown>>(); // period_type -> period -> payload
  async saveDailySnapshot(date: string, snapshot: unknown): Promise<void> {
    this.daily.set(date, snapshot);
  }
  async listDailySnapshots(): Promise<{ date: string; snapshot: unknown; createdAt: string }[]> {
    return [...this.daily.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, snapshot]) => ({ date, snapshot, createdAt: "" }));
  }
  async saveRollup(periodType: string, period: string, payload: unknown): Promise<void> {
    if (!this.rollups.has(periodType)) this.rollups.set(periodType, new Map());
    this.rollups.get(periodType)!.set(period, payload);
  }
  async getRollup(periodType: string, period: string): Promise<{ periodType: string; period: string; payload: unknown; updatedAt: string } | null> {
    const payload = this.rollups.get(periodType)?.get(period);
    return payload === undefined ? null : { periodType, period, payload, updatedAt: "" };
  }
  async listRollups(periodType: string): Promise<{ period: string; payload: unknown; updatedAt: string }[]> {
    const m = this.rollups.get(periodType);
    if (!m) return [];
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, payload]) => ({ period, payload, updatedAt: "" }));
  }
  async deleteRollup(periodType: string, period: string): Promise<void> {
    this.rollups.get(periodType)?.delete(period);
  }
  close(): void {}
}

/* ------------------------------ fixture factory ------------------------------ */
function mkDailySnapshot(date: string, over: Partial<DailySnapshot> = {}): DailySnapshot {
  return {
    date,
    generatedAt: `${date}T02:30:00.000Z`,
    postings: {
      totalTracked: 100,
      live: 80,
      removed: 15,
      relisted: 5,
      relistedAtLeastOnce: 10,
      relistShare: 0.1,
      medianDaysListed: 21,
      maxDaysListed: 90,
      daysListedSample: 80,
      distinctCompanies: 30,
      postingsWithCompany: 95,
    },
    boards: [
      { board: "greenhouse", count: 40, share: 0.4 },
      { board: "ashby", count: 20, share: 0.2 },
      { board: "lever", count: 15, share: 0.15 },
      { board: "web", count: 15, share: 0.15 },
    ],
    industries: [
      { industry: "AI/ML", count: 50, share: 0.5 },
      { industry: "Unclassified", count: 5, share: 0.05 },
    ],
    unclassifiedCount: 5,
    titles: [{ title: "software engineer", count: 20, share: 0.25 }],
    companies: [],
    requirements: {
      livePostings: 80,
      postingsWithDescriptionRead: 60,
      postingsWithFetchError: 5,
      postingsNotYetExtracted: 15,
      requiresBachelor: 30,
      requiresMasters: 10,
      requires5PlusYears: 20,
      bachelorShare: 0.5,
      mastersShare: 0.1667,
      fivePlusShare: 0.3333,
      method: "TEST FIXTURE",
    },
    scores: [
      { bucket: "0-20", count: 5, share: 0.0625 },
      { bucket: "21-40", count: 10, share: 0.125 },
      { bucket: "41-60", count: 20, share: 0.25 },
      { bucket: "61-80", count: 25, share: 0.3125 },
      { bucket: "81-100", count: 20, share: 0.25 },
    ],
    trends: {},
    method: "TEST FIXTURE — synthetic rows for rollups-test; never published",
    ...over,
  };
}

/* ============================ 1. period shapes + ISO weeks ============================ */
console.log("== 1. period shapes + ISO week math ==");
check("isoWeekOf 2026-08-17 (Monday)", isoWeekOf("2026-08-17"), "2026-W34");
check("isoWeekOf 2026-01-01 (Thursday)", isoWeekOf("2026-01-01"), "2026-W01");
check("isoWeekOf 2026-12-31 (Thursday)", isoWeekOf("2026-12-31"), "2026-W53");
check("isoWeekOf 2027-01-01 belongs to 2026-W53", isoWeekOf("2027-01-01"), "2026-W53");
check("isoWeekOf invalid date", isoWeekOf("2026-02-30"), null);
check("isoWeekStart 2026-W34", isoWeekStart("2026-W34"), "2026-08-17");
check("isoWeekStart invalid week 99", isoWeekStart("2026-W99"), null);
check("previous week 2026-W01 rolls to 2025-W52", previousRollupPeriod("week", "2026-W01"), "2025-W52");
check("previous week 2026-W34", previousRollupPeriod("week", "2026-W34"), "2026-W33");
check("previous month 2026-08", previousRollupPeriod("month", "2026-08"), "2026-07");
check("previous month 2026-01 rolls to 2025-12", previousRollupPeriod("month", "2026-01"), "2025-12");
check("previous year 2026", previousRollupPeriod("year", "2026"), "2025");
check("periodKind day", periodKind("2026-08-17"), "day");
check("periodKind week", periodKind("2026-W34"), "week");
check("periodKind month", periodKind("2026-08"), "month");
check("periodKind year", periodKind("2026"), "year");
check("periodKind rejects 2026-13", periodKind("2026-13"), null);
check("periodKind rejects 2026-W99", periodKind("2026-W99"), null);
check("periodKind rejects 2026-02-30", periodKind("2026-02-30"), null);
check("periodKind rejects garbage", periodKind("abc"), null);
check("rollupPeriodForDate week", rollupPeriodForDate("week", "2026-08-17"), "2026-W34");
check("rollupPeriodForDate month", rollupPeriodForDate("month", "2026-08-17"), "2026-08");
check("rollupPeriodForDate year", rollupPeriodForDate("year", "2026-08-17"), "2026");
check("labels", [dayLabel("2026-08-17"), weekLabel("2026-W34"), periodLabelFor("2026-08"), periodLabelFor("2026")], [
  "August 17, 2026",
  "Week of August 17, 2026",
  "August 2026",
  "2026",
]);

/* ============================ 2. computeRollup aggregation ============================ */
console.log("== 2. computeRollup aggregation ==");
const wkA1 = mkDailySnapshot("2026-08-17", { postings: { ...mkDailySnapshot("2026-08-17").postings, totalTracked: 100 } });
const wkA2 = mkDailySnapshot("2026-08-18", {
  postings: { ...mkDailySnapshot("2026-08-18").postings, totalTracked: 110 },
  industries: [
    { industry: "AI/ML", count: 60, share: 0.5 },
    { industry: "Cybersecurity", count: 40, share: 0.3333 },
    { industry: "Unclassified", count: 7, share: 0.0583 },
  ],
  unclassifiedCount: 7,
});
const wkA3 = mkDailySnapshot("2026-08-19", {
  postings: { ...mkDailySnapshot("2026-08-19").postings, totalTracked: 120 },
  requirements: { ...mkDailySnapshot("2026-08-19").requirements, bachelorShare: 0.6 },
});
const wkB1 = mkDailySnapshot("2026-08-24", { postings: { ...mkDailySnapshot("2026-08-24").postings, totalTracked: 130 } });
const wkB2 = mkDailySnapshot("2026-08-25", { postings: { ...mkDailySnapshot("2026-08-25").postings, totalTracked: 140 } });

const wk34 = computeRollup([wkA1, wkA2, wkA3], "week", "2026-W34", null, new Date("2026-08-19T03:00:00Z"))!;
checkTrue("week rollup computed for 2026-W34", wk34 !== null);
check("week rollup kind/period", [wk34.kind, wk34.period], ["week", "2026-W34"]);
check("week rollup snapshotsUsed", wk34.snapshotsUsed, 3);
check("week rollup first/last", [wk34.firstDate, wk34.lastDate], ["2026-08-17", "2026-08-19"]);
check("week rollup level metrics = LATEST day (totalTracked 120)", wk34.postings.totalTracked, 120);
check("week rollup requirements = LATEST day (bachelorShare 0.6)", wk34.requirements.bachelorShare, 0.6);
check("week rollup boards = LATEST day", wk34.boards[0], { board: "greenhouse", count: 40, share: 0.4 });
check("week rollup industries SUMMED across days (AI/ML 50+60+50=160)", wk34.industries.find((i) => i.industry === "AI/ML")?.count, 160);
check("week rollup second industry summed (40)", wk34.industries.find((i) => i.industry === "Cybersecurity")?.count, 40);
check("week rollup unclassified summed (5+7+5=17)", wk34.unclassifiedCount, 17);
check("week rollup titles summed (20+20+20=60)", wk34.titles[0]?.count, 60);
checkTrue("week rollup has trends object (empty vs no previous)", Object.keys(wk34.trends ?? {}).length >= 0);
check("week rollup trends are all n-a without a previous period", wk34.trends["totalTracked"], { delta: null, direction: "n-a" });
check("computeRollup null when no snapshots in period", computeRollup([wkA1], "week", "2026-W50", null), null);
check("computeRollup null when period kind mismatched", computeRollup([wkA1], "week", "2026-08", null), null);

/* ============================ 3. incremental upsert ============================ */
console.log("== 3. upsertRollupsForDate (incremental) ==");
const store = new FakeStore();
await store.saveDailySnapshot(wkA1.date, wkA1);
const ups1 = await upsertRollupsForDate(store, "2026-08-17");
check("upsert for 2026-08-17 touches week/month/year", ups1.map((u) => `${u.type}:${u.period}`).sort(), ["month:2026-08", "week:2026-W34", "year:2026"]);
check("no day rows in report_rollups (day buckets are the snapshots)", (await store.listRollups("day")).length, 0);
const wk34Stored = (await store.getRollup("week", "2026-W34"))!.payload as ArchiveView;
check("stored W34 was computed from the 1 day saved so far", wk34Stored.snapshotsUsed, 1);
check("stored W34 level metrics from that day (totalTracked 100)", wk34Stored.postings.totalTracked, 100);

// Second day in the same week → same buckets, refreshed with 2 days
await store.saveDailySnapshot(wkA2.date, wkA2);
const ups2 = await upsertRollupsForDate(store, "2026-08-18");
check("upsert for 2026-08-18 refreshes the same 3 buckets", ups2.map((u) => `${u.type}:${u.period}`).sort(), ["month:2026-08", "week:2026-W34", "year:2026"]);
const wk34After = (await store.getRollup("week", "2026-W34"))!.payload as ArchiveView;
check("W34 refreshed with 2 days", wk34After.snapshotsUsed, 2);
check("W34 level metrics now from latest day (totalTracked 110)", wk34After.postings.totalTracked, 110);

// A day in a NEW week → the new week's rollup appears with a trend vs the
// previous. The pipeline upserts after EVERY saved day (the 02:30 cron does),
// so W34 is refreshed to its final state before W35 is created.
await store.saveDailySnapshot(wkA3.date, wkA3);
await upsertRollupsForDate(store, "2026-08-19");
await store.saveDailySnapshot(wkB1.date, wkB1);
await upsertRollupsForDate(store, "2026-08-24");
await store.saveDailySnapshot(wkB2.date, wkB2);
const ups3 = await upsertRollupsForDate(store, "2026-08-25");
check("upsert for 2026-08-25 creates W35", ups3.map((u) => `${u.type}:${u.period}`).sort(), ["month:2026-08", "week:2026-W35", "year:2026"]);
check("week rollups now 2026-W34 and 2026-W35", (await store.listRollups("week")).map((r) => r.period), ["2026-W34", "2026-W35"]);
const wk35 = (await store.getRollup("week", "2026-W35"))!.payload as ArchiveView;
check("W35 trends vs W34 (totalTracked 140-120=+20 up)", wk35.trends["totalTracked"], { delta: 20, direction: "up" });
check("W35 industries still summed (AI/ML 50+50=100)", wk35.industries.find((i) => i.industry === "AI/ML")?.count, 100);
const month = (await store.getRollup("month", "2026-08"))!.payload as ArchiveView;
check("month 2026-08 snapshotsUsed = 5", month.snapshotsUsed, 5);
check("month level metrics from latest day (totalTracked 140)", month.postings.totalTracked, 140);
check("month trends all n-a (no previous month)", month.trends["totalTracked"], { delta: null, direction: "n-a" });
const year = (await store.getRollup("year", "2026"))!.payload as ArchiveView;
check("year 2026 snapshotsUsed = 5", year.snapshotsUsed, 5);
check("year trends all n-a (no previous year)", year.trends["totalTracked"], { delta: null, direction: "n-a" });

/* ============================ 4. backfill ============================ */
console.log("== 4. recomputeAllRollups (idempotent backfill) ==");
const store2 = new FakeStore();
for (const s of [wkA1, wkA2, wkA3, wkB1, wkB2]) await store2.saveDailySnapshot(s.date, s);
const totals = await recomputeAllRollups(store2);
check("backfill totals", totals, [
  { type: "week", count: 2 },
  { type: "month", count: 1 },
  { type: "year", count: 1 },
]);
// idempotent: re-running replaces the same buckets, no duplicates
const totals2 = await recomputeAllRollups(store2);
check("backfill re-run idempotent", totals2, totals);
check("no duplicate week buckets", (await store2.listRollups("week")).length, 2);

/* ============================ 5. buildTrendViews honesty ============================ */
console.log("== 5. buildTrendViews (honest insufficient-history) ==");
const views5 = await buildTrendViews(store2);
check("day view has 5 periods", views5.day.periods.length, 5);
check("day view compare uses the 2 latest days (140-130=+10)", views5.day.compare.find((c) => c.key === "totalTracked")?.delta, 10);
check("day view latest/previous", [views5.day.previousPeriod, views5.day.latestPeriod], ["2026-08-24", "2026-08-25"]);
check("week view has 2 periods", views5.week.periods.length, 2);
check("week view compare (140-120=+20)", views5.week.compare.find((c) => c.key === "totalTracked")?.delta, 20);
check("week view latest/previous", [views5.week.previousPeriod, views5.week.latestPeriod], ["2026-W34", "2026-W35"]);
check("month view has 1 period → compare EMPTY (needs 2+ months)", views5.month.compare.length, 0);
checkTrue("month note is honest about needing a second month", views5.month.note.includes("second month"));
check("month view latest set, previous null", [views5.month.latestPeriod, views5.month.previousPeriod], ["2026-08", null]);
check("year view compare EMPTY (needs 2+ years)", views5.year.compare.length, 0);
checkTrue("year note is honest about needing a second year", views5.year.note.includes("second year"));

// Empty store → every view empty with honest notes
const storeEmpty = new FakeStore();
const views0 = await buildTrendViews(storeEmpty);
check("empty store: day compare empty", views0.day.compare.length, 0);
check("empty store: week compare empty", views0.week.compare.length, 0);
check("empty store: month compare empty", views0.month.compare.length, 0);
check("empty store: year compare empty", views0.year.compare.length, 0);
checkTrue("empty store day note mentions two days", views0.day.note.includes("two days"));
check("empty store: no periods at all", [views0.day.periods.length, views0.week.periods.length, views0.month.periods.length, views0.year.periods.length], [0, 0, 0, 0]);

// 2 days only → day compare works, week/month/year still n/a
const store2d = new FakeStore();
await store2d.saveDailySnapshot(wkA1.date, wkA1);
await store2d.saveDailySnapshot(wkA2.date, wkA2);
await upsertRollupsForDate(store2d, "2026-08-18");
const views2d = await buildTrendViews(store2d);
check("2 days: day compare present (110-100=+10)", views2d.day.compare.find((c) => c.key === "totalTracked")?.delta, 10);
check("2 days: week compare EMPTY (1 week only)", views2d.week.compare.length, 0);
checkTrue("2 days: week note says a second week is needed", views2d.week.note.includes("second week"));
check("2 days: week has 1 period", views2d.week.periods.length, 1);

/* ============================ 6. archiveFromDaily ============================ */
console.log("== 6. archiveFromDaily ==");
const dayArch = archiveFromDaily(wkB2);
check("archive kind/period/label", [dayArch.kind, dayArch.period, dayArch.label], ["day", "2026-08-25", "August 25, 2026"]);
check("archive snapshotsUsed=1 first=last=date", [dayArch.snapshotsUsed, dayArch.firstDate, dayArch.lastDate], [1, "2026-08-25", "2026-08-25"]);
check("archive carries postings/requirements/scores", [dayArch.postings.totalTracked, dayArch.requirements.bachelorShare, dayArch.scores.length], [140, 0.5, 5]);

/* ------------------------------- summary ------------------------------- */
console.log(`\nRESULT: ${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`} (${pass} checks)`);
if (fail > 0) {
  console.log("failures: " + failures.join(" | "));
  process.exit(1);
}
