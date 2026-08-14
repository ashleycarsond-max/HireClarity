/**
 * Inaugural report email CLI (dev tooling — run from the sandbox).
 *
 *   bun run report-email [YYYY-MM] [--dry-run]
 *
 * Reads the PUBLISHED snapshot for a period (default: current calendar month —
 * run `bun run report-generate` first if the period has no snapshot), lists the
 * signups table, and sends the report email to every real (non-test) address
 * via Resend. Test/example addresses are reported as skipped and never sent.
 *
 *   --dry-run  prints the would-be email for each recipient without sending
 *              (verification path when there are no real signups yet).
 *
 * Output is an honest tally: how many went out, to which addresses (masked),
 * each recipient's Resend message id when accepted, and any failures.
 *
 * The monthly cron (/api/cron/report) uses the same sendReportToSignups path —
 * this CLI exists for the inaugural issue, which the cron must NOT send (the
 * cron only emails a NEW period snapshot).
 */

import { Store } from "./store";
import { currentPeriod, periodLabel, type ReportSnapshot } from "./report";
import { isTestAddress, maskEmail, sendReportEmail } from "../src/server/report-email";
import { listSignups } from "../src/server/signup";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const periodArg = args.find((a) => /^\d{4}-\d{2}$/.test(a));
  const dryRun = args.includes("--dry-run");
  const period = periodArg ?? currentPeriod();

  const store = new Store();
  const stored = await store.getReportSnapshot(period);
  if (!stored) {
    console.error(`No published snapshot for ${period} — run \`bun run report-generate ${period}\` first.`);
    process.exit(1);
  }
  const snapshot = stored.payload as ReportSnapshot;
  const p = snapshot.postings;
  console.log(`Report email for ${periodLabel(snapshot.period)} (${snapshot.period})`);
  console.log(`  snapshot generated ${stored.generatedAt} — ${p.totalTracked} postings, ${p.live} live, ${p.removed} removed, ${p.distinctCompanies} companies`);
  console.log(`  mode: ${dryRun ? "DRY-RUN (nothing sent)" : "SEND via Resend"}`);
  console.log("");

  const signups = await listSignups();
  console.log(`Signups in table: ${signups.length}`);
  if (signups.length === 0) {
    console.log("No addresses — nothing to send. The email path is ready; it will send automatically when the first real signup lands (or run this again).");
    return;
  }

  const real = signups.filter((s) => !isTestAddress(s.email));
  const skipped = signups.filter((s) => isTestAddress(s.email));
  console.log(`  real recipients: ${real.length} | skipped (test/example): ${skipped.map((s) => maskEmail(s.email)).join(", ") || "none"}`);
  console.log("");

  let sent = 0;
  let failed = 0;
  for (const s of real) {
    const res = await sendReportEmail(s.email, snapshot, { dryRun });
    const masked = maskEmail(s.email);
    if (dryRun) {
      console.log(`[dry-run] to ${masked}`);
      console.log(`  subject: ${res.content?.subject}`);
      console.log(`  text: ${(res.content?.text ?? "").split("\n")[0]} …`);
      console.log(`  unsubscribe link: ${(res.content?.text ?? "").split("\n").find((l) => l.includes("/api/report/unsubscribe")) ?? "n/a"}`);
      continue;
    }
    if (res.sent) {
      sent++;
      console.log(`SENT to ${masked} — resend id ${res.resendId}`);
    } else {
      failed++;
      console.log(`FAILED to ${masked} — ${res.error ?? res.reason}${res.reason === "no-resend-key" ? " (RESEND_API_KEY not set — nothing was sent)" : ""}`);
    }
  }

  if (dryRun) {
    console.log(`\nDry-run complete: ${real.length} would-be email(s) shown, none sent.`);
  } else {
    console.log(`\nResult: ${sent} sent, ${failed} failed, ${skipped.length} skipped (test/example).`);
    if (failed > 0) process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
