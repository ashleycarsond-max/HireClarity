/**
 * Billing-table verification/cleanup CLI (dev tooling only — not part of the
 * site runtime; the runtime never touches the filesystem, this tool just runs
 * from the sandbox against Neon).
 *
 *   bun run billing-list                 # subscriptions + recent events + stripe_meta
 *   bun run billing-delete <email>       # delete subscription + events for one email
 *   bun run billing-simulate <tier> <email>
 *                                        # insert a TEST active subscription (30d) for the
 *                                        # given email+tier — lets you test gating without
 *                                        # Stripe keys; REMOVE it afterwards with billing-delete.
 *   bun run billing-tool usage-list [email]    # free-tier usage rows
 *   bun run billing-tool usage-delete <email>  # delete usage rows (resets free checks to 5)
 *
 * Prints the emails/ids you ask about — never the connection string and never
 * any Stripe secret.
 */

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — cannot reach Neon.");
  process.exit(1);
}
const sql = neon(url);

const DDL = [
  `CREATE TABLE IF NOT EXISTS subscriptions (
    stripe_subscription_id TEXT PRIMARY KEY,
    customer_email          TEXT,
    stripe_customer_id      TEXT,
    tier                    TEXT,
    status                  TEXT NOT NULL,
    current_period_end      TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS subscription_events (
    id                     SERIAL PRIMARY KEY,
    event_type             TEXT NOT NULL,
    at                     TEXT NOT NULL,
    stripe_subscription_id TEXT,
    customer_email         TEXT,
    tier                   TEXT,
    detail                 TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS stripe_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS usage (
    user_email  TEXT NOT NULL,
    month       TEXT NOT NULL,
    checks_used INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (user_email, month)
  )`,
];

function isoNow(): string {
  return new Date().toISOString();
}

async function main() {
  for (const ddl of DDL) await sql.query(ddl); // same DDL as the server modules

  const cmd = process.argv[2] ?? "list";

  if (cmd === "delete") {
    const email = process.argv[3];
    if (!email) {
      console.error("usage: bun run billing-delete <email>");
      process.exit(1);
    }
    const subs = await sql.query(`DELETE FROM subscriptions WHERE customer_email = $1 RETURNING stripe_subscription_id`, [email]);
    const evts = await sql.query(`DELETE FROM subscription_events WHERE customer_email = $1 RETURNING id`, [email]);
    console.log(`deleted ${subs.length} subscription row(s) and ${evts.length} event row(s) for ${email}`);
    return;
  }

  if (cmd === "simulate") {
    const tier = process.argv[3];
    const email = process.argv[4];
    if (tier !== "seeker" && tier !== "company") {
      console.error("usage: bun run billing-simulate <seeker|company> <email>");
      process.exit(1);
    }
    if (!email || !email.includes("@")) {
      console.error("usage: bun run billing-simulate <seeker|company> <email>");
      process.exit(1);
    }
    const now = isoNow();
    const end = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const subId = `test_${tier}_${Date.now()}`;
    await sql.query(
      `INSERT INTO subscriptions
         (stripe_subscription_id, customer_email, stripe_customer_id, tier, status, current_period_end, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $6)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         customer_email = EXCLUDED.customer_email, stripe_customer_id = EXCLUDED.stripe_customer_id,
         tier = EXCLUDED.tier, status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end,
         updated_at = EXCLUDED.updated_at`,
      [subId, email, `cus_test_${Date.now()}`, tier, end, now]
    );
    await sql.query(
      `INSERT INTO subscription_events (event_type, at, stripe_subscription_id, customer_email, tier, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ["simulated_test_subscription", now, subId, email, tier, JSON.stringify({ note: "CLI fixture — delete with bun run billing-delete" })]
    );
    console.log(`inserted TEST active ${tier} subscription for ${email} (expires ${end.slice(0, 10)}).`);
    console.log("This is a dev fixture only — remove it with: bun run billing-delete " + email);
    return;
  }

  if (cmd === "usage-list") {
    const email = process.argv[3];
    const rows = email
      ? await sql.query(`SELECT user_email, month, checks_used FROM usage WHERE user_email = $1 ORDER BY month`, [email])
      : await sql.query(`SELECT user_email, month, checks_used FROM usage ORDER BY month DESC, user_email LIMIT 50`);
    console.log(`usage rows: ${rows.length}`);
    for (const r of rows) {
      console.log(`${String(r.user_email)} | ${String(r.month)} | checks_used=${String(r.checks_used)}`);
    }
    return;
  }
  if (cmd === "usage-delete") {
    const email = process.argv[3];
    if (!email) {
      console.error("usage: bun run billing-delete usage <email> OR bun run billing-tool usage-delete <email>");
      console.error("simplest: bun run billing-usage-reset <email>");
      process.exit(1);
    }
    const rows = await sql.query(`DELETE FROM usage WHERE user_email = $1 RETURNING user_email, month, checks_used`, [email]);
    console.log(`deleted ${rows.length} usage row(s) for ${email} — free checks reset to 5 for next use`);
    return;
  }
  const subRows = await sql.query(
    `SELECT stripe_subscription_id, customer_email, stripe_customer_id, tier, status, current_period_end, updated_at
     FROM subscriptions ORDER BY updated_at DESC LIMIT 20`
  );
  console.log(`subscriptions: ${subRows.length} (most recent ${Math.min(subRows.length, 20)})`);
  for (const r of subRows) {
    console.log(
      `${String(r.stripe_subscription_id)} | email=${String(r.customer_email ?? "—")} | tier=${String(r.tier ?? "—")} | ${String(r.status)} | period_end=${String(r.current_period_end ?? "—")} | updated=${String(r.updated_at)}`
    );
  }

  const evtRows = await sql.query(
    `SELECT event_type, at, stripe_subscription_id, customer_email, tier FROM subscription_events ORDER BY id DESC LIMIT 10`
  );
  console.log(`\nrecent events:`);
  for (const r of evtRows) {
    console.log(`${String(r.at)} | ${String(r.event_type)} | ${String(r.stripe_subscription_id ?? "—")} | ${String(r.customer_email ?? "—")} | ${String(r.tier ?? "—")}`);
  }

  const metaRows = await sql.query(`SELECT key, updated_at FROM stripe_meta ORDER BY key`);
  console.log(`\nstripe_meta (${metaRows.length}):`);
  for (const r of metaRows) {
    console.log(`${String(r.key)} | updated ${String(r.updated_at)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
