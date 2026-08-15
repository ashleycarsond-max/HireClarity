# Workable probe — 2026-08-15 (design §4.5 follow-up)

**Outcome: B — Workable is not trackable by the engine's no-JS polite pipeline; the site now discloses it like LinkedIn/Indeed.**

## What was probed (real, currently-active Workable-hosted boards)

All 5 verified LIVE today in a real browser (each serves a "Current Openings" page, HTTP 200):

| Subdomain | Company | Browser (HTML page) | Engine pipeline (`fetchWorkableBoard`) |
|---|---|---|---|
| etoro | eToro | live board | HTTP 404 — "Not Found" (widget API v1) |
| hopper | Hopper | live board | HTTP 404 — "Not Found" |
| gostudent | GoStudent | live board | HTTP 404 — "Not Found" |
| cabify | Cabify | live board | HTTP 404 — "Not Found" |
| curve | Curve | live board | HTTP 404 — "Not Found" |

The engine pipeline = the real sync path: robots.txt check (apply.workable.com/robots.txt → HTTP 200, no rules) → 2s same-host throttle → `politeFetch` with the `HireClarityDataBot/0.1` UA. All 5 returned clean HTTP 404 with a plain-text "Not Found" body — the **widget API v1 endpoint is retired**; it 404s live accounts too, so the client can never return jobs.

## Why (three independent facts, all verified live)

1. **Widget API v1 is dead.** `GET /api/v1/widget/accounts/{sub}/jobs` → 404 "Not Found" for every account — live (etoro, hopper, gostudent, cabify, curve) or dead.
2. **Careers pages are client-rendered SPAs.** The HTML (all our no-JS pipeline reads) contains no job data — one script tag (`careers.*.js` from CloudFront). The SPA fetches jobs from `/api/v3/accounts/{sub}/jobs`, which 404s for plain HTTP clients without browser-session context (verified with both bot and browser UAs).
3. **Cloudflare bot management.** A burst of automated requests gets a JS challenge — `HTTP 429, cf-mitigated: challenge, server: cloudflare` (13/44 subdomains in one pass, including genuinely live accounts like sorare, backmarket, glovo, matchesfashion). robots.txt itself stays readable; the restriction is technical, not a robots disallow.

## Candidate-gathering sweep (one pass, 44 subdomains, 1.2s spacing)

- 31× HTTP 404 (dead accounts: trustpilot, farfetch, deezer, fiverr, bolt, veriff, typeform, qonto, ledger, doctolib, blablacar, dataiku, aircall, dailymotion, getsafe, …)
- 13× HTTP 429 Cloudflare challenge (sorare, backmarket, jobandtalent, wallapop, glovo, cabify, wallbox, mambu, messagebird, zencargo, curve, wefox, matchesfashion)
- Browser re-check of the 429s: backmarket/glovo/matchesfashion/sorare/jobandtalent/curve = live boards with **0 openings today**; wallapop/wefox/mambu/messagebird/zencargo = board gone (redirect to /oops).

## What changed

- `engine/boards.ts`, `engine/candidates.ts`, `engine/companies.ts`, `engine/discover.ts`, `engine/README.md`: comments now state the verified evidence (was: "no real account probed" / stale 429 note).
- `engine/report.ts`: `REPORT_BOARDS` no longer lists `workable` (board stats drop the always-0 row; old snapshot rows filtered at render).
- Site copy (CoverageNote footer + short, /data, /reports, /reports/<period>, /companies, /check, 6 blog posts): Workable is no longer listed as tracked; the honest reason is stated ("careers pages expose no parseable public board for automated readers, verified 2026-08-15") — same treatment as LinkedIn/Indeed.
- No Workable discovery candidates added (all probe outcomes are honest 404s; the discovery cron would record them the same way).

## Honest label kept everywhere: "our observed sample".
