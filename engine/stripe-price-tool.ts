/**
 * Stripe single-tier retirement + verification (owner decision 2026-08-14):
 * the $149 Company tier is RETIRED — $9/month is the ONE product for everyone.
 *
 * What it does:
 *   1. Live Stripe: for the company product (metadata hireclarity_tier=company),
 *      deactivates EVERY active MONTHLY price (this retires price
 *      price_1U46TkRjxUbpCh6lB6pWN79g / any other active $149 price so nothing
 *      can ever be checked out against it).
 *   2. Clears the Neon stripe_meta company cache (price:company + every
 *      price_tier:<id> row with value 'company') so the cached $149 price id is
 *      never reused.
 *   3. Confirms TIERS contains ONLY the single $9 product and that
 *      ensurePrice("company") now throws (the retired tier can't be resolved).
 *   4. Verifies: the seeker $9 price (price_1U4QGCRjxUbpCh6l78VYQJo1) is active
 *      and the only active monthly seeker price; the old $25 price stays
 *      retired; the company $149 price is now active=false; a checkout session
 *      for the single product returns a cs_live_ URL whose line item is the $9
 *      price. Fails loudly (non-zero exit) on any mismatch.
 *
 * Run: bun run engine/stripe-price-tool.ts        (retire + verify)
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

async function clearCompanyCache(): Promise<void> {
  await sql.query(
    `INSERT INTO stripe_meta (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    ["price:company", JSON.stringify({ priceId: "RETIRED", productId: "RETIRED" }), iso()]
  );
  const rows = await sql.query(`SELECT key FROM stripe_meta WHERE key LIKE 'price_tier:%' AND value = 'company'`);
  for (const r of rows) {
    await sql.query(`DELETE FROM stripe_meta WHERE key = $1`, [String(r.key)]);
  }
  console.log(`  ok   cleared company price cache (${rows.length} price_tier row(s) + price:company -> RETIRED)`);
}

async function main() {
  console.log("TIERS config:", JSON.stringify(TIERS));
  check("TIERS has exactly ONE entry", Object.keys(TIERS).length === 1, Object.keys(TIERS).join(","));
  check("TIERS.seeker is 900 cents", TIERS.seeker.amountCents === 900, `${TIERS.seeker.amountCents}`);
  check("TIERS has NO company entry", !("company" in TIERS), "company tier removed");

  // ensurePrice("company") must now throw — the retired tier is unresolvable.
  try {
    await ensurePrice("company" as never);
    check("ensurePrice('company') rejects", false, "resolved a company price — unexpected");
  } catch (err) {
    check("ensurePrice('company') rejects", true, err instanceof Error ? err.message : "threw");
  }

  const products = await stripe.products.list({ limit: 100, active: true });
  const seekerProduct = products.data.find((p) => p.metadata?.hireclarity_tier === "seeker");
  const companyProduct = products.data.find((p) => p.metadata?.hireclarity_tier === "company");
  check("seeker product exists in live Stripe", Boolean(seekerProduct), seekerProduct?.id);
  check("company product exists in live Stripe", Boolean(companyProduct), companyProduct?.id);

  // Retire the company product's active monthly prices ($149) — clean swap, no
  // subscribers existed (owner decision 2026-08-14).
  if (companyProduct) {
    const prices = await stripe.prices.list({ product: companyProduct.id, limit: 100 });
    console.log(`  company product prices (${prices.data.length}):`);
    let retired = 0;
    for (const p of prices.data) {
      const monthly = p.type === "recurring" && p.recurring?.interval === "month";
      console.log(
        `    ${p.id} | $${(p.unit_amount ?? 0) / 100}/mo | active=${p.active} | monthly=${monthly}`
      );
      if (monthly && p.active) {
        await stripe.prices.update(p.id, { active: false });
        retired++;
        console.log(`    -> deactivated retired $${(p.unit_amount ?? 0) / 100} price ${p.id}`);
      }
    }
    check("deactivated every active monthly company price", retired >= 1, `${retired} price(s) deactivated`);
  }
  await clearCompanyCache();

  // The $149 price itself must now be inactive.
  const legacy149 = await stripe.prices.retrieve("price_1U46TkRjxUbpCh6lB6pWN79g").catch(() => null);
  check("company $149 price is inactive", Boolean(legacy149 && legacy149.active === false), legacy149?.id ?? "retrieve failed");

  // Seeker side untouched: exactly one active monthly $9 price.
  const allSeeker = await stripe.prices.list({ product: seekerProduct!.id, limit: 100 });
  const activeMonthly = allSeeker.data.filter(
    (p) => p.active && p.type === "recurring" && p.recurring?.interval === "month"
  );
  check("exactly one active monthly seeker price", activeMonthly.length === 1, activeMonthly.map((p) => p.id).join(","));
  check("active seeker price is $9", activeMonthly.length === 1 && activeMonthly[0].unit_amount === 900);
  check(
    "active seeker price is price_1U4QGCRjxUbpCh6l78VYQJo1",
    activeMonthly.length === 1 && activeMonthly[0].id === "price_1U4QGCRjxUbpCh6l78VYQJo1",
    activeMonthly[0]?.id ?? "none"
  );
  const retired25 = allSeeker.data.find(
    (p) => (p.unit_amount ?? 0) === 2500 && p.type === "recurring" && p.recurring?.interval === "month"
  );
  check("old $25 price stays retired (inactive)", retired25 ? retired25.active === false : true, retired25?.id ?? "none found");

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
    linePrice?.unit_amount === 900 && linePrice?.active && linePrice?.id === "price_1U4QGCRjxUbpCh6l78VYQJo1",
    linePrice ? `${linePrice.id} ($${(linePrice.unit_amount ?? 0) / 100}/mo)` : "no line item"
  );

  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS — single $9 product live, $149 company retired, cache cleared");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
