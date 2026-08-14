/**
 * DAILY REPORT REFRESH + DAY-OVER-DAY TRENDS test suite (owner decision
 * 2026-08-14: the public job-market report refreshes DAILY during the first 6
 * months — window 2026-08-14 → DAILY_REPORT_UNTIL — then reverts to monthly).
 *
 * Run: bun run report-daily-test
 *
 * Covers:
 *   1. Window guard (pure): inside the window the report refreshes every day
 *      ("daily-window"); after DAILY_REPORT_UNTIL it only refreshes on the 1st
 *      ("first-of-month") and is a no-op otherwise ("skipped").
 *   2. Day-over-day trend rows (buildDailySection): computed from the period's
 *      two most recent daily snapshots across the EXTENDED metric list
 *      (headlines + board counts + score-bucket counts), labeled with the two
 *      compared dates; correct direction + delta.
 *   3. Honest n/a with fewer than 2 snapshots (dailyTrends empty, dates null)
 *      and per-metric n/a when a metric is not comparable across compiles
 *      (computeTrendsFor).
 *   4. Report generation stays idempotent: store save replaces the period row
 *      (one row, latest wins) and computeReportSnapshot with the same `now` is
 *      deterministic (deep-equal).
 *
 * Fixtures are written to fake periods (2099-xx) and cleaned up afterwards —
 * nothing in the live data is touched (surgical deletes only).
 */
import { neon } from "@neondatabase/serverless";
import { Store } from "./store";
import {
  DAILY_REPORT_UNTIL,
  isDailyReportWindow,
  reportRefreshDecision,
  buildDailySection,
  computeReportSnapshot,
  REPORT_TREND_METRICS,
} from "./report";
import { computeTrendsFor, type DailySnapshot } from "./daily-stats";

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

const sql = neon(process.env.DATABASE_URL!);
const store = new Store();

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
      { board: "workable", count: 10, share: 0.1 },
      { board: "web", count: 15, share: 0.15 },
    ],
    industries: [{ industry: "AI/ML", count: 50, share: 0.5 }],
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
    method: "TEST FIXTURE — synthetic rows for report-daily-test; never published",
    ...over,
  };
}

/* ------------------------------ 1. window guard ------------------------------ */

console.log("== 1. window guard (reportRefreshDecision / isDailyReportWindow) ==");
check("DAILY_REPORT_UNTIL value", DAILY_REPORT_UNTIL, "2027-02-14");
checkTrue("in window: 2026-08-14 (launch day)", isDailyReportWindow(new Date("2026-08-14T02:30:00Z")));
checkTrue("in window: 2026-08-15", isDailyReportWindow(new Date("2026-08-15T09:00:00Z")));
checkTrue("in window: 2027-02-13 (last daily day)", isDailyReportWindow(new Date("2027-02-13T23:59:00Z")));
check("window ended: 2027-02-14", isDailyReportWindow(new Date("2027-02-14T00:00:00Z")), false);
check(
  "in window, mid-month -> daily refresh",
  reportRefreshDecision(new Date("2026-08-15T09:00:00Z")),
  { refresh: true, reason: "daily-window" }
);
check(
  "in window, 1st of month -> daily refresh (email path handled by cron)",
  reportRefreshDecision(new Date("2026-08-01T09:00:00Z")),
  { refresh: true, reason: "daily-window" }
);
check(
  "after window, not the 1st -> skipped (no daily refresh)",
  reportRefreshDecision(new Date("2027-03-05T09:00:00Z")),
  { refresh: false, reason: "skipped" }
);
check(
  "after window, exactly on DAILY_REPORT_UNTIL -> skipped",
  reportRefreshDecision(new Date("2027-02-14T09:00:00Z")),
  { refresh: false, reason: "skipped" }
);
check(
  "after window, 1st of month -> monthly refresh",
  reportRefreshDecision(new Date("2027-03-01T09:00:00Z")),
  { refresh: true, reason: "first-of-month" }
);

/* ---------------------- 2. day-over-day trends (2+ snapshots) ---------------------- */

console.log("\n== 2. day-over-day trends from 2+ daily snapshots ==");
const FIX_TWO_A = "2099-01-10";
const FIX_TWO_B = "2099-01-11";
const dayA = mkDailySnapshot(FIX_TWO_A);
const dayB = mkDailySnapshot(FIX_TWO_B, {
  date: FIX_TWO_B,
  generatedAt: `${FIX_TWO_B}T02:30:00.000Z`,
  postings: {
    totalTracked: 105, // up +5
    live: 90, // up +10
    removed: 15, // flat
    relisted: 5, // flat
    relistedAtLeastOnce: 12, // up +2
    relistShare: 0.12, // up +0.02
    medianDaysListed: 20, // down -1
    maxDaysListed: 90,
    daysListedSample: 90,
    distinctCompanies: 30, // flat
    postingsWithCompany: 100,
  },
  industries: [{ industry: "AI/ML", count: 55, share: 0.52 }], // topIndustryCount up +5
  titles: [{ title: "software engineer", count: 20, share: 0.22 }],
  requirements: {
    livePostings: 90,
    postingsWithDescriptionRead: 60,
    postingsWithFetchError: 5,
    postingsNotYetExtracted: 25,
    requiresBachelor: 30,
    requiresMasters: 10,
    requires5PlusYears: 20,
    bachelorShare: 0.5, // flat
    mastersShare: 0.1667,
    fivePlusShare: 0.3333,
    method: "TEST FIXTURE",
  },
  scores: [
    { bucket: "0-20", count: 4, share: 0.044 }, // down -1
    { bucket: "21-40", count: 12, share: 0.133 },
    { bucket: "41-60", count: 24, share: 0.267 },
    { bucket: "61-80", count: 28, share: 0.311 },
    { bucket: "81-100", count: 22, share: 0.244 },
  ],
  boards: [
    { board: "greenhouse", count: 35, share: 0.333 }, // down -5
    { board: "ashby", count: 20, share: 0.19 },
    { board: "lever", count: 18, share: 0.171 },
    { board: "workable", count: 12, share: 0.114 },
    { board: "web", count: 20, share: 0.19 },
  ],
});
await store.saveDailySnapshot(FIX_TWO_A, dayA);
await store.saveDailySnapshot(FIX_TWO_B, dayB);

// Pure computation check (computeTrendsFor with the report's extended list)
const deltas = computeTrendsFor(REPORT_TREND_METRICS, dayA, dayB);
check("pure: totalTracked up +5", deltas.totalTracked, { delta: 5, direction: "up" });
check("pure: relistShare up +0.02", deltas.relistShare, { delta: 0.02, direction: "up" });
check("pure: medianDaysListed down -1", deltas.medianDaysListed, { delta: -1, direction: "down" });
check("pure: removed flat", deltas.removed, { delta: 0, direction: "flat" });
check("pure: board_greenhouse down -5", deltas.board_greenhouse, { delta: -5, direction: "down" });
check("pure: score_0_20 down -1", deltas.score_0_20, { delta: -1, direction: "down" });
check("pure: topIndustryCount up +5", deltas.topIndustryCount, { delta: 5, direction: "up" });

// Report-layer check (buildDailySection reads the store)
const secTwo = await buildDailySection(store, "2099-01");
check("buildDailySection: 23 day-over-day rows (headlines + boards + scores)", secTwo.dailyTrends.length, REPORT_TREND_METRICS.length);
check("dailyTrendDates.latest", secTwo.dailyTrendDates.latest, FIX_TWO_B);
check("dailyTrendDates.previous", secTwo.dailyTrendDates.previous, FIX_TWO_A);
const tLive = secTwo.dailyTrends.find((t) => t.key === "live");
check("report row: live up +10", { d: tLive?.direction, delta: tLive?.delta, cur: tLive?.current, prev: tLive?.previous }, { d: "up", delta: 10, cur: 90, prev: 80 });
const tRelist = secTwo.dailyTrends.find((t) => t.key === "relistShare");
check("report row: relistShare up (percent format)", { d: tRelist?.direction, format: tRelist?.format }, { d: "up", format: "percent" });
const tBoard = secTwo.dailyTrends.find((t) => t.key === "board_greenhouse");
check("report row: board_greenhouse present + down", { d: tBoard?.direction, delta: tBoard?.delta }, { d: "down", delta: -5 });
const tScore = secTwo.dailyTrends.find((t) => t.key === "score_81_100");
check("report row: score_81_100 up +2", { d: tScore?.direction, delta: tScore?.delta }, { d: "up", delta: 2 });
check("row labels: board metric label", secTwo.dailyTrends.find((t) => t.key === "board_ashby")?.label, "ashby postings");
check("row labels: score metric label", secTwo.dailyTrends.find((t) => t.key === "score_61_80")?.label, "score 61-80");
// Preserved month-over-month view: no previous period yet -> all n-a rows present
check("month-over-month rows still built (13 headlines)", secTwo.trends.length, 13);
checkTrue("month-over-month all n-a without a previous period", secTwo.trends.every((t) => t.direction === "n-a"));

/* ------------------------------ 3. honest n/a (<2 snapshots) ------------------------------ */

console.log("\n== 3. n/a with fewer than 2 snapshots ==");
const FIX_ONE = "2099-02-01";
await store.saveDailySnapshot(FIX_ONE, mkDailySnapshot(FIX_ONE));
const secOne = await buildDailySection(store, "2099-02");
check("one snapshot -> dailyTrends empty", secOne.dailyTrends.length, 0);
check("one snapshot -> dates null", secOne.dailyTrendDates, { latest: null, previous: null });
check("one snapshot -> snapshotsUsed 1", secOne.snapshotsUsed, 1);

// Per-metric n/a: a metric that is not comparable across the two compiles
const dayMissing = mkDailySnapshot("2099-02-02", {
  date: "2099-02-02",
  postings: {
    totalTracked: 105, // comparable -> up vs dayA's 100
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
  requirements: {
    livePostings: 90,
    postingsWithDescriptionRead: 0, // nobody read yet -> shares null
    postingsWithFetchError: 0,
    postingsNotYetExtracted: 90,
    requiresBachelor: 0,
    requiresMasters: 0,
    requires5PlusYears: 0,
    bachelorShare: null,
    mastersShare: null,
    fivePlusShare: null,
    method: "TEST FIXTURE",
  },
});
const deltasNA = computeTrendsFor(REPORT_TREND_METRICS, dayA, dayMissing);
check("metric not comparable -> n-a, delta null", deltasNA.bachelorShare, { delta: null, direction: "n-a" });
check("other metrics still comparable", deltasNA.totalTracked.direction, "up");

/* ------------------------------ 4. idempotency ------------------------------ */

console.log("\n== 4. report generation stays idempotent ==");
const FIX_PERIOD = "2099-99";
await store.saveReportSnapshot(FIX_PERIOD, "2026-01-01T00:00:00.000Z", { x: 1 });
await store.saveReportSnapshot(FIX_PERIOD, "2026-01-02T00:00:00.000Z", { x: 2 });
const rows = (await store.listReportSnapshots()).filter((r) => r.period === FIX_PERIOD);
check("re-saving a period replaces the row (still one row)", rows.length, 1);
check("latest save wins", { gen: rows[0]?.generatedAt, x: (rows[0]?.payload as { x?: number })?.x }, { gen: "2026-01-02T00:00:00.000Z", x: 2 });

// Deterministic generation: same inputs + same `now` -> identical snapshot
const t0 = Date.now();
const snapA = await computeReportSnapshot(store, "2099-01", new Date("2026-08-14T09:00:00.000Z"));
const snapB = await computeReportSnapshot(store, "2099-01", new Date("2026-08-14T09:00:00.000Z"));
check("computeReportSnapshot deterministic (same now)", JSON.stringify(snapA), JSON.stringify(snapB));
console.log(`  (computeReportSnapshot x2 took ${Date.now() - t0}ms total on the live store)`);

/* --------------------------------- cleanup --------------------------------- */
await store.deleteDailySnapshot(FIX_TWO_A);
await store.deleteDailySnapshot(FIX_TWO_B);
await store.deleteDailySnapshot(FIX_ONE);
await store.deleteDailySnapshot("2099-02-02");
await sql.query(`DELETE FROM report_snapshots WHERE period = $1`, [FIX_PERIOD]);
const leftover = await store.listDailySnapshots();
checkTrue("fixtures cleaned up (only real snapshots remain)", leftover.every((r) => !r.date.startsWith("2099")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("failures:", failures.join(" | "));
  process.exit(1);
}
