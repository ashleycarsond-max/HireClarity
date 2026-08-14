/**
 * Watchlist alert email delivery via Resend (server-only).
 *
 * Same honesty contract as report-email.ts and auth-email.ts:
 *   - With RESEND_API_KEY set: POSTs to https://api.resend.com/emails with
 *     Bearer auth. `from` defaults to the Resend onboarding address, overridden
 *     by EMAIL_FROM (must be a verified sender in Resend).
 *   - Without RESEND_API_KEY: sends NOTHING and returns `sent: false` — the
 *     caller must never claim the email was sent (and must not update
 *     last_alert_at, so the next run retries honestly).
 *   - `sent: true` is only ever returned when Resend accepted the message
 *     (HTTP 2xx + a message id), which is logged.
 *
 * One-click UNWATCH: every email carries a GET link guarded by the user's
 * watch token (see watch-http.ts) — it removes ONLY that watch, never
 * anything else.
 */

import type { WatchAlertCandidate } from "../../engine/watchlist";

/** Live origin — every link in alert emails points here. */
export const WATCH_ORIGIN = "https://hireclarity-data.vercel.app";

export interface WatchEmailResult {
  sent: boolean;
  reason: "no-resend-key" | "resend-error" | null;
  /** Resend's message id — present only when Resend ACCEPTED the email. */
  resendId?: string;
  error?: string;
}

/** The one-click unwatch URL for one watch (guarded by the user's token). */
export function unwatchUrl(email: string, postingId: string, token: string): string {
  const p = new URLSearchParams({ email, posting: postingId, token });
  return `${WATCH_ORIGIN}/api/watch/remove?${p.toString()}`;
}

/** Escape for HTML text and attribute contexts. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface WatchEmailContent {
  subject: string;
  text: string;
  html: string;
}

const SUBJECTS: Record<WatchAlertCandidate["kind"], (title: string, days: number) => string> = {
  vanished: (t) => `Alert: ${t} was taken down`,
  relisted: (t) => `Alert: ${t} was relisted`,
  stale: (t, days) => `Alert: ${t} still listed after ${days} days`,
};

/**
 * Build the alert email for one candidate. The subject and body only ever
 * describe observed facts (the candidate's detail line comes from stored
 * events). The unwatch link removes exactly this watch.
 */
export function buildWatchAlertEmail(c: WatchAlertCandidate, email: string): WatchEmailContent {
  const title = c.title ?? "This posting";
  const subject = SUBJECTS[c.kind](title, c.daysListed);
  const watchlistUrl = `${WATCH_ORIGIN}/watchlist`;
  const unsub = unwatchUrl(email, c.postingId, c.watchToken);

  const text =
    `Hi,\n\n` +
    `You're watching this posting on HireClarity Data:\n` +
    `  ${title}\n` +
    `  ${c.canonicalUrl}\n` +
    `  Board: ${c.board}\n\n` +
    `What changed: it ${c.detail}\n\n` +
    `Open the posting: ${c.canonicalUrl}\n` +
    `Manage your watches: ${watchlistUrl}\n\n` +
    `— HireClarity Data\n\n` +
    `You get alert emails only for postings you're watching — at most one per posting per day.\n` +
    `Stop watching this posting with one click: ${unsub}`;

  const html =
    `<p>Hi,</p>` +
    `<p>You're watching this posting on <strong>HireClarity Data</strong>:</p>` +
    `<p style="margin:14px 0;padding:12px 14px;background:#f5f6f8;border-radius:10px;font-size:14px">` +
    `<strong>${esc(title)}</strong><br/>` +
    `<a href="${esc(c.canonicalUrl)}" style="color:#2563eb;word-break:break-all">${esc(c.canonicalUrl)}</a><br/>` +
    `<span style="color:#4a5568">Board: ${esc(c.board)}</span></p>` +
    `<p><strong>What changed:</strong> it ${esc(c.detail)}</p>` +
    `<p><a href="${esc(c.canonicalUrl)}" style="color:#2563eb">Open the posting</a> · ` +
    `<a href="${esc(watchlistUrl)}" style="color:#2563eb">Manage your watches</a></p>` +
    `<p>— HireClarity Data</p>` +
    `<p style="font-size:12px;color:#8a94a6;margin-top:24px">You get alert emails only for postings you're watching — at most one per posting per day.<br/>` +
    `<a href="${esc(unsub)}">Stop watching this posting with one click</a></p>`;

  return { subject, text, html };
}

/**
 * Send one watch alert via Resend. Never claims `sent: true` unless Resend
 * accepted the message (HTTP 2xx + an id).
 */
export async function sendWatchAlertEmail(
  email: string,
  candidate: WatchAlertCandidate
): Promise<WatchEmailResult> {
  const content = buildWatchAlertEmail(candidate, email);
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(
      `[watch-email] RESEND_API_KEY not set — alert email NOT sent to ${email}. Would-be email:\n${content.text}`
    );
    return { sent: false, reason: "no-resend-key" };
  }
  const sender = process.env.EMAIL_FROM ?? "HireClarity Data <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: sender, to: [email], subject: content.subject, text: content.text, html: content.html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[watch-email] Resend refused the alert email to ${email} (${res.status}): ${detail.slice(0, 300)}`);
      return { sent: false, reason: "resend-error", error: `resend http ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (!body.id) {
      console.error(`[watch-email] Resend 2xx without an id for ${email} — not counting as sent.`);
      return { sent: false, reason: "resend-error", error: "resend 2xx missing id" };
    }
    console.log(`[watch-email] accepted by Resend for ${email}: id=${body.id}`);
    return { sent: true, reason: null, resendId: body.id };
  } catch (err) {
    console.error("[watch-email] Resend request failed:", err);
    return { sent: false, reason: "resend-error", error: String(err) };
  }
}
