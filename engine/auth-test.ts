/**
 * Auth-system verification CLI (dev tooling only — not part of the site
 * runtime; the runtime never touches the filesystem, this tool just runs from
 * the sandbox against the real Neon DATABASE_URL).
 *
 *   bun run auth-test
 *
 * Drives the REAL server code (src/server/auth.ts, auth-email.ts,
 * auth-http.ts) through both the real HTTP routing (handleAuthHttp with
 * synthetic Requests, exactly as serve.ts/vercel-entry.ts call it) and the
 * in-process flow functions, and verifies:
 *   - POST /api/auth/request creates a token (and honestly reports the email
 *     could not be sent when RESEND_API_KEY is missing — never a fake success)
 *   - GET  /api/auth/verify with a fresh token shows the scanner-safe
 *     interstitial (200, Continue form) and does NOT consume the token
 *   - POST /api/auth/verify (the Continue tap) consumes the token exactly
 *     once and sets the hc_session cookie (302)
 *   - a second POST with the same token is rejected with the honest
 *     "already been used" page + one-tap recovery form (single-use)
 *   - an expired token (GET and POST) and a missing/unknown token are rejected
 *   - the default `from` is /check: a request without a `from` embeds
 *     from=/check in the emailed link and the POST redirects there
 *   - GET  /api/auth/me with the session cookie returns the email
 *   - POST /api/auth/logout clears the session (row deleted, /me -> 401)
 *
 * Full output goes to /tmp/auth-test-*.txt (terminal scrollback floods); a
 * short pass/fail summary is printed. Test rows are cleaned up afterwards.
 */

import { writeFileSync } from "node:fs";

import { neon } from "@neondatabase/serverless";

import { hashToken, requestMagicLink, storeMagicLinkToken } from "../src/server/auth.ts";
import { handleAuthHttp } from "../src/server/auth-http.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — cannot reach Neon.");
  process.exit(1);
}
const sql = neon(url);

const AUTH_DDL = [
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
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash   TEXT PRIMARY KEY,
    user_email   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT
  )`,
];

const BASE = "https://hireclarity-data.vercel.app"; // same origin as the live host
const lines: string[] = [];
let failures = 0;

function record(label: string, ok: boolean, detail = ""): void {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  const line = `${tag}  ${label}${detail ? ` — ${detail}` : ""}`;
  lines.push(line);
  console.log(line);
}

function jsonReq(path: string, body: unknown): Request {
  return new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Form-encoded POST — exactly what the no-JS interstitial/recovery forms send. */
function formPost(path: string, data: Record<string, string>): Request {
  const body = new URLSearchParams(data).toString();
  return new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function getReq(path: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new Request(BASE + path, { method: "GET", headers });
}

/** Extract the raw value of a cookie from a Set-Cookie header. */
function cookieValue(setCookie: string | null | undefined, name: string): string | null {
  if (!setCookie) return null;
  const part = setCookie.split(";")[0]?.trim();
  if (!part) return null;
  const eq = part.indexOf("=");
  if (eq === -1) return null;
  return part.slice(0, eq) === name ? part.slice(eq + 1) : null;
}

async function countTokens(email: string): Promise<number> {
  const rows = await sql.query(
    `SELECT COUNT(*) AS n FROM auth_tokens WHERE email = $1 AND purpose = 'magic-link'`,
    [email]
  );
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  for (const ddl of AUTH_DDL) await sql.query(ddl); // same DDL as src/server/auth.ts

  const email = `auth-test-${Date.now()}@example.com`;
  lines.push(`test email: ${email}`);
  lines.push(`RESEND_API_KEY: ${process.env.RESEND_API_KEY ? "set" : "NOT set"}`);
  console.log(`test email: ${email}`);
  console.log(`RESEND_API_KEY: ${process.env.RESEND_API_KEY ? "set" : "NOT set"}`);
  lines.push("");

  /* 1. request endpoint creates a token; never claims sent when the sender is off */
  const reqRes = await handleAuthHttp(jsonReq("/api/auth/request", { email }));
  const reqBody = await reqRes?.json().catch(() => ({}));
  const tokensAfterHttp = await countTokens(email);
  record(
    "POST /api/auth/request creates a token row",
    reqRes?.status === 502 && reqBody?.ok === false && tokensAfterHttp === 1,
    `status=${String(reqRes?.status)} ok=${String(reqBody?.ok)} tokens=${tokensAfterHttp}`
  );
  record(
    "request endpoint is honest when the email cannot be sent",
    reqRes?.status === 502 && typeof reqBody?.error === "string",
    String(reqBody?.error ?? "")
  );

  /* 2. in-process request flow returns the dev link (no RESEND_API_KEY here) */
  const flow = await requestMagicLink(email, "127.0.0.1");
  const tokensAfterFlow = await countTokens(email);
  record(
    "requestMagicLink creates a token and returns the dev link when not sent",
    flow.ok === false && flow.status === 502 && typeof flow.link === "string" && tokensAfterFlow === 2,
    `status=${flow.status} hasLink=${typeof flow.link === "string"} tokens=${tokensAfterFlow}`
  );
  if (!flow.link) {
    console.error("no dev link available — cannot continue verify tests");
    process.exitCode = 1;
    await writeLog();
    return;
  }
  const rawToken = new URL(flow.link).searchParams.get("token") ?? "";
  record("dev link carries a token", rawToken.length === 64, `tokenLen=${rawToken.length}`);

  /* 3. GET verify shows the interstitial and does NOT consume the token */
  const gRes = await handleAuthHttp(getReq(`/api/auth/verify?token=${rawToken}&from=/check`));
  const gBody = await gRes?.text().catch(() => "");
  const tokenAfterGet = await sql.query(`SELECT used_at FROM auth_tokens WHERE token_hash = $1`, [
    hashToken(rawToken),
  ]);
  record(
    "GET verify -> 200 interstitial with Continue form",
    gRes?.status === 200 && /Continue/.test(gBody ?? "") && (gBody ?? "").includes('action="/api/auth/verify"'),
    `status=${String(gRes?.status)}`
  );
  record(
    "GET verify does NOT consume the token (scanner-safe)",
    tokenAfterGet.length === 1 && !tokenAfterGet[0].used_at,
    `used_at=${String(tokenAfterGet[0]?.used_at ?? "NULL")}`
  );
  record(
    "interstitial carries the same token + sanitized from in hidden fields",
    (gBody ?? "").includes(`value="${rawToken}"`) && (gBody ?? "").includes('name="from" value="/check"'),
    ""
  );

  /* 4. POST verify (the Continue tap) consumes the token: 302 + cookie + session */
  const pRes = await handleAuthHttp(formPost("/api/auth/verify", { token: rawToken, from: "/check" }));
  const setCookie = pRes?.headers.get("set-cookie");
  const sessionRaw = cookieValue(setCookie, "hc_session");
  const location = pRes?.headers.get("location");
  const sessionRows = sessionRaw
    ? await sql.query(`SELECT user_email FROM sessions WHERE token_hash = $1`, [hashToken(sessionRaw)])
    : [];
  const tokenUsed = await sql.query(`SELECT used_at FROM auth_tokens WHERE token_hash = $1`, [
    hashToken(rawToken),
  ]);
  record("POST verify -> 302 redirect to from", pRes?.status === 302 && location === "/check", `status=${String(pRes?.status)} location=${String(location)}`);
  record("POST verify sets httpOnly hc_session cookie", typeof sessionRaw === "string" && sessionRaw.length === 64 && (setCookie ?? "").includes("HttpOnly") && (setCookie ?? "").includes("SameSite=Lax"), String(setCookie ?? ""));
  record("POST verify created a session row (hash stored, raw never persisted)", sessionRows.length === 1 && String(sessionRows[0].user_email) === email, `rows=${sessionRows.length}`);
  record("POST verify consumed the token exactly once", tokenUsed.length === 1 && !!tokenUsed[0].used_at, `used_at=${String(tokenUsed[0]?.used_at ?? "NULL")}`);

  /* 5. GET on the now-used token -> honest used page (never a dead end) */
  const gUsed = await handleAuthHttp(getReq(`/api/auth/verify?token=${rawToken}`));
  const gUsedBody = await gUsed?.text().catch(() => "");
  record(
    "GET on used token -> 'already been used' page with recovery form",
    gUsed?.status === 400 && /already been used/i.test(gUsedBody ?? "") && /Email me a new link/i.test(gUsedBody ?? ""),
    `status=${String(gUsed?.status)}`
  );

  /* 6. second POST with the same token -> used page prefilled with the email */
  const v2Res = await handleAuthHttp(formPost("/api/auth/verify", { token: rawToken, from: "/check" }));
  const v2Body = await v2Res?.text().catch(() => "");
  record(
    "second POST verify rejected (single-use) with recovery form",
    v2Res?.status === 400 && /already been used/i.test(v2Body ?? "") && /Email me a new link/i.test(v2Body ?? "") && (v2Body ?? "").includes(`value="${email}"`),
    `status=${String(v2Res?.status)}`
  );

  /* 7. expired token: GET and POST both show the honest expired page */
  const rawExpired = "e".repeat(64);
  await storeMagicLinkToken(email, rawExpired, new Date(Date.now() - 60_000).toISOString());
  const vExpGet = await handleAuthHttp(getReq(`/api/auth/verify?token=${rawExpired}`));
  const vExpGetBody = await vExpGet?.text().catch(() => "");
  record(
    "expired token GET -> expired page with recovery form",
    vExpGet?.status === 400 && /expired/i.test(vExpGetBody ?? "") && /Email me a new link/i.test(vExpGetBody ?? ""),
    `status=${String(vExpGet?.status)}`
  );
  const vExpPost = await handleAuthHttp(formPost("/api/auth/verify", { token: rawExpired, from: "/check" }));
  const vExpPostBody = await vExpPost?.text().catch(() => "");
  record(
    "expired token POST rejected -> expired page",
    vExpPost?.status === 400 && /expired/i.test(vExpPostBody ?? ""),
    `status=${String(vExpPost?.status)}`
  );

  /* 8. missing / unknown token -> invalid page with a link to /check */
  const vNoneRes = await handleAuthHttp(getReq("/api/auth/verify"));
  const vNoneBody = await vNoneRes?.text().catch(() => "");
  record(
    "missing token GET -> invalid page linking to /check",
    vNoneRes?.status === 400 && /isn't valid/i.test(vNoneBody ?? "") && (vNoneBody ?? "").includes('href="/check"'),
    `status=${String(vNoneRes?.status)}`
  );
  const vBadRes = await handleAuthHttp(getReq(`/api/auth/verify?token=${"f".repeat(64)}`));
  record("unknown token GET -> invalid page", vBadRes?.status === 400, `status=${String(vBadRes?.status)}`);

  /* 9. default `from` = /check: a request without a from embeds from=/check in
        the emailed link, the interstitial shows it, and the POST lands there */
  const flow2 = await requestMagicLink(email, "127.0.0.2"); // no `from` at all
  if (!flow2.link) {
    console.error("no dev link from flow2 — cannot continue default-from tests");
    process.exitCode = 1;
    await writeLog();
    return;
  }
  const link2 = new URL(flow2.link);
  const token2 = link2.searchParams.get("token") ?? "";
  record(
    "request without from embeds from=/check in the emailed link",
    link2.searchParams.get("from") === "/check",
    `from=${String(link2.searchParams.get("from"))}`
  );
  const g2 = await handleAuthHttp(getReq(`/api/auth/verify?token=${token2}`));
  const g2Body = await g2?.text().catch(() => "");
  record(
    "interstitial without from -> hidden from=/check",
    g2?.status === 200 && (g2Body ?? "").includes('name="from" value="/check"'),
    `status=${String(g2?.status)}`
  );
  const p2 = await handleAuthHttp(formPost("/api/auth/verify", { token: token2 })); // no from -> default /check
  const cookie2 = cookieValue(p2?.headers.get("set-cookie"), "hc_session");
  record(
    "POST verify without from -> 302 to /check + cookie",
    p2?.status === 302 && p2?.headers.get("location") === "/check" && typeof cookie2 === "string",
    `status=${String(p2?.status)} location=${String(p2?.headers.get("location"))}`
  );

  /* 10. /api/auth/request accepts form-encoded bodies (the no-JS recovery
         form) and replies with an honest HTML page, not raw JSON */
  const fRes = await handleAuthHttp(formPost("/api/auth/request", { email, from: "/check" }));
  const fBody = await fRes?.text().catch(() => "");
  record(
    "form POST /api/auth/request -> honest HTML (no sender: 502 page)",
    fRes?.status === 502 && (fBody ?? "").includes("<!doctype html>") && /couldn't send/i.test(fBody ?? ""),
    `status=${String(fRes?.status)}`
  );

  /* 11. /api/auth/me with the session returns the email; without -> 401 */
  const cookieHeader = `hc_session=${sessionRaw ?? ""}`;
  const meRes = await handleAuthHttp(getReq("/api/auth/me", cookieHeader));
  const meBody = await meRes?.json().catch(() => ({}));
  record("GET /api/auth/me with session returns the email", meRes?.status === 200 && meBody?.email === email, `status=${String(meRes?.status)} email=${String(meBody?.email ?? "")}`);
  const me2 = await handleAuthHttp(getReq("/api/auth/me", `hc_session=${cookie2 ?? ""}`));
  const me2Body = await me2?.json().catch(() => ({}));
  record("default-from flow session also authenticates /me", me2?.status === 200 && me2Body?.email === email, `status=${String(me2?.status)}`);
  const me401 = await handleAuthHttp(getReq("/api/auth/me"));
  record("GET /api/auth/me without session -> 401", me401?.status === 401, `status=${String(me401?.status)}`);

  /* 12. logout clears the session */
  const loRes = await handleAuthHttp(
    new Request(BASE + "/api/auth/logout", { method: "POST", headers: { cookie: cookieHeader } })
  );
  const sessionAfterLogout = sessionRaw
    ? await sql.query(`SELECT 1 AS x FROM sessions WHERE token_hash = $1`, [hashToken(sessionRaw)])
    : [];
  const meAfterLogout = await handleAuthHttp(getReq("/api/auth/me", cookieHeader));
  record("POST /api/auth/logout -> 200 and deletes the session row", loRes?.status === 200 && sessionAfterLogout.length === 0, `status=${String(loRes?.status)} rows=${sessionAfterLogout.length}`);
  record("session cookie no longer authenticates /me", meAfterLogout?.status === 401, `status=${String(meAfterLogout?.status)}`);

  /* 13. cleanup test rows */
  const delTokens = await sql.query(`DELETE FROM auth_tokens WHERE email = $1 RETURNING token_hash`, [email]);
  const delSessions = await sql.query(
    `DELETE FROM sessions WHERE user_email = $1 RETURNING token_hash`,
    [email]
  );
  const delUsers = await sql.query(`DELETE FROM users WHERE email = $1 RETURNING email`, [email]);
  record("cleanup removed test rows", delTokens.length + delSessions.length + delUsers.length >= 1, `tokens=${delTokens.length} sessions=${delSessions.length} users=${delUsers.length}`);

  await writeLog();
}

async function writeLog(): Promise<void> {
  const path = `/tmp/auth-test-${Date.now()}.txt`;
  lines.push("");
  lines.push(failures === 0 ? "RESULT: ALL PASS" : `RESULT: ${failures} FAILURE(S)`);
  writeFileSync(path, lines.join("\n") + "\n");
  console.log("");
  console.log(`full output: ${path}`);
  console.log(failures === 0 ? "RESULT: ALL PASS" : `RESULT: ${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
