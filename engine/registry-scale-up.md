# Registry Scale-Up — "track every posting on the tracked ATS boards"

Owner direction 2026-08-15: grow the registry orders of magnitude beyond the
current ~90 companies — every company posting on Greenhouse/Ashby/Lever boards
(thousands of companies, tens of thousands of postings), with the hourly sync
FULL-SCRUBBING the whole registry every few hours and EVERY posting's job
description read on a rolling basis so bachelor/masters/5+ years conclusions
stay accurate.

Shipped 2026-08-17 (PR #14, branch feat/registry-scale-up).

---

## 1. Baseline (measured live 2026-08-17, before this PR)

- Registry: **89 companies** (~8,050 tracked postings; 7,960 live).
- Hourly cron ran `COMPANIES_PER_RUN=8` → **full scrub cycle = 89/8 ≈ 12
  invocations ≈ 11–12 hours** (the plan's "~11h" — that was the baseline to
  beat).
- Measured per-company sync cost: **~1.76 s/company** (4 companies in 7.0s;
  dominated by the 2 s per-host politeness throttle on the shared board API
  hosts boards-api.greenhouse.io / api.ashbyhq.com / api.lever.co).
- Description coverage at ship (PR #12): 492/7,986 (~6.2%). Live at this
  PR's measurement: **3,420/7,960 read (43%)**, 210 fetch-errors, 4,330
  not-yet-extracted — the hourly+ daily sweeps had been climbing for ~2 days.
- Measured requirements sweep throughput: 30 postings in 15 s budget
  (25 s wall — the in-flight tail), ~3.75 s/posting typical.

## 2. Full-scrub cadence (GOAL 1 + 4)

**Change:** `runSyncChunk` is now bounded by BOTH `COMPANIES_PER_RUN` (hard
cap, clamp raised 50 → 1000) and a new wall-clock **`SYNC_TIME_BUDGET_MS`
(default 45 000)** — it processes companies until the budget expires (always
≥1), persists the cursor, and reports `skippedBudget`. The cron schedule went
from 1×/hour to **4×/hour (`0,15,30,45 * * * *`)**.

At ~1.8 s/company, one 45 s invocation does **~25 companies**; 4/hour ⇒
~100 companies/hour.

| Registry | Invocations/cycle | Cycle time @4/h | Notes |
|---|---|---|---|
| 89 (now) | ~4 | **~1 h** | was ~11–12 h before this PR |
| 200 | ~8 | ~2 h | |
| 500 | ~20 | ~5 h | |
| 1,000 | ~40 | ~10 h | politeness-throttle dominated |

The honest ceiling: the 2 s per-host throttle on the three shared ATS API
hosts is the binding constraint (1,000 companies ≈ 2,000 s minimum of pure
throttle ≈ 34 invocations). Levers, all env-only:
- raise `SYNC_TIME_BUDGET_MS` toward 50 s (watch the 60 s function limit —
  the budget only stops BETWEEN companies, so worst-case run = budget + one
  company's ~2.5 s fetch);
- add more invocations/hour (Vercel Pro allows per-minute crons, 100 jobs —
  every 5 min ⇒ 12/h ⇒ 1,000 companies in ~3.5 h);
- future: run board fetches for different ATS hosts in parallel within one
  invocation (politeness is per-host, hosts are independent — not done here).

## 3. Discovery pace (GOAL 3)

Defaults raised: `DISCOVERY_PER_RUN` 8 → **48**, `DISCOVERY_HOST_CAP` 3 →
**16**, `DISCOVERY_TIME_BUDGET_MS` 30 000 → **45 000**. Cron schedule:
1×/day → **4×/day (`45 1,7,13,19 * * *`)**, each slot claiming
`discovery_slot_<date>_<slot>` (slot = hour/6) so duplicate fires no-op while
all four slots run independently.

Pacing: ~45 s budget ÷ ~2.5–3 s per candidate ≈ **15–18 verified attempts per
slot ≈ 60–70/day ≈ 25–40 verified companies/day** at the pool's observed
~50% hit rate — an order of magnitude above the previous 3–5/day. The pool
drain at ~70/day means the new ~1,000-row pool lasts ~2 weeks, then user
checks + re-seeds keep it fed.

## 4. Description coverage at scale (GOAL 5)

**Change:** the sweep moved OUT of the shared sync handler into its own cron
**`/api/cron/requirements` (`5,35 * * * *` — every 30 min, offset from the
sync slots)**, so it gets its own full function window. Defaults:
`REQUIREMENTS_TIME_BUDGET_MS` 30 000 (was 25 s in the shared handler),
`REQUIREMENTS_CONCURRENCY` 12 (was 8). The 30 s budget keeps the worst-case
run ≤ ~55 s (budget + one in-flight extraction tail of up to ~25 s: robots 8 s
+ throttle 2 s + 15 s fetch).

Capacity: ~30 s ÷ ~3.75 s/posting × 12 concurrent hosts ≈ **~90–100
postings/run × 48 runs/day ≈ 4,300–4,800 descriptions/day** (plus the daily
cron's 30 s slice).

| Registry (live postings) | Never-read catch-up | 7-day freshness need | Capacity 48×/day | Holds? |
|---|---|---|---|---|
| 89 (7,960 now) | ~2 days (gap 4,330) | 1,137/day | ~4,500/day | yes |
| 200 (~16,000) | ~3–4 days on join | 2,286/day | ~4,500/day | yes |
| 500 (~40,000) | ~9 days on join | 5,714/day | ~4,500/day | no — raise cron to 3–4×/hour (env-free: edit vercel.json) or bump concurrency to 16 |
| 1,000 (~80,000) | ~18 days on join | 11,429/day | ~4,500/day | no — `*/15` cron + concurrency 16 (~11,500/day) |

Formula: `descriptions/day = runs/day × concurrency × budget / seconds-per-
posting`. The honest coverage metric (`postingsWithDescriptionRead` +
fetch-error + not-extracted) keeps reporting exactly what was read.

## 5. Candidate pool at scale (GOAL 2)

Pool before: **236 rows** (127 pending / 88 verified / 21 honest 404s) — and
the two days before this PR verified 16 candidates, ALL http-404: the old
pool was exhausted (good guesses already taken). New sources, all public and
robots-respecting:

1. `engine/candidates-scale.ts` — **SCALE_CANDIDATES**: ~230 curated
   Greenhouse + ~70 Ashby + ~24 Lever additions from public knowledge
   (companies' own careers pages / vendor marketing).
2. `engine/candidates-scale.ts` — **DIRECTORY_CANDIDATES**: 49 companies
   extracted from the ATS vendors' OWN public customer pages
   (lever.co/customers, ashbyhq.com/customers — fetched 2026-08-17).
3. `seed-discovery-pool.ts` now also parses the team's shared
   `/home/team/shared/ats-candidates.md` (markdown-table aware) — ~190 more.

Dedupe: `INSERT ... ON CONFLICT (candidate_key) DO NOTHING` — a candidate
already in the pool (verified, pending, or failed) is never duplicated; the
pool only grows with genuinely new (board, boardId) pairs. Verified seeds are
inserted first and win on conflict. Sources recorded honestly per row
(`curated` / `directory` / `shared-file` / `user-check` / `migration`).

Result: pool ≈ **1,000+ rows** (run `bun run seed-candidates`; idempotent —
re-runs insert 0). Only live-verified (HTTP 200 + ≥1 job) companies enter the
registry; every failure is counted by reason on its row.

## 6. Files changed

- `engine/sync.ts` — time-budgeted chunked sync (+ `SYNC_TIME_BUDGET_MS`,
  `skippedBudget`, injectable `fetchBoard` for tests).
- `engine/discovery-sync.ts` — raised defaults (48/16/45 s).
- `engine/requirements-sync.ts` — defaults 30 s / concurrency 12.
- `src/server/cron-http.ts` — requirements split to its own cron; discovery
  slot-based claims; new `/api/cron/requirements` route.
- `vercel.json` + `build-vercel.sh` — new schedules (sync 4×/h, requirements
  every 30 min, discover 4×/day).
- `go-live.sh` + `.env` — new sizing vars forwarded.
- `engine/candidates-scale.ts` (new) + `engine/seed-discovery-pool.ts` —
  pool scale wave + shared-file parsing.
- `engine/registry-scale-test.ts` (new) — 34 checks, fake-store based.
- `engine/cli.ts` — reporting for the new fields.
