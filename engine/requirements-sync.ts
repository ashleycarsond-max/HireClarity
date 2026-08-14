/**
 * ROLLING REQUIREMENTS REFRESH — keeps posting_requirements current for a
 * bounded slice of LIVE postings per run.
 *
 * Selection: `store.listRequirementCandidates` returns a per-host-CAPPED,
 * host-interleaved slice (never-extracted postings first, then oldest
 * extraction first; at most REQUIREMENTS_HOST_CAP per URL host, default 10) —
 * so one giant board host can't monopolize a run's time budget while
 * politeness per host (2s throttle + robots check, never bypassed) stays
 * bounded: a host's requests are serialized, 10 × ~2-3s caps one host at ~30s.
 *
 * Hosts are processed CONCURRENTLY (bounded) while postings within a host run
 * strictly sequentially — the module-level per-host throttle in robots.ts
 * stays correct because no two requests to the same host overlap.
 *
 * A hard wall-clock budget (REQUIREMENTS_TIME_BUDGET_MS, default 45_000) stops
 * the loop mid-slice so the daily cron (Vercel 60s function limit) always has
 * headroom for the daily-stats compile that follows. The run reports exactly
 * what it did and what it skipped.
 */

import { extractRequirementsForPosting } from "./requirements";
import { hostOf } from "./robots";
import { Store, isoNow } from "./store";
import type { PostingRecord, PostingRequirement } from "./types";

export interface RequirementsSyncOptions {
  /** Max postings to extract this run (env REQUIREMENTS_PER_RUN; default 250). */
  limit?: number;
  /** Max postings per host per run (env REQUIREMENTS_HOST_CAP; default 10). */
  hostCap?: number;
  /** Concurrent hosts processed at once (default 8). */
  concurrency?: number;
  /** Wall-clock budget in ms (default 45_000). Stops the loop when exceeded. */
  timeBudgetMs?: number;
  /** Injectable for deterministic tests. */
  now?: Date;
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

/** Env-overridable defaults, shared by the CLI and the daily cron. */
export function requirementsDefaults(): {
  limit: number;
  hostCap: number;
  concurrency: number;
  timeBudgetMs: number;
} {
  return {
    limit: envInt("REQUIREMENTS_PER_RUN", 250),
    hostCap: envInt("REQUIREMENTS_HOST_CAP", 10),
    concurrency: envInt("REQUIREMENTS_CONCURRENCY", 8),
    timeBudgetMs: envInt("REQUIREMENTS_TIME_BUDGET_MS", 45_000),
  };
}

/**
 * Run one refresh slice. The store already caps per host and interleaves hosts;
 * this layer filters loopback fixtures, groups by host, processes hosts
 * concurrently (sequential within a host), and writes extracted rows batched.
 * Honest result object; never throws for per-posting failures (they land in
 * fetch_error on the row).
 */
export async function runRequirementsSlice(
  store: Store,
  opts: RequirementsSyncOptions = {}
): Promise<RequirementsSyncResult> {
  const started = Date.now();
  const nowIso = opts.now ? opts.now.toISOString() : isoNow();
  const limit = opts.limit ?? requirementsDefaults().limit;
  const hostCap = opts.hostCap ?? requirementsDefaults().hostCap;
  const concurrency = opts.concurrency ?? requirementsDefaults().concurrency;
  const timeBudgetMs = opts.timeBudgetMs ?? requirementsDefaults().timeBudgetMs;

  const candidates = (await store.listRequirementCandidates(limit, hostCap)).filter(
    (r) => !isLoopbackUrl(r.canonicalUrl)
  );

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
      const row = await extractRequirementsForPosting(rec, nowIso);
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
    elapsedMs: Date.now() - started,
    note: results.length < candidates.length ? "some picked postings were not processed (time budget)" : null,
  };
}
