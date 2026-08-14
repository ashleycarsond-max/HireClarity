/** Dev tool: remove ALL e2e free-tier test fixtures for one email (sessions, users, auth_tokens, usage, subscriptions, events). */
import { neon } from "@neondatabase/serverless";
const email = process.argv[2];
if (!email) {
  console.error("usage: bun run engine/e2e-cleanup.ts <email>");
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL!);
const out: string[] = [];
for (const [table, col] of [
  ["sessions", "user_email"],
  ["auth_tokens", "email"],
  ["users", "email"],
  ["usage", "user_email"],
  ["subscriptions", "customer_email"],
  ["subscription_events", "customer_email"],
] as const) {
  try {
    const r = await sql.query(`DELETE FROM ${table} WHERE ${col} = $1 RETURNING *`, [email]);
    out.push(`${table}: deleted ${r.length}`);
  } catch (e: any) {
    out.push(`${table}: ERROR ${e.message}`);
  }
}
console.log(out.join("\n"));
process.exit(0);
