/**
 * Free-tier usage counting (server-only).
 *
 * The owner-approved free tier (2026-08-14): every signed-in account gets 5
 * posting checks per calendar month (UTC) at $0. A check counts only when it
 * produces a score result — failed or invalid submissions never consume.
 *
 * Uses the same lazy-client + CREATE TABLE IF NOT EXISTS pattern as
 * subscriptions.ts / auth.ts / signup.ts (Neon serverless Postgres over HTTP,
 * `$1..$n` placeholders, TEXT ISO timestamps) so it works on the platform host
 * and on Vercel without migrations. DATABASE_URL is read per call.
 *
 * Table:
 *   usage — one row per (user, UTC month): checks_used for that month.
 *     PRIMARY KEY (user_email, month) keeps a re-created row (new month) from
 *     conflicting with the previous month's row.
 */
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { normalizeEmail } from "../lib/email";

/** Owner decision (2026-08-14): 5 free posting checks per account per month. */
export const FREE_MONTHLY_CHECKS = 5;

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS usage (
    user_email  TEXT NOT NULL,
    month       TEXT NOT NULL,
    checks_used INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (user_email, month)
  )`,
];

// Lazy module-level client + schema init — same pattern as subscriptions.ts.
let _client: NeonQueryFunction<false, false> | null = null;
let _schemaReady: Promise<void> | null = null;
function client(): NeonQueryFunction<false, false> {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set — the usage store needs Neon. Connect the database (via the database card) and re-publish."
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

/** Current free-tier month as "YYYY-MM" in UTC (resets monthly, UTC midnight). */
export function usageMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * How many scored checks this account has used this month. 0 when the account
 * has no row yet. Throws on storage errors — callers fail closed on that
 * (never over-grant free access on a DB fault).
 */
export async function getChecksUsed(
  rawEmail: string | null | undefined
): Promise<number> {
  const email = normalizeEmail(rawEmail);
  if (!email) return 0;
  await ensureSchema();
  const sql = client();
  const rows = await sql.query(
    `SELECT checks_used FROM usage WHERE user_email = $1 AND month = $2`,
    [email, usageMonth()]
  );
  return Number(rows[0]?.checks_used ?? 0);
}

/**
 * Record one scored check for this account this month and return the new total
 * for the month. Atomic single-statement UPSERT (INSERT ... ON CONFLICT DO
 * UPDATE ... RETURNING) — safe under concurrent requests. Throws on storage
 * errors so the caller can fail closed.
 */
export async function incrementChecksUsed(
  rawEmail: string | null | undefined
): Promise<number> {
  const email = normalizeEmail(rawEmail);
  if (!email) return 0;
  await ensureSchema();
  const sql = client();
  const rows = await sql.query(
    `INSERT INTO usage (user_email, month, checks_used)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_email, month) DO UPDATE SET checks_used = usage.checks_used + 1
     RETURNING checks_used`,
    [email, usageMonth()]
  );
  return Number(rows[0]?.checks_used ?? 1);
}

/**
 * Dev-tooling only (not part of the site runtime): delete all usage rows for
 * one account — used to reset a test fixture back to 5 fresh checks.
 */
export async function resetChecksUsed(
  rawEmail: string | null | undefined
): Promise<number> {
  const email = normalizeEmail(rawEmail);
  if (!email) return 0;
  await ensureSchema();
  const sql = client();
  const rows = await sql.query(`DELETE FROM usage WHERE user_email = $1`, [email]);
  return rows.length ?? 0;
}
