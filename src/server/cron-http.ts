/**
 * Cron HTTP endpoint — GET /api/cron/sync (Vercel Cron Jobs).
 *
 * Vercel Cron triggers this path on the project's PRODUCTION deployment (an
 * HTTP GET), and — when the CRON_SECRET env var is configured on the project —
 * automatically attaches `Authorization: Bearer <CRON_SECRET>` (documented
 * pattern, https://vercel.com/docs/cron-jobs). We compare that header against
 * the env var and refuse everything else (401). We deliberately do NOT trust
 * the x-vercel-cron-schedule header alone — Vercel's docs present it as
 * informational, not as authentication.
 *
 * The handler runs a BOUNDED sync chunk (see engine/sync.ts runSyncChunk):
 * each invocation processes at most COMPANIES_PER_RUN registry companies
 * (default 1) and persists a company cursor in Neon, so the hourly schedule
 * cycles the whole registry across the day. It returns quickly and honestly:
 * a JSON summary of what this invocation processed, or a clear error.
 *
 * Wired OUTSIDE the TanStack router by serve.ts (Bun, port 3000) and
 * vercel-entry.ts (Node/Vercel render function) — this codebase has no
 * API-route support in the installed react-start build.
 */

import { Store } from "../../engine/store";
import { runSyncChunk } from "../../engine/sync";
import { runDiscoverySlice } from "../../engine/discovery-sync";
import { DAILY_REPORT_UNTIL, computeReportSnapshot, currentPeriod, reportRefreshDecision, saveReportSnapshot } from "../../engine/report";
import { runRequirementsSlice } from "../../engine/requirements-sync";
import { computeDailySnapshot, saveDailySnapshot, utcDateStr } from "../../engine/daily-stats";
import { sendReportToSignups } from "./report-email";
import { runWatchlistAlertPass } from "./watch-alerts";
import { timingSafeEqual } from "node:crypto";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

/** Timing-safe comparison of the Authorization header against CRON_SECRET. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: never expose the sync unguarded
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = new TextEncoder().encode(auth);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handleSync(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return json({ ok: false, error: "unauthorized — expected Authorization: Bearer <CRON_SECRET>" }, 401);
  }
  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "DATABASE_URL is not set — the tracking store isn't configured" }, 503);
  }
  const started = Date.now();
  try {
    const report = await runSyncChunk(new Store(), {});
    // Watchlist alert pass: inside the SAME guarded handler, after the sync
    // chunk. It re-reads the store (correct regardless of which chunk processed
    // a watched posting) and sends honest per-change/staleness emails only to
    // active subscribers — last_alert_at-guarded (see
    // engine/watchlist.ts + watch-alerts.ts).
    const watch = await runWatchlistAlertPass(new Store(), { now: new Date(report.at) });
    return json({
      ok: true,
      at: report.at,
      processed: report.processedNames,
      totals: report.totals,
      registrySize: report.registrySize,
      cursor: report.cursor,
      remaining: report.remaining,
      errors: report.errors,
      storeCount: report.storeCount,
      watchlist: {
        evaluated: watch.evaluated,
        sent: watch.sent,
        skipped: watch.skipped,
        failures: watch.failures,
      },
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    // Log detail server-side (function logs); the caller gets an honest error.
    console.error("[cron] /api/cron/sync failed:", err);
    return json({ ok: false, error: "sync failed — see function logs" }, 500);
  }
}

/**
 * GET /api/cron/report — the job-market report cron.
 *
 * Guards: same fail-closed CRON_SECRET auth as /api/cron/sync (Vercel Cron
 * sends `Authorization: Bearer <CRON_SECRET>` on every scheduled invocation).
 *
 * Cadence (owner decision 2026-08-14): the schedule runs DAILY ("0 9 * * *"),
 * and the handler is window-aware and idempotent:
 *   - Inside the daily-refresh window (2026-08-14 → DAILY_REPORT_UNTIL
 *     = 2027-02-14, see engine/report.ts) it regenerates the CURRENT month's
 *     snapshot from the latest daily compile every day and updates the
 *     published report at the same URL /reports/<YYYY-MM> (never a new URL per
 *     day).
 *   - On the 1st of any month it ALSO publishes a fresh monthly issue
 *     (existing behavior): regenerating the new period AND emailing the report
 *     to signups exactly once per new period (the sync_meta claim guard).
 *   - After DAILY_REPORT_UNTIL it only acts on the 1st (monthly), never daily.
 *
 * Behavior (idempotent by design):
 *   1. Computes the CURRENT month's snapshot from the tracking store and
 *      saves it (regenerating a period REPLACES the stored snapshot — safe to
 *      re-run any time; a same-day rerun is a no-op-with-refresh).
 *   2. Emails the report to the current signups ONLY when this period's
 *      snapshot is NEW (no snapshot existed for the period before this run) —
 *      the inaugural issue is sent once by hand (bun run report-email) and
 *      subsequent months go out automatically on the 1st. Regenerating an
 *      existing period never re-emails.
 *   3. An atomic sync_meta claim (`report_email_<period>`) makes the send
 *      happen at most once even if two cron invocations race on a new period.
 *
 * The snapshot computation is batched (~5 queries) so the whole run fits the
 * render function's 60s budget.
 */
async function handleReportCron(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return json({ ok: false, error: "unauthorized — expected Authorization: Bearer <CRON_SECRET>" }, 401);
  }
  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "DATABASE_URL is not set — the tracking store isn't configured" }, 503);
  }
  const started = Date.now();
  const store = new Store();
  try {
    const now = new Date();
    const decision = reportRefreshDecision(now);
    if (!decision.refresh) {
      return json({
        ok: true,
        action: "skipped",
        note: `outside the daily-refresh window (ended ${DAILY_REPORT_UNTIL}) and not the 1st of the month — the report only refreshes on the 1st after the window; nothing changed`,
        period: currentPeriod(now),
        elapsedMs: Date.now() - started,
      });
    }
    const period = currentPeriod(now);
    const existing = await store.getReportSnapshot(period);
    const snapshot = await computeReportSnapshot(store, period, now);
    await saveReportSnapshot(store, snapshot);
    const wasNewPeriod = existing === null;
    if (!wasNewPeriod) {
      return json({
        ok: true,
        period,
        action: decision.reason === "daily-window" ? "daily-refresh" : "regenerated-no-email",
        note:
          decision.reason === "daily-window"
            ? `a snapshot for this period already existed — it was refreshed from today's compile (data as of the latest daily snapshot) but no email was sent (the report email goes out once per NEW period)`
            : "a snapshot for this period already existed — the snapshot was refreshed but no email was sent (the report email goes out once per NEW period)",
        postings: {
          totalTracked: snapshot.postings.totalTracked,
          live: snapshot.postings.live,
          removed: snapshot.postings.removed,
          distinctCompanies: snapshot.postings.distinctCompanies,
        },
        daily: {
          snapshotsUsed: snapshot.daily.snapshotsUsed,
          lastDate: snapshot.daily.lastDate,
          dayOverDayTrendRows: snapshot.daily.dailyTrends.length,
        },
        elapsedMs: Date.now() - started,
      });
    }
    // New period: claim the one-time send, then email current signups.
    const claimed = await store.tryCreateMeta(`report_email_${period}`, new Date().toISOString());
    if (!claimed) {
      return json({
        ok: true,
        period,
        action: "new-period-already-emailed",
        note: "this period's snapshot is new but another invocation already claimed the send — no duplicate email",
        elapsedMs: Date.now() - started,
      });
    }
    const email = await sendReportToSignups(snapshot);
    return json({
      ok: true,
      period,
      action: "new-period-emailed",
      email: {
        sent: email.sent,
        skipped: email.skipped,
        totalSignups: email.total,
        recipients: email.recipients.map((r) => ({
          masked: r.masked,
          sent: r.sent,
          resendId: r.resendId ?? null,
          reason: r.reason,
        })),
      },
      postings: {
        totalTracked: snapshot.postings.totalTracked,
        live: snapshot.postings.live,
        removed: snapshot.postings.removed,
        distinctCompanies: snapshot.postings.distinctCompanies,
      },
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    console.error("[cron] /api/cron/report failed:", err);
    return json({ ok: false, error: "report generation failed — see function logs" }, 500);
  }
}

/**
 * GET /api/cron/daily — the daily data-pipeline cron (owner decision
 * 2026-08-14: compile daily, publish monthly).
 *
 * Guards: same fail-closed CRON_SECRET auth as the other cron paths (Vercel
 * Cron sends `Authorization: Bearer <CRON_SECRET>` on every scheduled
 * invocation). GET-only, trailing-slash variants intercepted below.
 *
 * Behavior (idempotent by design):
 *   1. Refreshes description requirements for a bounded slice of live postings
 *      (same bounded routine as `bun run requirements`; REQUIREMENTS_PER_RUN
 *      env default 150 here, with a 30s wall-clock budget so the compile that
 *      follows always fits the render function's 60s limit).
 *   2. Compiles today's daily snapshot from the store and saves it
 *      (re-running a date REPLACES the stored snapshot — safe to re-run).
 *   3. Returns a JSON summary: what the requirements slice did + the snapshot's
 *      headline numbers and trends.
 */
async function handleDailyCron(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return json({ ok: false, error: "unauthorized — expected Authorization: Bearer <CRON_SECRET>" }, 401);
  }
  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "DATABASE_URL is not set — the tracking store isn't configured" }, 503);
  }
  const started = Date.now();
  const store = new Store();
  try {
    const req = await runRequirementsSlice(store, {
      limit: Number(process.env.REQUIREMENTS_PER_RUN) > 0 ? Number(process.env.REQUIREMENTS_PER_RUN) : 150,
      timeBudgetMs: 30_000,
    });
    const date = utcDateStr();
    const snapshot = await computeDailySnapshot(store, date);
    await saveDailySnapshot(store, snapshot);
    return json({
      ok: true,
      date,
      at: snapshot.generatedAt,
      requirements: {
        picked: req.picked,
        processed: req.processed,
        skippedBudget: req.skippedBudget,
        descriptionsRead: req.descriptionsRead,
        fetchErrors: req.fetchErrors,
        flags: req.flags,
        elapsedMs: req.elapsedMs,
      },
      snapshot: {
        postings: {
          totalTracked: snapshot.postings.totalTracked,
          live: snapshot.postings.live,
          removed: snapshot.postings.removed,
          relisted: snapshot.postings.relisted,
          distinctCompanies: snapshot.postings.distinctCompanies,
        },
        industries: snapshot.industries.slice(0, 5),
        titles: snapshot.titles.slice(0, 5),
        requirements: {
          postingsWithDescriptionRead: snapshot.requirements.postingsWithDescriptionRead,
          bachelorShare: snapshot.requirements.bachelorShare,
          mastersShare: snapshot.requirements.mastersShare,
          fivePlusShare: snapshot.requirements.fivePlusShare,
        },
        trends: snapshot.trends,
      },
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    console.error("[cron] /api/cron/daily failed:", err);
    return json({ ok: false, error: "daily pipeline failed — see function logs" }, 500);
  }
}

/**
 * GET /api/cron/company-report — REMOVED (owner decision 2026-08-14).
 *
 * The Company product is retired (single $9 tier), so this cron no longer
 * exists: its vercel.json entry is gone and this handler was deleted — the
 * path falls through to the site router and returns 404. The shelved engine
 * code (engine/company-report.ts, src/server/company-report-email.ts) stays in
 * the repo for a future relaunch, unreferenced.
 */

/**
 * GET /api/cron/discover — the registry-growth cron (owner direction
 * 2026-08-15; design §4.2/§4.3/§4.6).
 *
 * Guards: same fail-closed CRON_SECRET auth as the other cron paths (Vercel
 * Cron sends `Authorization: Bearer <CRON_SECRET>` on every scheduled
 * invocation). GET-only, trailing-slash variants intercepted below.
 *
 * Schedule: 01:45 UTC daily — just before the 02:30 daily snapshot, so a
 * company verified at 01:45 can be picked up by the 02:00 hourly sync (or at
 * worst appears in the NEXT day's snapshot — honest and fine). A separate
 * invocation so discovery can never eat the hourly sync's time or the
 * daily/requirements budget.
 *
 * Behavior (idempotent by design):
 *   1. Atomic claim `discovery_day_<utcDate>` (tryCreateMeta) — a duplicate
 *      invocation on the same day no-ops (Vercel cron delivery is best-effort
 *      and may double-fire).
 *   2. runDiscoverySlice: a bounded slice of due candidates from the Neon
 *      pool (DISCOVERY_PER_RUN default 8, DISCOVERY_HOST_CAP default 3,
 *      DISCOVERY_TIME_BUDGET_MS default 30 s), verified live through the same
 *      politeness layer as the sync; only `verified` rows join the registry.
 *   3. Persists the run summary under `discovery_summary_<utcDate>` in
 *      sync_meta (the /data page and monthly report can consume registry
 *      growth KPI: pool summary + newlyVerifiedSince).
 *   4. Returns the JSON summary — the scheduled honest per-run report
 *      (byReason counts, newly verified, failures by reason).
 */
async function handleDiscoveryCron(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return json({ ok: false, error: "unauthorized — expected Authorization: Bearer <CRON_SECRET>" }, 401);
  }
  if (!process.env.DATABASE_URL) {
    return json({ ok: false, error: "DATABASE_URL is not set — the tracking store isn't configured" }, 503);
  }
  const started = Date.now();
  const store = new Store();
  try {
    const date = utcDateStr();
    const claimed = await store.tryCreateMeta(`discovery_day_${date}`, new Date().toISOString());
    if (!claimed) {
      return json({
        ok: true,
        at: new Date().toISOString(),
        claim: "already-claimed",
        note: `discovery already ran for ${date} — duplicate invocation no-op`,
        elapsedMs: Date.now() - started,
      });
    }
    const r = await runDiscoverySlice(store, {});
    const summary = {
      at: r.at,
      picked: r.picked,
      processed: r.processed,
      skippedBudget: r.skippedBudget,
      byReason: r.byReason,
      newlyVerified: r.newlyVerified,
      poolSize: r.poolSize,
      elapsedMs: r.elapsedMs,
    };
    try {
      await store.tryCreateMeta(`discovery_summary_${date}`, JSON.stringify(summary));
    } catch (err) {
      console.error("[cron] discovery summary persist failed (non-fatal):", err);
    }
    return json({ ok: true, at: r.at, claim: "claimed", date, ...summary });
  } catch (err) {
    console.error("[cron] /api/cron/discover failed:", err);
    return json({ ok: false, error: "discovery failed — see function logs" }, 500);
  }
}

/**
 * Route cron HTTP requests; returns null when the request is not ours and
 * should continue to the normal site handler.
 *
 * All ACTIVE cron paths (and their trailing-slash variants) are ALWAYS
 * intercepted here — they must never fall through to the site router, which
 * would render an HTML 404 page. Fail-closed is the only acceptable outcome:
 *   - not GET            -> 405 (Vercel Cron sends GET; nothing else may run it)
 *   - GET, no/wrong auth -> 401 (handlers below)
 *   - GET, correct auth  -> 200 + JSON summary
 * The Authorization check happens inside the handlers (timing-safe), AFTER the
 * pathname/method gates, so route interception does not depend on any header.
 *
 * NOTE (owner decision 2026-08-14): /api/cron/company-report was REMOVED — the
 * Company product is retired (single $9 tier). Its vercel.json cron entry is
 * gone and the handler below is deleted, so the path now falls through and
 * returns the site's 404. The shelved engine code (engine/company-report.ts,
 * src/server/company-report-email.ts) stays in the repo, unreferenced.
 */
export async function handleCronHttp(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/cron/sync" || pathname === "/api/cron/sync/") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method not allowed — cron sends GET" }, 405, { allow: "GET" });
    }
    return handleSync(request);
  }
  if (pathname === "/api/cron/report" || pathname === "/api/cron/report/") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method not allowed — cron sends GET" }, 405, { allow: "GET" });
    }
    return handleReportCron(request);
  }
  if (pathname === "/api/cron/daily" || pathname === "/api/cron/daily/") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method not allowed — cron sends GET" }, 405, { allow: "GET" });
    }
    return handleDailyCron(request);
  }
  if (pathname === "/api/cron/discover" || pathname === "/api/cron/discover/") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method not allowed — cron sends GET" }, 405, { allow: "GET" });
    }
    return handleDiscoveryCron(request);
  }
  return null;
}
