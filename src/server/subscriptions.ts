/**
 * Subscription state storage (server-only).
 *
 * Stripe webhooks write here; the access-gate helpers read here. Uses the same
 * lazy-client + CREATE TABLE IF NOT EXISTS pattern as engine/store.ts and
 * src/server/signup.ts (Neon serverless Postgres over HTTP, `$1..$n`
 * placeholders, TEXT ISO timestamps) so it works on the platform host and on
 * Vercel without migrations. DATABASE_URL is read per call — the site builds,
 * serves and runs honestly with the tables simply not existing yet.
 *
 * Tables:
 *   subscriptions      — one row per Stripe subscription (current state)
 *   subscription_events — append-only history of every webhook we processed
 *
 * Gating rule (documented in /home/team/shared/billing-README.md): a
 * subscription GRANTS access only while status = 'active' AND
 * current_period_end is in the future. Everything else revokes.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import { normalizeEmail } from "../lib/email";

export type SubscriptionTier = "seeker" | "company";

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS subscriptions (
    stripe_subscription_id TEXT PRIMARY KEY,
    customer_email          TEXT,
    stripe_customer_id      TEXT,
    tier                    TEXT,
    status                  TEXT NOT NULL,
    current_period_end      TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subscriptions_email_tier ON subscriptions(customer_email, tier)`,
  `CREATE TABLE IF NOT EXISTS subscription_events (
    id                     SERIAL PRIMARY KEY,
    event_type             TEXT NOT NULL,
    at                     TEXT NOT NULL,
    stripe_subscription_id TEXT,
    customer_email         TEXT,
    tier                   TEXT,
    detail                 TEXT
  )`,
];

// Lazy module-level client + schema init — same pattern as engine/store.ts.
let _client: NeonQueryFunction<false, false> | null = null;
let _schemaReady: Promise<void> | null = null;

function client(): NeonQueryFunction<false, false> {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set — the subscription store needs Neon. Connect the database (via the database card) and re-publish."
      );
    }
    _client = neon(url);
  }
  return _client;
}

function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      const sql = client();
      for (const ddl of SCHEMA_STATEMENTS) await sql.query(ddl);
    })().catch((err: unknown) => {
      _schemaReady = null; // allow a retry if the first init failed
      throw err;
    });
  }
  return _schemaReady;
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Normalize for storage; null when unparseable (never store garbage). */
function cleanEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return normalizeEmail(raw);
}

export interface UpsertSubscriptionInput {
  stripeSubscriptionId: string;
  customerEmail?: string | null;
  stripeCustomerId?: string | null;
  tier?: string | null;
  status: string;
  currentPeriodEnd?: string | null;
}

/**
 * Upsert the current state of one subscription. Idempotent and order-safe:
 * webhook events can arrive in any order; later events overwrite earlier ones,
 * and null/unknown fields never clobber known values (COALESCE on conflict).
 */
export async function upsertSubscription(input: UpsertSubscriptionInput): Promise<void> {
  await ensureSchema();
  const sql = client();
  const now = isoNow();
  const email = cleanEmail(input.customerEmail);
  const tier = input.tier && (input.tier === "seeker" || input.tier === "company") ? input.tier : null;
  await sql.query(
    `INSERT INTO subscriptions
       (stripe_subscription_id, customer_email, stripe_customer_id, tier, status, current_period_end, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       customer_email     = COALESCE(EXCLUDED.customer_email, subscriptions.customer_email),
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
       tier               = COALESCE(EXCLUDED.tier, subscriptions.tier),
       status             = EXCLUDED.status,
       current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
       updated_at         = EXCLUDED.updated_at`,
    [input.stripeSubscriptionId, email, input.stripeCustomerId ?? null, tier, input.status, input.currentPeriodEnd ?? null, now]
  );
}

export interface SubscriptionEventInput {
  eventType: string;
  stripeSubscriptionId?: string | null;
  customerEmail?: string | null;
  tier?: string | null;
  detail?: string | null;
}

/** Append one processed webhook event to the history table. */
export async function appendSubscriptionEvent(input: SubscriptionEventInput): Promise<void> {
  await ensureSchema();
  const sql = client();
  const tier = input.tier && (input.tier === "seeker" || input.tier === "company") ? input.tier : null;
  await sql.query(
    `INSERT INTO subscription_events (event_type, at, stripe_subscription_id, customer_email, tier, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.eventType, isoNow(), input.stripeSubscriptionId ?? null, cleanEmail(input.customerEmail), tier, input.detail ?? null]
  );
}

/**
 * The gate: does this email hold an ACTIVE subscription for this tier right
 * now? Fail-closed — any DB error becomes `false` (log it; never grant access
 * on a storage fault).
 */
export async function isSubscribed(tier: string, email: string): Promise<boolean> {
  const clean = cleanEmail(email);
  if (!clean) return false;
  if (tier !== "seeker" && tier !== "company") return false;
  try {
    await ensureSchema();
    const sql = client();
    const rows = await sql.query(
      `SELECT COUNT(*) AS n FROM subscriptions
       WHERE customer_email = $1 AND tier = $2 AND status = 'active' AND current_period_end > $3`,
      [clean, tier, isoNow()]
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch (err) {
    console.error("[subscriptions] isSubscribed check failed:", err);
    return false;
  }
}

/**
 * Every DISTINCT email currently holding an ACTIVE subscription for the tier
 * (the quarterly company-report cron's recipient list). Fail-closed on errors:
 * an empty list — never a crash or a partial grant.
 */
export async function listActiveSubscribers(tier: string): Promise<string[]> {
  if (tier !== "seeker" && tier !== "company") return [];
  try {
    await ensureSchema();
    const sql = client();
    const rows = await sql.query(
      `SELECT DISTINCT customer_email AS email FROM subscriptions
       WHERE customer_email IS NOT NULL AND tier = $1 AND status = 'active' AND current_period_end > $2`,
      [tier, isoNow()]
    );
    return rows
      .map((r) => cleanEmail(r.email))
      .filter((e): e is string => e !== null)
      .sort();
  } catch (err) {
    console.error("[subscriptions] listActiveSubscribers failed:", err);
    return [];
  }
}
