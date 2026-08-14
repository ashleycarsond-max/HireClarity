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
`events`) are created on first use. The old on-disk SQLite files
(`engine/data/*.sqlite`) remain as reference only — the engine no longer
reads or writes them.
