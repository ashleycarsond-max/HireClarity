/**
 * Watchlist alert SEND pass (server-only) — runs inside the guarded
 * /api/cron/sync handler after each hourly sync chunk.
 *
 * Pipeline per candidate from evaluateWatchAlerts (engine/watchlist.ts):
 *   1. The recipient must STILL hold an active HireClarity Data subscription
 *      (fail-closed via isSubscribed) — alerts are a paid-product feature and we
 *      never email a lapsed/free account.
 *   2. Test/example addresses are never emailed (same guard as report-email).
 *   3. Send via Resend; only when Resend ACCEPTS the message do we record
 *      last_alert_at (and the staleness milestone) — a failed send leaves the
 *      watch un-alerted so the next run retries honestly. Never re-alert the
 *      same change, never more than one email per posting per day (guards in
 *      engine/watchlist.ts + the last_alert_at record).
 */

import { Store } from "../../engine/store";
import { evaluateWatchAlerts } from "../../engine/watchlist";
import { isSubscribed } from "./subscriptions";
import { isTestAddress, maskEmail } from "./report-email";
import { sendWatchAlertEmail } from "./watch-email";

export interface WatchSendResult {
  evaluated: number;
  sent: number;
  skipped: { masked: string; postingId: string; reason: string }[];
  failures: { masked: string; postingId: string; reason: string }[];
}

/**
 * Run the full alert pass: evaluate, gate, send, record. `now` matches the
 * sync run's clock so staleness math and the 24h window are consistent with
 * the events the sync just wrote.
 */
export async function runWatchlistAlertPass(
  store: Store,
  opts: { now?: Date } = {}
): Promise<WatchSendResult> {
  const now = opts.now ?? new Date();
  const pass = await evaluateWatchAlerts(store, { now });
  const result: WatchSendResult = { evaluated: pass.evaluated, sent: 0, skipped: [], failures: [] };

  for (const c of pass.alerts) {
    const masked = maskEmail(c.userEmail);
    // 1. Paid-tier gate (fail-closed: a storage error means no email).
    let subscribed = false;
    try {
      subscribed = await isSubscribed("seeker", c.userEmail);
    } catch (err) {
      console.error("[watch-alerts] isSubscribed check failed:", err);
    }
    if (!subscribed) {
      result.skipped.push({ masked, postingId: c.postingId, reason: "no active HireClarity Data subscription" });
      continue;
    }
    // 2. Never email test/example addresses.
    if (isTestAddress(c.userEmail)) {
      result.skipped.push({ masked, postingId: c.postingId, reason: "test/example address — never emailed" });
      continue;
    }
    // 3. Send; record delivery ONLY on acceptance.
    const res = await sendWatchAlertEmail(c.userEmail, c);
    if (res.sent) {
      try {
        await store.updateLastAlertAt(c.watchId, now.toISOString());
        if (c.kind === "stale") {
          await store.updateStaleMilestone(c.watchId, Math.max(1, Math.floor(c.daysListed / 30)));
        }
      } catch (err) {
        // The email went out but we couldn't record it — log loudly: the next
        // run would re-alert (guarded to once per day by the 24h window, so
        // the user sees at most a duplicate the next day).
        console.error(`[watch-alerts] email accepted but last_alert_at update failed for watch ${c.watchId}:`, err);
      }
      result.sent++;
      continue;
    }
    result.failures.push({ masked, postingId: c.postingId, reason: res.error ?? res.reason ?? "send failed" });
  }

  // Log the pass outcome (server-side observability; honest, no PII beyond masked emails).
  console.log(
    `[watch-alerts] pass done: evaluated=${pass.evaluated} alerts=${pass.alerts.length} sent=${result.sent} ` +
      `skipped=${result.skipped.length} failures=${result.failures.length}`
  );
  for (const s of pass.skipped) console.log(`[watch-alerts] skip watch ${s.watchId} (${s.postingId}): ${s.reason}`);
  for (const s of result.skipped) console.log(`[watch-alerts] skip send to ${s.masked} (${s.postingId}): ${s.reason}`);

  return result;
}

/** Re-exported for the HTTP layer: build an email body without sending. */
export { buildWatchAlertEmail, unwatchUrl } from "./watch-email";
export type { WatchAlertCandidate } from "../../engine/watchlist";
