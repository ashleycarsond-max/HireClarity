/**
 * Watchlist HTTP endpoints (server-only).
 *
 * Served OUTSIDE the TanStack router (this react-start build has no API-route
 * support), from the server wrappers:
 *   - serve.ts        (Bun, port 3000 — platform working site)
 *   - vercel-entry.ts (Node, Vercel render function)
 * Both call handleWatchHttp(request) before the router.
 *
 * Endpoints (all watch mutations are server-side seeker-gated):
 *   POST /api/watch/add      { postingId }   (session cookie required)
 *       -> 200 { ok: true, watching: true }   watch created (idempotent)
 *       -> 401 { ok: false, error }           no session (anonymous)
 *       -> 403 { ok: false, error, code: "paywall" }  signed in, not a
 *              Job Seeker subscriber — the paywall message
 *       -> 404 { ok: false, error }           posting not in the tracking store
 *       -> 400 { ok: false, error }           malformed postingId
 *   POST /api/watch/remove   { postingId }   (session cookie required)
 *       -> 200 { ok: true, watching: false }  watch removed (idempotent)
 *       -> 401 / 403                          as above
 *   GET  /api/watch/list                      (session cookie required)
 *       -> 200 { ok: true, watching: string[] }  posting ids this user watches
 *       -> 401 / 403                          as above
 *   GET  /api/watch/remove?email=<addr>&posting=<id>&token=<secret>
 *       (the one-click UNWATCH link in alert emails — NO session needed; the
 *        guard is the per-user watch token stored on the watchlist row)
 *       -> 200 HTML "You're no longer watching this posting" — removes ONLY
 *          the (email, posting) row whose stored token matches. A wrong token
 *          removes nothing and renders the same page (no watch enumeration).
 *       -> 400 HTML (missing/invalid params — broken link)
 *       -> 500 HTML (storage failed — the link can be re-tapped)
 *
 * Gating guard (documented): identity ALWAYS comes from the httpOnly hc_session
 * cookie (currentUserEmail) or the email's own secret token — never from
 * client-supplied identity. Anonymous -> 401; signed-in free tier -> 403 with
 * the exact paywall copy ("Watchlists and alerts are part of Job Seeker —
 * $9/month"). Token mismatches are logged.
 */

import { normalizeEmail } from "../lib/email";
import { currentUserEmail } from "./auth";
import { isSubscribed } from "./subscriptions";
import { Store } from "../../engine/store";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

/** Posting ids are derived from URLs (board:slug / url:hash) — a strict charset. */
const POSTING_ID_RE = /^[A-Za-z0-9:_\-.]{1,200}$/;

const PAYWALL = {
  error: "Watchlists and alerts are part of Job Seeker — $9/month.",
  code: "paywall",
};

/** Session + seeker gate shared by the JSON endpoints. Returns the email or a Response. */
async function requireSeeker(request: Request): Promise<string | Response> {
  let email: string | null = null;
  try {
    email = await currentUserEmail(request);
  } catch (err) {
    console.error("[watch] session lookup failed:", err);
  }
  if (!email) {
    return json({ ok: false, error: "Sign in to use watchlists." }, 401);
  }
  const subscribed = await isSubscribed("seeker", email).catch((err: unknown) => {
    console.error("[watch] isSubscribed failed:", err);
    return false; // fail closed — never grant on a storage fault
  });
  if (!subscribed) {
    return json({ ok: false, ...PAYWALL }, 403);
  }
  return email;
}

function cleanPostingId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return POSTING_ID_RE.test(id) ? id : null;
}

async function handleAdd(request: Request): Promise<Response> {
  const email = await requireSeeker(request);
  if (email instanceof Response) return email;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "expected a JSON body with postingId" }, 400);
  }
  const postingId = cleanPostingId((body as { postingId?: unknown }).postingId);
  if (!postingId) {
    return json({ ok: false, error: "That posting id doesn't look valid." }, 400);
  }

  const store = new Store();
  try {
    const posting = await store.getByPostingId(postingId);
    if (!posting) {
      return json({ ok: false, error: "That posting isn't in our tracking store — check it first." }, 404);
    }
    await store.addWatch(email, postingId);
    return json({ ok: true, watching: true });
  } finally {
    store.close();
  }
}

async function handleRemove(request: Request): Promise<Response> {
  const email = await requireSeeker(request);
  if (email instanceof Response) return email;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "expected a JSON body with postingId" }, 400);
  }
  const postingId = cleanPostingId((body as { postingId?: unknown }).postingId);
  if (!postingId) {
    return json({ ok: false, error: "That posting id doesn't look valid." }, 400);
  }

  const store = new Store();
  try {
    await store.removeWatch(email, postingId);
    return json({ ok: true, watching: false });
  } finally {
    store.close();
  }
}

async function handleList(request: Request): Promise<Response> {
  const email = await requireSeeker(request);
  if (email instanceof Response) return email;

  const store = new Store();
  try {
    const rows = await store.listWatches(email);
    return json({ ok: true, watching: rows.map((r) => r.postingId) });
  } finally {
    store.close();
  }
}

/* ------------------- one-click unwatch (from alert emails) ------------------- */

/** Escape for HTML text and attribute contexts. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal dependency-free HTML page (same approach as the report/auth pages). */
function watchPage(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>${esc(title)} — HireClarity Data</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:#f5f6f8;color:#1c2430;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
.card{background:#fff;border:1px solid #e3e7ee;border-radius:14px;box-shadow:0 2px 8px rgba(16,24,40,.06);max-width:400px;width:100%;padding:32px 28px;text-align:center}
.brand{font-weight:700;font-size:18px;color:#0b1220}
h1{font-size:20px;line-height:1.3;margin:18px 0 10px;color:#0b1220}
p{font-size:15px;line-height:1.55;color:#4a5568;margin:0 0 20px}
.btn{display:block;width:100%;background:#2563eb;color:#fff;border:0;border-radius:10px;padding:13px 16px;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;margin-top:4px}
.btn:hover{background:#1d4ed8}
.muted{font-size:13px;color:#8a94a6;margin-top:18px}
</style>
</head>
<body>
<main class="card">
<div class="brand">HireClarity Data</div>
${bodyHtml}
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleTokenUnwatch(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const email = normalizeEmail(params.get("email"));
  const postingId = cleanPostingId(params.get("posting"));
  const token = params.get("token");

  if (!email || !postingId || !token || token.length < 16 || token.length > 200) {
    return watchPage(
      "That unwatch link isn't valid",
      `<h1>That unwatch link isn't valid</h1>` +
        `<p>The link is missing something or has the wrong format — open the full link from the alert email. You can also remove watches any time from your watchlist.</p>` +
        `<a class="btn" href="/watchlist">Go to my watchlist</a>`,
      400
    );
  }

  const store = new Store();
  try {
    const removed = await store.removeWatchByToken(email, postingId, token);
    if (!removed) {
      // Wrong/expired token (or no such watch). Log the guard firing — it is
      // the "nobody removes someone else's watch" protection — but render the
      // same confirmation as success (idempotent, no watch enumeration).
      console.log(`[watch] token unwatch: no match for masked ${email.slice(0, 2)}*** posting ${postingId} — nothing removed`);
    }
    return watchPage(
      "You're no longer watching this posting",
      `<h1>You're no longer watching this posting</h1>` +
        `<p>We won't send alert emails for it anymore. Your other watches are untouched.</p>` +
        `<a class="btn" href="/watchlist">See my watchlist</a>` +
        `<p class="muted">Manage or remove any watch any time from your watchlist.</p>`,
      200
    );
  } catch (err) {
    // Storage failed — be honest: do NOT claim the watch was removed.
    console.error("[watch] token unwatch failed:", err);
    return watchPage(
      "Something went wrong",
      `<h1>We couldn't process that just now</h1>` +
        `<p>Something went wrong on our side and the unwatch didn't go through. Please try the link again in a moment.</p>` +
        `<a class="btn" href="/watchlist">Go to my watchlist</a>`,
      500
    );
  } finally {
    store.close();
  }
}

/**
 * Route watchlist HTTP requests; returns null when the request is not ours and
 * should continue to the normal site handler.
 */
export async function handleWatchHttp(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/watch/add" || pathname === "/api/watch/add/") {
    if (request.method !== "POST") {
      return json({ ok: false, error: "method not allowed — expected POST" }, 405, { allow: "POST" });
    }
    return handleAdd(request);
  }
  if (pathname === "/api/watch/remove" || pathname === "/api/watch/remove/") {
    if (request.method === "GET") return handleTokenUnwatch(request);
    if (request.method === "POST") return handleRemove(request);
    return json({ ok: false, error: "method not allowed — expected GET (unwatch link) or POST (remove)" }, 405, { allow: "GET, POST" });
  }
  if (pathname === "/api/watch/list" || pathname === "/api/watch/list/") {
    if (request.method !== "GET") {
      return json({ ok: false, error: "method not allowed — expected GET" }, 405, { allow: "GET" });
    }
    return handleList(request);
  }
  return null;
}
