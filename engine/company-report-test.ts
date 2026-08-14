/**
 * Batch 3B tests — quarterly company reputation report.
 *
 * Runs against the real Neon store (DATABASE_URL injected into the sandbox)
 * for the DB-backed sections, plus pure in-memory fixtures for the trend,
 * matching, quarter-helper and email-copy math so those assertions are
 * deterministic and immune to live-data drift. Every row this test creates is
 * cleaned up afterwards; nothing in the live data is touched (surgical deletes
 * only, and fixture snapshot dates are chosen to never collide with real ones).
 *
 * Run: bun run company-report-test
 *
 * Covers (Batch 3B definition of done):
 *   1. Report content: score/fixes/benchmarks present; quarter trends computed
 *      from daily snapshots (first vs last); trends honestly n/a with < 2
 *      snapshots carrying the company's per-company block.
 *   2. company_reports table idempotency (regenerate replaces the row).
 *   3. Cron claim: one email per company per quarter; failed send leaves no
 *      claim so the next run retries; claim only after a 2xx send.
 *   4. Email copy: subject + score / fix-count / benchmark lines + live URL.
 */

import { Store } from "./store";
import type { PostingRecord } from "./types";
import {
  buildSummaryParagraph,
  computeQuarterTrends,
  currentQuarter,
  generateCompanyReport,
  matchCompanyForEmail,
  normalizeCompanyKey,
  previousQuarter,
  quarterEndIso,
  quarterLabel,
  quarterStartIso,
  type CompanyReport,
} from "./company-report";
import { buildCompanyReportEmailContent, companyReportUrl, runQuarterlyCompanyReportPass } from "../src/server/company-report-email";
import type { CompanyReportEmailResult } from "../src/server/company-report-email";

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

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();
const store = new Store();
const TAG = `crep-${now}`;
const postingIds: string[] = [];
const fixtureSnapshotDates: string[] = [];
const claimKeys: string[] = [];
const FIXTURE_QUARTER = "2026-Q3"; // real DB has only 2026-08-14; fixture dates below never collide

function mkPosting(id: string, over: Partial<PostingRecord> = {}): PostingRecord {
  return {
    postingId: id,
    canonicalUrl: `https://boards.greenhouse.io/fixture/jobs/${encodeURIComponent(id)}`,
    requestedUrl: null,
    title: `Fixture Role ${id}`,
    company: "ReportFixCo",
    location: "Remote",
    postedAt: null,
    sourceBoard: "greenhouse",
    identityKey: id,
    fingerprint: null,
    status: "live",
    relistCount: 0,
    firstSeenAt: iso(now - 5 * DAY_MS),
    lastSeenAt: iso(now),
    lastCheckedAt: iso(now),
    lastStatusCode: 200,
    lastNote: null,
    createdAt: iso(now - 5 * DAY_MS),
    ...over,
  };
}

async function seed(records: PostingRecord[]): Promise<void> {
  for (const r of records) {
    postingIds.push(r.postingId);
    await store.upsertPosting(r);
  }
}

/** Save a fixture daily snapshot containing ONLY the given company rows. */
async function seedSnapshot(date: string, companyRows: { name: string; live: number; medianDaysListed: number | null; relistShare: number | null }[]): Promise<void> {
  fixtureSnapshotDates.push(date);
  await store.saveDailySnapshot(date, {
    date,
    generatedAt: `${date}T12:00:00.000Z`,
    postings: { totalTracked: 0, live: 0, removed: 0, relisted: 0, relistedAtLeastOnce: 0, relistShare: null, medianDaysListed: null, maxDaysListed: null, daysListedSample: 0, distinctCompanies: 0, postingsWithCompany: 0 },
    boards: [], industries: [], unclassifiedCount: 0, titles: [], companies: companyRows,
    requirements: { livePostings: 0, postingsWithDescriptionRead: 0, postingsWithFetchError: 0, postingsNotYetExtracted: 0, requiresBachelor: 0, requiresMasters: 0, requires5PlusYears: 0, bachelorShare: null, mastersShare: null, fivePlusShare: null, method: "fixture" },
    scores: [], trends: {}, method: "fixture test data",
  });
}

/** A minimal valid CompanyReport for the email-copy + cron-claim fixtures. */
function mkFixtureReport(company: string, quarter: string): CompanyReport {
  return {
    company,
    quarter,
    generatedAt: iso(now),
    score: {
      score: 72,
      label: "Some signals worth watching",
      provisional: false,
      evidence: "medium",
      ghostEvidencePoints: 28,
      components: [
        { signalId: "relist_cycles", label: "Relist cycles", observed: "1 relist event observed", points: 25, maxPoints: 50, reason: "fixture" },
        { signalId: "stale_no_change", label: "Listing age (median)", observed: "Median 45 days listed", points: 0, maxPoints: 30, reason: "fixture" },
      ],
    },
    summary: {
      trackedPostings: 3,
      relistEvents: 1,
      relistedPostings: 1,
      relistRate: 1 / 3,
      medianDaysListed: 45,
      maxDaysListed: 90,
      liveCount: 2,
      removedCount: 1,
      boards: ["greenhouse"],
      urls: 1,
      observationWindowDays: 60,
      checksTotal: 10,
    },
    fixes: {
      healthy: false,
      healthyMessage: "",
      fixes: [
        {
          id: "stale_listings",
          heading: "1 posting has been listed 30+ days with no change we could observe — refresh or remove it",
          action: "fixture action",
          affected: [{ postingId: "p1", title: "Backend Engineer", canonicalUrl: "https://boards.greenhouse.io/x/1", board: "greenhouse", observed: "45 days listed" }],
        },
      ],
    },
    benchmarks: {
      industry: "TestIndustry",
      peerCount: 3,
      comparable: true,
      headline: "vs 3 tracked companies in TestIndustry (observed sample)",
      note: null,
      comparisons: [
        { metric: "medianDaysListed", label: "Median days listed", company: 45, peerMedian: 40, aheadPct: 33, lowerIsBetter: true, format: "days" },
        { metric: "relistShare", label: "Relist share", company: 1 / 3, peerMedian: 0.2, aheadPct: 33, lowerIsBetter: true, format: "pct" },
        { metric: "boardsUsed", label: "Boards used", company: 1, peerMedian: 2, aheadPct: null, lowerIsBetter: false, format: "count" },
        { metric: "livePostings", label: "Live postings", company: 2, peerMedian: 3, aheadPct: null, lowerIsBetter: false, format: "count" },
      ],
      freshness: { companyDays: 45, peerMedianDays: 40, fresherThanPct: 33 },
    },
    trends: [
      { metric: "livePostings", label: "Live postings", format: "count", first: 3, last: 2, delta: -1, direction: "down", firstDate: "2026-07-01", lastDate: "2026-07-15", samples: 2 },
      { metric: "medianDaysListed", label: "Median days listed", format: "days", first: 45, last: 40, delta: -5, direction: "down", firstDate: "2026-07-01", lastDate: "2026-07-15", samples: 2 },
      { metric: "relistShare", label: "Relist share", format: "pct", first: 0.5, last: 0.6, delta: 0.1, direction: "up", firstDate: "2026-07-01", lastDate: "2026-07-15", samples: 2 },
    ],
    summaryParagraph: "",
    note: null,
    dashboardAt: iso(now),
  };
}

async function cleanup(): Promise<void> {
  for (const id of postingIds) {
    try {
      await store.deletePosting(id);
    } catch {
      /* best effort */
    }
  }
  for (const d of fixtureSnapshotDates) {
    try {
      await store.deleteDailySnapshot(d);
    } catch {
      /* best effort */
    }
  }
  try {
    await store.deleteCompanyReport("ReportFixCo", FIXTURE_QUARTER);
  } catch {
    /* best effort */
  }
  try {
    await store.deleteCompanyReport("ReportNACompany", FIXTURE_QUARTER);
  } catch {
    /* best effort */
  }
  for (const k of claimKeys) {
    try {
      await store.deleteMeta(k);
    } catch {
      /* best effort */
    }
  }
}

/* ═════════════════ 1. QUARTER HELPERS + TREND MATH + MATCHING (pure) ═════════════════ */

function sectionPure(): void {
  console.log("\n[1] Quarter helpers, trend math, email→company matching");

  // quarter helpers
  check("currentQuarter Q3 2026 (fixture clock is 2026-08)", currentQuarter(new Date("2026-08-14T10:00:00Z")), "2026-Q3");
  check("currentQuarter Q1 boundary", currentQuarter(new Date("2026-01-05T00:00:00Z")), "2026-Q1");
  check("quarterLabel", quarterLabel("2026-Q3"), "Q3 2026");
  check("quarterLabel invalid", quarterLabel("2026-Q5"), null);
  check("quarterStartIso", quarterStartIso("2026-Q3"), "2026-07-01T00:00:00.000Z");
  check("quarterEndIso", quarterEndIso("2026-Q3"), "2026-10-01T00:00:00.000Z");
  check("previousQuarter", previousQuarter("2026-Q1"), "2025-Q4");
  check("previousQuarter", previousQuarter("2026-Q3"), "2026-Q2");

  // computeQuarterTrends — pair present
  const snapPair = [
    { date: "2026-07-15", snapshot: { companies: [{ name: "Acme", live: 2, medianDaysListed: 40, relistShare: 0.6 }] } },
    { date: "2026-07-01", snapshot: { companies: [{ name: "acme", live: 3, medianDaysListed: 45, relistShare: 0.5 }] } },
    { date: "2026-07-10", snapshot: {} }, // old-format snapshot without companies block — not counted
  ] as unknown as { date: string; snapshot: import("./daily-stats").DailySnapshot }[];
  const trends = computeQuarterTrends(snapPair, "Acme");
  const liveT = trends.find((t) => t.metric === "livePostings");
  const daysT = trends.find((t) => t.metric === "medianDaysListed");
  const relistT = trends.find((t) => t.metric === "relistShare");
  check("pair: samples=2 (old-format snapshot not counted)", liveT?.samples, 2);
  check("pair: case-insensitive match + date-sorted first", liveT?.first, 3);
  check("pair: last", liveT?.last, 2);
  check("pair: delta", liveT?.delta, -1);
  check("pair: direction down", liveT?.direction, "down");
  check("pair: firstDate", liveT?.firstDate, "2026-07-01");
  check("pair: lastDate", liveT?.lastDate, "2026-07-15");
  check("pair: medianDays delta", daysT?.delta, -5);
  check("pair: relistShare delta", relistT?.delta, 0.1);
  check("pair: relistShare direction up", relistT?.direction, "up");

  // single snapshot → n/a (honest)
  const snapOne = [{ date: "2026-07-01", snapshot: { companies: [{ name: "Acme", live: 3, medianDaysListed: 45, relistShare: 0.5 }] } }] as unknown as { date: string; snapshot: import("./daily-stats").DailySnapshot }[];
  const t1 = computeQuarterTrends(snapOne, "Acme");
  check("single: samples", t1[0]?.samples, 1);
  check("single: direction n-a", t1[0]?.direction, "n-a");
  check("single: delta null", t1[0]?.delta, null);
  check("single: first present", t1[0]?.first, 3);
  check("single: last null", t1[0]?.last, null);

  // no snapshots → n/a
  const t0 = computeQuarterTrends([], "Acme");
  check("none: direction n-a", t0[0]?.direction, "n-a");
  check("none: samples 0", t0[0]?.samples, 0);

  // company absent from snapshots → n/a
  const tAbsent = computeQuarterTrends(snapPair, "NoSuchCo");
  check("absent company: samples 0", tAbsent[0]?.samples, 0);

  // matchCompanyForEmail
  const registry = [{ name: "Greenhouse" }, { name: "Notion" }, { name: "Acme Inc" }];
  check("match: domain first label", matchCompanyForEmail("hiring@greenhouse.io", registry), "Greenhouse");
  check("match: local part", matchCompanyForEmail("notion@example.com", registry), "Notion");
  check("match: no match", matchCompanyForEmail("someone@unrelated.io", registry), null);
  check("match: ambiguous (Acme Inc / Acme, Inc. normalize equal)", matchCompanyForEmail("acmeinc@x.io", [{ name: "Acme Inc" }, { name: "Acme, Inc." }]), null);
  check("match: null email", matchCompanyForEmail(null, registry), null);
  check("normalizeCompanyKey", normalizeCompanyKey("Acme Inc."), "acmeinc");
}

/* ═════════════════ 2. REPORT CONTENT (DB-backed) ═════════════════ */

async function sectionReportContent(): Promise<void> {
  console.log("\n[2] Report content (score / fixes / benchmarks / trends)");

  // Weak-signal company: relist cycle + stale (no content change).
  await seed([
    mkPosting(`${TAG}-a`, { company: "ReportFixCo", title: "Backend Engineer", identityKey: `${TAG}-ident-a`, relistCount: 1, firstSeenAt: iso(now - 120 * DAY_MS) }),
    mkPosting(`${TAG}-b`, { company: "ReportFixCo", title: "Product Designer", identityKey: `${TAG}-ident-b`, relistCount: 0, firstSeenAt: iso(now - 45 * DAY_MS) }),
  ]);
  // Two fixture snapshots in the quarter carrying ReportFixCo's per-company block.
  await seedSnapshot("2026-07-01", [{ name: "ReportFixCo", live: 3, medianDaysListed: 45, relistShare: 0.5 }]);
  await seedSnapshot("2026-07-15", [{ name: "ReportFixCo", live: 2, medianDaysListed: 40, relistShare: 0.6 }]);

  const report = await generateCompanyReport(store, "ReportFixCo", FIXTURE_QUARTER);
  checkTrue("report generated", report !== null);
  check("report quarter", report.quarter, FIXTURE_QUARTER);
  check("report company (registry case)", report.company, "ReportFixCo");

  // (a) score + per-signal components
  checkTrue("score present (>= 2 tracked postings)", report.score.score !== null);
  checkTrue("score components present", report.score.components.length >= 4);
  checkTrue("score components carry reasons", report.score.components.every((c) => c.reason.length > 0));

  // (b) fixes
  checkTrue("fixes present for weak signals", !report.fixes.healthy);
  check("fix ids", report.fixes.fixes.map((f) => f.id).sort(), ["relist_cycles", "stale_listings"]);
  checkTrue("relist fix lists affected posting", report.fixes.fixes.find((f) => f.id === "relist_cycles")?.affected.length === 1);

  // (c) benchmarks (fixtures are Unclassified with 0 peers → honest not-comparable)
  checkTrue("benchmarks computed", report.benchmarks !== null);
  check("benchmark industry (curated map fallback)", report.benchmarks?.industry, "Unclassified");
  checkTrue("benchmarks honest small sample (not comparable)", report.benchmarks?.comparable === false);

  // (d) trends from the two fixture snapshots
  const live = report.trends.find((t) => t.metric === "livePostings");
  check("trend livePostings first", live?.first, 3);
  check("trend livePostings last", live?.last, 2);
  check("trend livePostings delta", live?.delta, -1);
  check("trend livePostings direction", live?.direction, "down");
  check("trend samples", live?.samples, 2);
  const days = report.trends.find((t) => t.metric === "medianDaysListed");
  check("trend medianDays first", days?.first, 45);
  check("trend medianDays last", days?.last, 40);

  // (e) summary paragraph — built from the report's own numbers
  checkTrue("summary paragraph non-empty", report.summaryParagraph.length > 50);
  checkTrue("summary mentions the quarter", report.summaryParagraph.includes("Q3 2026"));
  checkTrue("summary mentions tracked postings", report.summaryParagraph.includes("2 postings"));
  checkTrue("summary mentions live trend", report.summaryParagraph.includes("moved from 3 to 2"));
  checkTrue("summary mentions 30+ days stale fix", report.summaryParagraph.includes("30+ days"));

  // Stored + readable back.
  const stored = await store.getCompanyReport("ReportFixCo", FIXTURE_QUARTER);
  checkTrue("stored in company_reports", stored !== null);
  check("stored report company", (stored?.report as CompanyReport)?.company, "ReportFixCo");
  const quarters = await store.listCompanyReports("ReportFixCo");
  checkTrue("listCompanyReports has the quarter", quarters.some((q) => q.quarter === FIXTURE_QUARTER));

  // Trends honestly n/a for a company with only ONE snapshot.
  await seed([
    mkPosting(`${TAG}-na`, { company: "ReportNACompany", title: "Only Posting", identityKey: `${TAG}-ident-na`, relistCount: 0, firstSeenAt: iso(now - 5 * DAY_MS) }),
  ]);
  await seedSnapshot("2026-07-02", [{ name: "ReportNACompany", live: 5, medianDaysListed: 30, relistShare: 0.2 }]);
  const na = await generateCompanyReport(store, "ReportNACompany", FIXTURE_QUARTER);
  checkTrue("n/a company: all trends n-a", na.trends.every((t) => t.direction === "n-a"));
  check("n/a company: samples 1", na.trends[0]?.samples, 1);
  checkTrue("n/a company: paragraph honest about missing history", na.summaryParagraph.includes("two daily snapshots"));
}

/* ═════════════════ 3. TABLE IDEMPOTENCY ═════════════════ */

async function sectionIdempotency(): Promise<void> {
  console.log("\n[3] company_reports idempotency");
  const r1 = await generateCompanyReport(store, "ReportFixCo", FIXTURE_QUARTER);
  const firstGenerated = r1.generatedAt;
  await new Promise((res) => setTimeout(res, 20)); // let the clock move
  const r2 = await generateCompanyReport(store, "ReportFixCo", FIXTURE_QUARTER);
  checkTrue("regenerate updates generated_at", r2.generatedAt > firstGenerated);
  check("regenerate keeps quarter", r2.quarter, FIXTURE_QUARTER);
  const stored = await store.getCompanyReport("ReportFixCo", FIXTURE_QUARTER);
  check("stored row is the regenerated one", (stored?.report as CompanyReport)?.generatedAt, r2.generatedAt);
  const quarters = await store.listCompanyReports("ReportFixCo");
  check("exactly one row per (company, quarter)", quarters.filter((q) => q.quarter === FIXTURE_QUARTER).length, 1);
}

/* ═════════════════ 4. EMAIL COPY (pure) ═════════════════ */

function sectionEmailCopy(): void {
  console.log("\n[4] Quarterly email copy");
  const report = mkFixtureReport("ReportEmailCo", "2026-Q3");
  const content = buildCompanyReportEmailContent(report);
  check("subject", content.subject, "Your Q3 2026 HireClarity Data reputation report");
  checkTrue("text mentions score", content.text.includes("72 of 100"));
  checkTrue("text mentions fix count", content.text.includes("1 fix recommendation"));
  checkTrue("text mentions benchmark line", content.text.includes("tracked company") || content.text.includes("3"));
  checkTrue("text links the report page", content.text.includes(companyReportUrl("ReportEmailCo")));
  check("url is the live origin", companyReportUrl("ReportEmailCo"), "https://hireclarity-data.vercel.app/company/report?company=ReportEmailCo");
  checkTrue("html escapes are safe", !content.html.includes("<script"));
}

/* ═════════════════ 5. CRON CLAIM (one email per company per quarter, retry) ═════════════════ */

async function sectionCronClaim(): Promise<void> {
  console.log("\n[5] Quarterly cron claim guard");

  const company = "CronClaimCo";
  const quarter = "2026-Q3";
  const registry = [{ name: company }];
  const domain = `${company.toLowerCase()}.io`; // owner@cronclaimco.io → domain label cronclaimco → matches
  const emails = [`owner@${domain}`];
  const claimKey = `company_report_email_${quarter}_${company.toLowerCase()}`;
  const sendingKey = `company_report_sending_${quarter}_${company.toLowerCase()}`;
  claimKeys.push(claimKey, sendingKey);

  let failNext = true;
  const sentTo: string[] = [];
  const fakeSend = async (email: string, report: CompanyReport): Promise<CompanyReportEmailResult> => {
    if (failNext) {
      failNext = false;
      return { sent: false, reason: "resend-error", error: "simulated resend 500" };
    }
    sentTo.push(email);
    return { sent: true, reason: null, resendId: `re_${sentTo.length}` };
  };
  const fakeGenerate = async (c: string, q: string): Promise<CompanyReport> => mkFixtureReport(c, q);

  // Run 1: send FAILS → no claim key → nothing marked delivered.
  const r1 = await runQuarterlyCompanyReportPass(store, {
    now: new Date("2026-08-14T10:00:00Z"),
    registry,
    resolveEmails: async () => emails,
    send: fakeSend,
    generate: fakeGenerate,
  });
  check("run1 quarter", r1.quarter, "2026-Q3");
  check("run1: failure recorded (retry next run)", r1.failures.length, 1);
  check("run1: nothing sent", r1.sent, 0);
  check("run1: no claim key after failure", await store.getMeta(claimKey), null);
  check("run1: sending lock released", await store.getMeta(sendingKey), null);

  // Run 2: send SUCCEEDS → claim key created (only after 2xx).
  const r2 = await runQuarterlyCompanyReportPass(store, {
    now: new Date("2026-08-14T11:00:00Z"),
    registry,
    resolveEmails: async () => emails,
    send: fakeSend,
    generate: fakeGenerate,
  });
  check("run2: sent", r2.sent, 1);
  check("run2: sent to the subscriber", sentTo.join(","), emails.join(","));
  checkTrue("run2: claim key now exists", (await store.getMeta(claimKey)) !== null);
  check("run2: sending lock released", await store.getMeta(sendingKey), null);

  // Run 3: claim exists → no second email (one per company per quarter).
  const r3 = await runQuarterlyCompanyReportPass(store, {
    now: new Date("2026-08-14T12:00:00Z"),
    registry,
    resolveEmails: async () => emails,
    send: fakeSend,
    generate: fakeGenerate,
  });
  check("run3: no new send", r3.sent, 0);
  checkTrue("run3: skipped with already-emailed reason", r3.skipped.some((s) => s.reason.includes("already emailed")));

  // Two subscribers matching the SAME company → still exactly one email.
  const sentTwo: string[] = [];
  const r4 = await runQuarterlyCompanyReportPass(store, {
    now: new Date("2026-08-14T13:00:00Z"),
    registry,
    resolveEmails: async () => [...emails, `hiring@${domain}`],
    send: async (email: string, report: CompanyReport) => {
      sentTwo.push(email);
      return { sent: true, reason: null, resendId: "re_x" };
    },
    generate: fakeGenerate,
  });
  check("same-company second subscriber: 0 new sends", r4.sent, 0);
  check("same-company second subscriber: skipped", r4.skipped.length, 2);
  check("no duplicate email", sentTwo.length, 0);

  // Unmatched email → honest skip, never guessed.
  const r5 = await runQuarterlyCompanyReportPass(store, {
    now: new Date("2026-08-14T14:00:00Z"),
    registry,
    resolveEmails: async () => ["someone@unrelated-org.io"],
    send: fakeSend,
    generate: fakeGenerate,
  });
  check("unmatched: 0 sent", r5.sent, 0);
  checkTrue("unmatched: skipped with matching-rule reason", r5.skipped.some((s) => s.reason.includes("uniquely match")));
}

/* ═════════════════ run ═════════════════ */

(async () => {
  console.log(`company report test — ${TAG}`);
  try {
    sectionPure();
    await sectionReportContent();
    await sectionIdempotency();
    sectionEmailCopy();
    await sectionCronClaim();
  } catch (err) {
    fail++;
    failures.push("uncaught: " + String(err));
    console.error("  ERROR", err);
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("failures:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
})();
