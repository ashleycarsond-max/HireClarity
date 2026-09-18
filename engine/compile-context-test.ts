/**
 * COMPILE-PATH SIGNAL-CONTEXT EQUIVALENCE test (2026-09-18 pipeline fix).
 *
 * WHY THIS EXISTS: the daily/report compiles used to build their signal context
 * from `store.allEvents()` — one unbounded read of the whole events table
 * (1.43M rows / ~390 MB → Neon HTTP 507 "response is too large"), which is what
 * silently killed both compiles from 2026-08-22 to 2026-09-17. They now read the
 * same information in a bounded shape (`engine/signal-context.ts`:
 * `loadEventsByPosting` = transition rows + one `content_changed` flag per
 * posting; `loadPayByPosting` = keyset-paged pay rows). The entire point of the
 * fix is that the compiler's OUTPUT does not change — this suite is the check
 * that it hasn't. It was described in the fix handoff but never committed
 * (engine/compile-context-test.ts did not exist until this session).
 *
 * WHAT IS AND ISN'T EQUIVALENT (measured, not assumed)
 *   - EQUIVALENT: everything the compile path consumes — `daysListed` (the
 *     listing-duration distribution), `statusHistory` (the take-down/relist
 *     timeline), `relistCount`, the pay signal (`pay` / `payGroup`), the
 *     board/URL identity spread, `distinctPostingsInIdentity`, and the two
 *     event predicates the scorer reads (`events.some(content_changed)`,
 *     `events.some(removed)`) — hence the final score is identical too.
 *   - INTENTIONALLY NOT equivalent: `PostingSignals.events` itself. The batched
 *     context carries ONE synthetic `content_changed` row per posting (its first
 *     timestamp) instead of the flood of raw observations (98% of the events
 *     table). That is the whole point of the change and it is why the compile
 *     reads a few MB instead of 390 MB. Section 3 asserts that difference is
 *     deliberate and bounded.
 *
 * Two layers:
 *   1. IN-MEMORY SEMANTICS (no DB, no network): the batched loaders, driven by a
 *      fake store, produce exactly the map shape `buildSignals` consumes.
 *   2. LIVE EQUIVALENCE (READ-ONLY): for a sample of live postings, the batched
 *      context path (`buildSignals(store, rec, ctx)`, what the compiles use) is
 *      equivalent to the per-posting reference path (`buildSignals(store, rec)`,
 *      which queries the store directly) on the compile contract above.
 *      Skipped with a printed note when DATABASE_URL is unset.
 *
 * Run: bun run compile-context-test
 *      COMPILE_CONTEXT_SAMPLE=50 bun run compile-context-test   (bigger sample)
 */

import { Store } from "./store";
import { buildSignals, type PostingSignals, type SignalContext } from "./signals";
import { loadEventsByPosting, loadPayByPosting } from "./signal-context";
import { scoreCore } from "./score";
import type { PayInfo, PostingEvent, PostingRecord } from "./types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  }
}

function checkTrue(label: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
  }
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
}

/** The projection of PostingSignals the compile path actually consumes. */
function compileContract(s: PostingSignals, checks: number): Record<string, unknown> {
  return {
    daysListed: s.daysListed,
    relistCount: s.relistCount,
    statusHistory: s.statusHistory,
    pay: s.pay,
    payGroup: s.payGroup,
    boardsSeen: s.boardsSeen,
    urlsSeen: s.urlsSeen,
    distinctPostingsInIdentity: s.distinctPostingsInIdentity,
    hasContentChanged: s.events.some((e) => e.type === "content_changed"),
    hasRemoved: s.events.some((e) => e.type === "removed"),
    score: scoreCore(s, checks).score,
  };
}

/* ------------------- 1. batched-loader semantics (no DB) ------------------- */

function ev(postingId: string, type: PostingEvent["type"], at: string): PostingEvent {
  return { postingId, identityKey: `id-${postingId}`, type, at, detail: null };
}

/** Fake store carrying only what the two batched loaders read. */
function fakeStore(events: PostingEvent[], contentChanged: { postingId: string; at: string }[], pay: PayInfo[]): Store {
  return {
    transitionEventsAll: async () => events,
    contentChangedFirstAt: async () => contentChanged,
    allPay: async () => pay,
  } as unknown as Store;
}

console.log("== 1. batched loaders reproduce the map buildSignals consumes ==");

const fake = fakeStore(
  [
    ev("p1", "first_seen", "2026-08-01T00:00:00.000Z"),
    ev("p2", "first_seen", "2026-08-02T00:00:00.000Z"),
    ev("p1", "removed", "2026-08-05T00:00:00.000Z"),
    ev("p1", "relisted", "2026-08-07T00:00:00.000Z"),
    ev("p2", "removed", "2026-08-09T00:00:00.000Z"),
  ],
  [
    { postingId: "p1", at: "2026-08-03T12:00:00.000Z" }, // first content_changed for p1
    { postingId: "p2", at: "2026-08-04T12:00:00.000Z" },
  ],
  [{ postingId: "p1" } as PayInfo, { postingId: "p2" } as PayInfo]
);

const eventsMap = await loadEventsByPosting(fake);
// Map order is transition rows first, then the content_changed flags — that is
// fine and intentional: buildSignals re-sorts by `at` before using them, so the
// map only has to be a complete per-posting multiset.
check("p1 map entry = its 3 transitions + 1 content_changed flag", eventsMap.get("p1")?.map((e) => e.type).sort(), [
  "content_changed",
  "first_seen",
  "relisted",
  "removed",
]);
check("p2 map entry = its 2 transitions + 1 content_changed flag", eventsMap.get("p2")?.map((e) => e.type).sort(), [
  "content_changed",
  "first_seen",
  "removed",
]);
checkTrue(
  "content_changed flag carries the EARLIEST timestamp (the only bit scoring reads)",
  eventsMap.get("p1")?.some((e) => e.type === "content_changed" && e.at === "2026-08-03T12:00:00.000Z") === true
);
checkTrue(
  "one content_changed flag per posting, never one per observation",
  (eventsMap.get("p1") ?? []).filter((e) => e.type === "content_changed").length === 1
);
checkTrue("postings with no observations are simply absent (buildSignals falls back to [])", !eventsMap.has("p9"));
check("pay map is keyed by postingId", [...(await loadPayByPosting(fake)).keys()].sort(), ["p1", "p2"]);

/* ---------------- 2. live equivalence: batched vs per-posting ---------------- */

console.log("\n== 2. live equivalence: batched ctx vs per-posting store path ==");

if (!process.env.DATABASE_URL) {
  console.log("  skip DATABASE_URL unset — live equivalence section not run (nothing is written either way)");
} else {
  const store = new Store();
  try {
    const all = await store.getAll();

    // The context the compiles build (engine/daily-stats.ts, engine/report.ts):
    // identity groups keyed exactly like the callers do, plus the two batched maps.
    const identityGroups = new Map<string, PostingRecord[]>();
    for (const r of all) {
      const key = r.identityKey || r.postingId;
      const list = identityGroups.get(key) ?? [];
      list.push(r);
      identityGroups.set(key, list);
    }
    const eventsByPosting = await loadEventsByPosting(store);
    const payByPosting = await loadPayByPosting(store);
    const ctx: SignalContext = { identityGroups, eventsByPosting, payByPosting };
    const checkCounts = new Map((await store.checksByPosting()).map((c) => [c.postingId, c.count]));

    const requested = Number(process.env.COMPILE_CONTEXT_SAMPLE) > 0 ? Number(process.env.COMPILE_CONTEXT_SAMPLE) : 25;
    const sampleSize = Math.min(requested, all.length);
    // Even spread across the registry (first_seen order) so the sample is not all
    // one board or company.
    const step = sampleSize > 0 ? Math.max(1, Math.floor(all.length / sampleSize)) : 1;
    const sample: PostingRecord[] = [];
    for (let i = 0; i < all.length && sample.length < sampleSize; i += step) sample.push(all[i]);

    console.log(
      `  (registry ${all.length} postings; events map ${eventsByPosting.size} keys, pay map ${payByPosting.size} keys; sampling ${sample.length})`
    );

    let equivalent = 0;
    const mismatches: string[] = [];
    let transitionSetMismatch = 0;
    let contentFlagMismatch = 0;
    let payMismatch = 0;
    let subsetOk = 0;
    let rawEventsReplacedTotal = 0;
    let ctxFlagRows = 0;
    let refFlagRows = 0;

    for (const rec of sample) {
      const checks = checkCounts.get(rec.postingId) ?? 0;
      const batched = await buildSignals(store, rec, ctx);
      const reference = await buildSignals(store, rec);
      if (JSON.stringify(compileContract(batched, checks)) === JSON.stringify(compileContract(reference, checks))) equivalent++;
      else {
        const a = compileContract(batched, checks);
        const b = compileContract(reference, checks);
        const diffs = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
          (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])
        );
        mismatches.push(`${rec.postingId}: ${diffs.join(",")}`);
      }

      // Structural checks on the raw maps (independent of buildSignals' output):
      // the ctx events of the identity group must be exactly the reference
      // transitions, plus one content_changed flag iff the reference saw any.
      const group = identityGroups.get(rec.identityKey) ?? [];
      const groupIds = [...new Set(group.map((r) => r.postingId))].sort();
      const ctxEvents = groupIds.flatMap((id) => eventsByPosting.get(id) ?? []);
      const refEvents = (await Promise.all(groupIds.map((id) => store.eventsForPosting(id)))).flat();
      const keyOf = (e: PostingEvent) => `${e.type}|${e.at}|${e.postingId}`;
      const transitions = (list: PostingEvent[]) =>
        list
          .filter((e) => e.type === "first_seen" || e.type === "removed" || e.type === "relisted")
          .map(keyOf)
          .sort();
      if (JSON.stringify(transitions(ctxEvents)) !== JSON.stringify(transitions(refEvents))) transitionSetMismatch++;
      const ctxFlag = ctxEvents.some((e) => e.type === "content_changed");
      const refFlag = refEvents.some((e) => e.type === "content_changed");
      if (ctxFlag !== refFlag) contentFlagMismatch++;
      const ctxPay = groupIds.map((id) => payByPosting.get(id)).filter(Boolean).length;
      const refPay = (await store.getPaysForPostingIds(groupIds)).length;
      if (ctxPay !== refPay) payMismatch++;
      const ctxKeys = new Set(ctxEvents.map(keyOf));
      if (refEvents.every((e) => e.type === "content_changed" || ctxKeys.has(keyOf(e)))) subsetOk++;
      ctxFlagRows += ctxEvents.filter((e) => e.type === "content_changed").length;
      refFlagRows += refEvents.filter((e) => e.type === "content_changed").length;
      rawEventsReplacedTotal += refEvents.length;
    }

    checkTrue(
      `compile contract identical (batched ctx vs per-posting) for all ${sample.length} sampled postings`,
      mismatches.length === 0,
      mismatches.slice(0, 5).join(" | ")
    );
    check("postings with an identical compile contract", equivalent, sample.length);
    checkTrue("transition rows in ctx exactly match the reference events", transitionSetMismatch === 0, `${transitionSetMismatch} posting(s) differ`);
    checkTrue("content_changed presence matches the reference", contentFlagMismatch === 0, `${contentFlagMismatch} posting(s) differ`);
    checkTrue("pay rows in ctx exactly match getPaysForPostingIds", payMismatch === 0, `${payMismatch} posting(s) differ`);

    /* -------- 3. the ONE deliberate difference: the content_changed flood -------- */

    console.log("\n== 3. the deliberate difference: raw content_changed rows are collapsed ==");
    checkTrue("every reference transition event is present in the ctx maps", subsetOk === sample.length, `${sample.length - subsetOk} posting(s) missing a transition`);
    checkTrue(
      "ctx carries at most one content_changed row per posting in the sample",
      ctxFlagRows <= sample.length * 1 && ctxFlagRows <= refFlagRows,
      `ctx ${ctxFlagRows} vs reference ${refFlagRows}`
    );
    checkTrue(
      `raw events replaced by the batched read (${refFlagRows} content_changed rows → ${ctxFlagRows} flags over ${sample.length} postings)`,
      refFlagRows >= ctxFlagRows
    );
    console.log(
      `  (sample read ${rawEventsReplacedTotal.toLocaleString("en-US")} raw event rows through the old per-posting path; the batched ctx carries ${(
        sample.length + (rawEventsReplacedTotal - refFlagRows)
      ).toLocaleString("en-US")} rows for the same information)`
    );
  } finally {
    store.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("failures:", failures.join(" | "));
  process.exit(1);
}
