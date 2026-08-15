/**
 * Stripe integration (server-only).
 *
 * Lazy initialization mirroring the Neon pattern: the 'stripe' package and the
 * secret key are only touched when a billing operation actually runs, so the
 * site builds, serves and behaves honestly with STRIPE_* keys absent (the
 * checkout endpoint returns "billing not configured yet" and the webhook
 * endpoint acknowledges without recording).
 *
 * Key design points (full detail in /home/team/shared/billing-README.md):
 *  - TIERS: the ONE product — seeker -> $9/mo (900 cents). The former Company
 *    tier (monthly, at the retired higher price) was RETIRED (owner decision
 *    2026-08-14): TIERS contains only the single $9 product, so
 *    ensurePrice("company") throws and nothing can ever create/checkout the
 *    retired price again.
 *  - ensurePrice() is idempotent: products/prices are looked up by the
 *    `hireclarity_tier` metadata key before anything is created, and price IDs
 *    are cached in Neon (`stripe_meta` table) so repeated calls are cheap.
 *  - createCheckoutSession() makes a Stripe Checkout subscription session.
 *  - The webhook verifies signatures with STRIPE_WEBHOOK_SECRET and writes
 *    subscription state via src/server/subscriptions.ts.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import Stripe from "stripe";

import { normalizeEmail } from "../lib/email";
import { appendSubscriptionEvent, isoNow, upsertSubscription } from "./subscriptions";

export type SubscriptionTier = "seeker";

export const TIERS: Record<
  SubscriptionTier,
  { productName: string; amountCents: number }
> = {
  seeker: { productName: "HireClarity Data", amountCents: 900 }, // $9/mo — the ONE product for everyone (owner decision 2026-08-14)
};

export function isTier(t: unknown): t is SubscriptionTier {
  return t === "seeker";
}

export function isBillingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function isWebhookConfigured(): boolean {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

/* ------------------------------ stripe client ------------------------------ */

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not set — billing is not configured.");
    }
    _stripe = new Stripe(key, {
      appInfo: { name: "HireClarity Data", version: "1" },
      maxNetworkRetries: 2,
    });
  }
  return _stripe;
}

/* ------------------------------ stripe_meta ------------------------------- */
// Price-id cache in Neon (key -> value). Purely a convenience: if Neon is
// unreachable, ensurePrice falls back to listing products from Stripe (the
// metadata lookup is the real idempotency mechanism), so a Neon outage never
// breaks checkout.

const META_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stripe_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

let _metaClient: NeonQueryFunction<false, false> | null = null;
let _metaReady: Promise<void> | null = null;

function metaClient(): NeonQueryFunction<false, false> {
  if (!_metaClient) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set — cannot use the price cache.");
    _metaClient = neon(url);
  }
  return _metaClient;
}

async function ensureMetaSchema(): Promise<void> {
  if (!_metaReady) {
    _metaReady = (async () => {
      const sql = metaClient();
      for (const ddl of META_SCHEMA) await sql.query(ddl);
    })().catch((err: unknown) => {
      _metaReady = null;
      throw err;
    });
  }
  return _metaReady;
}

async function getMetaSafe(key: string): Promise<string | null> {
  try {
    await ensureMetaSchema();
    const sql = metaClient();
    const rows = await sql.query(`SELECT value FROM stripe_meta WHERE key = $1`, [key]);
    return rows[0] ? String(rows[0].value) : null;
  } catch (err) {
    console.warn("[stripe] price-cache read failed (continuing without it):", err);
    return null;
  }
}

async function setMetaSafe(key: string, value: string): Promise<void> {
  try {
    await ensureMetaSchema();
    const sql = metaClient();
    await sql.query(
      `INSERT INTO stripe_meta (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, value, isoNow()]
    );
  } catch (err) {
    console.warn("[stripe] price-cache write failed (continuing without it):", err);
  }
}

/* -------------------------------- prices ---------------------------------- */

export interface PriceRef {
  priceId: string;
  productId: string;
}

/**
 * Idempotently return the Stripe price for a tier.
 *
 * Order: (1) Neon cache, (2) Stripe lookup by product metadata
 * `hireclarity_tier`, (3) create product + monthly recurring price. Nothing is
 * ever duplicated: every create path stores the metadata key, and every
 * repeated call finds what already exists. Works across accounts and across a
 * lost/emptied Neon cache.
 */
export async function ensurePrice(tier: SubscriptionTier): Promise<PriceRef> {
  const cfg = TIERS[tier];
  if (!cfg) throw new Error(`unknown tier: ${String(tier)}`);
  const stripe = getStripe();

  // 1. Neon cache (cheap fast path).
  const cached = await getMetaSafe(`price:${tier}`);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as PriceRef;
      if (parsed.priceId && parsed.productId) {
        // Verify the cached price still exists in THIS Stripe account/mode —
        // a key rotation (e.g. test→live) leaves stale IDs in the cache, and
        // serving them would break checkout with a "no such price" error.
        const check = await stripe.prices.retrieve(parsed.priceId).catch(() => null);
        if (check?.active) return parsed;
      }
    } catch {
      // stale/corrupt cache value — fall through to Stripe lookup
    }
  }

  // 2. Look up by product metadata — idempotent across calls and processes.
  const products = await stripe.products.list({ limit: 100, active: true });
  const product = products.data.find((p) => p.metadata?.hireclarity_tier === tier);
  if (product) {
    const prices = await stripe.prices.list({ product: product.id, limit: 100, active: true });
    const monthly = prices.data.find(
      (p) => p.type === "recurring" && p.recurring?.interval === "month"
    );
    if (monthly) {
      const ref: PriceRef = { priceId: monthly.id, productId: product.id };
      await setMetaSafe(`price:${tier}`, JSON.stringify(ref));
      await setMetaSafe(`price_tier:${monthly.id}`, tier);
      return ref;
    }
    // Product exists but no monthly recurring price yet — attach one.
    const created = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: cfg.amountCents,
      recurring: { interval: "month" },
      metadata: { hireclarity_tier: tier },
    });
    const ref: PriceRef = { priceId: created.id, productId: product.id };
    await setMetaSafe(`price:${tier}`, JSON.stringify(ref));
    await setMetaSafe(`price_tier:${created.id}`, tier);
    return ref;
  }

  // 3. Create product + price.
  const createdProduct = await stripe.products.create({
    name: cfg.productName,
    metadata: { hireclarity_tier: tier, hireclarity_plan: "monthly" },
  });
  const createdPrice = await stripe.prices.create({
    product: createdProduct.id,
    currency: "usd",
    unit_amount: cfg.amountCents,
    recurring: { interval: "month" },
    metadata: { hireclarity_tier: tier },
  });
  const ref: PriceRef = { priceId: createdPrice.id, productId: createdProduct.id };
  await setMetaSafe(`price:${tier}`, JSON.stringify(ref));
  await setMetaSafe(`price_tier:${createdPrice.id}`, tier);
  return ref;
}

/* ----------------------------- checkout ----------------------------------- */

export interface CheckoutOptions {
  /** Origin of the requesting site (used for success/cancel URLs). */
  origin: string;
  /** Optional customer email — becomes the access key for gating. */
  email?: string | null;
}

export async function createCheckoutSession(
  tier: SubscriptionTier,
  opts: CheckoutOptions
): Promise<{ url: string }> {
  const stripe = getStripe();
  const { priceId } = await ensurePrice(tier);

  const email = opts.email ? normalizeEmail(opts.email) : null;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${opts.origin}/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${opts.origin}/#pricing`,
    // Metadata on the session AND the subscription: the webhook resolves the
    // tier from these even if the price metadata is ever missing.
    metadata: { hireclarity_tier: tier },
    subscription_data: { metadata: { hireclarity_tier: tier } },
    customer_email: email ?? undefined,
    allow_promotion_codes: false,
  });

  if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
  return { url: session.url };
}

/* ------------------------------- webhook ---------------------------------- */

export type WebhookVerifyResult =
  | { ok: true; event: Stripe.Event }
  | { ok: false; reason: "not-configured" | "invalid"; message?: string };

/**
 * Verify a webhook payload against STRIPE_WEBHOOK_SECRET. When the secret is
 * absent the endpoint is acknowledged WITHOUT verification (see README for the
 * decision) — this never crashes the site.
 */
export function verifyWebhook(rawBody: string, signature: string | null): WebhookVerifyResult {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "not-configured" };
  if (!signature) return { ok: false, reason: "invalid", message: "missing stripe-signature header" };
  try {
    const event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
    return { ok: true, event };
  } catch (err) {
    return {
      ok: false,
      reason: "invalid",
      message: err instanceof Error ? err.message : "signature verification failed",
    };
  }
}

function cleanTier(t: unknown): SubscriptionTier | null {
  return isTier(t) ? t : null;
}

/** Resolve tier from a checkout session's metadata. */
function tierFromSession(session: Stripe.Checkout.Session): SubscriptionTier | null {
  return cleanTier(session.metadata?.hireclarity_tier);
}

/** Resolve tier from a subscription: price metadata → sub metadata → price cache. */
async function tierFromSubscription(sub: Stripe.Subscription): Promise<SubscriptionTier | null> {
  const price = sub.items?.data?.[0]?.price;
  if (price) {
    const fromPriceMeta = cleanTier(price.metadata?.hireclarity_tier);
    if (fromPriceMeta) return fromPriceMeta;
    const cached = await getMetaSafe(`price_tier:${price.id}`);
    if (cached) {
      const fromCache = cleanTier(cached);
      if (fromCache) return fromCache;
    }
  }
  return cleanTier(sub.metadata?.hireclarity_tier);
}

/** Best-effort: fetch a customer's email from Stripe (webhook subs don't carry it). */
async function fetchCustomerEmail(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  try {
    const customer = await getStripe().customers.retrieve(customerId);
    if (!customer.deleted && customer.email) return customer.email;
  } catch (err) {
    console.warn("[stripe] could not fetch customer for email:", err);
  }
  return null;
}

function unixToIso(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Persist one Stripe webhook event into Neon (subscriptions + history).
 * Unknown event types are acknowledged but not stored. Throws on storage
 * failure so the endpoint can return 500 and Stripe retries.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  const at = isoNow();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const tier = tierFromSession(session);
      const email = session.customer_details?.email ?? null;
      const customerId = typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
      const subId = typeof session.subscription === "string" ? session.subscription : (session.subscription?.id ?? null);

      if (!subId) {
        // One-off payment or non-subscription checkout — not ours to record.
        await appendSubscriptionEvent({
          eventType: event.type,
          stripeSubscriptionId: null,
          customerEmail: email,
          tier,
          detail: JSON.stringify({ note: "no subscription on session — ignored", customerId }),
        });
        return;
      }

      // Payment completed => the subscription is live; fetch it for the
      // authoritative status/period (subscription.created/updated events also
      // arrive and overwrite — this just makes access immediate and correct).
      let status = "active";
      let periodEnd: string | null = null;
      try {
        const sub = await getStripe().subscriptions.retrieve(subId);
        status = sub.status;
        periodEnd = unixToIso(sub.current_period_end);
      } catch (err) {
        console.error("[stripe] could not fetch subscription for checkout session:", err);
      }

      await upsertSubscription({
        stripeSubscriptionId: subId,
        customerEmail: email,
        stripeCustomerId: customerId,
        tier,
        status,
        currentPeriodEnd: periodEnd,
      });
      await appendSubscriptionEvent({
        eventType: event.type,
        stripeSubscriptionId: subId,
        customerEmail: email,
        tier,
        detail: JSON.stringify({ status, periodEnd, customerId, at }),
      });
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const subId = sub.id;
      const status = sub.status;
      const periodEnd = unixToIso(sub.current_period_end);
      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      const tier = await tierFromSubscription(sub);
      const email = await fetchCustomerEmail(customerId);

      await upsertSubscription({
        stripeSubscriptionId: subId,
        customerEmail: email,
        stripeCustomerId: customerId,
        tier,
        status,
        currentPeriodEnd: periodEnd,
      });
      await appendSubscriptionEvent({
        eventType: event.type,
        stripeSubscriptionId: subId,
        customerEmail: email,
        tier,
        detail: JSON.stringify({ status, periodEnd, customerId, cancelAtPeriodEnd: sub.cancel_at_period_end ?? false }),
      });
      return;
    }

    default:
      // Acknowledged (200) but not stored — nothing we need to persist.
      return;
  }
}
