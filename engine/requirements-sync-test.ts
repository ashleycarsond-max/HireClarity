/**
 * FULL-DESCRIPTION-COVERAGE sweep test suite (owner direction 2026-08-15).
 *
 * Two layers, both following the discovery-sync-test.ts harness style
 * (check() helpers, numbered sections, honest RESULT line):
 *
 *   1. In-memory slice tests — runRequirementsSlice is exercised against a
 *      FAKE RequirementsStore (a JS port of the real SQL's three-tier
 *      ordering: never-read → stale → fresh-oldest, host-capped and
 *      host-interleaved) with a MOCK extractor, so the whole suite runs with
 *      ZERO live-DB writes and ZERO network (no TestCo-style phantom
 *      fixtures can ever land in the live store).
 *   2. One READ-ONLY live-Neon section — the real
 *      `Store.listRequirementCandidates(limit, hostCap, staleBefore)` SQL is
 *      verified structurally against the current live postings (per-host
 *      tier order, host cap, no loopbacks). No rows are inserted or deleted.
 *      Skipped (with a printed note) when DATABASE_URL is unset.
 *
 * Run: bun run requirements-sync-test
 */

import { Store } from "./store";
import { runRequirementsSlice, type RequirementsStore } from "./requirements-sync";
import type { PostingRecord, PostingRequirement } from "./types";
import { hostOf } from "./robots";

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

/* --------------------------- fake RequirementsStore -------------------------- */

/**
 * In-memory port of the store's candidate query: LIVE postings ordered
 * never-read → stale (extracted_at < staleBefore) → fresh, oldest first
 * within each tier, capped per URL host and interleaved by rank (rank-1 of
 * each host, then rank-2, ...) — the same shape listRequirementCandidates
 * returns, so the slice's consumption of that order is exercised faithfully.
 */
export class FakeRequirementsStore implements RequirementsStore {
  postings: PostingRecord[] = [];
  requirements = new Map<string, PostingRequirement>();
  listCalls: { limit: number; hostCap: number; staleBefore: string | null }[] = [];

  addPosting(rec: PostingRecord): void {
    this.postings.push(rec);
  }

  setRequirement(r: PostingRequirement): void {
    this.requirements.set(r.postingId, r);
  }

  async listRequirementCandidates(
    limit: number,
    hostCap = 10,
    staleBefore?: string | null
  ): Promise<PostingRecord[]> {
    this.listCalls.push({ limit, hostCap, staleBefore: staleBefore ?? null });
    const live = this.postings.filter((p) => p.status === "live" || p.status === "relisted");
    const tier = (p: PostingRecord): number => {
      const row = this.requirements.get(p.postingId);
      if (!row) return 0; // never-read
      if (staleBefore && row.extractedAt < staleBefore) return 1; // stale
      return 2; // fresh
    };
    const sortKey = (p: PostingRecord): string => {
      const row = this.requirements.get(p.postingId);
      return row?.extractedAt ?? "\uffff"; // never-read (tier 0) sorts by id below
    };
    // Within each host: tier ASC, then extraction ASC, then posting_id.
    const byHost = new Map<string, PostingRecord[]>();
    for (const p of live) {
      const h = hostOf(p.canonicalUrl);
      const list = byHost.get(h) ?? [];
      list.push(p);
      byHost.set(h, list);
    }
    const ranked: { rank: number; rec: PostingRecord }[] = [];
    for (const list of byHost.values()) {
      const sorted = [...list].sort(
        (a, b) => tier(a) - tier(b) || sortKey(a).localeCompare(sortKey(b)) || a.postingId.localeCompare(b.postingId)
      );
      sorted.slice(0, hostCap).forEach((rec, i) => ranked.push({ rank: i + 1, rec }));
    }
    ranked.sort((a, b) => a.rank - b.rank || a.rec.postingId.localeCompare(b.rec.postingId));
    return ranked.slice(0, limit).map((r) => r.rec);
  }

  async getRequirementsForPostingIds(ids: string[]): Promise<PostingRequirement[]> {
    const uniq = [...new Set(ids)];
    return uniq.map((id) => this.requirements.get(id)).filter((r): r is PostingRequirement => Boolean(r));
  }

  async flushRequirementWrites(rows: PostingRequirement[]): Promise<void> {
    for (const r of rows) this.requirements.set(r.postingId, r);
  }

  async requirementCoverage(): Promise<{ live: number; read: number; fetchError: number; notExtracted: number }> {
    const live = this.postings.filter((p) => p.status === "live" || p.status === "relisted");
    let read = 0;
    let fetchError = 0;
    let notExtracted = 0;
    for (const p of live) {
      const row = this.requirements.get(p.postingId);
      if (!row) notExtracted++;
      else if (row.descriptionPresent) read++;
      else if (row.fetchError) fetchError++;
      else notExtracted++;
    }
    return { live: live.length, read, fetchError, notExtracted };
  }
}

/* --------------------------------- fixtures ---------------------------------- */

const NOW = new Date("2026-08-15T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const DAY = 24 * 60 * 60 * 1000;

function mkPosting(id: string, host: string, over: Partial<PostingRecord> = {}): PostingRecord {
  return {
    postingId: id,
    canonicalUrl: `https://${host}/jobs/${id}`,
    requestedUrl: null,
    title: `Fixture ${id}`,
    company: "FxReqCo",
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
    ...over,
  };
}

/** A mock extractor that records calls and honors per-posting flag options. */
function mockExtractor(
  calls: string[] = [],
  opts: {
    fail?: Set<string>;
    flags?: Record<string, { requiresBachelor?: boolean; requiresMasters?: boolean; requires5PlusYears?: boolean }>;
  } = {}
): (rec: PostingRecord, nowIso: string) => Promise<PostingRequirement> {
  return async (rec, nowIso) => {
    calls.push(rec.postingId);
    if (opts.fail?.has(rec.postingId)) {
      return {
        postingId: rec.postingId,
        requiresBachelor: false,
        requiresMasters: false,
        requires5PlusYears: false,
        descriptionPresent: false,
        descriptionLen: 0,
        extractedAt: nowIso,
        fetchError: "mock fetch failed",
      };
    }
    const f = opts.flags?.[rec.postingId] ?? {};
    return {
      postingId: rec.postingId,
      requiresBachelor: Boolean(f.requiresBachelor),
      requiresMasters: Boolean(f.requiresMasters),
      requires5PlusYears: Boolean(f.requires5PlusYears),
      descriptionPresent: true,
      descriptionLen: 100,
      extractedAt: nowIso,
      fetchError: null,
    };
  };
}

/* ---------------------------------- run() ----------------------------------- */

async function run(): Promise<void> {
  console.log("== 1. never-read postings are picked and processed first ==");
  {
    const store = new FakeRequirementsStore();
    const neverA = mkPosting("fxreq-a", "boards.greenhouse.io");
    const neverB = mkPosting("fxreq-b", "api.ashbyhq.com");
    const freshC = mkPosting("fxreq-c", "jobs.lever.co");
    store.addPosting(neverA);
    store.addPosting(neverB);
    store.addPosting(freshC);
    // freshC was already read yesterday — must rank after both never-read ones.
    store.setRequirement({
      postingId: "fxreq-c",
      requiresBachelor: true,
      requiresMasters: false,
      requires5PlusYears: false,
      descriptionPresent: true,
      descriptionLen: 90,
      extractedAt: new Date(NOW.getTime() - DAY).toISOString(),
      fetchError: null,
    });

    const calls: string[] = [];
    const r = await runRequirementsSlice(store, {
      limit: 10,
      hostCap: 10,
      timeBudgetMs: 10_000,
      staleAfterDays: 7,
      now: NOW,
      extract: mockExtractor(calls, { flags: { "fxreq-c": { requiresBachelor: true } } }),
    });

    check("picked 3 (all live)", r.picked, 3);
    check("processed 3", r.processed, 3);
    check("skippedBudget 0", r.skippedBudget, 0);
    check("tiers: never-read 2, stale 0, fresh 1", [r.pickedNeverRead, r.pickedStale, r.pickedFresh], [2, 0, 1]);
    check("never-read fetched before fresh", calls, ["fxreq-a", "fxreq-b", "fxreq-c"]);
    check("descriptionsRead 3", r.descriptionsRead, 3);
    check("flags bachelor=1 (fxreq-c)", r.flags.requiresBachelor, 1);
    check("staleBefore passed to the store", store.listCalls[0]?.staleBefore, "2026-08-08T12:00:00.000Z");
    check("coverage read=3 of live=3", [r.coverage.read, r.coverage.live], [3, 3]);
    check("rows persisted with extractedAt=now", store.requirements.get("fxreq-a")?.extractedAt, NOW_ISO);
  }

  console.log("== 2. staleness rotation: stale before fresh, fresh only when nothing else ==");
  {
    // A: full run on a clean store → never-read, then stale, then fresh.
    const store = new FakeRequirementsStore();
    const neverA = mkPosting("fxreq-a1", "api.ashbyhq.com"); // never-read (ashby)
    const staleE = mkPosting("fxreq-e1", "boards.greenhouse.io"); // read 10 days ago → stale
    const freshF = mkPosting("fxreq-f1", "boards.greenhouse.io"); // read 1 day ago → fresh
    store.addPosting(neverA);
    store.addPosting(staleE);
    store.addPosting(freshF);
    store.setRequirement({
      postingId: "fxreq-e1", requiresBachelor: false, requiresMasters: false, requires5PlusYears: false,
      descriptionPresent: true, descriptionLen: 80, extractedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(), fetchError: null,
    });
    store.setRequirement({
      postingId: "fxreq-f1", requiresBachelor: false, requiresMasters: false, requires5PlusYears: false,
      descriptionPresent: true, descriptionLen: 80, extractedAt: new Date(NOW.getTime() - DAY).toISOString(), fetchError: null,
    });

    // limit=3 → never-read first, then the STALE one (10 days old), then fresh.
    // (host-interleaved by rank; postingId tiebreak within a rank)
    const calls3: string[] = [];
    const r3 = await runRequirementsSlice(store, { limit: 3, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW, extract: mockExtractor(calls3) });
    check("never-read then stale then fresh", calls3, ["fxreq-a1", "fxreq-e1", "fxreq-f1"]);
    check("tiers [1,1,1]", [r3.pickedNeverRead, r3.pickedStale, r3.pickedFresh], [1, 1, 1]);

    // Everything now has a fresh row → the rotation re-reads the OLDEST fresh
    // first (all rows share the same extractedAt from the run above, so the
    // posting_id tiebreak applies within each host; rank-1 rows sort first).
    const calls4: string[] = [];
    const r4 = await runRequirementsSlice(store, { limit: 1, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW, extract: mockExtractor(calls4) });
    check("rotation picks oldest covered first", calls4, ["fxreq-a1"]);
    check("tiers [0,0,1]", [r4.pickedNeverRead, r4.pickedStale, r4.pickedFresh], [0, 0, 1]);

    // B: a bounded run (limit=2) on a clean store must prefer never-read and
    // stale over the still-fresh posting — fresh only enters the rotation.
    const store2 = new FakeRequirementsStore();
    store2.addPosting(mkPosting("fxreq-b1", "api.ashbyhq.com")); // never-read
    store2.addPosting(mkPosting("fxreq-b2", "boards.greenhouse.io")); // never-read
    store2.addPosting(mkPosting("fxreq-b3", "jobs.lever.co")); // fresh (yesterday)
    store2.setRequirement({
      postingId: "fxreq-b3", requiresBachelor: false, requiresMasters: false, requires5PlusYears: false,
      descriptionPresent: true, descriptionLen: 70, extractedAt: new Date(NOW.getTime() - DAY).toISOString(), fetchError: null,
    });
    const callsB: string[] = [];
    const rB = await runRequirementsSlice(store2, { limit: 2, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW, extract: mockExtractor(callsB) });
    check("bounded run skips the fresh posting", callsB, ["fxreq-b1", "fxreq-b2"]);
    check("tiers [2,0,0]", [rB.pickedNeverRead, rB.pickedStale, rB.pickedFresh], [2, 0, 0]);
  }

  console.log("== 3. idempotency: no re-fetch before the never-read gap is covered ==");
  {
    const store = new FakeRequirementsStore();
    // 4 never-read postings on ONE host (sequential within host), limit=2.
    for (let i = 1; i <= 4; i++) store.addPosting(mkPosting(`fxreq-i${i}`, "boards.greenhouse.io"));
    const calls: string[] = [];
    const extract = mockExtractor(calls);
    await runRequirementsSlice(store, { limit: 2, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW, extract });
    await runRequirementsSlice(store, { limit: 2, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW, extract });
    check("first two passes fetch each posting exactly once", calls, ["fxreq-i1", "fxreq-i2", "fxreq-i3", "fxreq-i4"]);
    // Third pass: nothing never-read remains → the rotation re-reads the
    // oldest covered postings (fresh tier, oldest extracted_at first).
    await runRequirementsSlice(store, { limit: 2, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW, extract });
    check("third pass is the rotation (oldest covered first)", calls, ["fxreq-i1", "fxreq-i2", "fxreq-i3", "fxreq-i4", "fxreq-i1", "fxreq-i2"]);
  }

  console.log("== 4. budget cutoff: hard cutoff and mid-slice cutoff ==");
  {
    // Hard cutoff: a negative budget means nothing can even start — all
    // picked rows are counted as skipped, the extractor is never called.
    // (Negative is deterministic where 1ms would race with Date.now()'s
    // ~1ms resolution on an in-memory store.)
    const store = new FakeRequirementsStore();
    store.addPosting(mkPosting("fxreq-a1", "boards.greenhouse.io"));
    store.addPosting(mkPosting("fxreq-a2", "boards.greenhouse.io"));
    store.addPosting(mkPosting("fxreq-a3", "boards.greenhouse.io"));
    let calls = 0;
    const r = await runRequirementsSlice(store, {
      limit: 3, timeBudgetMs: -1, staleAfterDays: 7, now: NOW,
      extract: async () => {
        calls++;
        return { postingId: "", requiresBachelor: false, requiresMasters: false, requires5PlusYears: false, descriptionPresent: true, descriptionLen: 1, extractedAt: NOW_ISO, fetchError: null };
      },
    });
    check("hard cutoff: picked 3", r.picked, 3);
    check("hard cutoff: processed 0", r.processed, 0);
    check("hard cutoff: skippedBudget 3", r.skippedBudget, 3);
    check("hard cutoff: extractor never called", calls, 0);

    // Mid-slice cutoff: all postings on ONE host (sequential within host).
    // 1200ms mock vs 1000ms budget → only the first extraction fits.
    const store2 = new FakeRequirementsStore();
    store2.addPosting(mkPosting("fxreq-b1", "boards.greenhouse.io"));
    store2.addPosting(mkPosting("fxreq-b2", "boards.greenhouse.io"));
    store2.addPosting(mkPosting("fxreq-b3", "boards.greenhouse.io"));
    let calls2 = 0;
    const r2 = await runRequirementsSlice(store2, {
      limit: 3, timeBudgetMs: 1000, staleAfterDays: 7, now: NOW,
      extract: async (rec, nowIso) => {
        calls2++;
        await new Promise((res) => setTimeout(res, 1200));
        return { postingId: rec.postingId, requiresBachelor: false, requiresMasters: false, requires5PlusYears: false, descriptionPresent: true, descriptionLen: 1, extractedAt: nowIso, fetchError: null };
      },
    });
    check("mid-slice: processed 1 (only the first fits)", r2.processed, 1);
    check("mid-slice: skippedBudget 2", r2.skippedBudget, 2);
    check("mid-slice: extractor called once", calls2, 1);
  }

  console.log("== 5. honest failure counts: fetch errors never count as reads ==");
  {
    const store = new FakeRequirementsStore();
    store.addPosting(mkPosting("fxreq-ok", "boards.greenhouse.io"));
    store.addPosting(mkPosting("fxreq-bad", "api.ashbyhq.com"));
    const calls: string[] = [];
    const r = await runRequirementsSlice(store, {
      limit: 10, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW,
      extract: mockExtractor(calls, { fail: new Set(["fxreq-bad"]) }),
    });
    check("processed 2", r.processed, 2);
    check("descriptionsRead 1", r.descriptionsRead, 1);
    check("fetchErrors 1", r.fetchErrors, 1);
    check("flags all zero", [r.flags.requiresBachelor, r.flags.requiresMasters, r.flags.requires5PlusYears], [0, 0, 0]);
    const bad = store.requirements.get("fxreq-bad");
    check("failed row persisted with fetchError", bad?.fetchError, "mock fetch failed");
    check("failed row has descriptionPresent=false", bad?.descriptionPresent, false);
    check("coverage read=1 fetchError=1", [r.coverage.read, r.coverage.fetchError], [1, 1]);
  }

  console.log("== 6. loopback fixtures are filtered out of the sweep ==");
  {
    const store = new FakeRequirementsStore();
    store.addPosting(mkPosting("fxreq-real", "boards.greenhouse.io"));
    store.addPosting(mkPosting("fxreq-loop", "127.0.0.1:8890"));
    const calls: string[] = [];
    const r = await runRequirementsSlice(store, { limit: 10, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW, extract: mockExtractor(calls) });
    check("loopback excluded: picked 1", r.picked, 1);
    check("only the real posting fetched", calls, ["fxreq-real"]);
  }

  console.log("== 7. per-host cap is respected by the consumed slice ==");
  {
    const store = new FakeRequirementsStore();
    // 5 never-read postings on one greenhouse host + 1 on an ashby host.
    for (let i = 1; i <= 5; i++) store.addPosting(mkPosting(`fxreq-h${i}`, "boards.greenhouse.io"));
    store.addPosting(mkPosting("fxreq-ashby", "api.ashbyhq.com"));
    const calls: string[] = [];
    const r = await runRequirementsSlice(store, { limit: 10, hostCap: 2, timeBudgetMs: 10_000, staleAfterDays: 7, now: NOW, extract: mockExtractor(calls) });
    check("hostCap=2: 2 greenhouse + 1 ashby processed", r.processed, 3);
    check("no more than 2 greenhouse postings fetched", calls.filter((c) => c.startsWith("fxreq-h")).length, 2);
    check("host-interleaved: rank-1 rows first (ashby, h1), then rank-2 (h2)", calls, ["fxreq-ashby", "fxreq-h1", "fxreq-h2"]);
  }

  console.log("== 8. READ-ONLY live check: real listRequirementCandidates ordering ==");
  {
    if (!process.env.DATABASE_URL) {
      console.log("  skip — DATABASE_URL not set (in-memory sections above still ran)");
    } else {
      const store = new Store();
      const staleBefore = new Date(Date.now() - 7 * DAY).toISOString();
      const slice = await store.listRequirementCandidates(2000, 10, staleBefore);
      checkTrue("live slice returned rows", slice.length > 0);
      const ids = slice.map((r) => r.postingId);
      const rows = new Map((await store.getRequirementsForPostingIds(ids)).map((r) => [r.postingId, r]));
      // Within each host, tier order must be non-decreasing: never-read(0) < stale(1) < fresh(2).
      const tier = (rec: PostingRecord): number => {
        const row = rows.get(rec.postingId);
        if (!row) return 0;
        return row.extractedAt < staleBefore ? 1 : 2;
      };
      const byHost = new Map<string, PostingRecord[]>();
      for (const rec of slice) {
        const h = hostOf(rec.canonicalUrl);
        const list = byHost.get(h) ?? [];
        list.push(rec);
        byHost.set(h, list);
      }
      let inversions = 0;
      for (const list of byHost.values()) {
        for (let i = 1; i < list.length; i++) {
          if (tier(list[i]) < tier(list[i - 1])) inversions++;
        }
      }
      check("per-host tier order is never-read → stale → fresh (0 inversions)", inversions, 0);
      checkTrue("per-host cap respected (<= 10 per host)", [...byHost.values()].every((l) => l.length <= 10));
      checkTrue("no loopback URLs in the live slice", slice.every((r) => !r.canonicalUrl.includes("127.0.0.1") && !r.canonicalUrl.includes("localhost")));
      // Never-read postings must be the first tier when present: the first
      // returned row is never-read unless there are none in the whole store.
      const firstTier = tier(slice[0]);
      check("first row is never-read or no never-read rows remain", firstTier === 0 || slice.every((r) => tier(r) > 0), true);
    }
  }
}

(async () => {
  try {
    await run();
  } catch (err) {
    console.error("requirements-sync-test crashed:", err);
    fail++;
  }
  console.log(fail === 0 ? `\nRESULT: ALL PASS (${pass} checks)` : `\nRESULT: ${fail} FAILURE(S) of ${pass + fail} checks`);
  if (fail > 0) {
    console.log("failures:", failures.join(" | "));
    process.exit(1);
  }
})();
