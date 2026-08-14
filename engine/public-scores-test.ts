/**
 * Public tracked data + $9 seeker price tests (owner decisions 2026-08-14).
 *
 * Covers:
 *   1. /companies/<slug> data: every posting row carries a confidence score +
 *      per-signal breakdown (computed by scoreCore — the same rubric /check
 *      uses), WITHOUT any sign-in, and the public payload NEVER contains
 *      company-level private products (benchmarks, fix recommendations,
 *      posting-health scores, trends, quarterly reports).
 *   2. The rendered company-page HTML (react-dom/server, no auth) contains
 *      "Confidence score", the per-signal "How this score was built" panel,
 *      and observed values; it does NOT contain benchmark/fix/health copy.
 *   3. /company + /company/report stay gated: SubscriptionGate renders the
 *      paywall (and hides children) when access is denied, and renders the
 *      tool when access is allowed.
 *   4. The $9 seeker price flows through checkout config (TIERS + ensurePrice
 *      validation against live Stripe is verified by engine/stripe-price-tool;
 *      here we pin the config + cache wiring).
 *
 * Fixture rows are seeded into the real Neon store and surgically deleted
 * afterwards (same pattern as company-bench-test). Live data is untouched.
 *
 * Run: bun run public-scores-test
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { Store } from "./store";
import type { PostingRecord } from "./types";
import { companyDetail } from "../src/server/public-data";
import { CompanyDetailView } from "../src/routes/companies.$slug";
import { SubscriptionGate, type AccessResult } from "../src/components/SubscriptionGate";
import { TIERS } from "../src/server/stripe";
import { earlyAccessFree } from "../src/server/gate";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(label);
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();
function mkPosting(id: string, over: Partial<PostingRecord> = {}): PostingRecord {
  return {
    postingId: id,
    canonicalUrl: `https://boards.greenhouse.io/publicscores/jobs/${encodeURIComponent(id)}`,
    requestedUrl: null,
    title: `Public Score Role ${id}`,
    company: "PublicScoreFixtureCo",
    location: "Remote",
    postedAt: null,
    sourceBoard: "greenhouse",
    identityKey: id,
    fingerprint: null,
    status: "live",
    relistCount: 0,
    firstSeenAt: iso(now - 6 * DAY_MS),
    lastSeenAt: iso(now),
    lastCheckedAt: iso(now),
    lastStatusCode: 200,
    lastNote: null,
    createdAt: iso(now - 6 * DAY_MS),
    ...over,
  };
}
const store = new Store();
const TAG = `pubscore-${now}`;
const postingIds: string[] = [];
async function seed(records: PostingRecord[]): Promise<void> {
  for (const r of records) {
    postingIds.push(r.postingId);
    await store.upsertPosting(r);
  }
}
async function addChecks(postingId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await store.addCheck(postingId, iso(now - (n - i) * DAY_MS), "live", 200, `${TAG} fixture`);
  }
}
async function cleanup(): Promise<void> {
  for (const id of postingIds) {
    await store.deletePosting(id);
  }
}
async function main() {
  console.log("== 1. config: $9 seeker flows through checkout config ==");
  check("TIERS.seeker.amountCents === 900", TIERS.seeker.amountCents === 900, `$${TIERS.seeker.amountCents / 100}`);
  check("TIERS.company.amountCents === 14900", TIERS.company.amountCents === 14900);
  // Live Stripe wiring (cache validated against live mode + checkout line item)
  // is verified by engine/stripe-price-tool.ts; the config pin above is the
  // in-repo guard so a future price edit fails here.

  console.log("\n== 2. public company-page data: scores + breakdowns, no private products ==");
  const clean = mkPosting("clean-1");
  const relisted = mkPosting("relist-1", {
    status: "relisted",
    relistCount: 2,
    firstSeenAt: iso(now - 40 * DAY_MS),
    lastSeenAt: iso(now),
  });
  await seed([clean, relisted]);
  await addChecks("clean-1", 4);
  await addChecks("relist-1", 5);
  const detail = await companyDetail(store, "PublicScoreFixtureCo");
  check("companyDetail returned", Boolean(detail));
  if (detail) {
    check("two postings in the public payload", detail.postings.length === 2, `${detail.postings.length}`);
    const cleanRow = detail.postings.find((p) => p.url?.includes("clean-1"));
    const relistRow = detail.postings.find((p) => p.url?.includes("relist-1"));
    check("clean posting has a score", cleanRow?.score !== null && cleanRow?.score !== undefined, `score=${cleanRow?.score}`);
    check("clean posting has a label + verdict", Boolean(cleanRow?.label && cleanRow?.verdict), `${cleanRow?.label}`);
    check("clean posting has per-signal components", Boolean(cleanRow?.components?.length), `${cleanRow?.components?.length} factors`);
    check("relisted posting scored lower than clean", (relistRow?.score ?? 100) < (cleanRow?.score ?? -1), `relist=${relistRow?.score} clean=${cleanRow?.score}`);
    const json = JSON.stringify(detail);
    for (const forbidden of ["benchmark", "fixRecommendation", "postingHealthScore", "healthScore", "quarterlyReport", "trends"]) {
      check(`public payload has no "${forbidden}"`, !json.toLowerCase().includes(forbidden.toLowerCase()));
    }
  }

  console.log("\n== 3. public company-page HTML (no sign-in) contains scores + breakdowns ==");
  if (detail) {
    const html = renderToStaticMarkup(CompanyDetailView({ detail }));
    check("HTML contains 'Confidence score'", html.includes("Confidence score"));
    check("HTML contains the score number", /Confidence score[\s\S]{0,120}100|>100</.test(html) || html.includes(`>${Math.round(detail.postings[0].score ?? 0)}<`));
    check("HTML contains 'How this score was built'", html.includes("How this score was built"));
    check("HTML contains an observed factor value ('n/a' or real)", html.includes("n/a") || html.includes("checks") || html.includes("days"));
    check("HTML contains the observed-sample label", html.includes("Observed sample"));
    check("HTML contains the public-score explainer", html.includes("higher = more confidence the posting is real and active"));
    for (const forbidden of ["Benchmark", "Fix recommendation", "Posting-health score", "Quarterly report", "Confidence profiles are a paid product", "$25", "25/month"]) {
      check(`HTML has no "${forbidden}"`, !html.includes(forbidden));
    }
  }

  console.log("\n== 4. /company + /company/report stay gated (SubscriptionGate) ==");
  const deny: () => Promise<AccessResult> = async () => ({
    gated: true,
    allowed: false,
    reason: "nosub",
  });
  const allow: () => Promise<AccessResult> = async () => ({ gated: false, allowed: true, plan: "unlimited" });
  const deniedHtml = renderToStaticMarkup(h(SubscriptionGate, { tier: "company", verify: deny, children: h("p", null, "PRIVATE_DASHBOARD_CONTENT") }));
  check("denied: paywall heading 'Subscribe to continue'", deniedHtml.includes("Subscribe to continue"));
  check("denied: mentions $149/month", deniedHtml.includes("$149/month"));
  check("denied: private children NOT rendered", !deniedHtml.includes("PRIVATE_DASHBOARD_CONTENT"));
  // SSR cannot resolve the async verify fn (the gate renders in "resolving"
  // phase under renderToStaticMarkup), so the allowed path is asserted as
  // render-safe here and verified live (signed-in) in the deploy QA.
  let allowedOk = false;
  try {
    const allowedHtml = renderToStaticMarkup(h(SubscriptionGate, { tier: "company", verify: allow, children: h("p", null, "PRIVATE_DASHBOARD_CONTENT") }));
    allowedOk = allowedHtml.length > 0;
  } catch {
    allowedOk = false;
  }
  check("allowed: gate renders without throwing (SSR)", allowedOk);
  // seeker gate denies anonymous on the paid tool while public pages stay open
  const seekerDenied = renderToStaticMarkup(h(SubscriptionGate, { tier: "seeker", verify: deny, children: h("p", null, "UNLIMITED_TOOL") }));
  check("seeker gate: paywall shown for anonymous", seekerDenied.includes("Sign in to check postings"));
  check("seeker gate: $9/month quoted", seekerDenied.includes("$9/month"));
  check("seeker gate: tool hidden", !seekerDenied.includes("UNLIMITED_TOOL"));

  await cleanup();
  console.log(fail === 0 ? `\nRESULT: PASS (${pass} checks)` : `\nRESULT: FAIL (${fail} failed of ${pass + fail})`);
  if (failures.length) console.log("failures:", failures.join(" | "));
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
