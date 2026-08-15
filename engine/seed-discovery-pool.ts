/**
 * DISCOVERY POOL SEEDER (design §4.2) — boots the Neon discovery_candidates
 * pool from the repo's verified seed data, idempotently:
 *
 *   1. SEED_COMPANIES boards (88 companies: 5 legacy seeds + 83 verified by
 *      `bun run discover`) → rows with status='verified', verified_at from the
 *      company's verifiedAt, last_checked_at back-dated to that date so the
 *      90-day re-verify backoff runs from the real verification date.
 *   2. FALLBACK_CANDIDATES (231 curated guesses) → rows with status='pending'
 *      (never verified — the daily 01:45 UTC pass verifies them live).
 *
 * INSERT ... ON CONFLICT DO NOTHING: re-running never clobbers rows the pool
 * has already learned (a 'user-check' row, a verified row, an honest failure
 * with its backoff clock). Verified seeds are inserted FIRST so a company that
 * appears in both lists keeps its verified status.
 *
 * Run once during implementation against the live store:
 *   bun run seed-candidates
 */

import { Store } from "./store";
import type { DiscoveryCandidateRow } from "./store";
import { FALLBACK_CANDIDATES, candidateKey } from "./candidates";
import { SEED_COMPANIES } from "./companies";

export interface SeedPoolResult {
  /** Rows inserted by this run (0 on a re-run — idempotent). */
  inserted: number;
  /** Verified rows attempted (the 88 SEED_COMPANIES board refs). */
  verifiedRows: number;
  /** Curated rows attempted (the 231 FALLBACK_CANDIDATES). */
  curatedRows: number;
  /** Pool total after the run. */
  poolSize: number;
  /** Status counts after the run. */
  statusCounts: Record<string, number>;
}

export async function seedDiscoveryPool(store: Store, now: Date = new Date()): Promise<SeedPoolResult> {
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);

  const rows: DiscoveryCandidateRow[] = [];

  // Verified seeds FIRST (win on conflict): one row per board ref.
  for (const c of SEED_COMPANIES) {
    for (const b of c.boards) {
      const verifiedAt = c.verifiedAt ?? today;
      rows.push({
        candidateKey: candidateKey({ name: c.name, board: b.board, boardId: b.boardId }),
        name: c.name,
        board: b.board,
        boardId: b.boardId,
        careerUrl: c.careerUrl ?? null,
        source: "migration",
        status: "verified",
        jobs: null,
        statusCode: null,
        note: "seeded from the verified registry (bun run discover output)",
        lastCheckedAt: `${verifiedAt}T00:00:00Z`,
        verifiedAt,
        createdAt: nowIso,
      });
    }
  }
  const verifiedRows = rows.length;

  // Curated guesses: pending, never checked.
  for (const c of FALLBACK_CANDIDATES) {
    rows.push({
      candidateKey: candidateKey(c),
      name: c.name,
      board: c.board,
      boardId: c.boardId,
      careerUrl: c.careerUrl ?? null,
      source: "curated",
      status: "pending",
      jobs: null,
      statusCode: null,
      note: null,
      lastCheckedAt: null,
      verifiedAt: null,
      createdAt: nowIso,
    });
  }
  const curatedRows = rows.length - verifiedRows;

  let inserted = 0;
  for (const r of rows) {
    if (await store.upsertDiscoveryCandidate(r, true)) inserted++;
  }

  const statusCounts = await store.discoveryPoolSummary();
  const poolSize = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  return { inserted, verifiedRows, curatedRows, poolSize, statusCounts };
}
