/**
 * Landing-page email capture storage (server-only).
 *
 * Stores signups in Neon Postgres using the same lazy-client +
 * CREATE TABLE IF NOT EXISTS pattern as engine/store.ts, so it works on both
 * the platform host and Vercel without migrations.
 *
 * NOTE: the createServerFn for the signup form lives inline in
 * src/routes/index.tsx (same pattern as check.tsx/company.tsx). Defining the
 * server fn in a separate non-route module caused this module's Neon import to
 * leak into the browser bundle and break hydration — the TanStack Start plugin
 * only strips server-only imports referenced from a route file's handler.
 * This module is imported only from that handler, so it stays server-only.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import { normalizeEmail } from "../lib/email";

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS signups (
    id         SERIAL PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    source     TEXT NOT NULL DEFAULT 'landing',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
        "DATABASE_URL is not set — the signup form needs Neon. Connect the database (via the database card) and re-publish."
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

export type SignupResult = { status: "ok" } | { status: "duplicate" } | { status: "error" };

// Basic abuse hygiene: a cheap in-memory sliding window. Per process, so it is
// best-effort on serverless (each instance has its own window) — real per-IP
// rate limiting belongs with the billing backend and is a noted follow-up.
const RATE_LIMIT = { windowMs: 60_000, max: 20 };
const recentAttempts: number[] = [];

function rateLimited(): boolean {
  const now = Date.now();
  while (recentAttempts.length > 0 && recentAttempts[0] <= now - RATE_LIMIT.windowMs) {
    recentAttempts.shift();
  }
  if (recentAttempts.length >= RATE_LIMIT.max) return true;
  recentAttempts.push(now);
  return false;
}

/**
 * Insert a signup. Idempotent: the same email is stored once; a repeat
 * submission reports "duplicate". Never throws — DB failures become
 * { status: "error" } and are logged server-side only.
 */
export async function addSignup(rawEmail: unknown, source = "landing"): Promise<SignupResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    console.warn("[signup] rejected invalid email input");
    return { status: "error" };
  }
  if (rateLimited()) {
    console.warn("[signup] rate limit hit — rejecting signup attempt");
    return { status: "error" };
  }
  try {
    await ensureSchema();
    const sql = client();
    const rows = await sql.query(
      `INSERT INTO signups (email, source) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, source]
    );
    return rows.length > 0 ? { status: "ok" } : { status: "duplicate" };
  } catch (err) {
    console.error("[signup] failed to store email:", err);
    return { status: "error" };
  }
}

/** All signup rows, oldest first (used by the monthly report email path). */
export async function listSignups(): Promise<{ email: string; source: string; createdAt: string }[]> {
  await ensureSchema();
  const sql = client();
  const rows = await sql.query(`SELECT email, source, created_at FROM signups ORDER BY created_at`);
  return rows.map((r) => ({
    email: String(r.email),
    source: String(r.source),
    createdAt: String(r.created_at),
  }));
}

/**
 * Remove one signup row by email. Returns true only when a row was actually
 * removed (the unsubscribe endpoint still renders "you're unsubscribed" for a
 * missing row — idempotent, and it doesn't leak whether the address was on
 * the list).
 */
export async function deleteSignup(email: string): Promise<boolean> {
  await ensureSchema();
  const sql = client();
  const rows = await sql.query(`DELETE FROM signups WHERE email = $1 RETURNING id`, [email]);
  return rows.length > 0;
}
