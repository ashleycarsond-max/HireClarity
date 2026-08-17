/**
 * HireClarity Data posting-tracking engine — CLI entry point.
 *
 *   bun run track <url>            track a posting URL (first fetch / update)
 *   bun run recheck [--limit N]    re-fetch all tracked postings
 *   bun run signals [postingId]    print signals JSON (and write data/signals.json)
 *   bun run score [postingId]      print confidence scores + reasons
 *   bun run robots <url>           explain what robots.txt says for a URL
 *   bun run track-demo             end-to-end demo on real public postings
 *   bun run relist-demo            fixture demo proving relist detection (200→404→200)
 *   bun run track-reset            wipe the tracking store
 *
 * Storage: Neon serverless Postgres via process.env.DATABASE_URL (see store.ts).
 * The old on-disk SQLite stores (engine/data/*.sqlite) are kept as reference
 * only — nothing here reads or writes them anymore. `signals.json` and
 * `demo-signals.json` (CLI output artifacts) are still written to engine/data/.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { startMockBoard } from "./mock-board";
import { observeUrl } from "./observe";
import { inspectRobots } from "./robots";
import { scoreAll, scoreById } from "./score";
import { buildSignals, signalsForAll } from "./signals";
import { Store, isoNow } from "./store";
import type { ObserveResult, PostingRecord } from "./types";
import { derivePostingId, normalizeUrl } from "./urls";
import { ingestBoardJobs, runSync, runSyncChunk } from "./sync";
import type { BoardJob, BoardKind } from "./boards";
import type { MonitoredCompany } from "./companies";
import { computeReportSnapshot, currentPeriod, reportSummaryLine, saveReportSnapshot } from "./report";
import { runRequirementsSlice } from "./requirements-sync";
import { computeDailySnapshot, dailySummaryLine, saveDailySnapshot } from "./daily-stats";
import { runDiscovery } from "./discover";
import { runDiscoverySlice, discoverySummaryLine } from "./discovery-sync";
import { seedDiscoveryPool } from "./seed-discovery-pool";

// import.meta.dir is Bun-only; this form is portable and TS-clean.
const HERE = new URL(".", import.meta.url).pathname;

/**
 * Project root = first ancestor directory containing package.json. Only used
 * for CLI output artifacts (signals.json / demo-signals.json) under
 * <site>/engine/data/ — never in the server runtime path.
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

const DATA_DIR = resolve(findProjectRoot(HERE), "engine", "data");

function store(): Store {
  return new Store();
}

function printObserved(r: ObserveResult, label: string): void {
  const url = r.canonicalUrl ?? "(none)";
  console.log(`  ${label.padEnd(11)} → ${String(r.status).padEnd(16)} [${r.transition}] ${r.statusCode ?? "-"}  ${url}`);
  if (r.note) console.log(`               note: ${r.note}`);
}

async function cmdTrack(url: string): Promise<void> {
  const s = store();
  console.log(`Tracking ${url}`);
  const r = await observeUrl(url, { store: s });
  printObserved(r, "tracked");
  if (!r.ok && r.transition !== "blocked_by_robots") process.exitCode = 1;
}

async function cmdRecheck(limit: number): Promise<void> {
  const s = store();
  const all = await s.getAll();
  if (!all.length) {
    console.log("Nothing tracked yet — add postings with `bun run track <url>`.");
    return;
  }
  const targets = limit > 0 ? all.slice(0, limit) : all;
  console.log(`Rechecking ${targets.length} posting(s) at ${isoNow()}\n`);
  let live = 0;
  let removed = 0;
  let relisted = 0;
  for (const rec of targets) {
    const r = await observeUrl(rec.canonicalUrl, { store: s, isRecheck: true });
    printObserved(r, rec.postingId);
    if (r.status === "live") live++;
    else if (r.status === "removed") removed++;
    else if (r.status === "relisted") relisted++;
  }
  console.log(`\nSummary: ${live} live, ${removed} removed, ${relisted} relisted (of ${targets.length} rechecked)`);
}

async function cmdSignals(postingId: string | null): Promise<void> {
  const s = store();
  let records: PostingRecord[];
  if (postingId) {
    const rec = await s.getByPostingId(postingId);
    if (!rec) {
      console.error(`No tracked posting with id ${postingId}. Run \`bun run recheck\` to list ids.`);
      process.exitCode = 1;
      return;
    }
    records = [rec];
  } else {
    records = await s.getAll();
  }
  const signals = await Promise.all(records.map((r) => buildSignals(s, r)));
  const out = JSON.stringify(signals, null, 2);
  console.log(out);
  const outPath = resolve(DATA_DIR, "signals.json");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(outPath, out + "\n");
  console.log(`\n(wrote ${signals.length} signal object(s) to ${outPath})`);
}

async function cmdScore(postingId: string | null): Promise<void> {
  const s = store();
  let scores;
  if (postingId) {
    const one = await scoreById(s, postingId);
    if (!one) {
      console.error(`No tracked posting with id ${postingId}. Run \`bun run recheck\` to list ids.`);
      process.exitCode = 1;
      return;
    }
    scores = [one];
  } else {
    scores = await scoreAll(s);
  }
  console.log(JSON.stringify(scores, null, 2));
}

async function cmdRobots(url: string): Promise<void> {
  const { origin, rules } = await inspectRobots(url);
  console.log(`origin: ${origin ?? "(none)"}`);
  console.log(`disallow rules: ${rules.disallow.length ? rules.disallow.map((d) => d.pattern.source).join(" | ") : "none"}`);
  console.log(`allow rules:    ${rules.allow.length ? rules.allow.map((a) => a.pattern.source).join(" | ") : "none"}`);
  console.log(`crawl-delay:    ${rules.crawlDelay ?? "none"}`);
  console.log(`note:           ${rules.note ?? "—"}`);
}

async function cmdReset(): Promise<void> {
  const s = store();
  const n = await s.count();
  await s.wipe();
  console.log(`Reset tracking store (removed ${n} posting(s)) — Neon is now empty.`);
}

/**
 * `bun run report-generate [YYYY-MM]` — compute + store the monthly job-market
 * report snapshot for a period (default: current calendar month). Idempotent:
 * regenerating a period replaces the stored snapshot. The public /reports
 * pages render ONLY these stored snapshots.
 */
async function cmdReportGenerate(period: string | null): Promise<void> {
  const s = store();
  const p = period ?? currentPeriod();
  console.log(`Computing job-market report snapshot for ${p} (observed sample, from the tracking store)...`);
  const snapshot = await computeReportSnapshot(s, p);
  await saveReportSnapshot(s, snapshot);
  console.log(reportSummaryLine(snapshot));
  const b = snapshot.postings;
  console.log(`  tracked: ${b.totalTracked} (${b.live} live, ${b.removed} removed, ${b.relisted} relisted status)`);
  console.log(`  relisted at least once: ${b.relistedAtLeastOnce} (share ${b.relistShare === null ? "n/a" : `${Math.round(b.relistShare * 1000) / 10}%`})`);
  console.log(`  median/max days listed (live): ${b.medianDaysListed ?? "n/a"} / ${b.maxDaysListed ?? "n/a"} (sample ${b.daysListedSample})`);
  console.log(`  boards: ${snapshot.boards.map((x) => `${x.board}=${x.count}`).join(", ")}`);
  console.log(`  distinct companies: ${b.distinctCompanies} (names not published)`);
  console.log(`  checks in period: ${snapshot.checks.inPeriod} across ${snapshot.checks.distinctPostings} postings`);
  console.log(`  score distribution: ${snapshot.checks.scoreBuckets.map((x) => `${x.bucket}=${x.count}`).join(", ")}`);
  console.log(`  window: ${snapshot.observation.earliestFirstSeenAt ?? "—"} → ${snapshot.generatedAt} (${snapshot.observation.windowDays} days)`);
  console.log(`Saved snapshot for ${p} (generated_at ${snapshot.generatedAt}).`);
}

/** `bun run sync [--dry-run]` — proactive board scrub across the registry. */
async function cmdSync(dryRun: boolean): Promise<void> {
  const s = store();
  const report = await runSync(s, { dryRun });

  const lines: string[] = [];
  lines.push(`SYNC ${report.dryRun ? "(DRY-RUN — nothing written to the store)" : ""} at ${report.at}`);
  lines.push(`Registry: ${report.registry.length} monitored companies (${report.registry.map((c) => c.name).join(", ")})`);
  for (const c of report.companies) {
    lines.push(`\n${c.name}`);
    for (const b of c.boards) {
      lines.push(
        `  ${b.board}/${b.boardId}: ${b.ok ? "ok" : "FAILED"} seen=${b.jobsSeen} new=${b.created} updated=${b.updated} removed=${b.removed} relisted=${b.relisted}${b.note ? `  (${b.note})` : ""}`
      );
    }
  }
  const t = report.totals;
  lines.push(
    `\nTOTALS: seen=${t.jobsSeen} new=${t.created} updated=${t.updated} removed=${t.removed} relisted=${t.relisted}`
  );
  lines.push(`Store-wide posting count: ${report.storeCount}`);

  const out = lines.join("\n");
  console.log(out);
  const outPath = `/tmp/sync-${Date.now()}.txt`;
  writeFileSync(outPath, out + "\n");
  console.log(`\n(full output written to ${outPath})`);
}

/**
 * `bun run sync-chunk [--companies N]` — bounded sync batch (the cron-safe
 * form). Processes up to N registry companies (default COMPANIES_PER_RUN env,
 * else 1), bounded by SYNC_TIME_BUDGET_MS, advancing the persisted Neon
 * cursor each run.
 */
async function cmdSyncChunk(companies: number | null): Promise<void> {
  const s = store();
  const started = Date.now();
  const report = await runSyncChunk(s, { companies: companies ?? undefined });
  const lines: string[] = [];
  lines.push(`SYNC-CHUNK at ${report.at} (${Date.now() - started}ms)`);
  lines.push(
    `Registry: ${report.registrySize} monitored companies | batch: ${report.processedNames.join(", ") || "(none)"} | cursor: ${report.cursor} | remaining this cycle: ${report.remaining} | skippedBudget: ${report.skippedBudget}`
  );
  for (const c of report.processed) {
    lines.push(`${c.name}`);
    for (const b of c.boards) {
      lines.push(
        `  ${b.board}/${b.boardId}: ${b.ok ? "ok" : "FAILED"} seen=${b.jobsSeen} new=${b.created} updated=${b.updated} removed=${b.removed} relisted=${b.relisted}${b.note ? `  (${b.note})` : ""}`
      );
    }
  }
  const t = report.totals;
  lines.push(`TOTALS: seen=${t.jobsSeen} new=${t.created} updated=${t.updated} removed=${t.removed} relisted=${t.relisted}`);
  lines.push(`Store-wide posting count: ${report.storeCount}`);
  if (report.errors.length) lines.push(`Board errors (${report.errors.length}): ${report.errors.join(" | ")}`);
  const out = lines.join("\n");
  console.log(out);
  const outPath = `/tmp/sync-chunk-${Date.now()}.txt`;
  writeFileSync(outPath, out + "\n");
  console.log(`\n(full output written to ${outPath})`);
}

/**
 * `bun run sync-test` — proves removal + relist detection through the REAL
 * sync ingest path (ingestBoardJobs) against real Neon, using a fixture
 * company with loopback-free synthetic Lever URLs, then removes the fixture.
 * Same spirit as relist-demo: a documented test, not production data.
 */
async function cmdSyncTest(): Promise<void> {
  const s = store();
  const company: MonitoredCompany = { name: "SyncTestCo", boards: [] };
  const board: BoardKind = "lever";
  const boardId = "synctestco";
  const mk = (uuid: string, title: string): BoardJob => {
    const url = normalizeUrl(`https://jobs.lever.co/${boardId}/${uuid}`)!;
    return {
      board,
      externalId: uuid,
      title,
      location: "Fixtureville",
      postedAt: "2026-01-15T00:00:00Z",
      url,
      postingId: derivePostingId(url),
      raw: { fixture: true },
    };
  };
  const j1 = mk("11111111-1111-4111-8111-111111111111", "Fixture Engineer A");
  const j2 = mk("22222222-2222-4222-8222-222222222222", "Fixture Engineer B");
  const cleanup = async () => {
    await s.deletePosting(j1.postingId);
    await s.deletePosting(j2.postingId);
  };

  console.log("=== SYNC TEST (fixture company through the real ingest path) ===");
  console.log("storage: Neon Postgres (DATABASE_URL)\n");
  await cleanup(); // re-runs must start clean

  console.log("[1] ingest 2 postings → both live (created=2)");
  let c = await ingestBoardJobs(s, company, board, boardId, [j1, j2], new Date(), false);
  console.log(`    ${JSON.stringify(c)}`);

  console.log("\n[2] ingest only j1 → j2 missing → taken down (removed=1, event logged)");
  c = await ingestBoardJobs(s, company, board, boardId, [j1], new Date(), false);
  console.log(`    ${JSON.stringify(c)}`);
  const rec2 = await s.getByPostingId(j2.postingId);
  const ev2 = await s.eventsForPosting(j2.postingId);
  console.log(`    j2 status=${rec2?.status} relistCount=${rec2?.relistCount} events=[${ev2.map((e) => e.type).join(", ")}]`);

  console.log("\n[3] ingest both again → j2 reappears → relisted (relisted=1, relistCount=1, event logged)");
  c = await ingestBoardJobs(s, company, board, boardId, [j1, j2], new Date(), false);
  console.log(`    ${JSON.stringify(c)}`);
  const rec2b = await s.getByPostingId(j2.postingId);
  const ev2b = await s.eventsForPosting(j2.postingId);
  console.log(`    j2 status=${rec2b?.status} relistCount=${rec2b?.relistCount} events=[${ev2b.map((e) => e.type).join(", ")}]`);

  console.log("\n[4] dry-run ingest → reports but writes nothing (store count unchanged)");
  const before = await s.count();
  c = await ingestBoardJobs(s, company, board, boardId, [j1, j2], new Date(), true);
  const after = await s.count();
  console.log(`    ${JSON.stringify(c)}; store count ${before} → ${after} ${before === after ? "(unchanged ✓)" : "(CHANGED ✗)"}`);

  await cleanup();
  console.log("\n(fixture removed — only real postings remain in the store)");
}

/** End-to-end demo on real public postings (Greenhouse + Ashby boards). */
async function cmdTrackDemo(): Promise<void> {
  const s = store();

  const urls = [
    "https://job-boards.greenhouse.io/greenhouse/jobs/8017323", // Greenhouse's own board
    "https://boards.greenhouse.io/greenhouse/jobs/8017323", // same posting, old host (301s → dedupe proof)
    "https://jobs.ashbyhq.com/notion/05e14247-17c4-4e98-9a13-53828a4e2f13", // Notion BDR, New York
    "https://jobs.ashbyhq.com/notion/d177d052-ef57-4900-acf2-d58e9eded620", // Notion Product Designer
  ];
  console.log("=== DEMO: track 4 real posting URLs (2 boards) ===");
  console.log("storage: Neon Postgres (DATABASE_URL)\n");
  for (const u of urls) {
    const r = await observeUrl(u, { store: s });
    printObserved(r, "track");
  }
  const n = await s.count();
  console.log(`\nDistinct tracked postings: ${n} (4 URLs → ${n} records: the 301-redirect variant dedupes into the Greenhouse record)`);

  console.log("\n=== DEMO: recheck all tracked postings ===");
  for (const rec of await s.getAll()) {
    const r = await observeUrl(rec.canonicalUrl, { store: s, isRecheck: true });
    printObserved(r, rec.postingId);
  }

  console.log("\n=== DEMO: signals ===");
  const signals = await signalsForAll(s);
  for (const sg of signals) {
    console.log(
      `  ${sg.postingId.padEnd(22)} ${sg.title ?? "(no title)"} @ ${sg.company ?? "?"} | status=${sg.status} relists=${sg.relistCount} days=${sg.daysListed} boards=[${sg.boardsSeen.join(",")}] urls=${sg.urlsSeen.length}`
    );
  }
  const outPath = resolve(DATA_DIR, "demo-signals.json");
  writeFileSync(outPath, JSON.stringify(signals, null, 2) + "\n");
  console.log(`\nFull signals JSON written to ${outPath}`);
}

async function cmdRelistDemo(): Promise<void> {
  const s = store();
  const board = startMockBoard(8890);
  const url = `${board.url}/jobs/fixture-1`;

  // Re-runs must start from a clean slate: remove any leftover fixture data.
  const fixtureId = derivePostingId(normalizeUrl(url)!);
  await s.deletePosting(fixtureId);

  console.log("=== RELIST DEMO (local mock board, real HTTP: 200 → 404 → 200) ===");
  console.log("storage: Neon Postgres (DATABASE_URL)\n");

  console.log(`[1] posting is LIVE — track ${url}`);
  let r = await observeUrl(url, { store: s });
  printObserved(r, "track");

  console.log("\n[2] posting is REMOVED (mock returns 404) — recheck");
  board.setLive(false);
  r = await observeUrl(url, { store: s, isRecheck: true });
  printObserved(r, "recheck");

  console.log("\n[3] posting is LIVE AGAIN (mock returns 200) — recheck → relist detected");
  board.setLive(true);
  r = await observeUrl(url, { store: s, isRecheck: true });
  printObserved(r, "recheck");
  board.stop();

  console.log("\n=== RELIST DEMO: signals ===");
  const rec = (await s.getByPostingId(r.postingId!))!;
  const sg = await buildSignals(s, rec);
  console.log(JSON.stringify(sg, null, 2));

  // Fixture cleanup: the mock posting is sandbox test data, not real tracking.
  await s.deletePosting(r.postingId!);
  console.log("\n(fixture removed from the store — only real postings remain)");
}

/**
 * `bun run discover [--limit N] [--all]` — verify candidate companies live
 * against their ATS board APIs and regenerate the verified registry. Only
 * HTTP-200-with-jobs companies are written to engine/verified-companies.ts;
 * everything else lands in the honest per-reason failure report. Re-runs skip
 * already-verified candidates unless --all is passed.
 */
async function cmdDiscover(limit: number, all: boolean): Promise<void> {
  const started = Date.now();
  const { candidates, checked, outcomes, verified, reportPath } = await runDiscovery({ limit, all });
  const counts: Record<string, number> = {};
  for (const o of outcomes) counts[o.reason] = (counts[o.reason] ?? 0) + 1;
  const line = (r: string) => `${r}=${counts[r] ?? 0}`;
  console.log(`DISCOVERY at ${isoNow()} (${Date.now() - started}ms)`);
  console.log(`candidates: ${candidates} | checked this run: ${checked} | verified total: ${verified.length}`);
  console.log(`summary: ${["verified", "empty", "http-404", "http-429", "http-5xx", "http-other", "robots-blocked", "parse-error", "fetch-error"].map(line).filter((x) => !x.endsWith("=0")).join(", ")}`);
  console.log(`verified companies: ${verified.map((c) => c.name).join(", ")}`);
  console.log(`\nverified-companies.ts written (${verified.length} companies); full per-candidate report: ${reportPath}`);
  if (process.env.CI) process.exitCode = 0;
}

/**
 * `bun run requirements` — rolling FULL-description-coverage refresh for a
 * bounded slice of live postings (REQUIREMENTS_PER_RUN, default 150;
 * per-host cap REQUIREMENTS_HOST_CAP, default 10; wall-clock budget
 * REQUIREMENTS_TIME_BUDGET_MS, default 25s; staleness cutoff
 * DESCRIPTION_STALE_AFTER_DAYS, default 7). The same routine the hourly sync
 * and the daily cron run, so the CLI, the sync and the cron share one path.
 */
async function cmdRequirements(): Promise<void> {
  const s = store();
  console.log(`REQUIREMENTS REFRESH at ${isoNow()} (Neon store)`);
  const r = await runRequirementsSlice(s, {});
  console.log(
    `slice: ${r.picked} picked (${r.processed} processed, ${r.skippedBudget} skipped on time budget) | tiers: never-read=${r.pickedNeverRead}, stale=${r.pickedStale}, fresh=${r.pickedFresh}`
  );
  console.log(
    `extractions: ${r.descriptionsRead} descriptions read | ${r.fetchErrors} fetch errors | flags: bachelor=${r.flags.requiresBachelor}, masters=${r.flags.requiresMasters}, 5+years=${r.flags.requires5PlusYears}`
  );
  const c = r.coverage;
  const pct = c.live ? Math.round((c.read / c.live) * 1000) / 10 : 0;
  console.log(
    `coverage: ${c.read} of ${c.live} live postings have a read description (${pct}%); fetch errors: ${c.fetchError}; not yet extracted: ${c.notExtracted}`
  );
  console.log(`elapsed: ${r.elapsedMs}ms${r.note ? ` — note: ${r.note}` : ""}`);
}

/**
 * `bun run daily-stats [YYYY-MM-DD]` — compute + store one day's snapshot
 * (default: today, UTC). Re-running a date replaces the stored snapshot.
 */
async function cmdDailyStats(dateArg: string | null): Promise<void> {
  const s = store();
  const date = dateArg ?? utcDateStrForCli();
  const snapshot = await computeDailySnapshot(s, date);
  await saveDailySnapshot(s, snapshot);
  // Rollups (owner direction 2026-08-15): after every snapshot compile, refresh
  // the week/month/year buckets that contain this date (idempotent).
  const { upsertRollupsForDate } = await import("./rollups");
  const rollups = await upsertRollupsForDate(s, snapshot.date);
  console.log(dailySummaryLine(snapshot));
  console.log(`\n(snapshot stored in daily_snapshots for ${snapshot.date})`);
  if (rollups.length) {
    console.log(`rollups refreshed: ${rollups.map((r) => `${r.type} ${r.period}`).join(", ")}`);
  }
  console.log(`trends vs previous: ${Object.keys(snapshot.trends).length ? "" : "none"}`);
  for (const [key, t] of Object.entries(snapshot.trends)) {
    console.log(`  ${key.padEnd(30)} delta=${t.delta === null ? "n/a" : t.delta} direction=${t.direction}`);
  }
}
/**
 * `bun run rollups-backfill` — recompute EVERY week/month/year rollup from the
 * stored daily snapshots (idempotent; used to backfill the rollup table after
 * this feature ships, and any time rollup logic changes).
 */
async function cmdRollupsBackfill(): Promise<void> {
  const { recomputeAllRollups } = await import("./rollups");
  const totals = await recomputeAllRollups(store());
  for (const t of totals) {
    console.log(`${t.type.padEnd(6)} ${t.count} bucket${t.count === 1 ? "" : "s"} upserted`);
  }
}

function utcDateStrForCli(): string {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
}

/**
 * `bun run company-report <slug> [--quarter YYYY-Qn]` — compute + store one
 * company's quarterly reputation report (default quarter: the current one,
 * UTC). The slug is the deterministic /companies/<slug> slug (see
 * src/lib/slugs.ts); re-running the same (company, quarter) replaces the
 * stored row (idempotent).
 */
async function cmdCompanyReport(slug: string | null, quarter: string | null): Promise<void> {
  const { slugToCompany } = await import("../src/lib/slugs");
  const { generateCompanyReport, currentQuarter, quarterLabel } = await import("./company-report");
  if (!slug) {
    console.error("usage: bun run company-report <slug> [--quarter YYYY-Qn]");
    process.exitCode = 1;
    return;
  }
  const company = slugToCompany(slug);
  if (!company) {
    console.error(`no registry company for slug "${slug}" — try one from bun run companies`);
    process.exitCode = 1;
    return;
  }
  const q = quarter ?? currentQuarter();
  if (!quarterLabel(q)) {
    console.error(`invalid quarter: ${q} (expected YYYY-Qn)`);
    process.exitCode = 1;
    return;
  }
  const s = store();
  const report = await generateCompanyReport(s, company.name, q);
  const trendLine = report.trends
    .map(
      (t) =>
        `${t.metric}: ${t.first ?? "n/a"} → ${t.last ?? "n/a"} (${t.direction}${t.samples < 2 ? `, ${t.samples} snapshot${t.samples === 1 ? "" : "s"}` : ""})`
    )
    .join(" | ");
  console.log(`COMPANY REPORT ${report.company} ${report.quarter} (generated ${report.generatedAt})`);
  console.log(`score: ${report.score.score ?? "n/a"} (${report.score.label})`);
  console.log(`fixes: ${report.fixes.healthy ? "healthy — none" : report.fixes.fixes.length}`);
  console.log(`benchmarks: ${report.benchmarks ? `${report.benchmarks.industry} · peers ${report.benchmarks.peerCount} · comparable ${report.benchmarks.comparable}` : "n/a"}`);
  console.log(`trends: ${trendLine}`);
  console.log(`\n${report.summaryParagraph}`);
  console.log(`\n(stored in company_reports for ${report.company} / ${report.quarter})`);
}

/**
 * `bun run discovery-slice [--limit N]` — the scheduled discovery pass as a
 * CLI (same code path as the daily 01:45 UTC cron). Picks a bounded slice of
 * due candidates from the Neon pool, verifies each live (robots + throttle +
 * the same 9-way classification as `bun run discover`), and records results
 * honestly. Defaults from DISCOVERY_PER_RUN / DISCOVERY_HOST_CAP /
 * DISCOVERY_TIME_BUDGET_MS.
 */
async function cmdDiscoverySlice(limit: number | null): Promise<void> {
  const started = Date.now();
  const s = store();
  console.log(`DISCOVERY-SLICE at ${isoNow()} (Neon pool)`);
  const r = await runDiscoverySlice(s, { limit: limit ?? undefined });
  console.log(
    `picked: ${r.picked} | processed: ${r.processed} | skippedBudget: ${r.skippedBudget} | pool: ${r.poolSize}`
  );
  console.log(`byReason: ${discoverySummaryLine(r.byReason)}`);
  console.log(`newly verified: ${r.newlyVerified.length ? r.newlyVerified.join(", ") : "(none)"}`);
  console.log(`elapsed: ${r.elapsedMs}ms (total ${Date.now() - started}ms)`);
}

/**
 * `bun run seed-candidates` — idempotently seed the Neon discovery pool from
 * the repo's verified seed data (SEED_COMPANIES as 'verified' + the curated
 * FALLBACK_CANDIDATES + the scale-up wave (candidates-scale.ts) + the shared
 * ats-candidates.md as 'pending'). Re-running is a no-op for existing rows.
 */
async function cmdSeedCandidates(): Promise<void> {
  const s = store();
  const before = await s.discoveryPoolSummary();
  const beforeTotal = Object.values(before).reduce((a, b) => a + b, 0);
  console.log(`DISCOVERY POOL SEED at ${isoNow()} (Neon pool, before: ${beforeTotal} rows)`);
  const r = await seedDiscoveryPool(s);
  console.log(
    `seeded ${r.verifiedRows} verified board refs + ${r.curatedRows} curated + ${r.scaleRows} scale-wave + ${r.sharedRows} shared-file candidates | inserted this run: ${r.inserted} (re-run: 0)`
  );
  console.log(`pool after: ${r.poolSize} rows | ${Object.entries(r.statusCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const cmd = args[0];
  if (!cmd) {
    console.log(`HireClarity Data tracking engine v2 (Neon-backed)

Usage:
  bun run track <url>            track a posting URL (first fetch / update)
  bun run recheck [--limit N]    re-fetch all tracked postings (rate-limited)
  bun run sync [--dry-run]       scrub every monitored company's boards (proactive discovery)
  bun run sync-chunk [--companies N]  bounded sync batch (cron-safe, cursor-advancing)
  bun run sync-test              fixture proof: sync removal + relist detection (real Neon)
  bun run discover [--limit N] [--all]  verify candidate companies live → verified registry
  bun run discovery-slice [--limit N]   scheduled discovery pass (Neon pool; same code the daily cron runs)
  bun run seed-candidates               idempotently seed the Neon discovery pool (verified seeds + curated guesses)
  bun run signals [postingId]    print signals JSON for all (or one) postings
  bun run score [postingId]      print confidence scores + reasons for all (or one) postings
  bun run report-generate [YYYY-MM]  compute + store the monthly job-market report snapshot
  bun run company-report <slug> [--quarter YYYY-Qn]  compute + store one company's quarterly reputation report
  bun run requirements               rolling description-requirement refresh (bounded slice)
  bun run daily-stats [YYYY-MM-DD]   compute + store one day's snapshot (default today, UTC)
  bun run rollups-backfill           recompute all week/month/year rollups from stored daily snapshots
  bun run robots <url>           show what robots.txt says for a URL
  bun run track-demo             end-to-end demo on real public postings
  bun run relist-demo            fixture demo: relist detection (200→404→200)
  bun run track-reset            wipe the tracking store

Storage: Neon Postgres (process.env.DATABASE_URL)
`);
    return;
  }
  switch (cmd) {
    case "track": {
      const url = args[1];
      if (!url) {
        console.error("usage: bun run track <url>");
        process.exitCode = 1;
        return;
      }
      await cmdTrack(url);
      break;
    }
    case "recheck": {
      const li = args.indexOf("--limit");
      const limit = li >= 0 ? parseInt(args[li + 1] ?? "0", 10) : 0;
      await cmdRecheck(Number.isFinite(limit) ? limit : 0);
      break;
    }
    case "signals":
      await cmdSignals(args[1] ?? null);
      break;
    case "robots":
      if (!args[1]) {
        console.error("usage: bun run robots <url>");
        process.exitCode = 1;
        return;
      }
      await cmdRobots(args[1]);
      break;
    case "score":
      await cmdScore(args[1] ?? null);
      break;
    case "report-generate":
      await cmdReportGenerate(args[1] ?? null);
      break;
    case "company-report": {
      const qi = args.indexOf("--quarter");
      await cmdCompanyReport(args[1] ?? null, qi >= 0 ? (args[qi + 1] ?? null) : null);
      break;
    }
    case "requirements":
      await cmdRequirements();
      break;
    case "daily-stats":
      await cmdDailyStats(args[1] ?? null);
      break;
    case "rollups-backfill":
      await cmdRollupsBackfill();
      break;
    case "track-reset":
      await cmdReset();
      break;
    case "sync": {
      await cmdSync(args.includes("--dry-run"));
      break;
    }
    case "sync-chunk": {
      const ci = args.indexOf("--companies");
      const n = ci >= 0 ? parseInt(args[ci + 1] ?? "0", 10) : NaN;
      await cmdSyncChunk(Number.isFinite(n) && n > 0 ? n : null);
      break;
    }
    case "sync-test":
      await cmdSyncTest();
      break;
    case "discover": {
      const li = args.indexOf("--limit");
      const lim = li >= 0 ? parseInt(args[li + 1] ?? "0", 10) : 0;
      await cmdDiscover(Number.isFinite(lim) && lim > 0 ? lim : 0, args.includes("--all"));
      break;
    }
    case "discovery-slice": {
      const li = args.indexOf("--limit");
      const lim = li >= 0 ? parseInt(args[li + 1] ?? "0", 10) : 0;
      await cmdDiscoverySlice(Number.isFinite(lim) && lim > 0 ? lim : null);
      break;
    }
    case "seed-candidates":
      await cmdSeedCandidates();
      break;
    case "track-demo":
      await cmdTrackDemo();
      break;
    case "relist-demo":
      await cmdRelistDemo();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
  }
}

await main();
