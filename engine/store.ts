/**
 * Durable tracking storage via Neon serverless Postgres (HTTP driver) —
 * replaces the v1 on-disk bun:sqlite store so the engine runs in serverless
 * environments (Vercel functions can't persist files). The connection string
 * comes from `process.env.DATABASE_URL` (injected into the sandbox and passed
 * to the live host by go-live.sh); resolved lazily per query so the site
 * still builds/serves before a database is connected.
 *
 * Tables (same schema semantics as v1 SQLite):
 *   postings — one row per postingId (the URL identity anchor)
 *   checks   — append-only log of every HTTP observation (traceability)
 *   events   — state-transition events (first_seen / removed / relisted / ...)
 *
 * Timestamps are stored as TEXT (ISO strings), exactly like v1 — the driver
 * returns them as strings, so no client-side Date coercion is needed.
 *
 * The Store API is async (Neon is a network service); call sites await it.
 * `close()` is a no-op: the HTTP driver is stateless, there is nothing to
 * release per request.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { CheckRecord, PayInfo, PostingEvent, PostingRecord, PostingRequirement } from "./types";

/**
 * 64-hex-char random token without a node: import — engine/store.ts is shared
 * with the browser bundle (the check route imports the Store for its server
 * fns), so node:crypto would break the client build. Web Crypto's
 * getRandomValues exists in Node >= 19, Bun and every modern browser; the
 * Math.random fallback is only for exotic runtimes (best-effort, and the
 * token still only guards one-click unwatch links).
 */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) g.crypto.getRandomValues(arr);
  else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS postings (
    posting_id     TEXT PRIMARY KEY,
    canonical_url  TEXT NOT NULL UNIQUE,
    requested_url  TEXT,
    title          TEXT,
    company        TEXT,
    location       TEXT,
    posted_at      TEXT,
    source_board   TEXT NOT NULL,
    identity_key   TEXT,
    fingerprint    TEXT,
    status         TEXT NOT NULL,
    relist_count   INTEGER NOT NULL DEFAULT 0,
    first_seen_at  TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    last_checked_at TEXT,
    last_status_code INTEGER,
    last_note      TEXT,
    created_at     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_postings_identity ON postings(identity_key)`,
  `CREATE INDEX IF NOT EXISTS idx_postings_status ON postings(status)`,
  `CREATE TABLE IF NOT EXISTS checks (
    id              SERIAL PRIMARY KEY,
    posting_id      TEXT NOT NULL,
    at              TEXT NOT NULL,
    observed_status TEXT NOT NULL,
    status_code     INTEGER,
    note            TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_checks_posting ON checks(posting_id, at)`,
  `CREATE TABLE IF NOT EXISTS events (
    id           SERIAL PRIMARY KEY,
    posting_id   TEXT NOT NULL,
    identity_key TEXT,
    type         TEXT NOT NULL,
    at           TEXT NOT NULL,
    detail       TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_posting ON events(posting_id, at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_identity ON events(identity_key, at)`,
  `CREATE TABLE IF NOT EXISTS sync_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS report_snapshots (
    period       TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    payload      TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS posting_requirements (
    posting_id            TEXT PRIMARY KEY,
    requires_bachelor     BOOLEAN NOT NULL DEFAULT FALSE,
    requires_masters      BOOLEAN NOT NULL DEFAULT FALSE,
    requires_5plus_years  BOOLEAN NOT NULL DEFAULT FALSE,
    description_present   BOOLEAN NOT NULL DEFAULT FALSE,
    description_len       INTEGER NOT NULL DEFAULT 0,
    extracted_at          TEXT NOT NULL,
    fetch_error           TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_post_req_extracted ON posting_requirements(extracted_at)`,
  `CREATE TABLE IF NOT EXISTS posting_pay (
    posting_id   TEXT PRIMARY KEY,
    has_pay      BOOLEAN NOT NULL DEFAULT FALSE,
    pay_min      DOUBLE PRECISION,
    pay_max      DOUBLE PRECISION,
    currency     TEXT,
    period       TEXT,
    pay_text     TEXT,
    source       TEXT,
    fetch_error  TEXT,
    extracted_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_posting_pay_extracted ON posting_pay(extracted_at)`,
  `CREATE TABLE IF NOT EXISTS daily_snapshots (
    date       TEXT PRIMARY KEY,
    snapshot   JSONB NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS watchlists (
    id              SERIAL PRIMARY KEY,
    user_email      TEXT NOT NULL,
    posting_id      TEXT NOT NULL,
    watch_token     TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    last_alert_at   TEXT,
    stale_milestone INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_email, posting_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watchlists_email ON watchlists(user_email)`,
  `CREATE INDEX IF NOT EXISTS idx_watchlists_posting ON watchlists(posting_id)`,
  `CREATE TABLE IF NOT EXISTS company_reports (
    company      TEXT NOT NULL,
    quarter      TEXT NOT NULL,
    report       JSONB NOT NULL,
    generated_at TEXT NOT NULL,
    PRIMARY KEY (company, quarter)
  )`,
];

// Lazy module-level client + schema init: shared by the CLI, the dev server
// and the bundled production server; runs CREATE TABLE IF NOT EXISTS once per
// process (safe to run concurrently across processes — idempotent).
let _client: NeonQueryFunction<false, false> | null = null;
let _schemaReady: Promise<void> | null = null;

function client(): NeonQueryFunction<false, false> {
  if (!_client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set — the tracking store needs Neon. Connect the database (via the database card) and re-run."
      );
    }
    _client = neon(url);
  }
  return _client;
}

function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      const sql = client();
      for (const ddl of SCHEMA_STATEMENTS) await sql.query(ddl);
    })().catch((err: unknown) => {
      _schemaReady = null; // allow a retry if the first init failed
      throw err;
    });
  }
  return _schemaReady;
}

const ROW_COLS =
  "posting_id, canonical_url, requested_url, title, company, location, posted_at, source_board, identity_key, fingerprint, status, relist_count, first_seen_at, last_seen_at, last_checked_at, last_status_code, last_note, created_at";

/** One watchlist row — a user watching a posting (Job Seeker tier). */
export interface WatchlistRow {
  id: number;
  userEmail: string;
  postingId: string;
  /** Secret per-user token guarding the one-click unwatch links in alert emails. */
  watchToken: string;
  createdAt: string;
  lastAlertAt: string | null;
  /** The 30-day staleness milestone last alerted for this watch (0 = none yet). */
  staleMilestone: number;
}

export function rowToRecord(r: Record<string, unknown>): PostingRecord {
  return {
    postingId: String(r.posting_id),
    canonicalUrl: String(r.canonical_url),
    requestedUrl: r.requested_url ? String(r.requested_url) : null,
    title: r.title ? String(r.title) : null,
    company: r.company ? String(r.company) : null,
    location: r.location ? String(r.location) : null,
    postedAt: r.posted_at ? String(r.posted_at) : null,
    sourceBoard: String(r.source_board),
    identityKey: r.identity_key ? String(r.identity_key) : "",
    fingerprint: r.fingerprint ? String(r.fingerprint) : null,
    status: String(r.status) as PostingRecord["status"],
    relistCount: Number(r.relist_count),
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
    lastCheckedAt: r.last_checked_at ? String(r.last_checked_at) : "",
    lastStatusCode: r.last_status_code == null ? null : Number(r.last_status_code),
    lastNote: r.last_note ? String(r.last_note) : null,
    createdAt: String(r.created_at),
  };
}

export class Store {
  private async ready(): Promise<NeonQueryFunction<false, false>> {
    await ensureSchema();
    return client();
  }

  async upsertPosting(p: PostingRecord): Promise<void> {
    const sql = await this.ready();
    await sql.query(
      `INSERT INTO postings (${ROW_COLS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (posting_id) DO UPDATE SET
         canonical_url    = EXCLUDED.canonical_url,
         requested_url    = COALESCE(EXCLUDED.requested_url, postings.requested_url),
         title            = COALESCE(EXCLUDED.title, postings.title),
         company          = COALESCE(EXCLUDED.company, postings.company),
         location         = COALESCE(EXCLUDED.location, postings.location),
         posted_at        = COALESCE(EXCLUDED.posted_at, postings.posted_at),
         source_board     = EXCLUDED.source_board,
         identity_key     = EXCLUDED.identity_key,
         fingerprint      = EXCLUDED.fingerprint,
         status           = EXCLUDED.status,
         relist_count     = EXCLUDED.relist_count,
         first_seen_at    = postings.first_seen_at,
         last_seen_at     = EXCLUDED.last_seen_at,
         last_checked_at  = EXCLUDED.last_checked_at,
         last_status_code = EXCLUDED.last_status_code,
         last_note        = EXCLUDED.last_note`,
      [
        p.postingId, p.canonicalUrl, p.requestedUrl, p.title, p.company, p.location,
        p.postedAt, p.sourceBoard, p.identityKey, p.fingerprint, p.status, p.relistCount,
        p.firstSeenAt, p.lastSeenAt, p.lastCheckedAt, p.lastStatusCode, p.lastNote, p.createdAt,
      ]
    );
  }

  async getByPostingId(id: string): Promise<PostingRecord | null> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT ${ROW_COLS} FROM postings WHERE posting_id = $1`, [id]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  /**
   * Batched read for the sync loop: all records whose posting_id is in `ids`
   * (one query instead of N+1). Same rows as calling getByPostingId per id.
   */
  async getByPostingIds(ids: string[]): Promise<PostingRecord[]> {
    const sql = await this.ready();
    if (!ids.length) return [];
    const rows = await sql.query(`SELECT ${ROW_COLS} FROM postings WHERE posting_id = ANY($1::text[])`, [ids]);
    return rows.map(rowToRecord);
  }

  /**
   * Batched identity read for the sync loop: every record whose identity_key
   * is in `keys` (used to detect relists of removed identities). Same rows as
   * calling getByIdentity per key, deduplicated by posting_id.
   */
  async getByIdentityKeys(keys: string[]): Promise<PostingRecord[]> {
    const sql = await this.ready();
    const uniq = [...new Set(keys.filter(Boolean))];
    if (!uniq.length) return [];
    const rows = await sql.query(`SELECT ${ROW_COLS} FROM postings WHERE identity_key = ANY($1::text[])`, [uniq]);
    const byId = new Map<string, PostingRecord>();
    for (const r of rows) byId.set(String(r.posting_id), rowToRecord(r));
    return [...byId.values()];
  }

  async getByCanonicalUrl(url: string): Promise<PostingRecord | null> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT ${ROW_COLS} FROM postings WHERE canonical_url = $1`, [url]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async getAll(): Promise<PostingRecord[]> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT ${ROW_COLS} FROM postings ORDER BY first_seen_at`);
    return rows.map(rowToRecord);
  }

  async getByIdentity(key: string): Promise<PostingRecord[]> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT ${ROW_COLS} FROM postings WHERE identity_key = $1 ORDER BY first_seen_at`, [key]);
    return rows.map(rowToRecord);
  }

  /**
   * Records observed on a given board for a company (case-insensitive) — used
   * by the sync loop's removal pass: anything live here that is no longer in
   * the board's current job list is taken down.
   */
  async getByBoardAndCompany(board: string, company: string): Promise<PostingRecord[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT ${ROW_COLS} FROM postings
       WHERE LOWER(source_board) = LOWER($1) AND LOWER(COALESCE(company, '')) = LOWER($2)
       ORDER BY first_seen_at`,
      [board, company]
    );
    return rows.map(rowToRecord);
  }

  /** Records sharing an identity_key (exact match only — same as v1). */
  async identityGroupPostingIds(key: string): Promise<string[]> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT posting_id FROM postings WHERE identity_key = $1`, [key]);
    return rows.map((r) => String(r.posting_id));
  }

  async addCheck(postingId: string, at: string, observedStatus: string, statusCode: number | null, note: string | null): Promise<void> {
    const sql = await this.ready();
    await sql.query(
      `INSERT INTO checks (posting_id, at, observed_status, status_code, note) VALUES ($1, $2, $3, $4, $5)`,
      [postingId, at, observedStatus, statusCode, note]
    );
  }

  async addEvent(e: PostingEvent): Promise<void> {
    const sql = await this.ready();
    await sql.query(
      `INSERT INTO events (posting_id, identity_key, type, at, detail) VALUES ($1, $2, $3, $4, $5)`,
      [e.postingId, e.identityKey, e.type, e.at, e.detail]
    );
  }

  /**
   * Batched write path for the sync loop: persist many posting upserts, check
   * observations and events in a handful of HTTP transactions instead of one
   * round-trip per row. Semantically identical to calling upsertPosting /
   * addCheck / addEvent per row (same SQL, same params), just much faster —
   * which is what lets the scaled registry (60-120 companies) complete a full
   * hourly sync cycle inside Vercel's per-invocation time budget.
   *
   * Statements are chunked (default 200 per transaction) to keep request
   * payloads modest. The whole batch is not atomic across chunks — the sync
   * loop is idempotent (upserts + append-only checks/events), so a partial
   * batch is safe to re-run; per-chunk atomicity still prevents torn rows.
   */
  async flushSyncWrites(
    upserts: PostingRecord[],
    checks: { postingId: string; at: string; observedStatus: string; statusCode: number | null; note: string | null }[],
    events: PostingEvent[],
    payRows: PayInfo[] = [],
    chunkSize = 200
  ): Promise<void> {
    const sql = await this.ready();
    const stmts: Promise<unknown>[] = [];
    for (const p of upserts) {
      stmts.push(
        sql.query(
          `INSERT INTO postings (${ROW_COLS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           ON CONFLICT (posting_id) DO UPDATE SET
             canonical_url    = EXCLUDED.canonical_url,
             requested_url    = COALESCE(EXCLUDED.requested_url, postings.requested_url),
             title            = COALESCE(EXCLUDED.title, postings.title),
             company          = COALESCE(EXCLUDED.company, postings.company),
             location         = COALESCE(EXCLUDED.location, postings.location),
             posted_at        = COALESCE(EXCLUDED.posted_at, postings.posted_at),
             source_board     = EXCLUDED.source_board,
             identity_key     = EXCLUDED.identity_key,
             fingerprint      = EXCLUDED.fingerprint,
             status           = EXCLUDED.status,
             relist_count     = EXCLUDED.relist_count,
             first_seen_at    = postings.first_seen_at,
             last_seen_at     = EXCLUDED.last_seen_at,
             last_checked_at  = EXCLUDED.last_checked_at,
             last_status_code = EXCLUDED.last_status_code,
             last_note        = EXCLUDED.last_note`,
          [
            p.postingId, p.canonicalUrl, p.requestedUrl, p.title, p.company, p.location,
            p.postedAt, p.sourceBoard, p.identityKey, p.fingerprint, p.status, p.relistCount,
            p.firstSeenAt, p.lastSeenAt, p.lastCheckedAt, p.lastStatusCode, p.lastNote, p.createdAt,
          ]
        )
      );
    }
    for (const c of checks) {
      stmts.push(
        sql.query(
          `INSERT INTO checks (posting_id, at, observed_status, status_code, note) VALUES ($1, $2, $3, $4, $5)`,
          [c.postingId, c.at, c.observedStatus, c.statusCode, c.note]
        )
      );
    }
    for (const e of events) {
      stmts.push(
        sql.query(
          `INSERT INTO events (posting_id, identity_key, type, at, detail) VALUES ($1, $2, $3, $4, $5)`,
          [e.postingId, e.identityKey, e.type, e.at, e.detail]
        )
      );
    }
    for (const p of payRows) {
      stmts.push(
        sql.query(
          `INSERT INTO posting_pay (${Store.PAY_COLS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (posting_id) DO UPDATE SET
             has_pay      = posting_pay.has_pay OR EXCLUDED.has_pay,
             pay_min      = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.pay_min ELSE posting_pay.pay_min END,
             pay_max      = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.pay_max ELSE posting_pay.pay_max END,
             currency     = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.currency ELSE posting_pay.currency END,
             period       = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.period ELSE posting_pay.period END,
             pay_text     = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.pay_text ELSE posting_pay.pay_text END,
             source       = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.source ELSE posting_pay.source END,
             fetch_error  = EXCLUDED.fetch_error,
             extracted_at = EXCLUDED.extracted_at`,
          Store.payToRow(p)
        )
      );
    }
    for (let i = 0; i < stmts.length; i += chunkSize) {
      await sql.transaction(stmts.slice(i, i + chunkSize) as never);
    }
  }

  async eventsForPosting(postingId: string): Promise<PostingEvent[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT posting_id, identity_key, type, at, detail FROM events WHERE posting_id = $1 ORDER BY at, id`,
      [postingId]
    );
    return rows.map((r) => ({
      postingId: String(r.posting_id),
      identityKey: r.identity_key ? String(r.identity_key) : "",
      type: String(r.type) as PostingEvent["type"],
      at: String(r.at),
      detail: r.detail ? String(r.detail) : null,
    }));
  }

  /**
   * ALL transition events in one query — batched read for the monthly job-
   * market report (the events table is small: one row per state transition).
   */
  async allEvents(): Promise<PostingEvent[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT posting_id, identity_key, type, at, detail FROM events ORDER BY posting_id, at, id`
    );
    return rows.map((r) => ({
      postingId: String(r.posting_id),
      identityKey: r.identity_key ? String(r.identity_key) : "",
      type: String(r.type) as PostingEvent["type"],
      at: String(r.at),
      detail: r.detail ? String(r.detail) : null,
    }));
  }

  /**
   * Total check observations per posting (one GROUP BY query) — batched read
   * for the monthly job-market report's score distribution.
   */
  async checksByPosting(): Promise<{ postingId: string; count: number }[]> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT posting_id, COUNT(*) AS n FROM checks GROUP BY posting_id`);
    return rows.map((r) => ({ postingId: String(r.posting_id), count: Number(r.n) }));
  }

  async eventsForIdentity(key: string): Promise<PostingEvent[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT posting_id, identity_key, type, at, detail FROM events WHERE identity_key = $1 ORDER BY at, id`,
      [key]
    );
    return rows.map((r) => ({
      postingId: String(r.posting_id),
      identityKey: r.identity_key ? String(r.identity_key) : "",
      type: String(r.type) as PostingEvent["type"],
      at: String(r.at),
      detail: r.detail ? String(r.detail) : null,
    }));
  }

  async recentChecks(postingId: string, limit = 5): Promise<CheckRecord[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT id, posting_id, at, observed_status, status_code, note FROM checks WHERE posting_id = $1 ORDER BY at DESC LIMIT $2`,
      [postingId, limit]
    );
    return rows
      .map((r) => ({
        id: Number(r.id),
        postingId: String(r.posting_id),
        at: String(r.at),
        observedStatus: String(r.observed_status) as CheckRecord["observedStatus"],
        statusCode: r.status_code == null ? null : Number(r.status_code),
        note: r.note ? String(r.note) : null,
      }))
      .reverse();
  }

  async count(): Promise<number> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT COUNT(*) AS n FROM postings`);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * All check observations recorded in [startIso, endIso) — used by the
   * monthly job-market report (checks performed in the period).
   */
  async checksInPeriod(startIso: string, endIso: string): Promise<CheckRecord[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT id, posting_id, at, observed_status, status_code, note FROM checks WHERE at >= $1 AND at < $2 ORDER BY at, id`,
      [startIso, endIso]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      postingId: String(r.posting_id),
      at: String(r.at),
      observedStatus: String(r.observed_status) as CheckRecord["observedStatus"],
      statusCode: r.status_code == null ? null : Number(r.status_code),
      note: r.note ? String(r.note) : null,
    }));
  }

  /**
   * Persist a monthly report snapshot (idempotent — regenerating a period
   * replaces the row). `payload` is stored as JSON text; callers own the shape.
   */
  async saveReportSnapshot(period: string, generatedAt: string, payload: unknown): Promise<void> {
    const sql = await this.ready();
    await sql.query(
      `INSERT INTO report_snapshots (period, generated_at, payload) VALUES ($1, $2, $3)
       ON CONFLICT (period) DO UPDATE SET
         generated_at = EXCLUDED.generated_at,
         payload      = EXCLUDED.payload`,
      [period, generatedAt, JSON.stringify(payload)]
    );
  }

  /** Read one published snapshot (payload parsed from JSON). Null when not published. */
  async getReportSnapshot(period: string): Promise<{ generatedAt: string; payload: unknown } | null> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT generated_at, payload FROM report_snapshots WHERE period = $1`,
      [period]
    );
    if (!rows[0]) return null;
    return { generatedAt: String(rows[0].generated_at), payload: JSON.parse(String(rows[0].payload)) };
  }

  /* --------------------- posting_requirements (description extraction) --------------------- */

  private static REQUIREMENT_COLS =
    "posting_id, requires_bachelor, requires_masters, requires_5plus_years, description_present, description_len, extracted_at, fetch_error";

  private static requirementToRow(r: PostingRequirement): unknown[] {
    return [
      r.postingId, r.requiresBachelor, r.requiresMasters, r.requires5PlusYears,
      r.descriptionPresent, r.descriptionLen, r.extractedAt, r.fetchError,
    ];
  }

  private static rowToRequirement(row: Record<string, unknown>): PostingRequirement {
    return {
      postingId: String(row.posting_id),
      requiresBachelor: Boolean(row.requires_bachelor),
      requiresMasters: Boolean(row.requires_masters),
      requires5PlusYears: Boolean(row.requires_5plus_years),
      descriptionPresent: Boolean(row.description_present),
      descriptionLen: Number(row.description_len),
      extractedAt: String(row.extracted_at),
      fetchError: row.fetch_error == null ? null : String(row.fetch_error),
    };
  }

  /** Persist one posting's requirement extraction (idempotent upsert by posting_id). */
  async upsertRequirement(r: PostingRequirement): Promise<void> {
    await this.flushRequirementWrites([r]);
  }

  /**
   * Batched write path for the requirements refresh loop: same upsert SQL as
   * upsertRequirement, chunked into a handful of Neon transactions so a
   * REQUIREMENTS_PER_RUN slice (~250 rows) costs a few round-trips instead of
   * one per row. Idempotent (PK upsert), safe to re-run.
   */
  async flushRequirementWrites(rows: PostingRequirement[], chunkSize = 200): Promise<void> {
    const sql = await this.ready();
    if (!rows.length) return;
    const stmts: Promise<unknown>[] = [];
    for (const r of rows) {
      stmts.push(
        sql.query(
          `INSERT INTO posting_requirements (${Store.REQUIREMENT_COLS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (posting_id) DO UPDATE SET
             requires_bachelor    = EXCLUDED.requires_bachelor,
             requires_masters     = EXCLUDED.requires_masters,
             requires_5plus_years = EXCLUDED.requires_5plus_years,
             description_present  = EXCLUDED.description_present,
             description_len      = EXCLUDED.description_len,
             extracted_at         = EXCLUDED.extracted_at,
             fetch_error          = EXCLUDED.fetch_error`,
          Store.requirementToRow(r)
        )
      );
    }
    for (let i = 0; i < stmts.length; i += chunkSize) {
      await sql.transaction(stmts.slice(i, i + chunkSize) as never);
    }
  }

  /**
   * Candidate slice for the rolling requirements refresh: LIVE postings
   * (status live or relisted) ordered so the never-extracted ones come first,
   * then oldest-extracted first (round-robin by last extraction), then by
   * posting_id for a stable tiebreak — AND capped per host (ROW_NUMBER over
   * the posting's URL host) so one giant board (e.g. a 1,500-posting Ashby
   * host) cannot starve every other company's postings out of a run. The
   * slice interleaves hosts by rank (rank-1 posting of each host, then rank-2,
   * ...), so politeness per host (2s throttle) and breadth across hosts are
   * both bounded. `limit` bounds the returned rows; `hostCap` (default 10)
   * bounds each host's share.
   */
  async listRequirementCandidates(limit: number, hostCap = 10): Promise<PostingRecord[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT p.${ROW_COLS}
       FROM (
         SELECT p.posting_id,
                row_number() OVER (
                  PARTITION BY split_part(split_part(p.canonical_url, '://', 2), '/', 1)
                  ORDER BY (r.extracted_at IS NULL) DESC, r.extracted_at ASC NULLS FIRST, p.posting_id
                ) AS rn
         FROM postings p
         LEFT JOIN posting_requirements r ON r.posting_id = p.posting_id
         WHERE p.status IN ('live', 'relisted')
       ) ranked
       JOIN postings p ON p.posting_id = ranked.posting_id
       WHERE ranked.rn <= $2
       ORDER BY ranked.rn, p.posting_id
       LIMIT $1`,
      [limit, hostCap]
    );
    return rows.map(rowToRecord);
  }

  /** Read one posting's requirement row (null when it was never extracted). */
  async getRequirement(postingId: string): Promise<PostingRequirement | null> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT ${Store.REQUIREMENT_COLS} FROM posting_requirements WHERE posting_id = $1`,
      [postingId]
    );
    return rows[0] ? Store.rowToRequirement(rows[0]) : null;
  }

  /** Remove one requirement row (fixture cleanup). */
  async deleteRequirement(postingId: string): Promise<void> {
    const sql = await this.ready();
    await sql.query(`DELETE FROM posting_requirements WHERE posting_id = $1`, [postingId]);
  }

  /** Batched requirement read for daily-stats (one ANY() query instead of N+1). */
  async getRequirementsForPostingIds(ids: string[]): Promise<PostingRequirement[]> {
    const sql = await this.ready();
    const uniq = [...new Set(ids)];
    if (!uniq.length) return [];
    const rows = await sql.query(
      `SELECT ${Store.REQUIREMENT_COLS} FROM posting_requirements WHERE posting_id = ANY($1::text[])`,
      [uniq]
    );
    return rows.map(Store.rowToRequirement);
  }

  /* --------------------- posting_pay (pay-signal extraction) --------------------- */

  private static PAY_COLS =
    "posting_id, has_pay, pay_min, pay_max, currency, period, pay_text, source, fetch_error, extracted_at";

  private static payToRow(p: PayInfo): unknown[] {
    return [
      p.postingId, p.hasPay, p.payMin, p.payMax, p.currency, p.period, p.payText,
      p.source, p.fetchError, p.extractedAt,
    ];
  }

  private static rowToPay(row: Record<string, unknown>): PayInfo {
    return {
      postingId: String(row.posting_id),
      hasPay: Boolean(row.has_pay),
      payMin: row.pay_min == null ? null : Number(row.pay_min),
      payMax: row.pay_max == null ? null : Number(row.pay_max),
      currency: row.currency ? String(row.currency) : null,
      period: row.period ? (String(row.period) as PayInfo["period"]) : null,
      payText: row.pay_text ? String(row.pay_text) : null,
      source: row.source ? (String(row.source) as PayInfo["source"]) : null,
      fetchError: row.fetch_error ? String(row.fetch_error) : null,
      extractedAt: String(row.extracted_at),
    };
  }

  /**
   * Upsert one posting's pay extraction. The pay signal is MONOTONE on the
   * positive: once pay has been read for a posting, a later read that finds no
   * pay never downgrades the row (we saw it; we don't un-see it). The
   * "we read this listing and it states no pay" state is only ever written
   * over a row that never had pay, so the honest baselines stay distinct.
   */
  async upsertPay(p: PayInfo): Promise<void> {
    await this.flushPayWrites([p]);
  }

  /** Batched pay writes (same monotone SQL as upsertPay, chunked for Neon). */
  async flushPayWrites(rows: PayInfo[], chunkSize = 200): Promise<void> {
    const sql = await this.ready();
    if (!rows.length) return;
    const stmts: Promise<unknown>[] = [];
    for (const p of rows) {
      stmts.push(
        sql.query(
          `INSERT INTO posting_pay (${Store.PAY_COLS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (posting_id) DO UPDATE SET
             has_pay      = posting_pay.has_pay OR EXCLUDED.has_pay,
             pay_min      = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.pay_min ELSE posting_pay.pay_min END,
             pay_max      = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.pay_max ELSE posting_pay.pay_max END,
             currency     = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.currency ELSE posting_pay.currency END,
             period       = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.period ELSE posting_pay.period END,
             pay_text     = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.pay_text ELSE posting_pay.pay_text END,
             source       = CASE WHEN EXCLUDED.has_pay THEN EXCLUDED.source ELSE posting_pay.source END,
             fetch_error  = EXCLUDED.fetch_error,
             extracted_at = EXCLUDED.extracted_at`,
          Store.payToRow(p)
        )
      );
    }
    for (let i = 0; i < stmts.length; i += chunkSize) {
      await sql.transaction(stmts.slice(i, i + chunkSize) as never);
    }
  }

  /** One posting's pay row (null = pay not checked yet). */
  async getPay(postingId: string): Promise<PayInfo | null> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT ${Store.PAY_COLS} FROM posting_pay WHERE posting_id = $1`, [postingId]);
    return rows[0] ? Store.rowToPay(rows[0]) : null;
  }

  /** Batched pay read (one ANY() query — used by buildSignals for identity groups). */
  async getPaysForPostingIds(ids: string[]): Promise<PayInfo[]> {
    const sql = await this.ready();
    const uniq = [...new Set(ids)];
    if (!uniq.length) return [];
    const rows = await sql.query(`SELECT ${Store.PAY_COLS} FROM posting_pay WHERE posting_id = ANY($1::text[])`, [uniq]);
    return rows.map(Store.rowToPay);
  }

  /** Every pay row in the store (one query — the report/company-page context). */
  async allPay(): Promise<PayInfo[]> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT ${Store.PAY_COLS} FROM posting_pay`);
    return rows.map(Store.rowToPay);
  }

  /** Remove one posting's pay row (fixture cleanup). */
  async deletePay(postingId: string): Promise<void> {
    const sql = await this.ready();
    await sql.query(`DELETE FROM posting_pay WHERE posting_id = $1`, [postingId]);
  }

  /* ----------------------------- daily_snapshots (daily picture) ----------------------------- */

  /** Persist a daily snapshot (idempotent: re-running a date REPLACES the row). */
  async saveDailySnapshot(date: string, snapshot: unknown): Promise<void> {
    const sql = await this.ready();
    await sql.query(
      `INSERT INTO daily_snapshots (date, snapshot, created_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (date) DO UPDATE SET
         snapshot   = EXCLUDED.snapshot,
         created_at = EXCLUDED.created_at`,
      [date, JSON.stringify(snapshot), new Date().toISOString()]
    );
  }

  /** Read one daily snapshot (payload parsed from JSONB). Null when absent. */
  async getDailySnapshot(date: string): Promise<{ date: string; snapshot: unknown; createdAt: string } | null> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT date, snapshot::text AS snapshot, created_at FROM daily_snapshots WHERE date = $1`,
      [date]
    );
    if (!rows[0]) return null;
    return {
      date: String(rows[0].date),
      snapshot: JSON.parse(String(rows[0].snapshot)),
      createdAt: String(rows[0].created_at),
    };
  }

  /**
   * The daily snapshot for the latest date STRICTLY BEFORE `date` — the trend
   * comparison baseline for a given day's compile. Null when none exists.
   */
  async getPreviousDailySnapshot(date: string): Promise<{ date: string; snapshot: unknown; createdAt: string } | null> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT date, snapshot::text AS snapshot, created_at FROM daily_snapshots
       WHERE date < $1 ORDER BY date DESC LIMIT 1`,
      [date]
    );
    if (!rows[0]) return null;
    return {
      date: String(rows[0].date),
      snapshot: JSON.parse(String(rows[0].snapshot)),
      createdAt: String(rows[0].created_at),
    };
  }

  /** Remove one daily snapshot row (fixture cleanup / admin). */
  async deleteDailySnapshot(date: string): Promise<void> {
    const sql = await this.ready();
    await sql.query(`DELETE FROM daily_snapshots WHERE date = $1`, [date]);
  }

  /** All daily snapshots, oldest date first (the report compile layer — the monthly report aggregates these, it never recomputes from raw postings). */
  async listDailySnapshots(): Promise<{ date: string; snapshot: unknown; createdAt: string }[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT date, snapshot::text AS snapshot, created_at FROM daily_snapshots ORDER BY date ASC`
    );
    return rows.map((r) => ({
      date: String(r.date),
      snapshot: JSON.parse(String(r.snapshot)),
      createdAt: String(r.created_at),
    }));
  }

  /** All published snapshots, newest period first. */
  async listReportSnapshots(): Promise<{ period: string; generatedAt: string; payload: unknown }[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT period, generated_at, payload FROM report_snapshots ORDER BY period DESC`
    );
    return rows.map((r) => ({
      period: String(r.period),
      generatedAt: String(r.generated_at),
      payload: JSON.parse(String(r.payload)),
    }));
  }

  /**
   * Read an integer from the sync_meta key-value table (the sync-loop cursor).
   * Returns `def` when the key is missing or not an integer.
   */
  async getMetaInt(key: string, def: number): Promise<number> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT value FROM sync_meta WHERE key = $1`, [key]);
    const n = rows[0]?.value == null ? NaN : Number(rows[0].value);
    return Number.isFinite(n) ? n : def;
  }

  /** Write an integer to the sync_meta key-value table (upsert by key). */
  async setMetaInt(key: string, value: number): Promise<void> {
    const sql = await this.ready();
    await sql.query(
      `INSERT INTO sync_meta (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, String(value), new Date().toISOString()]
    );
  }

  /**
   * Atomically claim a sync_meta key (INSERT ... ON CONFLICT DO NOTHING).
   * Returns true only when THIS call created the key — the atomic "happens
   * once per period" guard the monthly report cron uses to make sure a new
   * period's report email is sent exactly once even if two cron invocations
   * race.
   */
  async tryCreateMeta(key: string, value: string): Promise<boolean> {
    const sql = await this.ready();
    const rows = await sql.query(
      `INSERT INTO sync_meta (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, value, new Date().toISOString()]
    );
    return rows.length > 0;
  }

  /** Remove one posting and all its checks/events (used by the relist-demo fixture cleanup). */
  async deletePosting(postingId: string): Promise<void> {
    const sql = await this.ready();
    await sql.query(`DELETE FROM events WHERE posting_id = $1`, [postingId]);
    await sql.query(`DELETE FROM checks WHERE posting_id = $1`, [postingId]);
    await sql.query(`DELETE FROM posting_pay WHERE posting_id = $1`, [postingId]);
    await sql.query(`DELETE FROM postings WHERE posting_id = $1`, [postingId]);
  }

  /** Wipe the whole tracking store (`bun run track-reset`). */
  async wipe(): Promise<void> {
    const sql = await this.ready();
    await sql.query(`DELETE FROM events`);
    await sql.query(`DELETE FROM checks`);
    await sql.query(`DELETE FROM posting_pay`);
    await sql.query(`DELETE FROM postings`);
  }

  /* ------------------------ company_reports (quarterly reputation) ------------------------ */

  /**
   * Persist one company's quarterly report (idempotent — regenerating a
   * (company, quarter) REPLACES the stored row). `report` is stored as JSON;
   * callers own the shape (see engine/company-report.ts CompanyReport).
   */
  async saveCompanyReport(company: string, quarter: string, report: unknown, generatedAt: string): Promise<void> {
    const sql = await this.ready();
    await sql.query(
      `INSERT INTO company_reports (company, quarter, report, generated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company, quarter) DO UPDATE SET
         report       = EXCLUDED.report,
         generated_at = EXCLUDED.generated_at`,
      [company, quarter, JSON.stringify(report), generatedAt]
    );
  }

  /** Read one stored company report (payload parsed from JSON). Null when never generated. */
  async getCompanyReport(company: string, quarter: string): Promise<{ company: string; quarter: string; report: unknown; generatedAt: string } | null> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT company, quarter, report::text AS report, generated_at FROM company_reports WHERE company = $1 AND quarter = $2`,
      [company, quarter]
    );
    if (!rows[0]) return null;
    return {
      company: String(rows[0].company),
      quarter: String(rows[0].quarter),
      report: JSON.parse(String(rows[0].report)),
      generatedAt: String(rows[0].generated_at),
    };
  }

  /** Every stored quarter for one company, newest first (the report page's quarter selector). */
  async listCompanyReports(company: string): Promise<{ quarter: string; generatedAt: string }[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT quarter, generated_at FROM company_reports WHERE company = $1 ORDER BY quarter DESC`,
      [company]
    );
    return rows.map((r) => ({ quarter: String(r.quarter), generatedAt: String(r.generated_at) }));
  }

  /** Remove one stored company report (fixture cleanup / admin). */
  async deleteCompanyReport(company: string, quarter: string): Promise<void> {
    const sql = await this.ready();
    await sql.query(`DELETE FROM company_reports WHERE company = $1 AND quarter = $2`, [company, quarter]);
  }

  /** Read a raw string from the sync_meta key-value table (null when missing). */
  async getMeta(key: string): Promise<string | null> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT value FROM sync_meta WHERE key = $1`, [key]);
    return rows[0]?.value == null ? null : String(rows[0].value);
  }

  /** Remove a sync_meta key — the retry path of the quarterly-email claim guard
   *  (a claim created for an in-flight send is deleted when the send FAILS, so
   *  the next cron run retries; a successful send keeps its claim key). */
  async deleteMeta(key: string): Promise<void> {
    const sql = await this.ready();
    await sql.query(`DELETE FROM sync_meta WHERE key = $1`, [key]);
  }

  /* ------------------- watchlists (Job Seeker watch + alert rows) ------------------- */

  private static WATCH_COLS =
    "id, user_email, posting_id, watch_token, created_at, last_alert_at, stale_milestone";

  private static rowToWatch(row: Record<string, unknown>): WatchlistRow {
    return {
      id: Number(row.id),
      userEmail: String(row.user_email),
      postingId: String(row.posting_id),
      watchToken: String(row.watch_token),
      createdAt: String(row.created_at),
      lastAlertAt: row.last_alert_at ? String(row.last_alert_at) : null,
      staleMilestone: Number(row.stale_milestone),
    };
  }

  /**
   * The secret watch token for a user (shared across all their watchlist rows —
   * it is what the one-click unwatch links in alert emails are guarded by).
   * Null when the user has no watches yet.
   */
  async getWatchToken(userEmail: string): Promise<string | null> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT watch_token FROM watchlists WHERE user_email = $1 LIMIT 1`,
      [userEmail]
    );
    return rows[0] ? String(rows[0].watch_token) : null;
  }

  /**
   * Add one watch (idempotent — re-adding is a no-op). The user's existing
   * watch token is reused; the first watch for a user mints a fresh 64-hex
   * token (only ever persisted; the raw token appears only in alert emails).
   */
  async addWatch(userEmail: string, postingId: string, token?: string): Promise<string> {
    const sql = await this.ready();
    const existingToken = token ?? (await this.getWatchToken(userEmail));
    const watchToken = existingToken ?? randomHex(32);
    await sql.query(
      `INSERT INTO watchlists (user_email, posting_id, watch_token, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_email, posting_id) DO NOTHING`,
      [userEmail, postingId, watchToken, new Date().toISOString()]
    );
    return watchToken;
  }

  /** Remove one watch (session-authenticated UI path). True when a row was removed. */
  async removeWatch(userEmail: string, postingId: string): Promise<boolean> {
    const sql = await this.ready();
    const rows = await sql.query(
      `DELETE FROM watchlists WHERE user_email = $1 AND posting_id = $2 RETURNING id`,
      [userEmail, postingId]
    );
    return rows.length > 0;
  }

  /**
   * Remove a watch via the email's one-click unwatch link — the token in the
   * link must match the row's stored token, so nobody can remove someone
   * else's watch by guessing email+postingId. True only when a row was removed.
   */
  async removeWatchByToken(userEmail: string, postingId: string, token: string): Promise<boolean> {
    const sql = await this.ready();
    const rows = await sql.query(
      `DELETE FROM watchlists
       WHERE user_email = $1 AND posting_id = $2 AND watch_token = $3
       RETURNING id`,
      [userEmail, postingId, token]
    );
    return rows.length > 0;
  }

  /** All watches for one user (the /watchlist page). */
  async listWatches(userEmail: string): Promise<WatchlistRow[]> {
    const sql = await this.ready();
    const rows = await sql.query(
      `SELECT ${Store.WATCH_COLS} FROM watchlists WHERE user_email = $1 ORDER BY created_at DESC, id DESC`,
      [userEmail]
    );
    return rows.map(Store.rowToWatch);
  }

  /** Every watch across all users (the hourly alert pass). */
  async listAllWatches(): Promise<WatchlistRow[]> {
    const sql = await this.ready();
    const rows = await sql.query(`SELECT ${Store.WATCH_COLS} FROM watchlists ORDER BY id`);
    return rows.map(Store.rowToWatch);
  }

  /** All watches whose posting is in `postingIds` (batched alert-check reads). */
  async listWatchesByPosting(postingIds: string[]): Promise<WatchlistRow[]> {
    const sql = await this.ready();
    const uniq = [...new Set(postingIds)];
    if (!uniq.length) return [];
    const rows = await sql.query(
      `SELECT ${Store.WATCH_COLS} FROM watchlists WHERE posting_id = ANY($1::text[]) ORDER BY id`,
      [uniq]
    );
    return rows.map(Store.rowToWatch);
  }

  /**
   * Record that an alert email was ACCEPTED for this watch. The caller updates
   * this ONLY after Resend accepts the message (never on failure), so the
   * guard is exactly "have we delivered an alert for this watch since X".
   */
  async updateLastAlertAt(watchId: number, at: string): Promise<void> {
    const sql = await this.ready();
    await sql.query(`UPDATE watchlists SET last_alert_at = $2 WHERE id = $1`, [watchId, at]);
  }

  /** Record the staleness milestone (30-day multiples) last alerted for a watch. */
  async updateStaleMilestone(watchId: number, milestone: number): Promise<void> {
    const sql = await this.ready();
    await sql.query(`UPDATE watchlists SET stale_milestone = $2 WHERE id = $1`, [watchId, milestone]);
  }

  /** No-op: the Neon HTTP driver is stateless — nothing to close per request. */
  close(): void {
    // intentionally nothing
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}
