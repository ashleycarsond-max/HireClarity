/**
 * WATCHLIST ALERT ENGINE — detects alert-worthy changes for watched postings.
 *
 * Runs INSIDE the guarded /api/cron/sync handler, after each hourly sync chunk:
 * it re-reads the store (not the sync report) so it is correct no matter which
 * chunk processed the posting, and it catches up on events whose alert email
 * failed to send in an earlier run (the guard below is "delivered", not "seen").
 *
 * Alert kinds (all derived from stored observations — nothing guessed):
 *   vanished  — a watched posting transitioned live → removed (taken down)
 *   relisted  — a watched posting reappeared after a removal (relist event)
 *   stale     — a watched posting has been listed continuously for >= the stale
 *               threshold (default 30 days) with no observed status change;
 *               alerted once per 30-day milestone (30, 60, 90, ... days)
 *
 * Guards (the anti-spam contract, documented in the product):
 *   - At most ONE alert email per watched posting per day: a watch is skipped
 *     entirely when last_alert_at is within the 24h window (regardless of how
 *     many times the posting flipped in between).
 *   - Never re-alert the same change: change alerts only consider events that
 *     happened AFTER the last delivered alert (or after the watch was created,
 *     so pre-watch history never fires an email).
 *   - Staleness milestones: a stale posting is alerted at 30, 60, 90... days —
 *     not every day — tracked per watch via stale_milestone.
 *
 * Sending is NOT this module's job: it returns candidates; the caller
 * (src/server/watch-alerts.ts) checks the recipient still holds an active Job
 * Seeker subscription, sends via Resend, and only THEN records last_alert_at.
 */

import { Store } from "./store";
import type { PostingRecord } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default staleness threshold: 30 days listed with no observed change. */
export const WATCH_STALE_DAYS_DEFAULT = 30;

/** At most one alert email per watched posting per day. */
export const WATCH_ALERT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type WatchAlertKind = "vanished" | "relisted" | "stale";

export interface WatchAlertCandidate {
  watchId: number;
  userEmail: string;
  watchToken: string;
  postingId: string;
  kind: WatchAlertKind;
  title: string | null;
  canonicalUrl: string;
  board: string;
  /** Whole days the posting identity has been listed (the "N" in "after N days"). */
  daysListed: number;
  /** ISO — when the change was observed (change alerts) or now (stale). */
  at: string;
  /** Human-readable "what changed" line for the email body. */
  detail: string;
}

export interface WatchlistPassResult {
  /** Watch rows evaluated this run. */
  evaluated: number;
  /** Candidates that warrant an alert email (subject to the send-time gates). */
  alerts: WatchAlertCandidate[];
  /** Watches skipped, with the honest reason (logged, never silently dropped). */
  skipped: { watchId: number; postingId: string; reason: string }[];
}

/** Same daysListed definition as signals.ts: now if live/relisted, else lastSeenAt. */
export function daysListedForRecord(record: PostingRecord, now: Date): number {
  const first = new Date(record.firstSeenAt).getTime();
  const end = record.status === "live" || record.status === "relisted" ? now.getTime() : new Date(record.lastSeenAt).getTime();
  return Math.max(0, Math.floor((end - first) / DAY_MS));
}

/**
 * Evaluate every watch in the store and return alert candidates. Pure
 * read+decide — writes nothing (the caller records delivery). `now` is
 * injectable for tests.
 */
export async function evaluateWatchAlerts(
  store: Store,
  opts: { now?: Date; staleDays?: number; minIntervalMs?: number } = {}
): Promise<WatchlistPassResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const staleDays = opts.staleDays && opts.staleDays > 0 ? opts.staleDays : WATCH_STALE_DAYS_DEFAULT;
  const minIntervalMs = opts.minIntervalMs ?? WATCH_ALERT_MIN_INTERVAL_MS;

  const watches = await store.listAllWatches();
  const result: WatchlistPassResult = { evaluated: watches.length, alerts: [], skipped: [] };

  for (const watch of watches) {
    const posting = await store.getByPostingId(watch.postingId);
    if (!posting) {
      result.skipped.push({ watchId: watch.id, postingId: watch.postingId, reason: "posting no longer tracked" });
      continue;
    }

    // Per-day throttle: no alert at all when one was delivered in the last 24h.
    if (watch.lastAlertAt) {
      const sinceLast = now.getTime() - new Date(watch.lastAlertAt).getTime();
      if (sinceLast < minIntervalMs) {
        result.skipped.push({ watchId: watch.id, postingId: watch.postingId, reason: "alerted within 24h window" });
        continue;
      }
    }

    const daysListed = daysListedForRecord(posting, now);
    const events = await store.eventsForPosting(watch.postingId);

    // ── Change alert: latest removed/relisted event since the last delivered
    //    alert (or since the watch was created — pre-watch history never
    //    fires an email). "Changed this run" is covered because the sync
    //    writes events with the run's timestamp; failed sends are caught up
    //    on the next run (the cutoff is lastAlertAt, not "this run").
    const cutoff = watch.lastAlertAt && watch.lastAlertAt > watch.createdAt ? watch.lastAlertAt : watch.createdAt;
    const changeEvents = events
      .filter((e) => (e.type === "removed" || e.type === "relisted") && e.at > cutoff)
      .sort((a, b) => (a.at < b.at ? -1 : 1));
    if (changeEvents.length > 0) {
      const latest = changeEvents[changeEvents.length - 1];
      const kind: WatchAlertKind = latest.type === "removed" ? "vanished" : "relisted";
      result.alerts.push({
        watchId: watch.id,
        userEmail: watch.userEmail,
        watchToken: watch.watchToken,
        postingId: watch.postingId,
        kind,
        title: posting.title,
        canonicalUrl: posting.canonicalUrl,
        board: posting.sourceBoard,
        daysListed,
        at: latest.at,
        detail:
          kind === "vanished"
            ? `was taken down — it was live and is no longer listed (observed ${latest.at.slice(0, 10)}).`
            : `was relisted — taken down earlier and now listed again (observed ${latest.at.slice(0, 10)}).`,
      });
      continue;
    }

    // ── Staleness alert: live/relisted, listed continuously for >= staleDays
    //    (no removed/relisted event inside the window — "no change we could
    //    observe"), and a NEW 30-day milestone vs the last alerted one.
    if (posting.status === "live" || posting.status === "relisted") {
      const lastChange = events
        .filter((e) => e.type === "removed" || e.type === "relisted")
        .sort((a, b) => (a.at < b.at ? -1 : 1))
        .at(-1);
      const continuousSince = lastChange ? lastChange.at : posting.firstSeenAt;
      const continuousDays = Math.max(0, Math.floor((now.getTime() - new Date(continuousSince).getTime()) / DAY_MS));
      if (continuousDays < staleDays) {
        result.skipped.push({ watchId: watch.id, postingId: watch.postingId, reason: "recently changed — staleness window reset" });
        continue;
      }
      const milestone = Math.floor(daysListed / staleDays);
      if (milestone < 1 || milestone <= watch.staleMilestone) {
        result.skipped.push({ watchId: watch.id, postingId: watch.postingId, reason: "staleness already alerted at this milestone" });
        continue;
      }
      result.alerts.push({
        watchId: watch.id,
        userEmail: watch.userEmail,
        watchToken: watch.watchToken,
        postingId: watch.postingId,
        kind: "stale",
        title: posting.title,
        canonicalUrl: posting.canonicalUrl,
        board: posting.sourceBoard,
        daysListed,
        at: nowIso,
        detail: `is still listed after ${daysListed} days with no change we could observe (stale threshold ${staleDays} days).`,
      });
    } else {
      result.skipped.push({ watchId: watch.id, postingId: watch.postingId, reason: "posting is removed and no new change since last alert" });
    }
  }

  return result;
}
