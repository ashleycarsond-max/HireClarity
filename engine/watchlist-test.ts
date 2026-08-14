/**
 * Watchlist + alert-engine test suite (runs against the real Neon store —
 * DATABASE_URL is injected into the sandbox; the live site uses the same DB).
 * Every row this test creates is cleaned up afterwards; nothing in the live
 * data is touched (no wipe, surgical deletes only).
 *
 * Run: bun run watchlist-test
 *
 * Covers (Batch 2 definition of done):
 *   1. Watch add / remove / list / token guard (removeWatchByToken).
 *   2. Alert triggers: live→removed (vanished) and relist events → candidate;
 *      pre-watch history never alerts; never re-alert the same change;
 *      last_alert_at is set on delivery; no duplicate within 24h.
 *   3. Staleness rule: 30-day threshold, one alert per 30-day milestone.
 *   4. Gating: anonymous → 401, signed-in free tier → 403 paywall, active Job
 *      Seeker → 200 (server-side, via the real HTTP handlers).
 *   5. The send pass (runWatchlistAlertPass): non-subscribers and test
 *      addresses are skipped, last_alert_at stays unset for skipped sends.
 */

import { neon } from "@neondatabase/serverless";
import { Store } from "./store";
import type { PostingRecord } from "./types";
import { evaluateWatchAlerts } from "./watchlist";
import { handleWatchHttp } from "../src/server/watch-http";
import { storeMagicLinkToken, verifyMagicLink } from "../src/server/auth";
import { upsertSubscription } from "../src/server/subscriptions";
import { runWatchlistAlertPass } from "../src/server/watch-alerts";

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

function checkTrue(label: string, cond: boolean): void {
  check(label, cond, true);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

function mkPosting(id: string, over: Partial<PostingRecord> = {}): PostingRecord {
  return {
    postingId: id,
    canonicalUrl: `https://boards.greenhouse.io/acme/jobs/fx-${encodeURIComponent(id)}`,
    requestedUrl: null,
    title: `Test Role ${id}`,
    company: "TestCo",
    location: "Remote",
    postedAt: null,
    sourceBoard: "greenhouse",
    identityKey: id,
    fingerprint: null,
    status: "live",
    relistCount: 0,
    firstSeenAt: iso(Date.now() - 10 * DAY_MS),
    lastSeenAt: iso(Date.now()),
    lastCheckedAt: iso(Date.now()),
    lastStatusCode: 200,
    lastNote: null,
    createdAt: iso(Date.now() - 10 * DAY_MS),
    ...over,
  };
}

const sql = neon(process.env.DATABASE_URL!);
const store = new Store();
const now = Date.now();
const TAG = `watch-test-${now}`;
const postings: string[] = [];
const emails: string[] = [];

/** A test email that isTestAddress would NEVER match (used for HTTP gate tests). */
function freshEmail(kind: string): string {
  const e = `${TAG}-${kind}@hc-test.dev`;
  emails.push(e);
  return e;
}

async function cleanup(): Promise<void> {
  for (const id of postings) {
    try {
      await store.deletePosting(id);
    } catch {
      /* best effort */
    }
  }
  for (const e of emails) {
    try {
      await sql.query(`DELETE FROM watchlists WHERE user_email = $1`, [e]);
      await sql.query(`DELETE FROM sessions WHERE user_email = $1`, [e]);
      await sql.query(`DELETE FROM auth_tokens WHERE email = $1`, [e]);
      await sql.query(`DELETE FROM users WHERE email = $1`, [e]);
      await sql.query(`DELETE FROM subscriptions WHERE customer_email = $1`, [e]);
      await sql.query(`DELETE FROM subscription_events WHERE customer_email = $1`, [e]);
    } catch {
      /* best effort */
    }
  }
}

async function makeSession(email: string): Promise<string> {
  const raw = `session-test-${sessionCounter++}-${"f".repeat(48)}`;
  await storeMagicLinkToken(email, raw, iso(Date.now() + 15 * 60_000));
  const res = await verifyMagicLink(raw, "/check");
  if (!res.ok || !res.sessionToken) throw new Error(`session mint failed for ${email}: ${JSON.stringify(res)}`);
  return res.sessionToken;
}
let sessionCounter = 1;

function req(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://hireclarity-data.vercel.app${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  } as RequestInit);
}

async function run(): Promise<void> {
  console.log("== watchlist store: add / list / remove / token guard ==");
  {
    const email = freshEmail("store");
    const p1 = `test-watch-${now}-p1`;
    postings.push(p1);
    await store.upsertPosting(mkPosting(p1));

    const t1 = await store.addWatch(email, p1);
    checkTrue("addWatch mints a 64-hex token", /^[0-9a-f]{64}$/.test(t1));
    const t2 = await store.addWatch(email, p1); // idempotent
    check("addWatch is idempotent (same token)", t2, t1);
    const rows = await store.listWatches(email);
    check("listWatches returns 1 row", rows.length, 1);
    check("row has the posting", rows[0]?.postingId, p1);
    check("row has last_alert_at null", rows[0]?.lastAlertAt, null);

    const byPosting = await store.listWatchesByPosting([p1, "nope"]);
    check("listWatchesByPosting finds the row", byPosting.length, 1);

    // token guard: wrong token removes nothing, correct token removes
    const wrong = await store.removeWatchByToken(email, p1, "f".repeat(64));
    check("wrong token removes nothing", wrong, false);
    const still = await store.listWatches(email);
    check("row survives a wrong token", still.length, 1);
    const right = await store.removeWatchByToken(email, p1, t1);
    check("correct token removes the watch", right, true);
    check("listWatches empty after remove", (await store.listWatches(email)).length, 0);
    const sessionRemove = await store.removeWatch(email, p1); // already gone
    check("removeWatch on missing row is false", sessionRemove, false);
  }

  console.log("== alert triggers: vanished / relisted / no-duplicate / pre-watch history ==");
  {
    const email = freshEmail("alerts");
    const pVan = `test-watch-${now}-van`;
    postings.push(pVan);
    const T0 = Date.now(); // fixed clock for the whole scenario
    const watchAt = T0 - 60 * 60_000; // watched an hour before T0
    await store.upsertPosting(mkPosting(pVan, { firstSeenAt: iso(watchAt), createdAt: iso(watchAt) }));
    const token = await store.addWatch(email, pVan);
    // The watch row's created_at is real-now; we need it back-dated to watchAt.
    await sql.query(`UPDATE watchlists SET created_at = $2 WHERE user_email = $1 AND posting_id = $3`, [email, iso(watchAt), pVan]);

    // Pre-watch history must never alert: a removal BEFORE the watch started.
    const removedAt = iso(watchAt - 2 * 60_000);
    await store.addEvent({ postingId: pVan, identityKey: pVan, type: "removed", at: removedAt, detail: "taken down" });
    await store.upsertPosting(mkPosting(pVan, { status: "removed", lastSeenAt: removedAt, lastNote: "removed" }));

    const pass1 = await evaluateWatchAlerts(store, { now: new Date(T0) });
    checkTrue("pre-watch removal does NOT alert", pass1.alerts.length === 0);
    check("pre-watch reason is honest", pass1.skipped[0]?.reason ?? "", "posting is removed and no new change since last alert");

    // Live → removed AFTER the watch started → vanished alert.
    await store.addEvent({ postingId: pVan, identityKey: pVan, type: "removed", at: iso(T0 - 30 * 60_000), detail: "taken down" });
    await store.upsertPosting(mkPosting(pVan, { status: "removed", lastSeenAt: iso(T0 - 30 * 60_000), lastNote: "removed" }));

    const pass2 = await evaluateWatchAlerts(store, { now: new Date(T0) });
    check("vanished candidate found", pass2.alerts.length, 1);
    check("vanished kind", pass2.alerts[0]?.kind, "vanished");
    check("candidate carries the watch token", pass2.alerts[0]?.watchToken, token);
    check("candidate has title", pass2.alerts[0]?.title, `Test Role ${pVan}`);

    // Simulate the send pass recording delivery, then the SAME change must
    // never re-alert (even with a last_alert_at outside the 24h window).
    await store.updateLastAlertAt(pass2.alerts[0]!.watchId, iso(T0));
    const pass3 = await evaluateWatchAlerts(store, { now: new Date(T0) });
    checkTrue("same change not re-alerted (cutoff = lastAlertAt)", pass3.alerts.length === 0);

    // 24h window: a NEW change within 24h of the last alert is suppressed.
    await store.addEvent({ postingId: pVan, identityKey: pVan, type: "relisted", at: iso(T0 + 2 * 60_000), detail: "back up" });
    await store.upsertPosting(mkPosting(pVan, { status: "relisted", relistCount: 1 }));
    const pass4 = await evaluateWatchAlerts(store, { now: new Date(T0 + 3 * 60_000) });
    checkTrue("no alert within 24h of the last one", pass4.alerts.length === 0);
    check("24h skip reason", pass4.skipped[0]?.reason ?? "", "alerted within 24h window");

    // After the 24h window, the RELIST (a different change than the one
    // alerted) fires exactly once.
    const pass5 = await evaluateWatchAlerts(store, {
      now: new Date(T0 + 25 * 60 * 60_000),
    });
    check("relist alert after 24h window", pass5.alerts.length, 1);
    check("relist kind", pass5.alerts[0]?.kind, "relisted");
    check("relist daysListed is 1 (relisted same day)", pass5.alerts[0]?.daysListed, 1);
    // Remove this watch so the later sections (which evaluate ALL watches)
    // stay hermetic — the send pass would have recorded delivery, but removal
    // is the deterministic way to keep sections isolated.
    await store.removeWatch(email, pVan);
  }

  console.log("== staleness: 30-day threshold, one alert per milestone ==");
  {
    const email = freshEmail("stale");
    const pStale = `test-watch-${now}-stale`;
    postings.push(pStale);
    const firstSeen = Date.now() - 31 * DAY_MS;
    await store.upsertPosting(mkPosting(pStale, { firstSeenAt: iso(firstSeen), createdAt: iso(firstSeen) }));
    await store.addWatch(email, pStale);
    await sql.query(`UPDATE watchlists SET created_at = $2 WHERE user_email = $1 AND posting_id = $3`, [email, iso(firstSeen), pStale]);

    const s1 = await evaluateWatchAlerts(store, { now: new Date() });
    check("stale candidate at 31 days", s1.alerts.length, 1);
    check("stale kind", s1.alerts[0]?.kind, "stale");
    check("stale daysListed is 31", s1.alerts[0]?.daysListed, 31);
    checkTrue("stale detail mentions the days", (s1.alerts[0]?.detail ?? "").includes("31"));

    // Deliver + record the milestone, then re-check a day later: no repeat.
    await store.updateLastAlertAt(s1.alerts[0]!.watchId, iso(Date.now()));
    await store.updateStaleMilestone(s1.alerts[0]!.watchId, 1);
    const s2 = await evaluateWatchAlerts(store, { now: new Date(Date.now() + 1 * DAY_MS) });
    checkTrue("no second stale alert the next day", s2.alerts.length === 0);

    // A recent change resets the continuous-listing window.
    await store.addEvent({ postingId: pStale, identityKey: pStale, type: "relisted", at: iso(Date.now() - 10 * DAY_MS), detail: "back up" });
    await store.upsertPosting(mkPosting(pStale, { status: "relisted", relistCount: 1 }));
    const s3 = await evaluateWatchAlerts(store, { now: new Date(Date.now() + 1 * DAY_MS) });
    checkTrue("recent change resets staleness window", s3.alerts.length === 0);

    // At 60+ days of continuous listing a NEW milestone fires.
    const s4 = await evaluateWatchAlerts(store, {
      now: new Date(firstSeen + 61 * DAY_MS),
      staleDays: 30,
    });
    check("second stale milestone at 61 days", s4.alerts.length, 1);
    check("second milestone daysListed is 61", s4.alerts[0]?.daysListed, 61);
  }

  console.log("== gating: anonymous 401 / free-tier 403 / seeker 200 ==");
  {
    const p = `test-watch-${now}-gate`;
    postings.push(p);
    await store.upsertPosting(mkPosting(p));

    // Anonymous: no cookie.
    const anon = await handleWatchHttp(req("POST", "/api/watch/add", { body: { postingId: p } }));
    check("anonymous add -> 401", anon?.status, 401);
    const anonList = await handleWatchHttp(req("GET", "/api/watch/list"));
    check("anonymous list -> 401", anonList?.status, 401);

    // Signed in, free tier (no subscription) -> 403 paywall.
    const freeEmail = freshEmail("free");
    const freeSession = await makeSession(freeEmail);
    const freeRes = await handleWatchHttp(req("POST", "/api/watch/add", { cookie: `hc_session=${freeSession}`, body: { postingId: p } }));
    check("free-tier add -> 403", freeRes?.status, 403);
    const freeBody = (await freeRes?.json()) as { error?: string; code?: string };
    check("free-tier paywall code", freeBody?.code, "paywall");
    checkTrue("paywall mentions Job Seeker", (freeBody?.error ?? "").includes("Job Seeker"));
    checkTrue("free user has no watch row", (await store.listWatches(freeEmail)).length === 0);

    // Active Job Seeker -> 200, watch created.
    const seekerEmail = freshEmail("seeker");
    await upsertSubscription({
      stripeSubscriptionId: `sub_test_${TAG}_seeker`,
      customerEmail: seekerEmail,
      tier: "seeker",
      status: "active",
      currentPeriodEnd: iso(Date.now() + 30 * DAY_MS),
    });
    const seekerSession = await makeSession(seekerEmail);
    const addRes = await handleWatchHttp(req("POST", "/api/watch/add", { cookie: `hc_session=${seekerSession}`, body: { postingId: p } }));
    check("seeker add -> 200", addRes?.status, 200);
    const listRes = await handleWatchHttp(req("GET", "/api/watch/list", { cookie: `hc_session=${seekerSession}` }));
    const listBody = (await listRes?.json()) as { watching?: string[] };
    check("seeker list includes the posting", listBody?.watching ?? [], [p]);

    // Seeker remove -> 200 and gone.
    const removeRes = await handleWatchHttp(req("POST", "/api/watch/remove", { cookie: `hc_session=${seekerSession}`, body: { postingId: p } }));
    check("seeker remove -> 200", removeRes?.status, 200);
    checkTrue("watch gone after remove", (await store.listWatches(seekerEmail)).length === 0);

    // One-click unwatch link: wrong token leaves the watch, right token removes.
    const token = await store.addWatch(seekerEmail, p);
    const wrong = await handleWatchHttp(req("GET", `/api/watch/remove?email=${encodeURIComponent(seekerEmail)}&posting=${encodeURIComponent(p)}&token=${"f".repeat(64)}`));
    check("token unwatch (wrong token) -> 200 page", wrong?.status, 200);
    checkTrue("watch survives wrong token", (await store.listWatches(seekerEmail)).length === 1);
    const right = await handleWatchHttp(req("GET", `/api/watch/remove?email=${encodeURIComponent(seekerEmail)}&posting=${encodeURIComponent(p)}&token=${encodeURIComponent(token)}`));
    check("token unwatch (right token) -> 200 page", right?.status, 200);
    checkTrue("watch removed by one-click link", (await store.listWatches(seekerEmail)).length === 0);

    // Missing params -> 400.
    const bad = await handleWatchHttp(req("GET", "/api/watch/remove?email=nope"));
    check("broken unwatch link -> 400", bad?.status, 400);
    // Method not allowed.
    const badMethod = await handleWatchHttp(req("PUT", "/api/watch/add"));
    check("PUT /api/watch/add -> 405", badMethod?.status, 405);
  }

  console.log("== send pass: non-subscriber and test-address skips, no false last_alert_at ==");
  {
    const p = `test-watch-${now}-send`;
    postings.push(p);
    const changedAt = Date.now() - 5 * 60_000;
    await store.upsertPosting(mkPosting(p, { status: "removed", lastSeenAt: iso(changedAt) }));
    await store.addEvent({ postingId: p, identityKey: p, type: "removed", at: iso(changedAt), detail: "taken down" });

    // Non-subscriber (no subscription row): skipped, no last_alert_at.
    const nonSubEmail = freshEmail("nonsub");
    await store.addWatch(nonSubEmail, p);
    await sql.query(`UPDATE watchlists SET created_at = $2 WHERE user_email = $1 AND posting_id = $3`, [nonSubEmail, iso(changedAt - 60_000), p]);
    const r1 = await runWatchlistAlertPass(store, { now: new Date() });
    checkTrue("non-subscriber skipped", r1.skipped.some((s) => s.reason === "no active Job Seeker subscription"));
    const w1 = await store.listWatches(nonSubEmail);
    check("non-subscriber last_alert_at stays null", w1[0]?.lastAlertAt, null);

    // Subscriber with a TEST address: skipped by the never-email-test guard.
    const testEmail = freshEmail("testaddr"); // local part contains "test"
    await upsertSubscription({
      stripeSubscriptionId: `sub_test_${TAG}_test`,
      customerEmail: testEmail,
      tier: "seeker",
      status: "active",
      currentPeriodEnd: iso(Date.now() + 30 * DAY_MS),
    });
    await store.addWatch(testEmail, p);
    await sql.query(`UPDATE watchlists SET created_at = $2 WHERE user_email = $1 AND posting_id = $3`, [testEmail, iso(changedAt - 60_000), p]);
    const r2 = await runWatchlistAlertPass(store, { now: new Date() });
    checkTrue("test address skipped", r2.skipped.some((s) => s.reason === "test/example address — never emailed"));
    const w2 = await store.listWatches(testEmail);
    check("test-address last_alert_at stays null", w2[0]?.lastAlertAt, null);
    check("nothing sent in the pass", r1.sent + r2.sent, 0);
  }

  console.log("== email copy: subjects and unwatch link ==");
  {
    const { buildWatchAlertEmail, unwatchUrl } = await import("../src/server/watch-alerts");
    const c = {
      watchId: 1,
      userEmail: "seeker@example.com",
      watchToken: "t".repeat(64),
      postingId: "greenhouse:123",
      kind: "vanished" as const,
      title: "Senior Engineer",
      canonicalUrl: "https://boards.greenhouse.io/acme/jobs/123",
      board: "greenhouse",
      daysListed: 12,
      at: iso(Date.now()),
      detail: "was taken down — it was live and is no longer listed.",
    };
    const content = buildWatchAlertEmail(c, "seeker@example.com");
    check("vanished subject", content.subject, "Alert: Senior Engineer was taken down");
    checkTrue("body has the posting URL", content.text.includes(c.canonicalUrl));
    checkTrue("body has an unwatch link", content.text.includes("/api/watch/remove?"));
    const url = unwatchUrl("seeker@example.com", c.postingId, c.watchToken);
    checkTrue("unwatch url has token + posting + email", url.includes("token=") && url.includes("posting=") && url.includes("email="));
  }
}

(async () => {
  try {
    await run();
  } finally {
    await cleanup();
  }
  console.log(fail === 0 ? `\nRESULT: ALL PASS (${pass} checks)` : `\nRESULT: ${fail} FAILURE(S) of ${pass + fail} checks`);
  if (fail > 0) {
    console.log("failures:", failures.join(" | "));
    process.exit(1);
  }
})();
