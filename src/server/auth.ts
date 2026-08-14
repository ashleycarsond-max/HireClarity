/**
 * Per-user auth (server-only): magic-link email sign-in with DB sessions.
 *
 * ADDITIVE and DEFAULT-OFF: nothing here changes live behavior by itself —
 * the live gate still works exactly as before until the UI cutover delegation
 * wires the sign-in forms and flips the client over to sessions. The only
 * reachable change today is that `verifyAccess` (used by /check and /company)
 * now prefers a signed-in session when the hc_session cookie is present and
 * falls back to the legacy email-keyed path unchanged otherwise.
 *
 * Uses the same lazy-client + CREATE TABLE IF NOT EXISTS pattern as
 * subscriptions.ts / engine/store.ts (Neon serverless Postgres over HTTP,
 * `$1..$n` placeholders, TEXT ISO timestamps) so it works on the platform host
 * and on Vercel without migrations. DATABASE_URL is read per call — the site
 * builds, serves and runs honestly with the tables simply not existing yet.
 *
 * Tables:
 *   users       — one row per account (email key)
 *   auth_tokens — single-use magic-link tokens (sha256 hashes only)
 *   sessions    — sign-in sessions (sha256 hashes only; cookie holds the raw)
 *
 * Security notes (see /home/team/shared/billing-README.md "Auth" section):
 *   - Only sha256 hashes of tokens/session keys are stored; the raw 64-hex
 *     value lives only in the email link / the httpOnly cookie.
 *   - Magic links are single-use (atomic conditional UPDATE) and expire after
 *     15 minutes; sessions expire after 30 days.
 *   - The client NEVER supplies the identity: sessions are resolved from the
 *     httpOnly hc_session cookie, which client JS cannot read.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { createHash, randomBytes } from "node:crypto";

import { normalizeEmail } from "../lib/email";

/* ------------------------------ constants ------------------------------- */

/** Live host only — never the old branded host. See billing-README.md. */
export const SESSION_COOKIE = "hc_session";
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Per-email request cap: at most 5 sign-in links per 15 minutes (counted as
// auth_tokens rows created in the window — each request consumes a slot).
const EMAIL_LINK_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };
// Best-effort per-IP cap (in-memory per process, like the checkout/signup
// guards — documented as such; each serverless instance has its own window).
const IP_LIMIT = { windowMs: 15 * 60 * 1000, max: 10 };
const ipAttempts: { at: number; ip: string }[] = [];

/* -------------------------------- schema -------------------------------- */

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    email           TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_sign_in_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_tokens_email_created ON auth_tokens(email, created_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_email   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user_email ON sessions(user_email)`,
];

// Lazy module-level client + schema init — same pattern as subscriptions.ts.
let _client: NeonQueryFunction<false, false> | null = null;
let _schemaReady: Promise<void> | null = null;

function client(): NeonQueryFunction<false, false> {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set — the auth store needs Neon. Connect the database (via the database card) and re-publish."
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

/* ------------------------------ utilities ------------------------------- */

export function isoNow(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

/** sha256 hex of a raw token/session key — the only form we persist. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Fresh 64-hex-char random token (raw form: emailed / stored in cookie). */
export function newRawToken(): string {
  return randomBytes(32).toString("hex");
}

/** Read the raw hc_session cookie value from a request (or null). */
export function readSessionRawToken(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function ipRateLimited(ip: string): boolean {
  const now = Date.now();
  while (ipAttempts.length > 0 && ipAttempts[0].at <= now - IP_LIMIT.windowMs) {
    ipAttempts.shift();
  }
  const recent = ipAttempts.filter((a) => a.ip === ip);
  if (recent.length >= IP_LIMIT.max) return true;
  ipAttempts.push({ at: now, ip });
  return false;
}

/* ------------------------------ users ---------------------------------- */

async function upsertUser(email: string, now: string): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql.query(
    `INSERT INTO users (email, created_at, updated_at, last_sign_in_at)
     VALUES ($1, $2, $2, NULL)
     ON CONFLICT (email) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
    [email, now]
  );
}

async function touchLastSignIn(email: string, now: string): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql.query(
    `UPDATE users SET last_sign_in_at = $2, updated_at = $2 WHERE email = $1`,
    [email, now]
  );
}

/* --------------------------- magic-link tokens --------------------------- */

/** Store one single-use magic-link token (raw token → sha256 in the table). */
export async function storeMagicLinkToken(
  email: string,
  rawToken: string,
  expiresAtIso: string
): Promise<void> {
  await ensureSchema();
  const sql = client();
  await sql.query(
    `INSERT INTO auth_tokens (token_hash, email, purpose, expires_at, used_at, created_at)
     VALUES ($1, $2, 'magic-link', $3, NULL, $4)`,
    [hashToken(rawToken), email, expiresAtIso, isoNow()]
  );
}

export interface MagicLinkRequestResult {
  ok: boolean;
  status: number; // 200 sent | 400 bad email | 429 rate limited | 502 send failed
  error?: string; // human-readable, only when !ok
  message?: string; // human-readable, only when ok
  /** Present only when the email was NOT sent (no RESEND_API_KEY or Resend
   *  error) — dev tooling / CLI harness use it; the HTTP layer never returns it. */
  link?: string;
}

/** Only allow same-site relative redirect targets; anything else -> "/check"
 *  (the check tool — the one page with a visible signed-in state). Defaulting
 *  to "/check" (not null, not "/") means every emailed link carries an explicit
 *  `from=/check` even when the caller passed no `from`, so a link requested
 *  without a destination never dead-ends on the homepage. */
function sanitizeFrom(raw: string | null | undefined): string {
  if (
    typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= 512 &&
    raw.startsWith("/") &&
    !raw.startsWith("//") &&
    !raw.includes("\\")
  ) {
    return raw;
  }
  return "/check";
}

/**
 * Full request-a-link flow: validate → rate limit → upsert user → create a
 * single-use token → send the email. Never claims the email was sent when the
 * sender failed: a failed send returns a 5xx-class result (the link never left
 * the server; the unused token simply expires in 15 minutes).
 */
export async function requestMagicLink(
  rawEmail: unknown,
  ip: string,
  rawFrom?: string | null
): Promise<MagicLinkRequestResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return { ok: false, status: 400, error: "That doesn't look like a valid email address — please double-check it." };
  }
  if (ipRateLimited(ip)) {
    return { ok: false, status: 429, error: "Too many requests from this device — wait a few minutes and try again." };
  }
  try {
    await ensureSchema();
    const sql = client();
    const rows = await sql.query(
      `SELECT COUNT(*) AS n FROM auth_tokens
       WHERE email = $1 AND purpose = 'magic-link' AND created_at > $2`,
      [email, isoNow(Date.now() - EMAIL_LINK_LIMIT.windowMs)]
    );
    if (Number(rows[0]?.n ?? 0) >= EMAIL_LINK_LIMIT.max) {
      return { ok: false, status: 429, error: "Too many sign-in links requested for this email — wait 15 minutes and try again." };
    }
  } catch (err) {
    console.error("[auth] rate-limit check failed:", err);
    return { ok: false, status: 500, error: "Something went wrong — please try again in a moment." };
  }

  const rawToken = newRawToken();
  const expiresAt = isoNow(Date.now() + MAGIC_LINK_TTL_MS);
  const now = isoNow();
  try {
    await upsertUser(email, now);
    await storeMagicLinkToken(email, rawToken, expiresAt);
  } catch (err) {
    console.error("[auth] failed to create magic-link token:", err);
    return { ok: false, status: 500, error: "Something went wrong — please try again in a moment." };
  }

  const { sendMagicLinkEmail } = await import("./auth-email");
  const sent = await sendMagicLinkEmail(email, rawToken, sanitizeFrom(rawFrom));
  if (!sent.sent) {
    // Honest failure: report the send failure — never a success. The token row
    // is left in place: it is single-use, was never delivered (nobody has the
    // link), and expires on its own in 15 minutes; dev tooling (CLI harness)
    // uses the logged link to exercise the verify flow.
    return {
      ok: false,
      status: 502,
      error: "We couldn't send the sign-in email right now — please try again in a moment.",
      link: sent.link,
    };
  }
  return { ok: true, status: 200, message: "Check your email — your sign-in link is on its way." };
}

export interface VerifyResult {
  ok: boolean;
  status: number; // 302 ok | 400 invalid/used/expired | 500 server error
  /** Machine-readable failure reason (only when !ok) so the HTTP layer can
   *  render the right page (used → "already been used" + recovery form,
   *  expired → recovery form, invalid/missing → link to /check). */
  reason?: "missing" | "invalid" | "used" | "expired" | "server";
  error?: string; // human-readable, only when !ok
  email?: string; // only when ok
  sessionToken?: string; // raw session key for the cookie — only when ok
  sessionExpiresAt?: string; // only when ok
}

/**
 * Redeem a magic-link token: single-use (atomic conditional UPDATE), 15-minute
 * expiry, marks the token used, records the sign-in, and creates a 30-day
 * session. Returns the raw session key so the HTTP layer can set the cookie.
 */
export async function verifyMagicLink(
  rawToken: string | null | undefined,
  _from: string
): Promise<VerifyResult> {
  if (!rawToken) {
    return { ok: false, status: 400, reason: "missing", error: "That sign-in link is missing its token — open the full link from your email." };
  }
  const tokenHash = hashToken(rawToken);
  const now = isoNow();
  try {
    await ensureSchema();
    const sql = client();
    // Atomic single-use: only a row that is still unused and unexpired can be
    // claimed. A concurrent second POST gets 0 rows and falls into the
    // used/expired/invalid branches below.
    const claimed = await sql.query(
      `UPDATE auth_tokens SET used_at = $2
       WHERE token_hash = $1 AND purpose = 'magic-link' AND used_at IS NULL AND expires_at > $2
       RETURNING email`,
      [tokenHash, now]
    );
    if (claimed.length === 0) {
      const rows = await sql.query(
        `SELECT expires_at, used_at FROM auth_tokens WHERE token_hash = $1 AND purpose = 'magic-link'`,
        [tokenHash]
      );
      if (rows.length === 0) {
        return { ok: false, status: 400, reason: "invalid", error: "That sign-in link isn't valid. Request a new one." };
      }
      if (rows[0].used_at) {
        return { ok: false, status: 400, reason: "used", error: "That sign-in link has already been used. Request a new one." };
      }
      return { ok: false, status: 400, reason: "expired", error: "That sign-in link has expired. Request a new one." };
    }
    const email = String(claimed[0].email);

    const sessionToken = newRawToken();
    const sessionExpiresAt = isoNow(Date.now() + SESSION_TTL_MS);
    await sql.query(
      `INSERT INTO sessions (token_hash, user_email, created_at, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $3)`,
      [hashToken(sessionToken), email, now, sessionExpiresAt]
    );
    await touchLastSignIn(email, now);
    return { ok: true, status: 302, email, sessionToken, sessionExpiresAt };
  } catch (err) {
    console.error("[auth] verifyMagicLink failed:", err);
    return { ok: false, status: 500, reason: "server", error: "Something went wrong — please try again in a moment." };
  }
}

export type MagicLinkLookupStatus = "valid" | "used" | "expired" | "unknown";

export interface MagicLinkLookupResult {
  status: MagicLinkLookupStatus;
  /** Present when the token row exists — used to prefill the "email me a new
   *  link" recovery form on the used/expired pages. */
  email?: string;
}

/**
 * Read-only token status check — NEVER consumes the token (no writes). This is
 * what the verify interstitial GET uses, so link-safety scanners that prefetch
 * the URL in the background (Gmail/Outlook mobile apps GET the link before the
 * user taps it) cannot spend the single-use token: only the user's explicit
 * POST to /api/auth/verify consumes it. Fail-closed to "unknown" on storage
 * errors (the page then offers the /check path and a fresh request).
 */
export async function lookupMagicLink(
  rawToken: string | null | undefined
): Promise<MagicLinkLookupResult> {
  if (!rawToken) return { status: "unknown" };
  try {
    await ensureSchema();
    const sql = client();
    const rows = await sql.query(
      `SELECT email, expires_at, used_at FROM auth_tokens
       WHERE token_hash = $1 AND purpose = 'magic-link'`,
      [hashToken(rawToken)]
    );
    if (rows.length === 0) return { status: "unknown" };
    const row = rows[0];
    const email = String(row.email);
    if (row.used_at) return { status: "used", email };
    if (String(row.expires_at) <= isoNow()) return { status: "expired", email };
    return { status: "valid", email };
  } catch (err) {
    console.error("[auth] lookupMagicLink failed:", err);
    return { status: "unknown" };
  }
}

/** Delete one session row by its raw cookie value (logout). */
export async function deleteSessionByRawToken(
  rawSessionToken: string | null | undefined
): Promise<void> {
  if (!rawSessionToken) return;
  try {
    await ensureSchema();
    const sql = client();
    await sql.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(rawSessionToken)]);
  } catch (err) {
    console.error("[auth] deleteSession failed:", err);
  }
}

/**
 * Resolve the signed-in user's email from a request's hc_session cookie, or
 * null when there is no (valid, unexpired) session. Read-only fast path: no
 * cookie → no DB query. Fail-closed on storage errors.
 */
export async function currentUserEmail(request: Request): Promise<string | null> {
  const raw = readSessionRawToken(request);
  if (!raw) return null;
  try {
    await ensureSchema();
    const sql = client();
    const rows = await sql.query(
      `SELECT user_email FROM sessions WHERE token_hash = $1 AND expires_at > $2`,
      [hashToken(raw), isoNow()]
    );
    return rows.length > 0 ? String(rows[0].user_email) : null;
  } catch (err) {
    console.error("[auth] currentUserEmail lookup failed:", err);
    return null;
  }
}

/** Touch last_seen_at for a live session (best-effort; used by /me). */
export async function touchSessionLastSeen(
  rawSessionToken: string,
  atIso: string
): Promise<void> {
  try {
    await ensureSchema();
    const sql = client();
    await sql.query(`UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1`, [
      hashToken(rawSessionToken),
      atIso,
    ]);
  } catch (err) {
    console.error("[auth] touchSessionLastSeen failed:", err);
  }
}
