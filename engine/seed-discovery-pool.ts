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
 *   3. SCALE_CANDIDATES + DIRECTORY_CANDIDATES (REGISTRY SCALE-UP wave,
 *      owner direction 2026-08-15 — candidates-scale.ts: ~370 more real
 *      companies from public knowledge + the vendors' own customer pages)
 *      → rows with status='pending', source='curated'/'directory'.
 *   4. /home/team/shared/ats-candidates.md when present (the team's shared
 *      markdown-table candidate lists) → rows with status='pending',
 *      source='shared-file'.
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
import { FALLBACK_CANDIDATES, candidateKey, type DiscoveryCandidate } from "./candidates";
import { DIRECTORY_CANDIDATES, SCALE_CANDIDATES } from "./candidates-scale";
import { SEED_COMPANIES } from "./companies";
import { existsSync, readFileSync } from "node:fs";

/** /home/team/shared/ats-candidates.md — the team's shared candidate lists. */
const SHARED_CANDIDATES_FILE = "/home/team/shared/ats-candidates.md";

/**
 * Parse the shared ats-candidates.md file (markdown tables AND the simple
 * `Name|board|id` format). Markdown table rows look like
 * `| Airbnb | greenhouse | airbnb | high | — |` — the first three columns are
 * (name, board, boardId); extra columns (confidence, notes) are ignored.
 * Non-table lines that still split on `|`/`,` with ≥3 parts are also accepted.
 * Returns [] when the file is absent.
 */
export function loadSharedCandidateFile(path = SHARED_CANDIDATES_FILE): DiscoveryCandidate[] {
  if (!existsSync(path)) return [];
  const out: DiscoveryCandidate[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((p) => p.trim());
    // Markdown table rows start AND end with a pipe: ["", name, board, id, ...].
    if (parts.length >= 4 && parts[0] === "" && parts[parts.length - 1] === "") {
      const [, name, board, boardId, ...rest] = parts;
      if (!name || !boardId) continue;
      const b = board.toLowerCase();
      if (b !== "greenhouse" && b !== "ashby" && b !== "lever") continue;
      if (name === "Company" || board === "Board" || boardId === "boardId guess") continue; // header row
      // Extra columns are confidence/notes — only a real URL becomes careerUrl.
      const maybeUrl = rest.find((p) => p?.startsWith("http"));
      out.push({ name, board: b, boardId, careerUrl: maybeUrl || undefined });
      continue;
    }
    // Pipe/CSV fallback: Name|board|id (the format the offline tool accepts).
    const csv = line.split(/[|,]/).map((p) => p.trim());
    if (csv.length < 3) continue;
    const [name, board, boardId] = csv;
    const b = board.toLowerCase();
    if (b !== "greenhouse" && b !== "ashby" && b !== "lever") continue;
    if (!name || !boardId) continue;
    out.push({ name, board: b, boardId, careerUrl: csv[3]?.startsWith("http") ? csv[3] : undefined });
  }
  return out;
}

export interface SeedPoolResult {
  /** Rows inserted by this run (0 on a re-run — idempotent). */
  inserted: number;
  /** Verified rows attempted (the 88 SEED_COMPANIES board refs). */
  verifiedRows: number;
  /** Curated rows attempted (the 231 FALLBACK_CANDIDATES). */
  curatedRows: number;
  /** Scale-wave rows attempted (SCALE_CANDIDATES + DIRECTORY_CANDIDATES). */
  scaleRows: number;
  /** Shared-file rows attempted (ats-candidates.md). */
  sharedRows: number;
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

  // REGISTRY SCALE-UP wave (owner direction 2026-08-15): curated + vendor-
  // directory candidates — pending, never checked.
  const scaleWave: DiscoveryCandidate[] = [...SCALE_CANDIDATES, ...DIRECTORY_CANDIDATES];
  for (const c of scaleWave) {
    rows.push({
      candidateKey: candidateKey(c),
      name: c.name,
      board: c.board,
      boardId: c.boardId,
      careerUrl: c.careerUrl ?? null,
      source: DIRECTORY_CANDIDATES.includes(c) ? "directory" : "curated",
      status: "pending",
      jobs: null,
      statusCode: null,
      note: null,
      lastCheckedAt: null,
      verifiedAt: null,
      createdAt: nowIso,
    });
  }
  const scaleRows = scaleWave.length;

  // Shared team file (ats-candidates.md) — pending, never checked.
  const sharedCandidates = loadSharedCandidateFile();
  for (const c of sharedCandidates) {
    rows.push({
      candidateKey: candidateKey(c),
      name: c.name,
      board: c.board,
      boardId: c.boardId,
      careerUrl: c.careerUrl ?? null,
      source: "shared-file",
      status: "pending",
      jobs: null,
      statusCode: null,
      note: null,
      lastCheckedAt: null,
      verifiedAt: null,
      createdAt: nowIso,
    });
  }
  const sharedRows = sharedCandidates.length;

  let inserted = 0;
  for (const r of rows) {
    if (await store.upsertDiscoveryCandidate(r, true)) inserted++;
  }

  const statusCounts = await store.discoveryPoolSummary();
  const poolSize = Object.values(statusCounts).reduce((a, b) => a + b, 0);

  return { inserted, verifiedRows, curatedRows, scaleRows, sharedRows, poolSize, statusCounts };
}
