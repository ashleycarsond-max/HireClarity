/**
 * REGISTRY SCALE-UP test suite (owner direction 2026-08-15).
 *
 * Fake-store based throughout — ZERO live-DB writes, ZERO network (no
 * TestCo-style phantom fixtures can ever land in the live store):
 *
 *   1. runSyncChunk FULL-SCRUB semantics — the time budget stops the loop
 *      mid-batch (skippedBudget counted, cursor persisted, next invocation
 *      continues), at least one company always processes, the batch clamp
 *      holds, and the registry never wraps mid-run.
 *   2. seedDiscoveryPool scale wave — SCALE_CANDIDATES / DIRECTORY_CANDIDATES
 *      / shared ats-candidates.md (markdown tables) all become pending rows,
 *      deduped by candidate_key (ON CONFLICT DO NOTHING), verified seeds win
 *      on conflict, and sources are recorded honestly.
 *
 * Run: bun run registry-scale-test
 */

import { Store } from "./store";
import type { DiscoveryCandidateRow } from "./store";
import { runSyncChunk } from "./sync";
import { seedDiscoveryPool, loadSharedCandidateFile } from "./seed-discovery-pool";
import { SCALE_CANDIDATES, DIRECTORY_CANDIDATES, SCALE_WAVE_TOTALS } from "./candidates-scale";
import type { BoardFetchResult, BoardKind } from "./boards";
import type { PostingRecord, PostingEvent, PayInfo } from "./types";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/* ----------------------- fake store for runSyncChunk ----------------------- */

/**
 * Minimal in-memory Store surface for runSyncChunk: a registry built from
 * verified discovery candidates, a meta map for the cursor, and empty
 * posting tables (the mock board fetcher returns jobs that ingestBoardJobs
 * can upsert into a no-op flush).
 */
class FakeSyncStore {
  verified: DiscoveryCandidateRow[] = [];
  meta = new Map<string, string>();
  postings: PostingRecord[] = [];

  async listVerifiedDiscoveryCandidates(): Promise<DiscoveryCandidateRow[]> {
    return this.verified;
  }
  async getAll(): Promise<PostingRecord[]> {
    return this.postings;
  }
  async count(): Promise<number> {
    return this.postings.length;
  }
  async getMetaInt(key: string, def: number): Promise<number> {
    const v = this.meta.get(key);
    return v === undefined ? def : Number(v);
  }
  async setMetaInt(key: string, value: number): Promise<void> {
    this.meta.set(key, String(value));
  }
  async getByPostingIds(): Promise<PostingRecord[]> {
    return [];
  }
  async getByIdentityKeys(): Promise<PostingRecord[]> {
    return [];
  }
  async getByBoardAndCompany(): Promise<PostingRecord[]> {
    return [];
  }
  async flushSyncWrites(
    upserts: PostingRecord[],
    _checks: unknown[],
    _events: PostingEvent[],
    _pay: PayInfo[]
  ): Promise<void> {
    this.postings.push(...upserts);
  }
}

function mkVerifiedCandidate(name: string, board: BoardKind, boardId: string): DiscoveryCandidateRow {
  return {
    candidateKey: `${board}:${boardId.toLowerCase()}`,
    name,
    board,
    boardId,
    careerUrl: null,
    source: "curated",
    status: "verified",
    jobs: 1,
    statusCode: 200,
    note: "fixture",
    lastCheckedAt: "2026-08-01T00:00:00.000Z",
    verifiedAt: "2026-08-01",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function okBoard(board: BoardKind, boardId: string, jobs: number, sleepMs = 0): BoardFetchResult {
  return {
    ok: true,
    board,
    boardId,
    jobs: Array.from({ length: jobs }, (_, i) => ({
      board,
      externalId: `${boardId}-${i}`,
      title: `Fixture ${boardId} ${i}`,
      location: "Remote",
      postedAt: "2026-08-01T00:00:00.000Z",
      url: `https://boards.greenhouse.io/${boardId}/jobs/${i}`,
      postingId: `fx-${boardId}-${i}`,
      raw: { fixture: true },
    })),
    statusCode: 200,
    note: sleepMs > 0 ? `mock (${sleepMs}ms)` : "HTTP 200",
  };
}

async function slowBoard(sleepMs: number): Promise<BoardFetchResult> {
  await new Promise((r) => setTimeout(r, sleepMs));
  return okBoard("greenhouse", "slowco", 1);
}

/* -------------------- fake store for seedDiscoveryPool --------------------- */

class FakePoolStore {
  rows = new Map<string, DiscoveryCandidateRow>();
  async upsertDiscoveryCandidate(row: DiscoveryCandidateRow, insertOnly = false): Promise<boolean> {
    const key = row.candidateKey;
    if (this.rows.has(key)) return false;
    this.rows.set(key, row);
    return true;
  }
  async discoveryPoolSummary(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.rows.values()) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }
}

/* ---------------------------------- run() ----------------------------------- */

async function run(): Promise<void> {
  console.log("== 1. sync chunk: time budget stops the loop mid-batch, cursor persists ==");
  {
    const store = new FakeSyncStore();
    // buildRegistry merges the static SEED_COMPANIES list, so the registry is
    // the real ~89 companies — the budget test is registry-size-agnostic.
    const calls: string[] = [];
    const mockFetch = async (board: BoardKind, boardId: string): Promise<BoardFetchResult> => {
      calls.push(`${board}/${boardId}`);
      await new Promise((r) => setTimeout(r, 120));
      return okBoard(board, boardId, 2);
    };
    const r1 = await runSyncChunk(store as unknown as Store, {
      companies: 1000,
      timeBudgetMs: 250,
      fetchBoard: mockFetch,
    });
    checkTrue("processed at least one company", r1.processed.length >= 1);
    checkTrue("did not process the whole registry (budget cut)", r1.processed.length < r1.registrySize);
    checkTrue("skippedBudget counts the unprocessed remainder", r1.skippedBudget === 1000 - r1.processed.length);
    check("cursor persisted at the last processed index", store.meta.get("sync_cursor"), String(r1.cursor));
    checkTrue("no company processed twice", new Set(calls).size === calls.length);
    checkTrue("registrySize reported (>= 80)", r1.registrySize >= 80);
    checkTrue("elapsedMs reported", r1.elapsedMs > 0);
    check("remaining this cycle is honest", r1.remaining, r1.registrySize - 1 - r1.cursor);

    // Next invocation continues where the cursor stopped (no re-processing).
    const callsBefore2 = calls.length;
    const r2 = await runSyncChunk(store as unknown as Store, {
      companies: 1000,
      timeBudgetMs: 120_000,
      fetchBoard: mockFetch,
    });
    check("second run completes the cycle (no dupes)", r2.processedNames.length, r1.registrySize - r1.processed.length);
    const r1Keys = new Set(r1.processedNames.map((n) => n.toLowerCase()));
    const r2Calls = calls.slice(callsBefore2);
    checkTrue(
      "run 2 never re-fetches a run-1 company",
      r2Calls.every((c) => !r1Keys.has(c.split("/")[1]))
    );
  }

  console.log("== 2. sync chunk: always processes at least one company even on an expired budget ==");
  {
    const store = new FakeSyncStore();
    const r = await runSyncChunk(store as unknown as Store, {
      companies: 1000,
      timeBudgetMs: -1, // hard cutoff (deterministic — an instant mock can elapse 0ms)
      fetchBoard: async (board, boardId) => okBoard(board, boardId, 1),
    });
    check("first company still processed", r.processed.length, 1);
    check("the rest counted as skipped", r.skippedBudget, 999);
    check("cursor advanced to the first company", r.cursor, 0);
    checkTrue("registry untouched size", r.registrySize >= 80);
  }

  console.log("== 3. sync chunk: no mid-run wrap + batch clamp ==");
  {
    const store = new FakeSyncStore();
    const r = await runSyncChunk(store as unknown as Store, {
      companies: 1000,
      timeBudgetMs: 300_000,
      fetchBoard: async (board, boardId) => okBoard(board, boardId, 1),
    });
    check("batch clamped to registry size (no wrap)", r.processed.length, r.registrySize);
    check("cursor at the last company", r.cursor, r.registrySize - 1);
    check("remaining 0 (cycle complete)", r.remaining, 0);
  }

  console.log("== 4. scale wave totals are sane (curated + directory) ==");
  {
    checkTrue("scale wave has hundreds of curated candidates", SCALE_CANDIDATES.length >= 200);
    checkTrue("directory wave present", DIRECTORY_CANDIDATES.length >= 20);
    checkTrue("greenhouse wave present", (SCALE_WAVE_TOTALS.byBoard.greenhouse ?? 0) >= 100);
    const keys = new Set(SCALE_CANDIDATES.map((c) => `${c.board}:${c.boardId.toLowerCase()}`));
    checkTrue("no duplicate candidate keys inside the curated wave", keys.size === SCALE_CANDIDATES.length);
  }

  console.log("== 5. seeder: shared-file markdown tables parse + scale wave seeds with dedupe ==");
  {
    const dir = mkdtempSync(join(tmpdir(), "hcd-scale-"));
    const sharedPath = join(dir, "ats-candidates.md");
    writeFileSync(
      sharedPath,
      [
        "# test candidates",
        "| Company | Board | boardId guess | Confidence | Notes |",
        "|---|---|---|---|---|",
        "| WaveCo A | greenhouse | wavecoa | high | — |",
        "| WaveCo B | lever | wavecob | medium | — |",
        "| WaveCo C | ashby | wavecoc | low | — |",
        "SomeCo|greenhouse|someco",
        "|---| garbage",
      ].join("\n")
    );
    const parsed = loadSharedCandidateFile(sharedPath);
    check("markdown rows + csv row parse (4)", parsed.length, 4);
    checkTrue("header/separator/garbage lines ignored", parsed.every((c) => c.name.startsWith("WaveCo") || c.name === "SomeCo"));
    check("boardIds mapped (markdown + csv rows)", parsed.map((c) => c.boardId).sort(), ["someco", "wavecoa", "wavecob", "wavecoc"].sort());

    const store = new FakePoolStore();
    // Pre-seed a verified row that the scale wave also contains (e.g. Notion
    // is in DIRECTORY_CANDIDATES and would collide with a verified pool row).
    store.rows.set("ashby:notion", {
      ...mkVerifiedCandidate("Notion", "ashby", "notion"),
      source: "migration",
    });
    const r = await seedDiscoveryPool(store as unknown as Store, new Date("2026-08-17T00:00:00.000Z"));
    checkTrue("verified seed rows attempted", r.verifiedRows > 0);
    checkTrue("scale rows attempted", r.scaleRows === SCALE_CANDIDATES.length + DIRECTORY_CANDIDATES.length);
    checkTrue("shared rows attempted", r.sharedRows > 0);
    const notionRow = store.rows.get("ashby:notion");
    check("existing verified row wins on conflict (source unchanged)", notionRow?.source, "migration");
    check("existing verified row status preserved", notionRow?.status, "verified");
    const waveRow = store.rows.get("greenhouse:2u");
    check("scale candidate seeded as pending", waveRow?.status, "pending");
    check("scale candidate source recorded", waveRow?.source, "curated");
    const dirRow = store.rows.get("ashby:cursor");
    check("directory candidate source recorded", dirRow?.source, "directory");
    const total = Object.values(r.statusCounts).reduce((a, b) => a + b, 0);
    checkTrue("pool populated at scale (>= 500 rows after dedupe)", total >= 500);
    checkTrue("pending rows dominate (the verification queue)", (r.statusCounts.pending ?? 0) >= 300);
  }
}

(async () => {
  try {
    await run();
  } catch (err) {
    console.error("registry-scale-test crashed:", err);
    fail++;
  }
  console.log(fail === 0 ? `\nRESULT: ALL PASS (${pass} checks)` : `\nRESULT: ${fail} FAILURE(S) of ${pass + fail} checks`);
  if (fail > 0) {
    console.log("failures:", failures.join(" | "));
    process.exit(1);
  }
})();
