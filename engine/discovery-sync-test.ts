/**
 * Discovery-pool + scheduled-pass test suite (design §4.8). Runs against the
 * real Neon store (like watchlist-test.ts) — every row this test creates is
 * cleaned up afterwards; nothing in the live data is touched (no wipe,
 * surgical deletes only). All fixture candidate keys use the `fxdisc-` prefix
 * and old created_at dates so they sort FIRST in the pool's priority order
 * (deterministic slice selection without touching real candidates), and are
 * denylisted-safe (company names do not match /test/i; board ids are
 * `fxdisc-*`, not `acme`). The /check hook guard (TestCo/acme no-ops) is
 * tested explicitly.
 *
 * Run: bun run discovery-sync-test
 */

import { neon } from "@neondatabase/serverless";
import { Store } from "./store";
import type { DiscoveryCandidateRow } from "./store";
import { buildRegistry } from "./companies";
import { runDiscoverySlice } from "./discovery-sync";
import { handleCronHttp } from "../src/server/cron-http";
import { utcDateStr } from "./daily-stats";
import type { BoardFetchResult, BoardKind } from "./boards";
import type { PostingRecord } from "./types";

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
const TAG = `fxdisc-${Date.now()}`;
const candidateKeys: string[] = [];
let claimKeyCreated = false;

const OLD = "2025-12-01T00:00:00.000Z"; // older than every real pool row

function mkCandidate(over: Partial<DiscoveryCandidateRow>): DiscoveryCandidateRow {
  return {
    candidateKey: `${over.board ?? "greenhouse"}:${(over.boardId ?? "x").toLowerCase()}`,
    name: "FxDiscCo",
    board: "greenhouse",
    boardId: "x",
    careerUrl: null,
    source: "curated",
    status: "pending",
    jobs: null,
    statusCode: null,
    note: null,
    lastCheckedAt: null,
    verifiedAt: null,
    createdAt: OLD,
    ...over,
  };
}

function mkPosting(id: string, url: string, company: string): PostingRecord {
  return {
    postingId: id,
    canonicalUrl: url,
    requestedUrl: null,
    title: `Fixture ${id}`,
    company,
    location: "Remote",
    postedAt: null,
    sourceBoard: "greenhouse",
    identityKey: id,
    fingerprint: null,
    status: "live",
    relistCount: 0,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-10T00:00:00.000Z",
    lastCheckedAt: "2026-08-10T00:00:00.000Z",
    lastStatusCode: 200,
    lastNote: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function mockResult(over: Partial<BoardFetchResult>): BoardFetchResult {
  return {
    ok: false,
    board: "greenhouse",
    boardId: "",
    jobs: [],
    statusCode: null,
    note: null,
    ...over,
  } as BoardFetchResult;
}

function job(board: BoardKind, boardId: string, n: number) {
  return {
    board,
    externalId: String(n),
    title: `Fixture ${n}`,
    location: null,
    postedAt: null,
    url: `https://boards.greenhouse.io/${boardId}/jobs/${n}`,
    postingId: `fx-${boardId}-${n}`,
    raw: { fixture: true },
  };
}

async function row(candidateKey: string): Promise<Record<string, unknown> | null> {
  const rows = await sql.query(`SELECT candidate_key, name, board, board_id, source, status, jobs, status_code, note, last_checked_at, verified_at, created_at FROM discovery_candidates WHERE candidate_key = $1`, [candidateKey]);
  return rows[0] ?? null;
}

/** Delete all fixture candidate rows tracked so far (surgical, between sections). */
async function clearFixtures(): Promise<void> {
  if (!candidateKeys.length) return;
  await sql
    .query(`DELETE FROM discovery_candidates WHERE candidate_key = ANY($1::text[])`, [[...new Set(candidateKeys)]])
    .catch((e: unknown) => console.error("fixture cleanup failed:", e));
  candidateKeys.length = 0;
}

const DAY = 24 * 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

async function run(): Promise<void> {
  console.log("== 1. listDiscoveryCandidates: ordering, backoff, host cap ==");
  {
    const A = await store.upsertDiscoveryCandidate(
      mkCandidate({ candidateKey: `ashby:fxdisc-a-${TAG}`, board: "ashby", boardId: `fxdisc-a-${TAG}`, createdAt: "2025-12-01T00:00:00.000Z" }), true
    );
    const B = await store.upsertDiscoveryCandidate(
      mkCandidate({ candidateKey: `lever:fxdisc-b-${TAG}`, board: "lever", boardId: `fxdisc-b-${TAG}`, status: "http-404", lastCheckedAt: isoAgo(2 * DAY) }), true
    );
    const C = await store.upsertDiscoveryCandidate(
      mkCandidate({ candidateKey: `lever:fxdisc-c-${TAG}`, board: "lever", boardId: `fxdisc-c-${TAG}`, status: "http-404", lastCheckedAt: isoAgo(31 * DAY) }), true
    );
    const D = await store.upsertDiscoveryCandidate(
      mkCandidate({ candidateKey: `greenhouse:fxdisc-d-${TAG}`, board: "greenhouse", boardId: `fxdisc-d-${TAG}`, status: "verified", lastCheckedAt: isoAgo(91 * DAY), verifiedAt: "2026-01-01" }), true
    );
    const E = await store.upsertDiscoveryCandidate(
      mkCandidate({ candidateKey: `greenhouse:fxdisc-e-${TAG}`, board: "greenhouse", boardId: `fxdisc-e-${TAG}`, status: "verified", lastCheckedAt: isoAgo(10 * DAY), verifiedAt: "2026-08-01" }), true
    );
    for (const [created, key] of [
      [A, `ashby:fxdisc-a-${TAG}`], [B, `lever:fxdisc-b-${TAG}`], [C, `lever:fxdisc-c-${TAG}`],
      [D, `greenhouse:fxdisc-d-${TAG}`], [E, `greenhouse:fxdisc-e-${TAG}`],
    ] as const) {
      if (created) candidateKeys.push(key);
    }

    const slice = await store.listDiscoveryCandidates(1000, 1000);
    const keys = slice.map((c) => c.candidateKey);
    const keyA = `ashby:fxdisc-a-${TAG}`;
    const keyC = `lever:fxdisc-c-${TAG}`;
    const keyD = `greenhouse:fxdisc-d-${TAG}`;
    checkTrue("pending row is picked", keys.includes(keyA));
    checkTrue("recent 404 (2d) NOT re-picked", !keys.includes(`lever:fxdisc-b-${TAG}`));
    checkTrue("31-day-old 404 re-picked", keys.includes(keyC));
    checkTrue("91-day-old verified re-picked", keys.includes(keyD));
    checkTrue("recent verified (10d) NOT re-picked", !keys.includes(`greenhouse:fxdisc-e-${TAG}`));
    checkTrue("priority order pending < failed < verified", keys.indexOf(keyA) < keys.indexOf(keyC) && keys.indexOf(keyC) < keys.indexOf(keyD));

    // Host cap: 5 pending greenhouse fixtures + hostCap=3 → at most 3 greenhouse rows.
    for (let i = 1; i <= 5; i++) {
      const created = new Date(Date.UTC(2025, 11, 2, 0, i)).toISOString();
      const k = `greenhouse:fxdisc-g${i}-${TAG}`;
      const createdRow = await store.upsertDiscoveryCandidate(
        mkCandidate({ candidateKey: k, board: "greenhouse", boardId: `fxdisc-g${i}-${TAG}`, createdAt: created }), true
      );
      if (createdRow) candidateKeys.push(k);
    }
    const capped = await store.listDiscoveryCandidates(1000, 3);
    const greenhouseRows = capped.filter((c) => c.board === "greenhouse");
    checkTrue("host cap respected (greenhouse <= 3)", greenhouseRows.length <= 3);
    checkTrue("first fixture greenhouse row survives the cap", greenhouseRows.some((c) => c.candidateKey === `greenhouse:fxdisc-g1-${TAG}`));
    checkTrue("5th fixture greenhouse row cut by the cap", !greenhouseRows.some((c) => c.candidateKey === `greenhouse:fxdisc-g5-${TAG}`));
    await clearFixtures();
  }

  console.log("== 2. runDiscoverySlice: pending-first order, statuses, newly verified ==");
  {
    const h1 = `greenhouse:fxdisc-h1-${TAG}`;
    const h2 = `greenhouse:fxdisc-h2-${TAG}`;
    const h3 = `ashby:fxdisc-h3-${TAG}`;
    for (const [k, board, id, at] of [
      [h1, "greenhouse", `fxdisc-h1-${TAG}`, "2025-12-31T00:00:00.000Z"],
      [h2, "greenhouse", `fxdisc-h2-${TAG}`, "2025-12-31T00:01:00.000Z"],
      [h3, "ashby", `fxdisc-h3-${TAG}`, "2025-12-31T00:02:00.000Z"],
    ] as const) {
      const created = await store.upsertDiscoveryCandidate(
        mkCandidate({ candidateKey: k, board: board as BoardKind, boardId: id, createdAt: at }), true
      );
      if (created) candidateKeys.push(k);
    }

    const order: string[] = [];
    const fetchMock = async (board: BoardKind, boardId: string): Promise<BoardFetchResult> => {
      order.push(`${board}:${boardId}`);
      if (boardId.includes("h1")) return mockResult({ ok: true, statusCode: 200, jobs: [job(board, boardId, 1), job(board, boardId, 2)] });
      if (boardId.includes("h2")) return mockResult({ ok: false, statusCode: 404, note: "HTTP 404" });
      return mockResult({ ok: true, statusCode: 200, jobs: [job(board, boardId, 3)] });
    };

    const r = await runDiscoverySlice(store, {
      limit: 3,
      hostCap: 10,
      timeBudgetMs: 30_000,
      now: new Date("2026-08-15T12:00:00.000Z"),
      fetchBoard: fetchMock,
    });

    check("processed 3", r.processed, 3);
    check("picked 3", r.picked, 3);
    check("skippedBudget 0", r.skippedBudget, 0);
    check("fetch order is pending-first", order, [h1, h2, h3]);
    check("byReason verified=2", r.byReason.verified, 2);
    check("byReason http-404=1", r.byReason["http-404"], 1);
    check("newlyVerified", r.newlyVerified, [h1, h3]);
    const expectedPool = Object.values(await store.discoveryPoolSummary()).reduce((a, b) => a + b, 0);
    check("poolSize matches pool summary", r.poolSize, expectedPool);

    const r1 = await row(h1);
    check("h1 status verified", r1?.status, "verified");
    check("h1 verified_at set", r1?.verified_at, "2026-08-15");
    check("h1 jobs recorded", r1?.jobs, 2);
    const r2 = await row(h2);
    check("h2 status http-404", r2?.status, "http-404");
    check("h2 verified_at stays null", r2?.verified_at, null);
    const r3 = await row(h3);
    check("h3 status verified", r3?.status, "verified");
    check("h3 verified_at set", r3?.verified_at, "2026-08-15");
    await clearFixtures();
  }

  console.log("== 3. budget cutoff mid-slice ==");
  {
    const k1 = `greenhouse:fxdisc-k1-${TAG}`;
    const k2 = `greenhouse:fxdisc-k2-${TAG}`;
    for (const [k, at] of [[k1, "2025-11-01T00:00:00.000Z"], [k2, "2025-11-01T00:01:00.000Z"]] as const) {
      const created = await store.upsertDiscoveryCandidate(
        mkCandidate({ candidateKey: k, board: "greenhouse", boardId: k.split(":")[1], createdAt: at }), true
      );
      if (created) candidateKeys.push(k);
    }
    // Hard cutoff FIRST (nothing processed — both rows stay pending): a 1ms
    // budget means even the first candidate is skipped; nothing is fetched,
    // everything is counted (skippedBudget).
    let calls2 = 0;
    const r2 = await runDiscoverySlice(store, {
      limit: 2, hostCap: 10, timeBudgetMs: 1,
      fetchBoard: async () => {
        calls2++;
        return mockResult({ ok: false, statusCode: 404, note: "HTTP 404" });
      },
    });
    check("hard cutoff: picked 2", r2.picked, 2);
    check("hard cutoff: processed 0", r2.processed, 0);
    check("hard cutoff: skippedBudget 2", r2.skippedBudget, 2);
    check("hard cutoff: nothing fetched", calls2, 0);

    // Mid-slice cutoff (both rows still pending after the hard-cutoff run):
    // the pre-loop store queries take ~0.2-0.6s, so a 1500ms budget lets the
    // FIRST candidate start; the 3000ms mock fetch blows the budget before the
    // second candidate's check → it is skipped and counted (skippedBudget),
    // never fetched. Deterministic within wide margins (warm Neon pool).
    let calls = 0;
    const slowMock = async (): Promise<BoardFetchResult> => {
      calls++;
      await new Promise((res) => setTimeout(res, 3000));
      return mockResult({ ok: false, statusCode: 404, note: "HTTP 404" });
    };
    const r = await runDiscoverySlice(store, { limit: 2, hostCap: 10, timeBudgetMs: 1500, fetchBoard: slowMock });
    check("budget: picked 2", r.picked, 2);
    check("budget: processed 1 (only the first fits)", r.processed, 1);
    check("budget: skippedBudget 1 counted", r.skippedBudget, 1);
    check("budget: fetch called once", calls, 1);
    await clearFixtures();
  }

  console.log("== 4. upsertDiscoveryCandidate: verified_at set-once + insertOnly ==");
  {
    const key = `greenhouse:fxdisc-x-${TAG}`;
    const created = await store.upsertDiscoveryCandidate(
      mkCandidate({ candidateKey: key, board: "greenhouse", boardId: `fxdisc-x-${TAG}` }), true
    );
    candidateKeys.push(key);
    checkTrue("insertOnly creates the row", created);
    check("insertOnly on existing key is a no-op", await store.upsertDiscoveryCandidate(
      mkCandidate({ candidateKey: key, board: "greenhouse", boardId: `fxdisc-x-${TAG}` }), true
    ), false);

    await store.upsertDiscoveryCandidate(mkCandidate({ candidateKey: key, board: "greenhouse", boardId: `fxdisc-x-${TAG}`, status: "verified", verifiedAt: "2026-08-15", lastCheckedAt: "2026-08-15T00:00:00Z", jobs: 5 }));
    check("first verified observation sets verified_at", (await row(key))?.verified_at, "2026-08-15");
    await store.upsertDiscoveryCandidate(mkCandidate({ candidateKey: key, board: "greenhouse", boardId: `fxdisc-x-${TAG}`, status: "verified", verifiedAt: "2026-08-20", lastCheckedAt: "2026-08-20T00:00:00Z", jobs: 6 }));
    check("second verified observation keeps the original date", (await row(key))?.verified_at, "2026-08-15");
    await store.upsertDiscoveryCandidate(mkCandidate({ candidateKey: key, board: "greenhouse", boardId: `fxdisc-x-${TAG}`, status: "http-404", statusCode: 404, lastCheckedAt: "2026-09-01T00:00:00Z" }));
    const x = await row(key);
    check("failure keeps verified_at", x?.verified_at, "2026-08-15");
    check("failure updates status honestly", x?.status, "http-404");
    check("source survives upserts", x?.source, "curated");
    await clearFixtures();
  }

  console.log("== 5. ensureDiscoveryCandidateFromPosting: no-ops ==");
  {
    const url = `https://jobs.lever.co/fxuser-${TAG}/abc`;
    const key = `lever:fxuser-${TAG}`;
    const created = await store.ensureDiscoveryCandidateFromPosting(mkPosting("fx-user-1", url, "FxUserCo"));
    candidateKeys.push(key);
    checkTrue("new board URL creates a pending user-check row", created);
    const r = await row(key);
    check("row source is user-check", r?.source, "user-check");
    check("row status is pending", r?.status, "pending");
    check("existing key is a no-op", await store.ensureDiscoveryCandidateFromPosting(mkPosting("fx-user-1", url, "FxUserCo")), false);
    check("non-board URL is a no-op", await store.ensureDiscoveryCandidateFromPosting(mkPosting("fx-user-2", "https://example.com/jobs/1", "ExampleCo")), false);
    check("TestCo/acme fixture is a no-op", await store.ensureDiscoveryCandidateFromPosting(mkPosting("fx-user-3", "https://boards.greenhouse.io/acme/jobs/fx-test-1", "TestCo")), false);
    check("loopback fixture is a no-op", await store.ensureDiscoveryCandidateFromPosting(mkPosting("fx-user-4", "http://127.0.0.1:8890/jobs/fixture-1", "FixtureCorp")), false);
    const acmeRow = await row("greenhouse:acme");
    check("no greenhouse:acme row exists", acmeRow, null);
    await clearFixtures();
  }

  console.log("== 6. buildRegistry: verified-candidates merge + denylist + determinism ==");
  {
    const keyCo = `greenhouse:fxdisc-1-${TAG}`;
    const keyLever = `lever:fxdisc-1lev-${TAG}`;
    const keyTest = `greenhouse:acme`;
    await store.upsertDiscoveryCandidate(mkCandidate({ candidateKey: keyCo, name: "FxDiscCo", board: "greenhouse", boardId: `fxdisc-1-${TAG}`, status: "verified", verifiedAt: "2026-08-14", lastCheckedAt: "2026-08-14T00:00:00Z" }));
    await store.upsertDiscoveryCandidate(mkCandidate({ candidateKey: keyTest, name: "TestCo", board: "greenhouse", boardId: "acme", status: "verified", verifiedAt: "2026-08-13", lastCheckedAt: "2026-08-13T00:00:00Z" }));
    candidateKeys.push(keyCo, keyTest);

    const reg1 = await buildRegistry(store);
    const co = reg1.find((c) => c.name === "FxDiscCo");
    checkTrue("verified candidate joins the registry", Boolean(co));
    check("verified candidate carries its board", co?.boards.map((b) => `${b.board}/${b.boardId}`) ?? [], [`greenhouse/fxdisc-1-${TAG}`]);
    check("verified candidate carries verifiedAt", co?.verifiedAt, "2026-08-14");
    checkTrue("TestCo (verified candidate) excluded from registry", !reg1.some((c) => c.name === "TestCo"));
    checkTrue("no registry entry carries the acme board", !reg1.some((c) => c.boards.some((b) => b.boardId === "acme")));
    checkTrue("live TestCo phantom excluded (denylist)", !reg1.some((c) => c.name.toLowerCase() === "testco"));

    await store.upsertDiscoveryCandidate(mkCandidate({ candidateKey: keyLever, name: "FxDiscCo", board: "lever", boardId: `fxdisc-1lev-${TAG}`, status: "verified", verifiedAt: "2026-08-14", lastCheckedAt: "2026-08-14T00:00:00Z" }));
    candidateKeys.push(keyLever);
    const reg2 = await buildRegistry(store);
    const co2 = reg2.find((c) => c.name === "FxDiscCo");
    check("multi-board append keeps both boards", co2?.boards.map((b) => `${b.board}/${b.boardId}`).sort() ?? [], [`greenhouse/fxdisc-1-${TAG}`, `lever/fxdisc-1lev-${TAG}`].sort());

    const withPosting = await buildRegistry(store, [
      mkPosting("fx-p1", `https://boards.greenhouse.io/fxdisc-post-${TAG}/jobs/1`, "FxDiscPostCo"),
      mkPosting("fx-p2", "https://boards.greenhouse.io/acme/jobs/fx-test-2", "TestCo"),
    ]);
    checkTrue("postings-derived company joins via records", withPosting.some((c) => c.name === "FxDiscPostCo"));
    checkTrue("TestCo postings-derived excluded", !withPosting.some((c) => c.name === "TestCo"));

    check("buildRegistry is deterministic", JSON.stringify(reg2), JSON.stringify(await buildRegistry(store)));
    await clearFixtures();
  }

  console.log("== 7. cron claim guard + newlyVerifiedSince ==");
  {
    // newlyVerifiedSince KPI: a verified row dated today counts.
    const today = utcDateStr(new Date());
    const keyToday = `greenhouse:fxdisc-today-${TAG}`;
    await store.upsertDiscoveryCandidate(mkCandidate({ candidateKey: keyToday, board: "greenhouse", boardId: `fxdisc-today-${TAG}`, status: "verified", verifiedAt: today, lastCheckedAt: new Date().toISOString() }));
    candidateKeys.push(keyToday);
    const nv = await store.newlyVerifiedSince(today);
    checkTrue("newlyVerifiedSince counts today's verified row", nv >= 1);

    // Claim guard: an existing discovery_slot_<date>_<slot> claim makes the
    // cron no-op (slot = hour/6 — the scale-up cron's independent slots).
    const slot = Math.floor(new Date().getUTCHours() / 6);
    const claimKey = `discovery_slot_${today}_${slot}`;
    claimKeyCreated = await store.tryCreateMeta(claimKey, new Date().toISOString());
    const authed = new Request("https://hireclarity-data.vercel.app/api/cron/discover", {
      method: "GET",
      headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
    });
    const res = await handleCronHttp(authed);
    const body = (await res?.json()) as { ok?: boolean; claim?: string };
    check("claimed path returns 200", res?.status, 200);
    check("claimed path no-ops", body?.ok, true);
    check("claim is already-claimed", body?.claim, "already-claimed");

    const badMethod = new Request("https://hireclarity-data.vercel.app/api/cron/discover", { method: "POST" });
    check("POST /api/cron/discover -> 405", (await handleCronHttp(badMethod))?.status, 405);
    const noAuth = new Request("https://hireclarity-data.vercel.app/api/cron/discover", { method: "GET" });
    check("GET without Bearer -> 401", (await handleCronHttp(noAuth))?.status, 401);
    await clearFixtures();
  }
}

(async () => {
  try {
    await run();
  } finally {
    await clearFixtures();
    if (claimKeyCreated) {
      try {
        await store.deleteMeta(`discovery_slot_${utcDateStr(new Date())}_${Math.floor(new Date().getUTCHours() / 6)}`);
      } catch {
        /* best effort */
      }
    }
  }
  console.log(fail === 0 ? `\nRESULT: ALL PASS (${pass} checks)` : `\nRESULT: ${fail} FAILURE(S) of ${pass + fail} checks`);
  if (fail > 0) {
    console.log("failures:", failures.join(" | "));
    process.exit(1);
  }
})();
