/**
 * SCHEDULED DISCOVERY PASS — the "registry grows EVERY DAY" mechanism
 * (owner direction 2026-08-15, design: registry-growth-design.md §4.2).
 *
 * runDiscoverySlice() picks a bounded slice of due candidates from the Neon
 * discovery_candidates pool (pending first, then failed-with-30-day-backoff,
 * then verified-with-90-day-re-verify-backoff; per-ATS-host capped), verifies
 * each LIVE through the SAME politeness layer as the sync (boards.ts fetchBoard
 * → robots.txt + per-host throttle, no bypass), classifies with the SAME 9-way
 * honesty rules as the offline tool (engine/discover.ts classify — shared), and
 * records the result on the candidate row. ONLY `verified` rows ever join the
 * registry (via buildRegistry's verified-candidates merge) — every other
 * outcome is recorded and countable, never seeded.
 *
 * Key properties (same spirit as runRequirementsSlice):
 *   - bounded: DISCOVERY_PER_RUN (default 48) candidates, DISCOVERY_HOST_CAP
 *     (default 16) per ATS host, DISCOVERY_TIME_BUDGET_MS (default 45_000)
 *     wall-clock budget — a 60 s Vercel function always completes; with 4
 *     daily slots (01:45/07:45/13:45/19:45) this verifies ~40-70 candidates
 *     and ~2-4× that per day, pacing the pool drain at dozens of verified
 *     companies/day (registry scale-up, owner direction 2026-08-15 — see
 *     engine/registry-scale-up.md §3);
 *   - never writes postings — ingest stays with the hourly sync loop, this is
 *     verification only;
 *   - never throws per candidate — each fetch/classify/upsert failure is
 *     recorded on the row, the run reports exactly what it did;
 *   - idempotent: upserts by candidate_key, verified_at set only on the FIRST
 *     verified observation; the daily cron additionally claims
 *     discovery_day_<date> so duplicate invocations no-op.
 */

import { fetchBoard } from "./boards";
import type { BoardFetchResult, BoardKind } from "./boards";
import { classify } from "./discover";
import type { DiscoveryReason } from "./discover";
import { isTestArtifactBoardId, isTestArtifactName } from "./companies";
import { Store, isoNow } from "./store";
import type { DiscoveryCandidateRow } from "./store";

export interface DiscoverySliceOptions {
  /** Max candidates to verify this run (env DISCOVERY_PER_RUN; default 8). */
  limit?: number;
  /** Max candidates per ATS host per run (env DISCOVERY_HOST_CAP; default 3). */
  hostCap?: number;
  /** Wall-clock budget in ms (env DISCOVERY_TIME_BUDGET_MS; default 30_000). */
  timeBudgetMs?: number;
  /** Injectable for deterministic tests. */
  now?: Date;
  /** Injectable board fetcher (tests substitute a mock; default = boards.ts). */
  fetchBoard?: (board: BoardKind, boardId: string) => Promise<BoardFetchResult>;
}

export interface DiscoverySliceResult {
  at: string;
  /** Candidates picked from the pool (due rows, loopback/denylist filtered). */
  picked: number;
  /** Candidates actually fetched + recorded this run. */
  processed: number;
  /** Picked but skipped because the wall-clock budget expired. */
  skippedBudget: number;
  /** Per-reason counts (the honest per-run failure report). */
  byReason: Record<DiscoveryReason, number>;
  /** Candidate keys whose FIRST verified observation happened this run. */
  newlyVerified: string[];
  /** Total rows in the pool after the run (registry-growth KPI input). */
  poolSize: number;
  elapsedMs: number;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** Env-overridable defaults, shared by the CLI and the daily cron. */
export function discoveryDefaults(): { limit: number; hostCap: number; timeBudgetMs: number } {
  return {
    limit: envInt("DISCOVERY_PER_RUN", 48),
    hostCap: envInt("DISCOVERY_HOST_CAP", 16),
    timeBudgetMs: envInt("DISCOVERY_TIME_BUDGET_MS", 45_000),
  };
}

/** Today's UTC calendar date — the verified_at value (UTC date of first verified observation). */
function utcDateStr(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const REASON_ORDER: DiscoveryReason[] = [
  "verified", "empty", "http-404", "http-429", "http-5xx", "http-other",
  "robots-blocked", "parse-error", "fetch-error",
];

export function discoverySummaryLine(byReason: Record<DiscoveryReason, number>): string {
  return REASON_ORDER.filter((r) => byReason[r] > 0).map((r) => `${r}=${byReason[r]}`).join(", ") || "(no results)";
}

/**
 * Run one scheduled discovery slice. Sequential processing (candidates are
 * already host-capped and host-interleaved by the store query, so the
 * module-level per-host throttle in robots.ts stays correct: no two requests
 * to the same ATS host overlap). Honest result object; never throws for
 * per-candidate failures (they land on the candidate row's status/note).
 */
export async function runDiscoverySlice(
  store: Store,
  opts: DiscoverySliceOptions = {}
): Promise<DiscoverySliceResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = opts.limit ?? discoveryDefaults().limit;
  const hostCap = opts.hostCap ?? discoveryDefaults().hostCap;
  const timeBudgetMs = opts.timeBudgetMs ?? discoveryDefaults().timeBudgetMs;
  const fetch = opts.fetchBoard ?? fetchBoard;

  // Due candidates (store-side priority order). Loopback/denylisted rows are
  // filtered here — test fixtures must never be probed or recorded as results.
  const candidates = (await store.listDiscoveryCandidates(limit, hostCap)).filter(
    (c) => !isTestArtifactName(c.name) && !isTestArtifactBoardId(c.boardId)
  );

  // Verified BEFORE this run — "newly verified" = first verified observation.
  const prevVerified = new Set((await store.listVerifiedDiscoveryCandidates()).map((c) => c.candidateKey));

  const byReason: Record<DiscoveryReason, number> = {};
  const newlyVerified: string[] = [];
  let processed = 0;
  let skippedBudget = 0;

  for (const c of candidates) {
    if (Date.now() - started > timeBudgetMs) {
      skippedBudget++;
      continue;
    }
    const fetched = await fetch(c.board, c.boardId);
    const parseOk = !(fetched.note?.startsWith("could not parse"));
    const reason = classify(fetched.statusCode, fetched.note, fetched.ok, fetched.jobs.length, parseOk);
    const row: DiscoveryCandidateRow = {
      candidateKey: c.candidateKey,
      name: c.name,
      board: c.board,
      boardId: c.boardId,
      careerUrl: c.careerUrl,
      source: c.source,
      status: reason,
      jobs: fetched.jobs.length,
      statusCode: fetched.statusCode,
      note: fetched.note,
      lastCheckedAt: nowIso,
      verifiedAt: reason === "verified" ? utcDateStr(now) : null,
      createdAt: c.createdAt,
    };
    await store.upsertDiscoveryCandidate(row);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    processed++;
    if (reason === "verified" && !prevVerified.has(c.candidateKey)) {
      newlyVerified.push(c.candidateKey);
    }
  }

  const summary = await store.discoveryPoolSummary();
  const poolSize = Object.values(summary).reduce((a, b) => a + b, 0);

  return {
    at: nowIso,
    picked: candidates.length,
    processed,
    skippedBudget,
    byReason,
    newlyVerified,
    poolSize,
    elapsedMs: Date.now() - started,
  };
}
