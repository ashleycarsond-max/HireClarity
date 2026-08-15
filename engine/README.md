# HireClarity Data tracking engine (v2 — Neon-backed)
Full documentation: **`/home/team/shared/engine-README.md`**
Quick start (from `/home/team/shared/site`):
```bash
bun run track <url>     # track a posting URL
bun run recheck         # re-fetch all tracked postings (rate-limited)
bun run signals         # signals JSON (input for the scoring layer)
bun run track-demo      # end-to-end demo on real Greenhouse + Ashby postings
bun run relist-demo     # fixture demo proving relist detection (200→404→200)
bun run migrate-neon    # one-off: copy real postings from the old SQLite store into Neon
```
Storage: **Neon serverless Postgres** via `process.env.DATABASE_URL`
(`@neondatabase/serverless` HTTP driver). Tables (`postings`, `checks`,
`events`, `sync_meta`, `report_snapshots`, `daily_snapshots`,
`posting_requirements`, `posting_pay`, `watchlists`, `company_reports`,
`discovery_candidates`) are created on first use. The old on-disk SQLite files
(`engine/data/*.sqlite`) remain as reference only — the engine no longer
reads or writes them.

## Registry growth — the scheduled daily pass (owner direction 2026-08-15)
The registry grows EVERY DAY, unattended and honestly. The mechanism (full
design: `/home/team/shared/registry-growth-design.md`):

- **`discovery_candidates` table in Neon** is the single source of truth for
  growth candidates (curated guesses, verified companies, user-check refs).
- **`bun run seed-candidates`** (engine/seed-discovery-pool.ts) idempotently
  seeds the pool: the 88 verified SEED_COMPANIES (as `verified`, with their
  verifiedAt) + the 231 FALLBACK_CANDIDATES (as `pending`). Re-running is a
  no-op for existing rows — it never clobbers learned state.
- **`bun run discovery-slice [--limit N]`** (engine/discovery-sync.ts) is the
  scheduled pass: picks a bounded slice of DUE candidates (pending first,
  failed-with-30-day-backoff, verified-with-90-day-re-verify-backoff;
  per-ATS-host capped DISCOVERY_HOST_CAP=3), verifies each LIVE through the
  same politeness layer as the sync, classifies with the same 9-way honesty
  rules as `bun run discover`, and records the result on the candidate row.
  It never writes postings — ingest stays with the hourly sync loop. Sizing:
  `DISCOVERY_PER_RUN` (default 8), `DISCOVERY_HOST_CAP` (3),
  `DISCOVERY_TIME_BUDGET_MS` (30_000).
- **`/api/cron/discover` at 01:45 UTC daily** (src/server/cron-http.ts) runs
  the same code; an atomic `discovery_day_<date>` claim makes duplicate
  invocations no-op; the summary JSON lands under `discovery_summary_<date>`
  in sync_meta (registry-growth KPI input). Registered in BOTH vercel.json
  and build-vercel.sh (prebuilt deploys read only the Build Output config).
- **buildRegistry** (engine/companies.ts) merges three sources: SEED_COMPANIES
  + `discovery_candidates WHERE status='verified'` + postings-derived
  companies (user checks). Only verified rows ever join; every failure is
  recorded and countable. Test-fixture names/boardIds (TestCo/acme) are
  denylisted (TEST_ARTIFACT) so fixtures can never enter the registry.
- **User checks feed the pool** (src/routes/check.tsx): every successful
  check of a supported board URL calls
  `store.ensureDiscoveryCandidateFromPosting` (INSERT ON CONFLICT DO NOTHING,
  source `user-check`, non-fatal) — the next daily pass verifies it live.
- **Workable** (re-verified 2026-08-15): the widget API v1 is retired — it
  404s every account, live or dead; careers pages are client-rendered SPAs
  with no parseable public board; Cloudflare challenges automated bursts
  (429 cf-mitigated). Workable stays at 0 accounts
  honestly — no real account has been registered as a candidate yet. The
  fetcher is implemented and would work if a real subdomain were added.
