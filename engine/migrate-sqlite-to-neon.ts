/**
 * One-off migration: copy the real tracked postings (and their checks/events)
 * from the v1 on-disk SQLite store (engine/data/tracker.sqlite) into Neon.
 *
 *   bun run migrate-neon [--force]
 *
 * Loopback fixture postings (127.0.0.1 / localhost) are skipped — they are
 * sandbox test data, and company.ts excludes them from profiles anyway.
 *
 * Safety: refuses to run when the Neon store already has postings unless
 * `--force` is passed (which wipes Neon first). Idempotent in the sense that
 * re-running with --force always reproduces the same state from the SQLite
 * file. The SQLite files remain in engine/data/ as reference only — the
 * engine no longer reads or writes them.
 */

import { Database } from "bun:sqlite";
import { rowToRecord, Store } from "./store";
import type { PostingEvent } from "./types";

const SRC = process.env.HIRECLARITY_SQLITE ?? new URL("../engine/data/tracker.sqlite", import.meta.url).pathname;
const FORCE = Bun.argv.includes("--force");

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

const db = new Database(SRC);
try {
  const postingRows = db.query("SELECT * FROM postings ORDER BY first_seen_at").all() as Record<string, unknown>[];
  const realRows = postingRows.filter((r) => !isLoopbackUrl(String(r.canonical_url)));
  const skipped = postingRows.length - realRows.length;

  const ids = new Set(realRows.map((r) => String(r.posting_id)));
  const checks = (db.query("SELECT posting_id, at, observed_status, status_code, note FROM checks").all() as Record<string, unknown>[]).filter(
    (c) => ids.has(String(c.posting_id))
  );
  const events = (db.query("SELECT posting_id, identity_key, type, at, detail FROM events").all() as Record<string, unknown>[]).filter(
    (e) => ids.has(String(e.posting_id))
  );

  const store = new Store();
  const existing = await store.count();
  if (existing > 0 && !FORCE) {
    console.error(
      `Neon already has ${existing} posting(s) — refusing to migrate over it. ` +
        `Use \`bun run migrate-neon --force\` to wipe Neon first and re-migrate from ${SRC}.`
    );
    process.exit(1);
  }
  if (existing > 0) {
    console.log(`--force: wiping ${existing} existing posting(s) from Neon first.`);
    await store.wipe();
  }

  for (const r of realRows) {
    await store.upsertPosting(rowToRecord(r));
  }
  for (const c of checks) {
    await store.addCheck(String(c.posting_id), String(c.at), String(c.observed_status), c.status_code == null ? null : Number(c.status_code), c.note ? String(c.note) : null);
  }
  for (const e of events) {
    await store.addEvent({
      postingId: String(e.posting_id),
      identityKey: e.identity_key ? String(e.identity_key) : "",
      type: String(e.type) as PostingEvent["type"],
      at: String(e.at),
      detail: e.detail ? String(e.detail) : null,
    });
  }

  console.log(`Migrated ${realRows.length} posting(s), ${checks.length} check(s), ${events.length} event(s) from ${SRC} → Neon.`);
  if (skipped > 0) console.log(`Skipped ${skipped} loopback fixture posting(s) (127.0.0.1/localhost test data).`);
  console.log(`Neon now holds ${await store.count()} posting(s).`);
} finally {
  db.close();
}
