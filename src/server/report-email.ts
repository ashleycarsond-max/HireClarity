/**
 * Monthly job-market report email delivery (server-only).
 *
 * Follows the auth-email.ts pattern exactly:
 *   - With RESEND_API_KEY set: POSTs to https://api.resend.com/emails with
 *     Bearer auth. `from` defaults to the Resend onboarding address and can be
 *     overridden with EMAIL_FROM (must be a verified sender in Resend).
 *   - Without RESEND_API_KEY: sends NOTHING, logs to the server console and
 *     returns `sent: false`. Callers must never report the email as sent.
 *
 * Honesty contract:
 *   - Only addresses in the signups table are ever emailed; test/example
 *     addresses are skipped by sendReportToSignups (and the CLI reports them
 *     as skipped, never silently sent).
 *   - The unsubscribe link is a one-click GET that removes ONLY that email
 *     from the signups table (see report-http.ts).
 *   - Every figure in the email comes from the stored report snapshot (an
 *     observed sample — the email says so) and the numbers are pulled from
 *     the snapshot at send time, never hard-coded.
 */
import type { ReportSnapshot } from "../../engine/report";
import { periodLabel } from "../../engine/report";
import { listSignups } from "./signup";

/** Live origin — every link in the report email points here. */
export const REPORT_ORIGIN = "https://hireclarity-data.vercel.app";

export interface ReportEmailResult {
  sent: boolean;
  reason: "no-resend-key" | "resend-error" | null;
  /** Resend's message id — present only when Resend ACCEPTED the email. */
  resendId?: string;
  error?: string;
}

export interface ReportEmailRecipientResult {
  /** address, masked for logs (a****n@example.com) */
  masked: string;
  sent: boolean;
  reason: string | null;
  resendId?: string;
}

/**
 * Test/example addresses are never emailed. Conservative guard on top of the
 * signups table: example.* domains, .test domains, and anything whose local
 * part contains "test" (e.g. test@example.com, user+test@x.com).
 */
export function isTestAddress(email: string): boolean {
  const e = email.toLowerCase();
  if (/example\.(com|org|net)$/.test(e)) return true;
  if (/\.test$/.test(e)) return true;
  const local = e.split("@")[0] ?? "";
  return local.includes("test");
}

/** a****n@example.com — enough to report the recipient without leaking it. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "****";
  if (local.length <= 2) return `${local[0] ?? "*"}****@${domain}`;
  return `${local[0]}****${local[local.length - 1]}@${domain}`;
}

/** One-click unsubscribe URL for a given address. */
export function unsubscribeUrl(email: string): string {
  return `${REPORT_ORIGIN}/api/report/unsubscribe?email=${encodeURIComponent(email)}`;
}

/** Escape for HTML text and attribute contexts. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ReportEmailContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * Build the email for one recipient from the stored snapshot. The subject is
 * fixed; the body's summary lines are derived from snapshot numbers only.
 */
export function buildReportEmailContent(snapshot: ReportSnapshot, email: string): ReportEmailContent {
  const p = snapshot.postings;
  const period = periodLabel(snapshot.period);
  const reportUrl = `${REPORT_ORIGIN}/reports/${snapshot.period}`;
  const unsubUrl = unsubscribeUrl(email);

  // ── summary lines (observed-sample figures, pulled from the snapshot) ──
  const topScore = [...snapshot.checks.scoreBuckets]
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count);
  const scoreLine =
    topScore.length === 0
      ? `No postings were checked for scores in ${period}.`
      : topScore.length === 1
        ? `${topScore[0].count} of ${snapshot.checks.distinctPostings} postings checked (${Math.round(topScore[0].share * 1000) / 10}%) scored in the ${topScore[0].bucket} band.`
        : `${topScore.map((b) => `${b.count} scored ${b.bucket}`).join("; ")} — of ${snapshot.checks.distinctPostings} postings checked.`;
  const boards = snapshot.boards
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((b) => `${b.board} ${b.count}`)
    .join(", ");
  const liveLine = `${p.live} are live right now, ${p.removed} have been removed${
    p.relistedAtLeastOnce > 0
      ? `, and ${p.relistedAtLeastOnce} were observed taken down and reposted`
      : ", and none has been observed taken down and reposted yet"
  }.`;

  const text =
    `Hi,\n\n` +
    `The first HireClarity Data job-market report is out — the honest, observed-sample numbers on ghost jobs and recycled postings.\n\n` +
    `You're getting this because you asked to hear when the first report came out.\n\n` +
    `${period}, at a glance (our observed sample: ${p.totalTracked} postings we track across ${p.distinctCompanies} companies${
      snapshot.observation.windowDays > 0 ? `, watched over ${snapshot.observation.windowDays} day${snapshot.observation.windowDays === 1 ? "" : "s"}` : ""
    }):\n` +
    `• ${liveLine}\n` +
    `• ${scoreLine}\n` +
    `• Board split: ${boards}.\n\n` +
    `Read the full report: ${reportUrl}\n\n` +
    `— HireClarity Data\n\n` +
    `You'll get one email per month, when the new report is published.\n` +
    `Unsubscribe with one click: ${unsubUrl}\n` +
    `If your mail app doesn't render links, reply to this email with "unsubscribe" and we'll take you off the list.`;

  const html =
    `<p>Hi,</p>` +
    `<p>The first <strong>HireClarity Data job-market report</strong> is out — the honest, observed-sample numbers on ghost jobs and recycled postings.</p>` +
    `<p><em>You're getting this because you asked to hear when the first report came out.</em></p>` +
    `<p><strong>${esc(period)}, at a glance</strong> (our observed sample: ${p.totalTracked} postings we track across ${p.distinctCompanies} companies${snapshot.observation.windowDays > 0 ? `, watched over ${snapshot.observation.windowDays} day${snapshot.observation.windowDays === 1 ? "" : "s"}` : ""}):</p>` +
    `<ul>` +
    `<li>${esc(liveLine)}</li>` +
    `<li>${esc(scoreLine)}</li>` +
    `<li>Board split: ${esc(boards)}.</li>` +
    `</ul>` +
    `<p><a href="${esc(reportUrl)}">Read the full report</a></p>` +
    `<p>— HireClarity Data</p>` +
    `<p style="font-size:12px;color:#8a94a6;margin-top:24px">You'll get one email per month, when the new report is published.<br/>` +
    `<a href="${esc(unsubUrl)}">Unsubscribe with one click</a> · if your mail app doesn't render links, reply to this email with "unsubscribe" and we'll take you off the list.</p>`;

  return { subject: "The HireClarity Data job-market report is out", text, html };
}

/**
 * Send one report email via Resend. `dryRun` returns the would-be email
 * without contacting Resend (verification path). Never claims `sent: true`
 * unless Resend accepted the message (HTTP 2xx + an id).
 */
export async function sendReportEmail(
  email: string,
  snapshot: ReportSnapshot,
  opts: { dryRun?: boolean } = {}
): Promise<ReportEmailResult & { content?: ReportEmailContent }> {
  const content = buildReportEmailContent(snapshot, email);
  if (opts.dryRun) {
    return { sent: false, reason: null, content };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[report-email] RESEND_API_KEY not set — report email NOT sent to ${email}. Would-be email:\n${content.text}`);
    return { sent: false, reason: "no-resend-key", content };
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
      console.error(`[report-email] Resend refused the email to ${maskEmail(email)} (${res.status}): ${detail.slice(0, 300)}`);
      return { sent: false, reason: "resend-error", content, error: `resend http ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (!body.id) {
      // Resend returned 2xx but no id — treat as not accepted (honest).
      console.error(`[report-email] Resend 2xx without an id for ${maskEmail(email)} — not counting as sent.`);
      return { sent: false, reason: "resend-error", content, error: "resend 2xx missing id" };
    }
    console.log(`[report-email] accepted by Resend for ${maskEmail(email)}: id=${body.id}`);
    return { sent: true, reason: null, content, resendId: body.id };
  } catch (err) {
    console.error("[report-email] Resend request failed:", err);
    return { sent: false, reason: "resend-error", content, error: String(err) };
  }
}

/**
 * Send the report to everyone in the signups table (test/example addresses
 * skipped — reported, never sent). Returns per-recipient results so callers
 * can report exactly how many went out and to whom (masked).
 */
export async function sendReportToSignups(
  snapshot: ReportSnapshot,
  opts: { dryRun?: boolean } = {}
): Promise<{ total: number; sent: number; skipped: number; recipients: ReportEmailRecipientResult[] }> {
  const signups = await listSignups();
  const recipients: ReportEmailRecipientResult[] = [];
  let sent = 0;
  let skipped = 0;
  for (const s of signups) {
    const masked = maskEmail(s.email);
    if (isTestAddress(s.email)) {
      skipped++;
      recipients.push({ masked, sent: false, reason: "test/example address — never emailed" });
      continue;
    }
    const res = await sendReportEmail(s.email, snapshot, opts);
    if (res.sent) sent++;
    recipients.push({ masked, sent: res.sent, reason: res.sent ? null : (res.error ?? res.reason), resendId: res.resendId });
  }
  return { total: signups.length, sent, skipped, recipients };
}
