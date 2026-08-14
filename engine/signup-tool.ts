/**
 * Signup-table verification/cleanup CLI (dev tooling only — not part of the
 * site runtime; the runtime never touches the filesystem, this tool just runs
 * from the sandbox against Neon).
 *
 *   bun run signup-list               # total count + newest rows (email, source, created_at)
 *   bun run signup-delete <email>     # delete one row by email (test cleanup)
 *
 * Prints the test email you ask about — never the connection string.
 */

import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — cannot reach Neon.");
  process.exit(1);
}
const sql = neon(url);

const DDL = `CREATE TABLE IF NOT EXISTS signups (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  source     TEXT NOT NULL DEFAULT 'landing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

async function main() {
  await sql.query(DDL); // same DDL as src/server/signup.ts — safe before any submission

  const cmd = process.argv[2] ?? "list";

  if (cmd === "delete") {
    const email = process.argv[3];
    if (!email) {
      console.error("usage: bun run signup-delete <email>");
      process.exit(1);
    }
    const rows = await sql.query(`DELETE FROM signups WHERE email = $1 RETURNING id`, [email]);
    console.log(`deleted ${rows.length} row(s) for ${email}`);
    return;
  }

  const countRows = await sql.query(`SELECT COUNT(*) AS n FROM signups`);
  console.log(`signups count: ${Number(countRows[0]?.n ?? 0)}`);

  const rows = await sql.query(
    `SELECT email, source, created_at FROM signups ORDER BY created_at DESC LIMIT 10`
  );
  for (const r of rows) {
    console.log(`${String(r.email)} | source=${String(r.source)} | created_at=${String(r.created_at)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
