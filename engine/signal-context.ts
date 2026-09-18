/**
 * COMPILE-PATH SIGNAL CONTEXT — the batched, SCALE-SAFE store reads that the
 * scoring / daily-compile / report layers need.
 *
 * WHY THIS MODULE EXISTS (2026-09-18, pipeline outage fix)
 * -------------------------------------------------------
 * The daily (02:30) and report (09:00) compiles built their signal context from
 * `store.allEvents()` — ONE unbounded query over the whole events table. The
 * table reached 1.43M rows / ~390 MB (98% of it `content_changed` observations),
 * far past the 64 MB single-response cap of Neon's serverless HTTP driver, so
 * both crons died for weeks with:
 *     NeonDbError: Server error (HTTP status 507): "response is too large"
 * The reads are now shaped like the aggregation the callers actually use:
 *   - transition events (`first_seen` / `removed` / `relisted`), keyset-paged;
 *   - a per-posting `content_changed` boolean (its FIRST timestamp), via one
 *     GROUP BY, instead of 1.4M raw rows;
 *   - pay rows, keyset-paged.
 *
 * SEMANTICS ARE UNCHANGED. buildSignals consumes events for exactly three
 * things: `events.some(e => e.type === "content_changed")` (scoreCore),
 * `events.some(e => e.type === "removed")` (scoreCore) and the chronological
 * statusHistory built from the three transition types (everything else is
 * skipped by `else continue`). This module reproduces all three exactly: the
 * transition rows keep their chronological (id) order, and a posting with any
 * content_changed observation gets one synthetic event carrying its first such
 * timestamp. `engine/compile-context-test.ts` asserts equality against the
 * per-posting reference path (store.eventsForPosting, i.e. buildSignals with no
 * ctx) for live postings.
 */
import type { Store } from "./store";
import type { PayInfo, PostingEvent } from "./types";

/**
 * posting_id → its events, in chronological order. Drop-in replacement for the
 * map the old `allEvents()` loop built (same keys, same per-posting order).
 */
export async function loadEventsByPosting(store: Store): Promise<Map<string, PostingEvent[]>> {
  const map = new Map<string, PostingEvent[]>();
  const push = (e: PostingEvent) => {
    const list = map.get(e.postingId);
    if (list) list.push(e);
    else map.set(e.postingId, [e]);
  };
  for (const e of await store.transitionEventsAll()) push(e);
  for (const c of await store.contentChangedFirstAt()) {
    push({ postingId: c.postingId, identityKey: "", type: "content_changed", at: c.at, detail: null });
  }
  return map;
}

/** posting_id → its pay row (keyset-paged read — no unbounded SELECT). */
export async function loadPayByPosting(store: Store): Promise<Map<string, PayInfo>> {
  const map = new Map<string, PayInfo>();
  for (const p of await store.allPay()) map.set(p.postingId, p);
  return map;
}
