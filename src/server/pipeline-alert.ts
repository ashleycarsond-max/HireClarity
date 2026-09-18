/**
 * PIPELINE HEARTBEAT + FAILURE ALERTING (server-only; 2026-09-18 hardening).
 *
 * WHY: the daily/report compiles were dead for 28 days (2026-08-22 → 2026-09-17,
 * Neon 507 on unbounded reads) and NOTHING told anyone — every scheduled run
 * failed silently in the function logs. This module makes a silent outage
 * impossible:
 *
 *   1. SUCCESS HEARTBEAT — every cron body runs through `withPipelineHeartbeat`.
 *      A 2xx/3xx response upserts `pipeline_<job>_last_ok` (ISO timestamp) in
 *      sync_meta, so "when did this job last actually succeed?" is one query
 *      (`SELECT key, value FROM sync_meta WHERE key LIKE 'pipeline_%'`).
 *   2. FAILURE HEARTBEAT — a 5xx response (or a thrown error) upserts
 *      `pipeline_<job>_last_error` with the ISO timestamp + the honest error
 *      detail, and the timestamp is only updated on failure — a stale
 *      `last_ok` next to a fresh `last_error` is exactly the outage signal.
 *   3. ALERT EMAIL — the first failure sends a Resend email to the owner
 *      (ASHLEYCARSOND@GMAIL.COM) describing which endpoint failed and how.
 *      A repeat-failure cooldown (ALERT_COOLDOWN_MS, default 6 h) keeps a
 *      long outage from flooding the inbox: the sync job alone would otherwise
 *      mail ~96 times/day. The heartbeat key still updates on EVERY failure —
 *      only the email is rate-limited, and the cooldown is stated in the mail.
 *      No retry loops: one attempt per send, and a Resend problem is logged,
 *      never allowed to break the cron response.
 *
 * NOTHING here is allowed to break the cron: heartbeat and alert writes are
 * best-effort (wrapped), and a failure inside them is logged only. The handler's
 * own response (2xx summary / 5xx honest error) is always returned unchanged.
 */
import { Store } from "../../engine/store";

/** The cron jobs that carry a heartbeat + alert. */
export type PipelineJob = "daily" | "report" | "sync" | "requirements" | "discover";

/** Where each job's owner is told when the pipeline breaks. */
export const PIPELINE_ALERT_RECIPIENT = "ASHLEYCARSOND@GMAIL.COM";

/**
 * Minimum gap between alert EMAILS for the same job. Heartbeat keys always
 * update; this only throttles the mail so a multi-day outage sends a handful of
 * reminders instead of one per invocation. The cooldown is stated in the email.
 */
export const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** sync_meta keys per job: last success, last error, last alert email. */
export const PIPELINE_HEARTBEAT_KEYS: Record<PipelineJob, { ok: string; error: string; alert: string }> = {
  daily: { ok: "pipeline_daily_last_ok", error: "pipeline_daily_last_error", alert: "pipeline_daily_last_alert" },
  report: { ok: "pipeline_report_last_ok", error: "pipeline_report_last_error", alert: "pipeline_report_last_alert" },
  sync: { ok: "pipeline_sync_last_ok", error: "pipeline_sync_last_error", alert: "pipeline_sync_last_alert" },
  requirements: {
    ok: "pipeline_requirements_last_ok",
    error: "pipeline_requirements_last_error",
    alert: "pipeline_requirements_last_alert",
  },
  discover: { ok: "pipeline_discover_last_ok", error: "pipeline_discover_last_error", alert: "pipeline_discover_last_alert" },
};

/** The public path of each job (for the alert email). */
export const PIPELINE_ENDPOINT: Record<PipelineJob, string> = {
  daily: "/api/cron/daily",
  report: "/api/cron/report",
  sync: "/api/cron/sync",
  requirements: "/api/cron/requirements",
  discover: "/api/cron/discover",
};

export interface PipelineAlertResult {
  sent: boolean;
  /** why no email went out: missing key / Resend refusal / cooldown. null when sent. */
  reason: "no-resend-key" | "resend-error" | "cooldown" | null;
  resendId?: string;
  error?: string;
}

/** Escape for the HTML body (the detail can carry arbitrary error text). */
function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PipelineFailureEmail {
  subject: string;
  text: string;
  html: string;
}

/** Build the failure email (pure — exported so tests/CLI can render it). */
export function buildPipelineFailureEmail(
  job: PipelineJob,
  detail: string,
  at: string,
  opts: { repeatedSince?: string | null } = {}
): PipelineFailureEmail {
  const path = PIPELINE_ENDPOINT[job];
  const keys = PIPELINE_HEARTBEAT_KEYS[job];
  const lines = [
    `The scheduled pipeline job "${job}" FAILED on the live deployment.`,
    ``,
    `endpoint: ${path}`,
    `when:     ${at} (UTC)`,
    `result:   ${detail}`,
    ``,
    `These jobs run unattended (GitHub Actions schedules for sync/requirements/discover,`,
    `Vercel Cron for daily/report). Nothing retries automatically, so a run that fails is`,
    `lost until the next scheduled slot.`,
    ``,
    `Heartbeat keys in the database (sync_meta):`,
    `  ${keys.ok}     — last SUCCESS (unchanged when this mail is about a failure)`,
    `  ${keys.error}  — last ERROR (this failure, with its timestamp)`,
    ``,
    opts.repeatedSince
      ? `This job has been failing since at least ${opts.repeatedSince}. Repeats are emailed at most once per ${Math.round(
          ALERT_COOLDOWN_MS / 3600000
        )} hours so a long outage does not flood your inbox — the error key above updates on every single failure.`
      : `Further failures for this job are emailed at most once per ${Math.round(
          ALERT_COOLDOWN_MS / 3600000
        )} hours (the error key above updates on every failure).`,
    ``,
    `— HireClarity Data pipeline`,
  ];
  const text = lines.join("\n");
  const html =
    `<p><strong>The scheduled pipeline job "${esc(job)}" FAILED</strong> on the live deployment.</p>` +
    `<ul>` +
    `<li>endpoint: <code>${esc(path)}</code></li>` +
    `<li>when: ${esc(at)} (UTC)</li>` +
    `<li>result: <code>${esc(detail)}</code></li>` +
    `</ul>` +
    `<p>These jobs run unattended (GitHub Actions schedules for sync/requirements/discover, Vercel Cron for daily/report). Nothing retries automatically, so a run that fails is lost until the next scheduled slot.</p>` +
    `<p>Heartbeat keys in <code>sync_meta</code>:</p>` +
    `<ul>` +
    `<li><code>${esc(keys.ok)}</code> — last SUCCESS (unchanged when this mail is about a failure)</li>` +
    `<li><code>${esc(keys.error)}</code> — last ERROR (this failure, with its timestamp)</li>` +
    `</ul>` +
    `<p>${opts.repeatedSince ? `This job has been failing since at least ${esc(opts.repeatedSince)}. ` : ""}Further failures are emailed at most once per ${Math.round(
      ALERT_COOLDOWN_MS / 3600000
    )} hours — the error key updates on every failure.</p>` +
    `<p>— HireClarity Data pipeline</p>`;
  return { subject: `[HireClarity pipeline] ${path} failed`, text, html };
}

/**
 * Send ONE failure alert via Resend (same pattern as report-email.ts). Without
 * RESEND_API_KEY nothing is sent and that is reported honestly (never claimed as
 * sent). No retries.
 */
export async function sendPipelineFailureEmail(
  job: PipelineJob,
  detail: string,
  at: string,
  opts: { repeatedSince?: string | null } = {}
): Promise<PipelineAlertResult> {
  const content = buildPipelineFailureEmail(job, detail, at, opts);
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[pipeline-alert] RESEND_API_KEY not set — failure email NOT sent. Would-be email:\n${content.text}`);
    return { sent: false, reason: "no-resend-key" };
  }
  const sender = process.env.EMAIL_FROM ?? "HireClarity Data <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: sender,
        to: [PIPELINE_ALERT_RECIPIENT],
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
    });
    if (!res.ok) {
      const detailText = await res.text().catch(() => "");
      console.error(`[pipeline-alert] Resend refused the alert (${res.status}): ${detailText.slice(0, 300)}`);
      return { sent: false, reason: "resend-error", error: `resend http ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (!body.id) {
      console.error("[pipeline-alert] Resend 2xx without an id — not counting the alert as sent.");
      return { sent: false, reason: "resend-error", error: "resend 2xx missing id" };
    }
    console.log(`[pipeline-alert] alert emailed for ${job} (${PIPELINE_ENDPOINT[job]}): id=${body.id}`);
    return { sent: true, reason: null, resendId: body.id };
  } catch (err) {
    console.error("[pipeline-alert] Resend request failed:", err);
    return { sent: false, reason: "resend-error", error: String(err) };
  }
}

/** Best-effort heartbeat write — a store problem never breaks the cron. */
async function writeHeartbeat(key: string, value: string): Promise<void> {
  try {
    await new Store().setMeta(key, value);
  } catch (err) {
    console.error(`[pipeline-alert] heartbeat write failed for ${key} (non-fatal):`, err);
  }
}

/** Success: record the ISO timestamp of the last successful run. */
async function reportSuccess(job: PipelineJob, started: number): Promise<void> {
  const at = new Date().toISOString();
  await writeHeartbeat(PIPELINE_HEARTBEAT_KEYS[job].ok, at);
  console.log(`[pipeline-heartbeat] ${job} ok at ${at} (${Date.now() - started}ms)`);
}

/**
 * Failure: always record the error heartbeat, then email the owner unless the
 * last alert for this job is inside ALERT_COOLDOWN_MS. Returns the alert result
 * for logging; never throws.
 */
async function reportFailure(job: PipelineJob, detail: string, started: number): Promise<void> {
  const keys = PIPELINE_HEARTBEAT_KEYS[job];
  const at = new Date().toISOString();
  console.error(`[pipeline-heartbeat] ${job} FAILED at ${at} (${Date.now() - started}ms): ${detail}`);
  await writeHeartbeat(keys.error, `${at} — ${detail}`);

  const store = new Store();
  let lastAlert: string | null = null;
  try {
    lastAlert = await store.getMeta(keys.alert);
  } catch (err) {
    console.error(`[pipeline-alert] could not read ${keys.alert} (non-fatal, alerting anyway):`, err);
  }
  if (lastAlert) {
    const age = Date.now() - Date.parse(lastAlert);
    if (Number.isFinite(age) && age >= 0 && age < ALERT_COOLDOWN_MS) {
      console.log(
        `[pipeline-alert] ${job}: alert suppressed (last one ${Math.round(age / 60000)} min ago, cooldown ${Math.round(
          ALERT_COOLDOWN_MS / 60000
        )} min) — the error heartbeat was still written`
      );
      return;
    }
  }
  const since = lastAlert && Number.isFinite(Date.parse(lastAlert)) ? lastAlert : null;
  const result = await sendPipelineFailureEmail(job, detail, at, { repeatedSince: since });
  // Anchor the cooldown whether or not Resend accepted it: a broken mail path
  // must not turn into one attempt per invocation.
  await writeHeartbeat(keys.alert, at);
  console.log(`[pipeline-alert] ${job} alert: ${result.sent ? `sent (${result.resendId})` : `not sent (${result.reason})`}`);
}

/**
 * Run one cron body with the heartbeat + alert wrapper.
 *
 * Success = a response with a 2xx/3xx status. 4xx responses (401 unauthorized /
 * 405 method) are the caller's guard rails, not pipeline failures, so they are
 * not alerted. 5xx responses and thrown errors are failures: heartbeat + alert
 * email, then the ORIGINAL response is returned (the wrapper never rewrites a
 * handler's honest error into a success).
 */
export async function withPipelineHeartbeat(
  job: PipelineJob,
  started: number,
  body: () => Promise<Response>
): Promise<Response> {
  try {
    const res = await body();
    if (res.status >= 500) {
      const text = await res
        .clone()
        .text()
        .catch(() => "");
      await reportFailure(job, `HTTP ${res.status} ${text.slice(0, 500)}`.trim(), started);
    } else if (res.status < 400) {
      await reportSuccess(job, started);
    }
    return res;
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await reportFailure(job, `uncaught ${detail}`, started);
    return new Response(JSON.stringify({ ok: false, error: `${job} failed — see function logs` }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
