/**
 * Auth HTTP endpoints (server-only).
 *
 * Like the Stripe endpoints, these are served OUTSIDE the TanStack router
 * (this react-start build has no API-route support), from the server wrappers:
 *   - serve.ts        (Bun, port 3000 — platform working site)
 *   - vercel-entry.ts (Node, Vercel render function)
 * Both call handleAuthHttp(request) before the router; when it returns a
 * Response the request is served and never reaches the site.
 *
 * Endpoints:
 *   POST /api/auth/request { email }               (JSON — the sign-in UI)
 *       -> 200 { ok: true, message }                (email actually sent)
 *       -> 400 { ok: false, error }                 (invalid email)
 *       -> 429 { ok: false, error }                 (rate limited)
 *       -> 502 { ok: false, error }                 (sender failed — never
 *                                                     claims the email was sent)
 *       -> 500 { ok: false, error }
 *   POST /api/auth/request (form-encoded)          (no-JS "email me a new
 *                                                     link" recovery forms)
 *       -> HTML page — success ("check your email") or an honest error page.
 *   GET  /api/auth/verify?token=...&from=...      (SCANNER-SAFE two-step)
 *       -> 200 interstitial HTML with a <form method="POST" action="/api/
 *          auth/verify"> (hidden token + from) and a Continue button. NEVER
 *          consumes the token — phone mail apps (Gmail/Outlook) prefetch the
 *          link in the background and that must not spend it.
 *       -> 400 HTML error page (used / expired / invalid — with a one-tap
 *          "email me a new link" recovery form on used/expired).
 *   POST /api/auth/verify (form-encoded, from the interstitial)
 *       -> 302 to `from` (sanitized) with hc_session cookie set — the ONLY
 *          place the single-use token is consumed (atomic, exactly once).
 *       -> 400/500 HTML error page (used / expired / invalid / server).
 *   POST /api/auth/logout
 *       -> 200 { ok: true }  (deletes the session row + clears the cookie)
 *   GET  /api/auth/me
 *       -> 200 { email }  or  401 { error: "Not signed in." }
 *
 * Cookie: hc_session, httpOnly + Secure + SameSite=Lax + Path=/, 30-day
 * Max-Age. The cookie holds the RAW session key; only its sha256 is stored.
 */

import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  currentUserEmail,
  deleteSessionByRawToken,
  lookupMagicLink,
  readSessionRawToken,
  requestMagicLink,
  touchSessionLastSeen,
  verifyMagicLink,
} from "./auth";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Secure when the request arrived over https (both live hosts are https). */
function cookieSecure(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  return request.headers.get("x-forwarded-proto") === "https";
}

function sessionCookieHeader(request: Request, value: string, maxAgeSec: number): string {
  const secure = cookieSecure(request) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Max-Age=${String(maxAgeSec)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

/**
 * Only allow same-site relative redirect targets; anything else -> "/check"
 * (the check tool — the one page with a visible signed-in state). Defaulting to
 * "/check" (not "/") means a link requested without a `from` never dead-ends on
 * the homepage, which has no signed-in indicator and made sign-in look broken.
 */
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

/* -------------------- plain-HTML auth pages (no JS, mobile-first) -------------------- */

/** Escape for HTML text and attribute contexts. */
function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wrap a page body in a minimal, dependency-free HTML document. Deliberately
 * no external assets and no JS: these pages must work in in-app browsers
 * (Gmail/Outlook webviews) that prefetch links and may block scripts.
 * `Cache-Control: no-store` so proxies/CDNs never serve a stale interstitial.
 */
function authPage(title: string, bodyHtml: string, status = 200): Response {
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
form{margin:0}
button,.btn{display:block;width:100%;background:#2563eb;color:#fff;border:0;border-radius:10px;padding:13px 16px;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;margin-top:4px;-webkit-appearance:none;appearance:none}
button:hover,.btn:hover{background:#1d4ed8}
input[type="email"]{display:block;width:100%;border:1px solid #cbd2dc;border-radius:10px;padding:12px 14px;font-size:16px;margin:8px 0 14px;-webkit-appearance:none;appearance:none}
.label{display:block;text-align:left;font-size:13px;font-weight:600;color:#344054;margin-top:4px}
.muted{font-size:13px;color:#8a94a6;margin-top:18px}
.muted a{color:#2563eb;text-decoration:none}
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

/** The scanner-safe interstitial: shows the POST form, never consumes. */
function continuePage(token: string, from: string, email?: string): string {
  return (
    `<h1>Sign in to HireClarity Data</h1>` +
    (email ? `<p>You're signing in as <strong>${esc(email)}</strong>.</p>` : "") +
    `<p>This sign-in link works once — tap <strong>Continue</strong> to sign in.</p>` +
    `<form method="post" action="/api/auth/verify">` +
    `<input type="hidden" name="token" value="${esc(token)}"/>` +
    `<input type="hidden" name="from" value="${esc(from)}"/>` +
    `<button type="submit">Continue</button>` +
    `</form>` +
    `<p class="muted">The link expires 15 minutes after it was requested.</p>`
  );
}

/** One-tap recovery: prefilled email (from the token row when known) POSTs to
 *  /api/auth/request (form-encoded — no JS needed). */
function newLinkForm(email?: string): string {
  return (
    `<form method="post" action="/api/auth/request">` +
    `<input type="hidden" name="from" value="/check"/>` +
    `<label class="label" for="email">Email</label>` +
    `<input type="email" name="email" id="email" value="${esc(email ?? "")}" placeholder="you@example.com" required autocomplete="email"/>` +
    `<button type="submit">Email me a new link</button>` +
    `</form>`
  );
}

function usedPage(email?: string): string {
  return (
    `<h1>This sign-in link has already been used</h1>` +
    `<p>Each sign-in link works once, and this one was already redeemed. If that wasn't you, request a fresh link below.</p>` +
    newLinkForm(email) +
    `<p class="muted"><a href="/check">Go to the check tool</a></p>`
  );
}

function expiredPage(email?: string): string {
  return (
    `<h1>This sign-in link has expired</h1>` +
    `<p>Sign-in links are valid for 15 minutes. Request a fresh one below.</p>` +
    newLinkForm(email) +
    `<p class="muted"><a href="/check">Go to the check tool</a></p>`
  );
}

function invalidPage(): string {
  return (
    `<h1>This sign-in link isn't valid</h1>` +
    `<p>That link is missing its token or has the wrong address — open the full link from your email, or request a new one.</p>` +
    `<a class="btn" href="/check">Go to the check tool</a>`
  );
}

function linkSentPage(): string {
  return (
    `<h1>Check your email</h1>` +
    `<p>Your new sign-in link is on its way — it works once and expires in 15 minutes. Tap the link, then tap <strong>Continue</strong>.</p>` +
    `<a class="btn" href="/check">Go to the check tool</a>`
  );
}

function sendFailedPage(): string {
  return (
    `<h1>We couldn't send the email</h1>` +
    `<p>Something went wrong on our side and the sign-in email didn't go out. Please try again in a moment.</p>` +
    `<a class="btn" href="/check">Go to the check tool</a>`
  );
}

function badEmailPage(): string {
  return (
    `<h1>That email doesn't look right</h1>` +
    `<p>Double-check the address and try again.</p>` +
    `<a class="btn" href="/check">Go to the check tool</a>`
  );
}

function rateLimitedPage(): string {
  return (
    `<h1>Too many requests</h1>` +
    `<p>Sign-in links were requested a few times recently — wait a few minutes and try again.</p>` +
    `<a class="btn" href="/check">Go to the check tool</a>`
  );
}

/* ------------------------------- endpoints ------------------------------- */

async function handleAuthRequest(request: Request): Promise<Response> {
  // Two content types: JSON (the sign-in UI's fetch — returns JSON) and
  // form-encoded (the no-JS "email me a new link" recovery forms — returns a
  // plain HTML page so a plain form POST never lands on raw JSON).
  const contentType = request.headers.get("content-type") ?? "";
  const isForm = contentType.includes("application/x-www-form-urlencoded");
  let email: unknown;
  let from: unknown;
  if (isForm) {
    try {
      const form = new URLSearchParams(await request.text());
      email = form.get("email");
      from = form.get("from");
    } catch {
      return authPage("We couldn't send the email", sendFailedPage(), 400);
    }
  } else {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "expected a JSON body" }, 400);
    }
    email = (body as { email?: unknown }).email;
    from = (body as { from?: unknown }).from;
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const result = await requestMagicLink(email, ip, from as string | undefined);
  if (isForm) {
    if (result.ok) return authPage("Check your email", linkSentPage());
    if (result.status === 400) return authPage("That email doesn't look right", badEmailPage(), 400);
    if (result.status === 429) return authPage("Too many requests", rateLimitedPage(), 429);
    return authPage("We couldn't send the email", sendFailedPage(), result.status >= 500 ? result.status : 500);
  }
  if (result.ok) {
    return json({ ok: true, message: result.message });
  }
  return json({ ok: false, error: result.error }, result.status);
}

async function handleVerifyGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const from = sanitizeFrom(url.searchParams.get("from"));
  // Read-only: NEVER consumes the token here. Mail apps' link-safety scanners
  // GET this URL in the background before the user taps; the token is spent
  // only by the user's explicit POST below.
  const lookup = await lookupMagicLink(token);
  if (lookup.status === "valid") {
    return authPage("Sign in to HireClarity Data", continuePage(token ?? "", from, lookup.email));
  }
  if (lookup.status === "used") {
    return authPage("This sign-in link has already been used", usedPage(lookup.email), 400);
  }
  if (lookup.status === "expired") {
    return authPage("This sign-in link has expired", expiredPage(lookup.email), 400);
  }
  return authPage("This sign-in link isn't valid", invalidPage(), 400);
}

async function handleVerifyPost(request: Request): Promise<Response> {
  let token: string | null = null;
  let from = sanitizeFrom(null);
  try {
    const form = new URLSearchParams(await request.text());
    token = form.get("token");
    from = sanitizeFrom(form.get("from"));
  } catch {
    return authPage("This sign-in link isn't valid", invalidPage(), 400);
  }
  // The ONLY consumer of the single-use token (atomic conditional UPDATE).
  const result = await verifyMagicLink(token, from);
  if (result.ok) {
    // Success: set the httpOnly session cookie and redirect (302).
    const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
    return new Response(null, {
      status: 302,
      headers: {
        location: from,
        "set-cookie": sessionCookieHeader(request, result.sessionToken ?? "", maxAgeSec),
      },
    });
  }
  if (result.reason === "server") {
    return authPage("Something went wrong", sendFailedPage(), 500);
  }
  // Honest error page. Re-check read-only so the recovery form can prefill the
  // email from the token row (the atomic claim above already failed, so the
  // row can only be used/expired/invalid — safe to render from the lookup).
  const lookup = await lookupMagicLink(token);
  if (lookup.status === "used") {
    return authPage("This sign-in link has already been used", usedPage(lookup.email), 400);
  }
  if (lookup.status === "expired") {
    return authPage("This sign-in link has expired", expiredPage(lookup.email), 400);
  }
  return authPage("This sign-in link isn't valid", invalidPage(), 400);
}

async function handleAuthLogout(request: Request): Promise<Response> {
  const raw = readSessionRawToken(request);
  await deleteSessionByRawToken(raw);
  // Clear the cookie even when there was no session (idempotent).
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...JSON_HEADERS, "set-cookie": sessionCookieHeader(request, "", 0) },
  });
}

async function handleAuthMe(request: Request): Promise<Response> {
  const raw = readSessionRawToken(request);
  const email = raw ? await currentUserEmail(request) : null;
  if (!email) {
    return json({ error: "Not signed in." }, 401);
  }
  if (raw) await touchSessionLastSeen(raw, new Date().toISOString());
  return json({ email });
}

/**
 * Route auth HTTP requests; returns null when the request is not ours and
 * should continue to the normal site handler.
 */
export async function handleAuthHttp(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/api/auth/request") {
    return handleAuthRequest(request);
  }
  if (pathname === "/api/auth/verify") {
    // GET = scanner-safe interstitial (never consumes); POST = the user's
    // explicit Continue tap (consumes exactly once).
    return request.method === "GET" ? handleVerifyGet(request) : handleVerifyPost(request);
  }
  if (request.method === "POST" && pathname === "/api/auth/logout") {
    return handleAuthLogout(request);
  }
  if (request.method === "GET" && pathname === "/api/auth/me") {
    return handleAuthMe(request);
  }
  return null;
}
