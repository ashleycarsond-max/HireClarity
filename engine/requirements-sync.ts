/**
 * FULL-DESCRIPTION-COVERAGE ROLLING SWEEP (owner direction 2026-08-15) —
 * keeps posting_requirements current for a bounded slice of LIVE postings per
 * run, on a rolling cycle that reaches 100% of live postings and then keeps
 * every covered description fresh.
 *
 * Selection: `store.listRequirementCandidates` returns a per-host-CAPPED,
 * host-interleaved slice in three explicit priority tiers:
 *   1. live postings with NO description read yet (the ~7,600-posting gap);
 *   2. live postings whose description is STALE (extracted_at older than
 *      DESCRIPTION_STALE_AFTER_DAYS, default 7) — the fresh-kept promise;
 *   3. already-covered postings, oldest extraction first (the rolling
 *      rotation that only engages once tiers 1-2 are exhausted within the
 *      run's budget).
 * At most REQUIREMENTS_HOST_CAP (default 10) postings per URL host — one
 * giant board host can't monopolize a run's time budget while politeness per
 * host (2s throttle + robots check, never bypassed) stays bounded: a host's
 * requests are serialized, 10 × ~2-3s caps one host at ~30s.
 *
 * Hosts are processed CONCURRENTLY (bounded) while postings within a host run
 * strictly sequentially — the module-level per-host throttle in robots.ts
 * stays correct because no two requests to the same host overlap.
 *
 * A hard wall-clock budget (REQUIREMENTS_TIME_BUDGET_MS, default 25s for the
 * hourly cron) stops the loop mid-slice so the hourly sync / daily compile
 * (Vercel 60s function limit) always has headroom. The run reports exactly
 * what it did, what it skipped, how the picked batch split across the three
 * tiers, and the honest live-store coverage counts (read / fetch-error /
 * not-yet-extracted) that feed the daily snapshot's
 * postingsWithDescriptionRead metric.
 *
 * Idempotent: the store query itself re-picks never-extracted postings
 * FIRST, so a re-run (cron double-fire, retry) never re-fetches a posting
 * this run already wrote a fresh row for — double-fires pick the next
 * not-yet-covered batch instead.
 */

import { extractRequirementsForPosting } from "./requirements";
import { hostOf } from "./robots";
import { Store, isoNow } from "./store";
import type { PostingRecord, PostingRequirement } from "./types";

/**
 * The minimal store surface the slice needs — the concrete Store satisfies
 * this structurally, and tests substitute an in-memory fake (no live-DB
 * fixtures; see requirements-sync-test.ts).
 */
export interface RequirementsStore {
  listRequirementCandidates(limit: number, hostCap: number, staleBefore?: string | null): Promise<PostingRecord[]>;
  getRequirementsForPostingIds(ids: string[]): Promise<PostingRequirement[]>;
  flushRequirementWrites(rows: PostingRequirement[]): Promise<void>;
  requirementCoverage(): Promise<{ live: number; read: number; fetchError: number; notExtracted: number }>;
}

/** Per-posting extraction — injectable so tests mock the network entirely. */
export type RequirementExtractor = (rec: PostingRecord, nowIso: string) => Promise<PostingRequirement>;

export interface RequirementsSyncOptions {
  /** Max postings to extract this run (env REQUIREMENTS_PER_RUN; default 150). */
  limit?: number;
  /** Max postings per host per run (env REQUIREMENTS_HOST_CAP; default 10). */
  hostCap?: number;
  /** Concurrent hosts processed at once (default 8). */
  concurrency?: number;
  /** Wall-clock budget in ms (env REQUIREMENTS_TIME_BUDGET_MS). Stops the loop when exceeded. */
  timeBudgetMs?: number;
  /** Re-read covered descriptions older than this many days (env
   *  DESCRIPTION_STALE_AFTER_DAYS; default 7 — the fresh-kept promise). */
  staleAfterDays?: number;
  /** Injectable for deterministic tests. */
  now?: Date;
  /** Injectable extractor (tests substitute a mock; default = real polite fetch). */
  extract?: RequirementExtractor;
}

export interface RequirementsSyncResult {
  at: string;
  requested: number;
  picked: number;
  processed: number;
  skippedBudget: number;
  descriptionsRead: number;
  fetchErrors: number;
  flags: { requiresBachelor: number; requiresMasters: number; requires5PlusYears: number };
  /** Picked batch classified against the staleness cutoff: no row yet. */
  pickedNeverRead: number;
  /** Picked batch classified against the staleness cutoff: read, now stale. */
  pickedStale: number;
  /** Picked batch classified against the staleness cutoff: read, still fresh. */
  pickedFresh: number;
  /** The staleness cutoff applied (ISO), or null when staleness is disabled. */
  staleBefore: string | null;
  /** Honest live-store description coverage at run end (daily-snapshot source). */
  coverage: { live: number; read: number; fetchError: number; notExtracted: number };
  elapsedMs: number;
  note: string | null;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Env-overridable defaults, shared by the CLI, the hourly sync and the daily cron. */
export function requirementsDefaults(): {
  limit: number;
  hostCap: number;
  concurrency: number;
  timeBudgetMs: number;
  staleAfterDays: number;
} {
  return {
    limit: envInt("REQUIREMENTS_PER_RUN", 150),
    hostCap: envInt("REQUIREMENTS_HOST_CAP", 10),
    concurrency: envInt("REQUIREMENTS_CONCURRENCY", 8),
    timeBudgetMs: envInt("REQUIREMENTS_TIME_BUDGET_MS", 25_000),
    staleAfterDays: envInt("DESCRIPTION_STALE_AFTER_DAYS", 7),
  };
}

/**
 * Run one refresh slice. The store already caps per host, interleaves hosts
 * and orders by the three-tier priority (never-read → stale → fresh); this
 * layer filters loopback fixtures, groups by host, processes hosts
 * concurrently (sequential within a host), classifies the picked batch
 * against the staleness cutoff, and writes extracted rows batched. Honest
 * result object; never throws for per-posting failures (they land in
 * fetch_error on the row).
 */
export async function runRequirementsSlice(
  store: RequirementsStore,
  opts: RequirementsSyncOptions = {}
): Promise<RequirementsSyncResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = opts.limit ?? requirementsDefaults().limit;
  const hostCap = opts.hostCap ?? requirementsDefaults().hostCap;
  const concurrency = opts.concurrency ?? requirementsDefaults().concurrency;
  const timeBudgetMs = opts.timeBudgetMs ?? requirementsDefaults().timeBudgetMs;
  const staleAfterDays = opts.staleAfterDays ?? requirementsDefaults().staleAfterDays;
  const extract = opts.extract ?? extractRequirementsForPosting;
  const staleBefore = new Date(now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000).toISOString();

  const candidates = (await store.listRequirementCandidates(limit, hostCap, staleBefore)).filter(
    (r) => !isLoopbackUrl(r.canonicalUrl)
  );

  // Classify the picked batch against the cutoff (one ANY() read, not N+1):
  // never-read (no row), stale (row older than cutoff), fresh (row newer).
  const existing = new Map(
    (await store.getRequirementsForPostingIds(candidates.map((c) => c.postingId))).map((r) => [r.postingId, r])
  );
  let pickedNeverRead = 0;
  let pickedStale = 0;
  let pickedFresh = 0;
  for (const rec of candidates) {
    const row = existing.get(rec.postingId);
    if (!row) pickedNeverRead++;
    else if (row.extractedAt < staleBefore) pickedStale++;
    else pickedFresh++;
  }

  // Group by host (preserving the store's priority order within each host).
  const byHost = new Map<string, PostingRecord[]>();
  for (const rec of candidates) {
    const host = hostOf(rec.canonicalUrl);
    const list = byHost.get(host) ?? [];
    list.push(rec);
    byHost.set(host, list);
  }

  const results: PostingRequirement[] = [];
  const hosts = [...byHost.keys()];
  let skippedBudget = 0;

  const processHost = async (host: string): Promise<void> => {
    for (const rec of byHost.get(host) ?? []) {
      if (Date.now() - started > timeBudgetMs) {
        skippedBudget++;
        continue;
      }
      const row = await extract(rec, nowIso);
      results.push(row);
    }
  };

  // Bounded concurrency across hosts (sequential within a host). A host not
  // started before the budget expires is skipped whole — that bounds the run's
  // tail to a single in-flight host.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= hosts.length) break;
        const host = hosts[i];
        if (Date.now() - started > timeBudgetMs) {
          skippedBudget += (byHost.get(host) ?? []).length;
          continue;
        }
        await processHost(host);
      }
    })
  );

  await store.flushRequirementWrites(results);

  const flags = { requiresBachelor: 0, requiresMasters: 0, requires5PlusYears: 0 };
  let descriptionsRead = 0;
  let fetchErrors = 0;
  for (const r of results) {
    if (r.descriptionPresent) {
      descriptionsRead++;
      if (r.requiresBachelor) flags.requiresBachelor++;
      if (r.requiresMasters) flags.requiresMasters++;
      if (r.requires5PlusYears) flags.requires5PlusYears++;
    } else if (r.fetchError) {
      fetchErrors++;
    }
  }

  return {
    at: nowIso,
    requested: candidates.length,
    picked: candidates.length,
    processed: results.length,
    skippedBudget,
    descriptionsRead,
    fetchErrors,
    flags,
    pickedNeverRead,
    pickedStale,
    pickedFresh,
    staleBefore,
    coverage: await store.requirementCoverage(),
    elapsedMs: Date.now() - started,
    note: results.length < candidates.length ? "some picked postings were not processed (time budget)" : null,
  };
}
