/**
 * Report HTTP endpoints (server-only).
 *
 * Served OUTSIDE the TanStack router (this react-start build has no API-route
 * support), from the server wrappers:
 *   - serve.ts        (Bun, port 3000 — platform working site)
 *   - vercel-entry.ts (Node, Vercel render function)
 * Both call handleReportHttp(request) before the router; when it returns a
 * Response the request is served and never reaches the site.
 *
 * Endpoints:
 *   GET /api/report/unsubscribe?email=<addr>   (the one-click link in the
 *       monthly report email)
 *       -> 200 plain HTML "You've been unsubscribed" page, Cache-Control:
 *          no-store. Removes ONLY that email from the signups table; the page
 *          renders the same confirmation whether or not the row existed
 *          (idempotent — no address enumeration, no "you weren't on the
 *          list" leak).
 *       -> 400 plain HTML page (missing/invalid email — the link is broken).
 * Only GET is accepted; anything else returns 405.
 */

import { normalizeEmail } from "../lib/email";
import { deleteSignup } from "./signup";

/** Escape for HTML text and attribute contexts. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal dependency-free HTML page (same approach as the auth pages — must
 * work in in-app browsers that prefetch links and may block scripts).
 * `Cache-Control: no-store` so proxies never serve a stale confirmation.
 */
function reportPage(title: string, bodyHtml: string, status = 200): Response {
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

function unsubscribedPage(): string {
  return (
    `<h1>You've been unsubscribed</h1>` +
    `<p>You won't get the HireClarity Data monthly job-market report anymore. If this wasn't you, or you change your mind, you can sign up again on the report page.</p>` +
    `<a class="btn" href="/reports">Read the latest report</a>` +
    `<p class="muted">The monthly report stays free and public — no account needed to read it.</p>`
  );
}

function invalidLinkPage(): string {
  return (
    `<h1>That unsubscribe link isn't valid</h1>` +
    `<p>The link is missing its email address or has the wrong format — open the full link from the report email. If it still doesn't work, reply to the email with "unsubscribe" and we'll take you off the list.</p>` +
    `<a class="btn" href="/reports">Go to the reports page</a>`
  );
}

async function handleUnsubscribe(request: Request): Promise<Response> {
  const email = normalizeEmail(new URL(request.url).searchParams.get("email"));
  if (!email) {
    return reportPage("That unsubscribe link isn't valid", invalidLinkPage(), 400);
  }
  try {
    await deleteSignup(email);
  } catch (err) {
    // Storage failed — be honest: do NOT claim they were unsubscribed. 500
    // with a clear message; the link can be re-tapped.
    console.error("[report] unsubscribe failed:", err);
    return reportPage(
      "Something went wrong",
      `<h1>We couldn't process that just now</h1>` +
        `<p>Something went wrong on our side and the unsubscribe didn't go through. Please try the link again in a moment.</p>` +
        `<a class="btn" href="/reports">Go to the reports page</a>`,
      500
    );
  }
  // Same confirmation whether or not a row existed (idempotent, no leak).
  return reportPage("You've been unsubscribed", unsubscribedPage(), 200);
}

/**
 * Route report HTTP requests; returns null when the request is not ours and
 * should continue to the normal site handler.
 */
export async function handleReportHttp(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/report/unsubscribe" || pathname === "/api/report/unsubscribe/") {
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ ok: false, error: "method not allowed — the unsubscribe link is a GET" }), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", allow: "GET" },
      });
    }
    return handleUnsubscribe(request);
  }
  return null;
}
