/**
 * Quarterly company reputation report EMAIL delivery (server-only) — Batch 3B.
 *
 * Follows the report-email.ts / watch-alerts.ts patterns exactly:
 *   - With RESEND_API_KEY set: POSTs to https://api.resend.com/emails with
 *     Bearer auth; `from` defaults to the Resend onboarding address and can be
 *     overridden with EMAIL_FROM (must be a verified sender in Resend).
 *   - Without RESEND_API_KEY: sends NOTHING, logs, returns `sent: false` —
 *     callers never report the email as sent.
 *   - Test/example addresses are never emailed (isTestAddress guard).
 *
 * GUARD (the quarterly "one email per company per quarter" contract):
 *   For each ACTIVE company subscriber (isSubscribed("company") — looked up
 *   from the subscriptions table), we match their email to a tracked company
 *   by matching the company name against the registry (documented rule in
 *   engine/company-report.ts matchCompanyForEmail: the email's local part or
 *   domain's first label, normalized, must uniquely equal a registry company's
 *   normalized name).
 *
 *   Two sync_meta keys per (company, quarter):
 *     company_report_email_<quarter>_<key>      — created ONLY after Resend
 *                                                  ACCEPTS the email (2xx + id).
 *                                                  Its existence = "already
 *                                                  emailed this quarter".
 *     company_report_sending_<quarter>_<key>    — atomic in-flight lock
 *                                                  (tryCreateMeta) so two racing
 *                                                  cron invocations can't both
 *                                                  send. Deleted when the send
 *                                                  finishes (success or failure),
 *                                                  so a FAILED send leaves no
 *                                                  claim and the next run
 *                                                  retries honestly.
 *   An unmatched email is skipped with the reason logged (never guessed).
 */

import { Store } from "../../engine/store";
import { currentQuarter, generateCompanyReport, matchCompanyForEmail, quarterLabel, type CompanyReport } from "../../engine/company-report";
import { SEED_COMPANIES } from "../../engine/companies";
import { listActiveSubscribers } from "./subscriptions";
import { isTestAddress, maskEmail } from "./report-email";

/** Live origin — every link in the quarterly report email points here. */
export const REPORT_ORIGIN = "https://hireclarity-data.vercel.app";

export interface CompanyReportEmailResult {
  sent: boolean;
  reason: "no-resend-key" | "resend-error" | null;
  resendId?: string;
  error?: string;
}

export interface CompanyReportEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Escape for HTML text and attribute contexts. */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The report page link for a company (all URLs point at the live origin). */
export function companyReportUrl(company: string): string {
  return `${REPORT_ORIGIN}/company/report?company=${encodeURIComponent(company)}`;
}

/**
 * Build the quarterly email for one report. Subject follows
 * "Your Q3 2026 HireClarity Data reputation report". Body = score, top fix
 * count, benchmark line, link to the report page — every figure pulled from
 * the report object at send time, never hard-coded.
 */
export function buildCompanyReportEmailContent(report: CompanyReport): CompanyReportEmailContent {
  const qLabel = quarterLabel(report.quarter) ?? report.quarter;
  const subject = `Your ${qLabel} HireClarity Data reputation report`;

  const scoreLine =
    report.score.score === null
      ? `We don't have a posting-health score for ${report.company} yet — fewer than 2 tracked postings, so there's nothing honest to score.`
      : `Your posting-health score is ${report.score.score} of 100 — ${report.score.label.toLowerCase()}.`;

  const fixesLine = report.fixes.healthy
    ? "No fix recommendations this quarter — your tracked postings look healthy."
    : `${plural(report.fixes.fixes.length, "fix recommendation")} ${report.fixes.fixes.length === 1 ? "is" : "are"} ready in the report: ${report.fixes.fixes
        .map((f) => f.heading)
        .join("; ")}.`;

  const benchLine = report.benchmarks
    ? report.benchmarks.comparable
      ? `You're compared with ${report.benchmarks.peerCount === 1 ? "1 tracked company" : `${report.benchmarks.peerCount} tracked companies`} in ${report.benchmarks.industry} (observed sample).`
      : `Benchmark comparison is on hold — fewer than 3 other tracked companies in ${report.benchmarks.industry} yet.`
    : "Benchmark comparison is n/a this quarter.";

  const url = companyReportUrl(report.company);

  const text =
    `Hi,\n\n` +
    `Your ${qLabel} HireClarity Data reputation report for ${report.company} is ready.\n\n` +
    `• ${scoreLine}\n` +
    `• ${fixesLine}\n` +
    `• ${benchLine}\n\n` +
    `Read the full report (score breakdown, quarter trends, fixes with affected postings, benchmarks):\n${url}\n\n` +
    `— HireClarity Data\n\n` +
    `You're getting this because you hold an active Company subscription. One email per quarter, on the 1st of Jan/Apr/Jul/Oct.`;

  const html =
    `<p>Hi,</p>` +
    `<p>Your <strong>${esc(qLabel)} HireClarity Data reputation report</strong> for <strong>${esc(report.company)}</strong> is ready.</p>` +
    `<ul>` +
    `<li>${esc(scoreLine)}</li>` +
    `<li>${esc(fixesLine)}</li>` +
    `<li>${esc(benchLine)}</li>` +
    `</ul>` +
    `<p><a href="${esc(url)}">Read the full report</a> — score breakdown, quarter trends, fixes with affected postings, and benchmarks.</p>` +
    `<p>— HireClarity Data</p>` +
    `<p style="font-size:12px;color:#8a94a6;margin-top:24px">You're getting this because you hold an active Company subscription. One email per quarter, on the 1st of Jan/Apr/Jul/Oct.</p>`;

  return { subject, text, html };
}

/** Send one quarterly report email via Resend. Never claims `sent: true` unless
 *  Resend accepted the message (HTTP 2xx + an id). */
export async function sendCompanyReportEmail(
  email: string,
  report: CompanyReport,
  opts: { dryRun?: boolean } = {}
): Promise<CompanyReportEmailResult & { content?: CompanyReportEmailContent }> {
  const content = buildCompanyReportEmailContent(report);
  if (opts.dryRun) {
    return { sent: false, reason: null, content };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[company-report-email] RESEND_API_KEY not set — report email NOT sent to ${maskEmail(email)}. Would-be email:\n${content.text}`);
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
      console.error(`[company-report-email] Resend refused the email to ${maskEmail(email)} (${res.status}): ${detail.slice(0, 300)}`);
      return { sent: false, reason: "resend-error", content, error: `resend http ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (!body.id) {
      console.error(`[company-report-email] Resend 2xx without an id for ${maskEmail(email)} — not counting as sent.`);
      return { sent: false, reason: "resend-error", content, error: "resend 2xx missing id" };
    }
    console.log(`[company-report-email] accepted by Resend for ${maskEmail(email)}: id=${body.id}`);
    return { sent: true, reason: null, content, resendId: body.id };
  } catch (err) {
    console.error("[company-report-email] Resend request failed:", err);
    return { sent: false, reason: "resend-error", content, error: String(err) };
  }
}

/* ------------------------------ the quarterly pass ------------------------------ */

export interface CompanyReportPassResult {
  quarter: string;
  /** distinct active company subscribers considered */
  subscribers: number;
  sent: number;
  skipped: { masked: string; company: string | null; reason: string }[];
  failures: { masked: string; company: string | null; reason: string }[];
}

/**
 * The quarterly cron pass: generate + email the current quarter's report to
 * every ACTIVE company subscriber whose email uniquely matches a tracked
 * company. Claims are per (company, quarter) — each company gets ONE email per
 * quarter even if several subscribers match it; a failed send leaves no claim
 * so the next run retries.
 *
 * Injectable seams (fixture tests): `registry` (default the seed registry),
 * `resolveEmails` (default the live subscriptions lookup) and `send` (default
 * the real Resend sender). `now` drives the quarter.
 */
export async function runQuarterlyCompanyReportPass(
  store: Store,
  opts: {
    now?: Date;
    registry?: { name: string }[];
    resolveEmails?: () => Promise<string[]>;
    send?: (email: string, report: CompanyReport) => Promise<CompanyReportEmailResult>;
    generate?: (company: string, quarter: string) => Promise<CompanyReport>;
  } = {}
): Promise<CompanyReportPassResult> {
  const now = opts.now ?? new Date();
  const registry = opts.registry ?? SEED_COMPANIES;
  const emails = await (opts.resolveEmails ?? (() => listActiveSubscribers("company")))();
  const sendFn = opts.send ?? sendCompanyReportEmail;
  const generateFn = opts.generate ?? ((company: string, quarter: string) => generateCompanyReport(store, company, quarter, now));

  const quarter = currentQuarter(now);

  const result: CompanyReportPassResult = { quarter, subscribers: emails.length, sent: 0, skipped: [], failures: [] };

  const alreadyEmailed = new Set<string>();
  for (const email of emails) {
    const masked = maskEmail(email);
    if (isTestAddress(email)) {
      result.skipped.push({ masked, company: null, reason: "test/example address — never emailed" });
      continue;
    }
    const company = matchCompanyForEmail(email, registry);
    if (!company) {
      result.skipped.push({
        masked,
        company: null,
        reason: "email doesn't uniquely match a tracked registry company (matched on local part / domain's first label vs normalized registry names)",
      });
      continue;
    }
    const companyKey = company.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const claimKey = `company_report_email_${quarter}_${companyKey}`;
    const sendingKey = `company_report_sending_${quarter}_${companyKey}`;

    // 1. Already delivered this quarter? (claim key only exists after a 2xx.)
    const claimed = await store.getMeta(claimKey).catch((err: unknown) => {
      console.error(`[company-report-email] claim read failed for ${companyKey}:`, err);
      return null;
    });
    if (claimed !== null) {
      result.skipped.push({ masked, company, reason: `already emailed this quarter (claim ${claimKey})` });
      continue;
    }
    if (alreadyEmailed.has(companyKey)) {
      result.skipped.push({ masked, company, reason: "company already emailed this quarter (first matching subscriber won)" });
      continue;
    }

    // 2. Atomic in-flight lock — one sender per (company, quarter) even if two
    //    cron invocations race.
    const acquired = await store.tryCreateMeta(sendingKey, now.toISOString()).catch((err: unknown) => {
      console.error(`[company-report-email] sending lock failed for ${companyKey}:`, err);
      return false;
    });
    if (!acquired) {
      result.skipped.push({ masked, company, reason: "another invocation is sending this company's report" });
      continue;
    }

    try {
      // 3. Generate (idempotent — replaces the stored (company, quarter) row).
      const report = await generateFn(company, quarter);
      // 4. Send; claim ONLY after Resend 2xx; failures leave no claim → retry.
      const res = await sendFn(email, report);
      if (res.sent) {
        const claimMade = await store.tryCreateMeta(claimKey, now.toISOString()).catch((err: unknown) => {
          console.error(`[company-report-email] claim failed after accepted send for ${companyKey}:`, err);
          return false;
        });
        if (!claimMade) {
          console.error(`[company-report-email] email accepted for ${companyKey} but the claim key could not be written — next run may re-email`);
        }
        alreadyEmailed.add(companyKey);
        result.sent++;
      } else {
        result.failures.push({ masked, company, reason: res.error ?? res.reason ?? "send failed" });
      }
    } catch (err) {
      result.failures.push({ masked, company, reason: String(err) });
    } finally {
      // 5. Release the in-flight lock — a failed send is retried next run.
      await store.deleteMeta(sendingKey).catch((err: unknown) => {
        console.error(`[company-report-email] sending lock delete failed for ${companyKey}:`, err);
      });
    }
  }

  console.log(
    `[company-report-email] quarterly pass ${quarter}: subscribers=${result.subscribers} sent=${result.sent} skipped=${result.skipped.length} failures=${result.failures.length}`
  );
  for (const s of result.skipped) console.log(`[company-report-email] skip ${s.masked}: ${s.reason}`);
  for (const f of result.failures) console.log(`[company-report-email] fail ${f.masked}: ${f.reason}`);

  return result;
}
