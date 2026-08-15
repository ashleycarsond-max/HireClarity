/**
 * SYNC LOOP — proactive discovery + monitoring of monitored companies.
 *
 * For every company in the registry (seed + auto-discovered, see
 * companies.ts), for every board the company runs:
 *
 *   1. FETCH  the board's current public job list (polite: robots.txt +
 *      throttle, via boards.ts).
 *   2. INGEST  each job: dedupe by postingId (derived from the canonical URL,
 *      exactly like observe.ts does for `track`/`recheck`); create new
 *      postings or refresh existing ones (status live, boardsSeen via the
 *      record's sourceBoard, lastCheckedAt updated).
 *   3. REMOVAL  postings previously seen for this company+board that are no
 *      longer in the list → status=removed + "removed" event (the same
 *      take-down detection the recheck loop performs, driven by the board's
 *      list instead of an HTTP 404).
 *   4. RELIST  an identity that reappears after a removal (same postingId, or
 *      a new URL with the same title+company identity) → relistCount++,
 *      status=relisted + "relisted" event — mirroring observe.ts exactly.
 *
 * The removal pass is skipped when a board returns ok but an EMPTY job list
 * (a transient/empty response would otherwise nuke every live record to
 * "removed" and poison relist counts with false relists — we only claim a
 * take-down we actually observed against a real list).
 *
 * `dryRun` fetches and reports (including would-be created/updated/removed/
 * relisted counts) WITHOUT writing to the store.
 */

import { fetchBoard } from "./boards";
import type { BoardFetchResult, BoardJob, BoardKind } from "./boards";
import { buildRegistry, type MonitoredCompany } from "./companies";
import { extractPayFromBoardRaw } from "./pay";
import { Store } from "./store";
import type { PayInfo, PostingEvent, PostingRecord } from "./types";
import { identityKey } from "./urls";

export interface SyncOptions {
  /** Fetch + report only; never write to the store. */
  dryRun?: boolean;
  now?: Date;
}

export interface BoardSyncCounts {
  jobsSeen: number;
  created: number;
  updated: number;
  removed: number;
  relisted: number;
}

export interface BoardSyncResult extends BoardSyncCounts {
  board: BoardKind;
  boardId: string;
  ok: boolean;
  note: string | null;
}

export interface CompanySyncResult {
  name: string;
  boards: BoardSyncResult[];
  errors: string[];
}

export interface SyncReport {
  at: string;
  dryRun: boolean;
  registry: MonitoredCompany[];
  companies: CompanySyncResult[];
  totals: BoardSyncCounts;
  storeCount: number;
}

const EMPTY: BoardSyncCounts = { jobsSeen: 0, created: 0, updated: 0, removed: 0, relisted: 0 };

function addCounts(a: BoardSyncCounts, b: BoardSyncCounts): BoardSyncCounts {
  return {
    jobsSeen: a.jobsSeen + b.jobsSeen,
    created: a.created + b.created,
    updated: a.updated + b.updated,
    removed: a.removed + b.removed,
    relisted: a.relisted + b.relisted,
  };
}

/**
 * Ingest one board's job list for one company (the shared path used by the
 * real sync and the `sync-test` fixture — the fixture proves removal/relist
 * through this exact code).
 *
 * Reads and writes are BATCHED per board (getByPostingIds / getByIdentityKeys
 * / flushSyncWrites in store.ts): the per-row SQL is byte-for-byte the same as
 * the sequential methods, so results are identical — but a 400-posting board
 * costs ~4 Neon round-trips instead of ~1,200, which is what lets the scaled
 * registry sync inside a serverless invocation's time budget.
 */
export async function ingestBoardJobs(
  store: Store,
  company: MonitoredCompany,
  board: BoardKind,
  boardId: string,
  jobs: BoardJob[],
  now: Date,
  dryRun: boolean
): Promise<BoardSyncCounts> {
  const nowIso = now.toISOString();
  const currentIds = new Set(jobs.map((j) => j.postingId).filter(Boolean));
  const counts: BoardSyncCounts = { ...EMPTY, jobsSeen: jobs.length };
  if (jobs.length === 0) return counts;

  // Batched pre-reads: existing records for these posting ids, plus identity
  // groups for any posting whose identity key differs from its posting id
  // (those are the only ones that can match a removed record → relist).
  const recordsById = new Map((await store.getByPostingIds([...currentIds])).map((r) => [r.postingId, r]));
  const identityKeys = new Set<string>();
  for (const job of jobs) {
    if (!job.postingId) continue;
    const idKey = identityKey(job.title, company.name) ?? job.postingId;
    if (idKey !== job.postingId) identityKeys.add(idKey);
  }
  const recordsByIdentity = new Map<string, PostingRecord[]>();
  for (const r of await store.getByIdentityKeys([...identityKeys])) {
    const key = r.identityKey || r.postingId;
    const list = recordsByIdentity.get(key) ?? [];
    list.push(r);
    recordsByIdentity.set(key, list);
  }

  const upserts: PostingRecord[] = [];
  const checks: { postingId: string; at: string; observedStatus: string; statusCode: number | null; note: string | null }[] = [];
  const events: PostingEvent[] = [];
  // Pay signal (owner decision 2026-08-15): the board APIs carry structured
  // compensation (Greenhouse `compensation`, Ashby/Lever `salaryRange`) and/or
  // the ad copy — extract per job WITHOUT any extra fetch, and persist batched
  // with the same flush. Jobs with no pay data get the honest "not stated"
  // row; the store's monotone merge never downgrades a positive observation.
  const payRows: PayInfo[] = [];
  for (const job of jobs) {
    if (!job.postingId) continue;
    const payExtract = extractPayFromBoardRaw(job.raw);
    payRows.push({
      postingId: job.postingId,
      hasPay: Boolean(payExtract),
      payMin: payExtract?.min ?? null,
      payMax: payExtract?.max ?? null,
      currency: payExtract?.currency ?? null,
      period: payExtract?.period ?? null,
      payText: payExtract?.payText ?? null,
      source: payExtract?.source ?? null,
      fetchError: null,
      extractedAt: nowIso,
    });
  }

  for (const job of jobs) {
    if (!job.postingId) continue;
    const record = recordsById.get(job.postingId) ?? null;
    const idKey = identityKey(job.title, company.name) ?? job.postingId;

    if (record) {
      // ── Existing posting: refresh, or flip removed → relisted. ────────────
      const wasRemoved = record.status === "removed";
      const titleChanged = job.title && record.title && job.title !== record.title;
      const companyChanged = company.name && record.company && company.name !== record.company;
      const merged: PostingRecord = {
        ...record,
        canonicalUrl: job.url,
        requestedUrl: record.requestedUrl ?? job.url,
        title: job.title ?? record.title,
        company: company.name ?? record.company,
        location: job.location ?? record.location,
        postedAt: job.postedAt ?? record.postedAt,
        sourceBoard: board,
        identityKey: idKey,
        status: wasRemoved ? "relisted" : record.status === "relisted" ? "relisted" : "live",
        relistCount: wasRemoved ? record.relistCount + 1 : record.relistCount,
        lastSeenAt: nowIso,
        lastCheckedAt: nowIso,
        lastStatusCode: 200,
        lastNote: wasRemoved
          ? `relisted: reappeared on ${board}/${boardId} after removal`
          : null,
      };
      if (wasRemoved) counts.relisted++;
      else counts.updated++;
      if (!dryRun) {
        upserts.push(merged);
        checks.push({ postingId: job.postingId, at: nowIso, observedStatus: merged.status, statusCode: 200, note: merged.lastNote ?? `live via ${board}/${boardId} board sync` });
        if (wasRemoved) {
          events.push({
            postingId: job.postingId,
            identityKey: idKey,
            type: "relisted",
            at: nowIso,
            detail: `reappeared on ${board}/${boardId} after removal (relist #${merged.relistCount})`,
          });
        } else if (titleChanged || companyChanged) {
          events.push({
            postingId: job.postingId,
            identityKey: idKey,
            type: "content_changed",
            at: nowIso,
            detail: `title/company changed: "${record.title}" → "${job.title}"`,
          });
        }
      }
    } else {
      // ── New posting: first_seen, or relist if this identity was removed. ──
      let relistFrom: PostingRecord | null = null;
      if (idKey !== job.postingId) {
        const candidates = (recordsByIdentity.get(idKey) ?? []).filter(
          (r) => r.status === "removed" && r.postingId !== job.postingId
        );
        if (candidates.length) {
          candidates.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1)); // most recent removal first
          relistFrom = candidates[0];
        }
      }
      const rec: PostingRecord = {
        postingId: job.postingId,
        canonicalUrl: job.url,
        requestedUrl: job.url,
        title: job.title,
        company: company.name,
        location: job.location,
        postedAt: job.postedAt,
        sourceBoard: board,
        identityKey: idKey,
        fingerprint: null,
        status: relistFrom ? "relisted" : "live",
        relistCount: relistFrom ? relistFrom.relistCount + 1 : 0,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        lastCheckedAt: nowIso,
        lastStatusCode: 200,
        lastNote: relistFrom
          ? `relisted: reappeared at ${job.url} after removal of ${relistFrom.postingId}`
          : `first observed via ${board}/${boardId} board sync`,
        createdAt: nowIso,
      };
      if (relistFrom) counts.relisted++;
      else counts.created++;
      if (!dryRun) {
        upserts.push(rec);
        checks.push({ postingId: job.postingId, at: nowIso, observedStatus: rec.status, statusCode: 200, note: rec.lastNote });
        events.push({
          postingId: job.postingId,
          identityKey: idKey,
          type: "first_seen",
          at: nowIso,
          detail: `discovered via ${board}/${boardId} board sync from ${job.url}`,
        });
        if (relistFrom) {
          events.push({
            postingId: job.postingId,
            identityKey: idKey,
            type: "relisted",
            at: nowIso,
            detail: `reappeared after removal of ${relistFrom.postingId} (was listed from ${relistFrom.firstSeenAt} to ${relistFrom.lastSeenAt})`,
          });
        }
      }
    }
  }

  // ── REMOVAL: previously-live postings for this company+board, now gone. ──
  // Skipped on empty lists (see header — don't fabricate take-downs).
  if (jobs.length > 0) {
    const prior = await store.getByBoardAndCompany(board, company.name);
    for (const rec of prior) {
      if (rec.status === "removed") continue;
      if (currentIds.has(rec.postingId)) continue;
      counts.removed++;
      if (!dryRun) {
        const merged: PostingRecord = {
          ...rec,
          status: "removed",
          lastSeenAt: nowIso,
          lastCheckedAt: nowIso,
          lastStatusCode: null,
          lastNote: `no longer in ${board}/${boardId} public job list (board sync)`,
        };
        upserts.push(merged);
        checks.push({ postingId: rec.postingId, at: nowIso, observedStatus: "removed", statusCode: null, note: merged.lastNote });
        events.push({
          postingId: rec.postingId,
          identityKey: rec.identityKey || rec.postingId,
          type: "removed",
          at: nowIso,
          detail: `taken down from ${board}/${boardId} (missing from public job list)`,
        });
      }
    }
  }

  if (!dryRun && (upserts.length || checks.length || events.length)) {
    await store.flushSyncWrites(upserts, checks, events, payRows);
  }

  return counts;
}

/** Fetch one board and ingest its list (or report-only in dry-run). */
async function syncBoard(
  store: Store,
  company: MonitoredCompany,
  board: BoardKind,
  boardId: string,
  now: Date,
  dryRun: boolean
): Promise<BoardSyncResult> {
  const fetched: BoardFetchResult = await fetchBoard(board, boardId);
  if (!fetched.ok) {
    return { board, boardId, ok: false, note: fetched.note, ...EMPTY };
  }
  const counts = await ingestBoardJobs(store, company, board, boardId, fetched.jobs, now, dryRun);
  const note =
    fetched.jobs.length === 0
      ? "board returned an empty job list — removal pass skipped (possible transient)"
      : `HTTP 200, ${fetched.jobs.length} job(s)`;
  return { board, boardId, ok: true, note, ...counts };
}

/** Run the full sync across the registry. */
export async function runSync(store: Store, opts: SyncOptions = {}): Promise<SyncReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const registry = await buildRegistry(store);
  const companies: CompanySyncResult[] = [];
  let totals: BoardSyncCounts = { ...EMPTY };

  for (const company of registry) {
    const result: CompanySyncResult = { name: company.name, boards: [], errors: [] };
    for (const ref of company.boards) {
      const r = await syncBoard(store, company, ref.board, ref.boardId, now, dryRun);
      result.boards.push(r);
      if (!r.ok) result.errors.push(`${ref.board}/${ref.boardId}: ${r.note}`);
      totals = addCounts(totals, r);
    }
    companies.push(result);
  }

  return {
    at: now.toISOString(),
    dryRun,
    registry,
    companies,
    totals,
    storeCount: await store.count(),
  };
}

/* ------------------------- chunked sync (cron-safe) ------------------------ */
/**
 * Run a BOUNDED batch of the sync — the serverless-safe form used by the
 * Vercel cron endpoint (/api/cron/sync) and `bun run sync-chunk`.
 *
 * Why: a full `runSync` across the whole registry takes ~2 minutes (sequential
 * board fetches + Neon upserts), which can exceed a single serverless
 * invocation's lifetime. Chunking makes each invocation process a small,
 * configurable number of companies and persist a CURSOR in Neon (sync_meta),
 * so successive invocations advance through the registry and wrap around. An
 * hourly cron therefore cycles the entire registry across the day.
 *
 * - Cursor semantics: `sync_cursor` holds the index of the last company
 *   processed (start = cursor + 1, wrapping at registry length; -1 = none yet).
 * - Batch size: `COMPANIES_PER_RUN` env (default 1) or the `companies` option.
 * - A run never processes the same company twice and stops at the end of the
 *   registry (no mid-run wrap), so a batch is at most min(companies, registry).
 */

export const SYNC_CURSOR_KEY = "sync_cursor";

export interface SyncChunkOptions {
  /** Max companies to process in this invocation (default: COMPANIES_PER_RUN env, then 1). */
  companies?: number;
  now?: Date;
}

export interface SyncChunkReport {
  at: string;
  /** Full company results for the companies processed in this invocation. */
  processed: CompanySyncResult[];
  processedNames: string[];
  totals: BoardSyncCounts;
  /** Companies in the registry at this invocation. */
  registrySize: number;
  /** Index of the last processed company (−1 when nothing was processed). */
  cursor: number;
  /** Companies left before the cursor wraps to the start of the registry. */
  remaining: number;
  /** Errors across all processed boards (honest per-board failures). */
  errors: string[];
  storeCount: number;
}

export async function runSyncChunk(store: Store, opts: SyncChunkOptions = {}): Promise<SyncChunkReport> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const fromEnv = Number.parseInt(process.env.COMPANIES_PER_RUN ?? "", 10);
  const batch = Math.max(1, Math.min(50, opts.companies ?? (Number.isFinite(fromEnv) ? fromEnv : 1)));

  const registry = await buildRegistry(store);
  const registrySize = registry.length;
  if (registrySize === 0) {
    return {
      at: nowIso,
      processed: [],
      processedNames: [],
      totals: { ...EMPTY },
      registrySize: 0,
      cursor: -1,
      remaining: 0,
      errors: [],
      storeCount: await store.count(),
    };
  }

  const prevCursor = await store.getMetaInt(SYNC_CURSOR_KEY, -1);
  const start = ((prevCursor % registrySize) + registrySize + 1) % registrySize;
  const processed: CompanySyncResult[] = [];
  let totals: BoardSyncCounts = { ...EMPTY };
  const errors: string[] = [];
  let lastIdx = -1;

  for (let i = 0; i < batch; i++) {
    const idx = start + i;
    if (idx >= registrySize) break; // never wrap mid-run — next invocation continues
    const company = registry[idx];
    const result: CompanySyncResult = { name: company.name, boards: [], errors: [] };
    for (const ref of company.boards) {
      const r = await syncBoard(store, company, ref.board, ref.boardId, now, false);
      result.boards.push(r);
      if (!r.ok) result.errors.push(`${ref.board}/${ref.boardId}: ${r.note}`);
      totals = addCounts(totals, r);
    }
    processed.push(result);
    errors.push(...result.errors);
    lastIdx = idx;
    await store.setMetaInt(SYNC_CURSOR_KEY, idx);
  }

  return {
    at: nowIso,
    processed,
    processedNames: processed.map((c) => c.name),
    totals,
    registrySize,
    cursor: lastIdx,
    remaining: lastIdx < 0 ? registrySize : (registrySize - 1 - lastIdx + registrySize) % registrySize,
    errors,
    storeCount: await store.count(),
  };
}
