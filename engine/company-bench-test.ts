/**
 * Company dashboard Batch 3A tests — fix recommendations + industry benchmarks.
 *
 * Runs against the real Neon store (DATABASE_URL is injected into the sandbox;
 * the live site uses the same DB) for the recommendation fixtures, plus pure
 * in-memory fixtures for the benchmark math so the assertions are deterministic
 * and immune to live-data drift. Every row this test creates is cleaned up
 * afterwards; nothing in the live data is touched (surgical deletes only).
 *
 * Run: bun run company-bench-test
 *
 * Covers (Batch 3A definition of done):
 *   1. Fix recommendations: a company with weak signals gets data-backed fixes
 *      with the AFFECTED POSTINGS (title + URL + board + observed value); a
 *      healthy company gets the healthy-state message and no fixes; postings
 *      with an observed content change are NOT flagged stale (honesty rule).
 *   2. Benchmark math: company value vs peer MEDIAN across OTHER companies in
 *      the same industry bucket, freshness percentile math, and the honest
 *      small-sample path (< 3 comparable companies → no comparison).
 */

import { Store } from "./store";
import type { PostingRecord } from "./types";
import { companyDashboard, computeBenchmarks, medianOf } from "./company";

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

function mkPosting(id: string, over: Partial<PostingRecord> = {}): PostingRecord {
  return {
    postingId: id,
    canonicalUrl: `https://boards.greenhouse.io/fixture/jobs/${encodeURIComponent(id)}`,
    requestedUrl: null,
    title: `Fixture Role ${id}`,
    company: "FixtureCo",
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

const store = new Store();
const TAG = `bench-${now}`;
const postingIds: string[] = [];

async function seed(records: PostingRecord[]): Promise<void> {
  for (const r of records) {
    postingIds.push(r.postingId);
    await store.upsertPosting(r);
  }
}

async function cleanup(): Promise<void> {
  for (const id of postingIds) {
    try {
      await store.deletePosting(id);
    } catch {
      /* best effort */
    }
  }
}

/* ═════════════════════════ 1. FIX RECOMMENDATIONS (DB-backed) ═════════════════════════ */

async function sectionFixes(): Promise<void> {
  console.log("\n[1] Fix recommendations");

  // ── Weak-signal company: relists, stale, board spread, multi-URL, removed ──
  await seed([
    mkPosting(`${TAG}-fix-a`, {
      company: "FixTestCo",
      title: "Backend Engineer",
      identityKey: `${TAG}-fix-ident-a`,
      relistCount: 2,
      firstSeenAt: iso(now - 120 * DAY_MS),
    }),
    mkPosting(`${TAG}-fix-b`, {
      company: "FixTestCo",
      title: "Product Designer",
      identityKey: `${TAG}-fix-ident-b`,
      relistCount: 0,
      firstSeenAt: iso(now - 45 * DAY_MS),
    }),
    // c+d share one identity across two boards (spread + multi-URL); c removed.
    mkPosting(`${TAG}-fix-c`, {
      company: "FixTestCo",
      title: "Account Executive",
      identityKey: `${TAG}-fix-ident-shared`,
      sourceBoard: "greenhouse",
      status: "removed",
      relistCount: 0,
      firstSeenAt: iso(now - 10 * DAY_MS),
      lastSeenAt: iso(now - 2 * DAY_MS),
    }),
    mkPosting(`${TAG}-fix-d`, {
      company: "FixTestCo",
      title: "Account Executive",
      identityKey: `${TAG}-fix-ident-shared`,
      sourceBoard: "lever",
      status: "live",
      relistCount: 0,
      firstSeenAt: iso(now - 10 * DAY_MS),
    }),
    // e: old BUT with an observed content change — must NOT be flagged stale.
    mkPosting(`${TAG}-fix-e`, {
      company: "FixTestCo",
      title: "Data Analyst",
      identityKey: `${TAG}-fix-ident-e`,
      status: "live",
      relistCount: 0,
      firstSeenAt: iso(now - 100 * DAY_MS),
    }),
  ]);
  await store.addEvent({
    postingId: `${TAG}-fix-e`,
    identityKey: `${TAG}-fix-ident-e`,
    type: "content_changed",
    at: iso(now - 10 * DAY_MS),
    detail: null,
  });

  const dash = await companyDashboard(store, "FixTestCo");
  checkTrue("dashboard exists for weak-signal fixture", dash !== null);
  if (dash) {
    checkTrue("weak signals → not healthy", !dash.fixes.healthy);
    const ids = dash.fixes.fixes.map((f) => f.id);
    check("fix ids for weak signals", ids, [
      "relist_cycles",
      "stale_listings",
      "board_spread",
      "multi_url",
      "removed_postings",
    ]);

    const relistFix = dash.fixes.fixes.find((f) => f.id === "relist_cycles");
    checkTrue("relist fix has the affected posting", relistFix?.affected.length === 1);
    const affected = relistFix?.affected[0];
    check("relist fix affected title", affected?.title, "Backend Engineer");
    check("relist fix affected board", affected?.board, "greenhouse");
    check("relist fix observed value", affected?.observed, "2 relists");
    checkTrue("relist fix URL points at the posting", affected?.canonicalUrl.includes(encodeURIComponent(`${TAG}-fix-a`)) ?? false);

    const staleFix = dash.fixes.fixes.find((f) => f.id === "stale_listings");
    const staleIds = staleFix?.affected.map((p) => p.postingId) ?? [];
    checkTrue("stale fix includes the 45-day posting", staleIds.includes(`${TAG}-fix-b`));
    checkTrue("stale fix includes the 120-day posting", staleIds.includes(`${TAG}-fix-a`));
    checkTrue(
      "content-changed posting is NOT flagged stale (honesty rule)",
      !staleIds.includes(`${TAG}-fix-e`)
    );
    const staleB = staleFix?.affected.find((p) => p.postingId === `${TAG}-fix-b`);
    check("stale fix observed value", staleB?.observed, "45 days listed");

    const spreadFix = dash.fixes.fixes.find((f) => f.id === "board_spread");
    const spreadIds = spreadFix?.affected.map((p) => p.postingId) ?? [];
    checkTrue("board-spread fix lists both identity postings", spreadIds.includes(`${TAG}-fix-c`) && spreadIds.includes(`${TAG}-fix-d`));
    check("board-spread observed boards", spreadFix?.affected[0]?.observed, "boards: greenhouse, lever");

    const urlFix = dash.fixes.fixes.find((f) => f.id === "multi_url");
    checkTrue("multi-URL fix exists with the shared-identity posting", (urlFix?.affected.length ?? 0) >= 1);
    check("multi-URL observed value", urlFix?.affected[0]?.observed, "2 URLs");

    const removedFix = dash.fixes.fixes.find((f) => f.id === "removed_postings");
    checkTrue("removed fix lists the removed posting", removedFix?.affected.some((p) => p.postingId === `${TAG}-fix-c`) ?? false);
    check("removed fix observed value", removedFix?.affected[0]?.observed, "removed from board");

    // Benchmark attachment: fixtures are "Unclassified" (not in the curated
    // map) — FixHealthyCo is the only other peer, so peerCount is small and the
    // honest non-comparable path must be active.
    checkTrue("benchmarks computed for the company", dash.benchmarks !== null);
    check("benchmark industry for fixture company", dash.benchmarks?.industry, "Unclassified");
    checkTrue("small peer sample → not comparable (honest)", dash.benchmarks?.comparable === false);
  }

  // ── Healthy company: nothing weak → healthy state, no fixes ──
  await seed([
    mkPosting(`${TAG}-healthy-1`, {
      company: "FixHealthyCo",
      title: "Support Engineer",
      identityKey: `${TAG}-healthy-ident-1`,
      status: "live",
      relistCount: 0,
      firstSeenAt: iso(now - 5 * DAY_MS),
    }),
    mkPosting(`${TAG}-healthy-2`, {
      company: "FixHealthyCo",
      title: "Accountant",
      identityKey: `${TAG}-healthy-ident-2`,
      status: "live",
      relistCount: 0,
      firstSeenAt: iso(now - 2 * DAY_MS),
    }),
  ]);
  const healthy = await companyDashboard(store, "FixHealthyCo");
  checkTrue("healthy company dashboard exists", healthy !== null);
  if (healthy) {
    checkTrue("healthy → no fixes", healthy.fixes.fixes.length === 0);
    checkTrue("healthy flag", healthy.fixes.healthy);
    check(
      "healthy message",
      healthy.fixes.healthyMessage,
      "No fixes needed right now — your postings look healthy."
    );
  }
}

/* ═════════════════════════ 2. BENCHMARK MATH (pure, deterministic) ═════════════════════════ */

function sectionBenchmarks(): void {
  console.log("\n[2] Industry benchmark math");

  // medianOf sanity
  check("medianOf odd", medianOf([1, 2, 3]), 2);
  check("medianOf even picks lower-middle (matches dashboard)", medianOf([1, 2, 3, 4]), 2);
  check("medianOf single", medianOf([5]), 5);
  check("medianOf empty", medianOf([]), null);

  // Local resolver: fixture names → TestIndustry, everything else → Other.
  const FIXTURE = new Set([
    "BenchTarget",
    "BenchPeer1",
    "BenchPeer2",
    "BenchPeer3",
    "BenchOld",
    "BenchSolo",
    "BenchPeerOnly",
    "BenchAlone",
  ]);
  const resolver = (name: string) => (FIXTURE.has(name) ? "TestIndustry" : "Other");

  const peerRecords = [
    mkPosting("b-p1", { company: "BenchPeer1", identityKey: "b-p1", firstSeenAt: iso(now - 20 * DAY_MS) }),
    mkPosting("b-p2", { company: "BenchPeer2", identityKey: "b-p2", firstSeenAt: iso(now - 40 * DAY_MS) }),
    mkPosting("b-p3a", {
      company: "BenchPeer3",
      identityKey: "b-p3a",
      firstSeenAt: iso(now - 60 * DAY_MS),
      status: "live",
    }),
    mkPosting("b-p3b", {
      company: "BenchPeer3",
      identityKey: "b-p3b",
      firstSeenAt: iso(now - 60 * DAY_MS),
      status: "removed",
      relistCount: 1,
      lastSeenAt: iso(now),
    }),
  ];

  // ── B1: company freshest — honest percentile + median math ──
  const targetRecords = [
    mkPosting("b-t1", { company: "BenchTarget", identityKey: "b-t1", firstSeenAt: iso(now - 10 * DAY_MS) }),
    mkPosting("b-t2", { company: "BenchTarget", identityKey: "b-t2", firstSeenAt: iso(now - 10 * DAY_MS), status: "removed", lastSeenAt: iso(now) }),
  ];
  const b1 = computeBenchmarks([...peerRecords, ...targetRecords], "BenchTarget", resolver);
  check("B1 peerCount (other companies only)", b1.peerCount, 3);
  checkTrue("B1 comparable", b1.comparable);
  check("B1 industry", b1.industry, "TestIndustry");
  const days = b1.comparisons.find((c) => c.metric === "medianDaysListed");
  check("B1 company median days", days?.company, 10);
  check("B1 peer median days (median of 20/40/60)", days?.peerMedian, 40);
  check("B1 days aheadPct", days?.aheadPct, 100);
  const relist = b1.comparisons.find((c) => c.metric === "relistShare");
  check("B1 company relist share", relist?.company, 0);
  check("B1 peer relist-share median (median of 0/0/0.5)", relist?.peerMedian, 0);
  check("B1 relist aheadPct (only peer3 is worse)", relist?.aheadPct, 33);
  const boards = b1.comparisons.find((c) => c.metric === "boardsUsed");
  check("B1 boards peer median", boards?.peerMedian, 1);
  const live = b1.comparisons.find((c) => c.metric === "livePostings");
  check("B1 live postings peer median (1/1/1)", live?.peerMedian, 1);
  checkTrue("B1 freshness present", b1.freshness !== null);
  check("B1 freshness company days", b1.freshness?.companyDays, 10);
  check("B1 freshness peer median days", b1.freshness?.peerMedianDays, 40);
  check("B1 fresher than 100% of peers", b1.freshness?.fresherThanPct, 100);

  // ── B2: company NOT freshest — the claim must not inflate (strictly-greater count) ──
  const oldTarget = [mkPosting("b-old", { company: "BenchOld", identityKey: "b-old", firstSeenAt: iso(now - 50 * DAY_MS) })];
  const b2 = computeBenchmarks([...peerRecords, ...oldTarget], "BenchOld", resolver);
  check("B2 days aheadPct (only 60d peer is longer)", b2.comparisons.find((c) => c.metric === "medianDaysListed")?.aheadPct, 33);
  check("B2 freshness pct", b2.freshness?.fresherThanPct, 33);
  checkTrue("B2 comparable", b2.comparable);

  // ── B3: small sample — honest refusal, no fabricated comparison ──
  const solo = [
    mkPosting("b-solo", { company: "BenchSolo", identityKey: "b-solo", firstSeenAt: iso(now - 5 * DAY_MS) }),
    mkPosting("b-only", { company: "BenchPeerOnly", identityKey: "b-only", firstSeenAt: iso(now - 9 * DAY_MS) }),
  ];
  const b3 = computeBenchmarks(solo, "BenchSolo", resolver);
  check("B3 peerCount", b3.peerCount, 1);
  checkTrue("B3 not comparable (< 3)", !b3.comparable);
  checkTrue("B3 note explains the honesty rule", (b3.note ?? "").includes("at least 3"));
  check("B3 no freshness claim", b3.freshness, null);
  check("B3 aheadPct null (no claim)", b3.comparisons.find((c) => c.metric === "medianDaysListed")?.aheadPct, null);

  // ── B4: zero peers ──
  const alone = [mkPosting("b-alone", { company: "BenchAlone", identityKey: "b-alone", firstSeenAt: iso(now - 5 * DAY_MS) })];
  const b4 = computeBenchmarks(alone, "BenchAlone", resolver);
  check("B4 peerCount zero", b4.peerCount, 0);
  checkTrue("B4 not comparable", !b4.comparable);
  check("B4 peer median null (nothing to compare to)", b4.comparisons.find((c) => c.metric === "medianDaysListed")?.peerMedian, null);
}

/* ═════════════════════════ run ═════════════════════════ */

(async () => {
  console.log(`company bench test — ${TAG}`);
  try {
    await sectionFixes();
    sectionBenchmarks();
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
