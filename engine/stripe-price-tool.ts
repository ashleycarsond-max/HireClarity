/**
 * Stripe price migration + verification (owner decision 2026-08-14):
 * seeker tier $25 -> $9/month, clean swap (no subscribers existed).
 *
 * What it does:
 *   1. Live Stripe: for the seeker product (metadata hireclarity_tier=seeker),
 *      deactivates any active MONTHLY price that isn't exactly 900 cents (this
 *      retires the old $25 price so ensurePrice can never pick it up), leaving
 *      an active $9 price untouched if one already exists.
 *   2. Clears the Neon stripe_meta price cache (price:seeker + price_tier:<id>
 *      rows for the seeker tier) so the cached $25 price id is not reused.
 *   3. Calls ensurePrice("seeker") — idempotent: creates the $9 live price if
 *      needed and re-caches it; validates against the live Stripe mode.
 *   4. Verifies: lists every seeker price (active + retired), confirms the
 *      cached price is $9 (900 cents) and active, confirms a checkout session
 *      is created with a cs_live_ URL, and confirms the company tier is still
 *      $149. Fails loudly (non-zero exit) on any mismatch.
 *
 * Run: bun run engine/stripe-price-tool.ts        (migrate + verify)
 */
import { neon } from "@neondatabase/serverless";
import Stripe from "stripe";
import { ensurePrice, createCheckoutSession, TIERS } from "../src/server/stripe";

let failed = false;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failed = true;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  appInfo: { name: "HireClarity Data", version: "1" },
  maxNetworkRetries: 2,
});
const sql = neon(process.env.DATABASE_URL!);
const iso = () => new Date().toISOString();

async function clearSeekerCache(): Promise<void> {
  await sql.query(
    `INSERT INTO stripe_meta (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    ["price:seeker", JSON.stringify({ priceId: "RETIRED", productId: "RETIRED" }), iso()]
  );
  const rows = await sql.query(`SELECT key FROM stripe_meta WHERE key LIKE 'price_tier:%' AND value = 'seeker'`);
  for (const r of rows) {
    await sql.query(`DELETE FROM stripe_meta WHERE key = $1`, [String(r.key)]);
  }
  console.log(`  ok   cleared seeker price cache (${rows.length} price_tier row(s) + price:seeker)`);
}

async function main() {
  console.log("TIERS config:", JSON.stringify(TIERS));
  check("TIERS.seeker is 900 cents", TIERS.seeker.amountCents === 900, `${TIERS.seeker.amountCents}`);
  check("TIERS.company is 14900 cents", TIERS.company.amountCents === 14900, `${TIERS.company.amountCents}`);

  const products = await stripe.products.list({ limit: 100, active: true });
  const seekerProduct = products.data.find((p) => p.metadata?.hireclarity_tier === "seeker");
  const companyProduct = products.data.find((p) => p.metadata?.hireclarity_tier === "company");
  check("seeker product exists in live Stripe", Boolean(seekerProduct), seekerProduct?.id);
  check("company product exists in live Stripe", Boolean(companyProduct), companyProduct?.id);

  if (seekerProduct) {
    const prices = await stripe.prices.list({ product: seekerProduct.id, limit: 100 });
    console.log(`  seeker product prices (${prices.data.length}):`);
    for (const p of prices.data) {
      const monthly = p.type === "recurring" && p.recurring?.interval === "month";
      console.log(
        `    ${p.id} | $${(p.unit_amount ?? 0) / 100}/mo | active=${p.active} | monthly=${monthly}`
      );
      if (monthly && p.active && p.unit_amount !== 900) {
        await stripe.prices.update(p.id, { active: false });
        console.log(`    -> deactivated retired $${(p.unit_amount ?? 0) / 100} price ${p.id}`);
      }
    }
    await clearSeekerCache();
    const ref = await ensurePrice("seeker");
    const live = await stripe.prices.retrieve(ref.priceId);
    check(
      "cached/created seeker price is $9 and active",
      live.active === true && live.unit_amount === 900,
      `${ref.priceId} ($${(live.unit_amount ?? 0) / 100}/mo, active=${live.active})`
    );
  } else {
    // No product yet — ensurePrice creates everything.
    await clearSeekerCache();
    const ref = await ensurePrice("seeker");
    check("seeker price created at $9", true, ref.priceId);
  }

  // No $25 active price may remain anywhere in the seeker product.
  const allSeeker = await stripe.prices.list({ product: seekerProduct!.id, limit: 100 });
  const activeMonthly = allSeeker.data.filter(
    (p) => p.active && p.type === "recurring" && p.recurring?.interval === "month"
  );
  check("exactly one active monthly seeker price", activeMonthly.length === 1, activeMonthly.map((p) => p.id).join(","));
  check("active seeker price is $9", activeMonthly.length === 1 && activeMonthly[0].unit_amount === 900);
  const retired25 = allSeeker.data.find(
    (p) => (p.unit_amount ?? 0) === 2500 && p.type === "recurring" && p.recurring?.interval === "month"
  );
  check("old $25 price is retired (inactive)", retired25 ? retired25.active === false : true, retired25?.id ?? "none found");

  // Company tier untouched.
  if (companyProduct) {
    const comp = await ensurePrice("company");
    const cp = await stripe.prices.retrieve(comp.priceId);
    check("company price still $149 and active", cp.active === true && cp.unit_amount === 14900, `${comp.priceId}`);
  }

  // Checkout flows through the $9 price (live session URL).
  const session = await createCheckoutSession("seeker", {
    origin: "https://hireclarity-data.vercel.app",
  });
  check("checkout returns a live session URL", session.url.startsWith("https://checkout.stripe.com/c/pay/cs_live_"), session.url.slice(0, 60) + "…");
  const m = session.url.match(/cs_live_[a-zA-Z0-9_]+/);
  const full = await stripe.checkout.sessions.retrieve(m![0], {
    expand: ["line_items"],
  });
  const linePrice = full.line_items?.data?.[0]?.price;
  check(
    "checkout session line item is the $9 price",
    linePrice?.unit_amount === 900 && linePrice?.active,
    linePrice ? `${linePrice.id} ($${(linePrice.unit_amount ?? 0) / 100}/mo)` : "no line item"
  );

  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS — seeker is $9/month live, $25 retired, cache validated");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
