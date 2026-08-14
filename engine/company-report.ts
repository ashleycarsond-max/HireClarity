/**
 * QUARTERLY COMPANY REPUTATION REPORT (company tier v2, part 2).
 *
 * A private, per-company quarterly report built from the Batch 3A shapes:
 *   (a) posting-health score + per-signal components  — companyDashboard (engine/company.ts)
 *   (b) fix recommendations                         — buildFixes (via companyDashboard)
 *   (c) industry/peer benchmarks                    — computeBenchmarks (via companyDashboard)
 *   (d) QUARTER TRENDS from the daily_snapshots table — how the company's live-posting
 *       count, median days listed and relist share moved across the quarter (first vs
 *       last daily snapshot in the quarter that contains the company's per-company
 *       block). Honest "n/a" when the quarter has < 2 snapshots with the company's data.
 *   (e) a plain-language reputation summary paragraph generated from the above —
 *       reputation-protection framing, never finger-wagging, every figure derived
 *       from observed data.
 *
 * HONESTY RULES (hard, same spirit as engine/company.ts):
 *   - Every number traces to the tracking store (postings/checks/events/daily
 *     snapshots). We never invent statistics.
 *   - Trends are "n/a" until at least TWO daily snapshots in the quarter carry
 *     this company's per-company block. Snapshots compiled before the block
 *     existed (pre-2026-08-14) simply don't count — no reconstruction, no guess.
 *   - The summary paragraph is built ONLY from the report's own numbers.
 *
 * STORAGE: company_reports table (company TEXT, quarter TEXT 'YYYY-Qn',
 * report JSONB, generated_at TEXT, PK (company, quarter)) — regenerating a
 * (company, quarter) replaces the row (idempotent).
 */

import { Store } from "./store";
import { companyDashboard } from "./company";
import type { CompanyBenchmarks, CompanyDashboard, CompanyFixes, CompanySummary, CompanyScoreResult } from "./company";
import type { DailySnapshot } from "./daily-stats";

const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

/* ------------------------------ quarter helpers ------------------------------ */

/** Current calendar quarter as "YYYY-Qn" (UTC). */
export function currentQuarter(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

/** "YYYY-Qn" → human label, e.g. "Q3 2026". Null when invalid. */
export function quarterLabel(quarter: string): string | null {
  const m = QUARTER_RE.exec(quarter ?? "");
  if (!m) return null;
  return `Q${m[2]} ${m[1]}`;
}

/** "YYYY-Qn" → the quarter's first UTC instant, or null when invalid. */
export function quarterStartIso(quarter: string): string | null {
  const m = QUARTER_RE.exec(quarter ?? "");
  if (!m) return null;
  const month = (Number(m[2]) - 1) * 3; // Q1 → Jan (0), Q2 → Apr (3), ...
  return new Date(Date.UTC(Number(m[1]), month, 1)).toISOString();
}

/** "YYYY-Qn" → the first instant AFTER the quarter (exclusive end), or null. */
export function quarterEndIso(quarter: string): string | null {
  const start = quarterStartIso(quarter);
  if (!start) return null;
  const d = new Date(Date.parse(start));
  d.setUTCMonth(d.getUTCMonth() + 3);
  return d.toISOString();
}

/** "YYYY-Qn" → previous quarter, or null when invalid. */
export function previousQuarter(quarter: string): string | null {
  const m = QUARTER_RE.exec(quarter ?? "");
  if (!m) return null;
  const q = Number(m[2]);
  const y = Number(m[1]);
  return q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}`;
}

/* ---------------------------------- report ---------------------------------- */

export type QuarterTrendMetric = "livePostings" | "medianDaysListed" | "relistShare";

/** One trend row: the company's metric on the first vs last qualifying daily
 *  snapshot of the quarter. `samples` = how many daily snapshots in the
 *  quarter actually carried this company's per-company block. */
export interface CompanyReportTrend {
  metric: QuarterTrendMetric;
  label: string;
  /** how the value is displayed ("count" | "days" | "pct") */
  format: "count" | "days" | "pct";
  first: number | null;
  last: number | null;
  /** last - first (null when either side is missing) */
  delta: number | null;
  /** literal change direction; "n-a" when fewer than 2 snapshots with data */
  direction: "up" | "down" | "flat" | "n-a";
  /** UTC date ("YYYY-MM-DD") of the first qualifying snapshot */
  firstDate: string | null;
  /** UTC date ("YYYY-MM-DD") of the last qualifying snapshot */
  lastDate: string | null;
  samples: number;
}

export interface CompanyReport {
  company: string;
  /** "YYYY-Qn" */
  quarter: string;
  generatedAt: string;
  score: CompanyScoreResult;
  summary: CompanySummary;
  fixes: CompanyFixes;
  benchmarks: CompanyBenchmarks | null;
  trends: CompanyReportTrend[];
  /** plain-language reputation summary built from the report's own numbers */
  summaryParagraph: string;
  /** honest context note from the dashboard (null when none) */
  note: string | null;
  /** ISO timestamp of the underlying dashboard snapshot */
  dashboardAt: string;
}

const TREND_METRICS: { metric: QuarterTrendMetric; label: string; format: CompanyReportTrend["format"] }[] = [
  { metric: "livePostings", label: "Live postings", format: "count" },
  { metric: "medianDaysListed", label: "Median days listed", format: "days" },
  { metric: "relistShare", label: "Relist share", format: "pct" },
];

function round2(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Compute the quarter's trends for one company from the daily_snapshots table.
 * First vs last daily snapshot in the quarter that carries the company's
 * per-company block (case-insensitive name match). "n/a" (null values +
 * direction "n-a") when fewer than 2 such snapshots exist — the honest state,
 * never a reconstruction.
 */
export function computeQuarterTrends(
  snapshots: { date: string; snapshot: DailySnapshot }[],
  company: string
): CompanyReportTrend[] {
  const key = company.trim().toLowerCase();
  const qualifying: { date: string; row: { live: number; medianDaysListed: number | null; relistShare: number | null } }[] = [];
  for (const s of snapshots) {
    const rows = (s.snapshot as { companies?: { name: string; live: number; medianDaysListed: number | null; relistShare: number | null }[] }).companies;
    if (!Array.isArray(rows)) continue; // pre-company-block snapshot
    const row = rows.find((r) => r.name.trim().toLowerCase() === key);
    if (row) qualifying.push({ date: s.date, row });
  }
  qualifying.sort((a, b) => a.date.localeCompare(b.date));

  const first = qualifying[0] ?? null;
  const last = qualifying.length > 1 ? qualifying[qualifying.length - 1] : null;
  const samples = qualifying.length;
  const havePair = first !== null && last !== null && samples >= 2;

  return TREND_METRICS.map((m) => {
    const pick = (q: typeof first): number | null => {
      if (!q) return null;
      switch (m.metric) {
        case "livePostings":
          return q.row.live;
        case "medianDaysListed":
          return q.row.medianDaysListed;
        case "relistShare":
          return q.row.relistShare;
      }
    };
    const f = pick(first);
    const l = pick(last);
    let delta: number | null = null;
    let direction: CompanyReportTrend["direction"] = "n-a";
    if (havePair && f !== null && l !== null) {
      delta = round2(l - f);
      direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
    }
    return {
      metric: m.metric,
      label: m.label,
      format: m.format,
      first: f,
      last: l,
      delta,
      direction,
      firstDate: first?.date ?? null,
      lastDate: last?.date ?? null,
      samples,
    };
  });
}

/* --------------------------- summary paragraph --------------------------- */

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Plain-language reputation summary generated from the report's own numbers —
 * reputation-protection framing ("keep your hiring credible"), never
 * finger-wagging. Every clause is derived from the report fields above it.
 */
export function buildSummaryParagraph(r: CompanyReport): string {
  const sentences: string[] = [];

  const scoreTxt =
    r.score.score === null
      ? "no posting-health score yet (fewer than 2 tracked postings — one posting can't honestly represent a company's hiring practice)"
      : `a posting-health score of ${r.score.score} of 100 — ${r.score.label.toLowerCase()}`;
  sentences.push(
    `During ${quarterLabel(r.quarter) ?? r.quarter}, we watched ${plural(r.summary.trackedPostings, "posting")} from ${r.company}, giving ${scoreTxt}.`
  );

  const live = r.trends.find((t) => t.metric === "livePostings");
  const days = r.trends.find((t) => t.metric === "medianDaysListed");
  if (live && live.samples >= 2 && live.first !== null && live.last !== null) {
    const parts = [`Your live-posting count moved from ${live.first} to ${live.last} across the quarter.`];
    if (days && days.samples >= 2 && days.first !== null && days.last !== null) {
      parts.push(`Median days listed went from ${days.first} to ${days.last}.`);
    }
    sentences.push(parts.join(" "));
  } else {
    sentences.push(
      "Trend data is n/a this quarter — we need at least two daily snapshots of your company before we can honestly report how your postings moved."
    );
  }

  const staleFix = r.fixes.fixes.find((f) => f.id === "stale_listings");
  if (staleFix && staleFix.affected.length > 0) {
    sentences.push(
      `${plural(staleFix.affected.length, "posting")} ${staleFix.affected.length === 1 ? "has" : "have"} been listed 30+ days with no change we could observe — refreshing or taking down ${staleFix.affected.length === 1 ? "it" : "them"} keeps your openings looking real.`
    );
  }
  if (r.fixes.healthy) {
    sentences.push("No fix recommendations this quarter — your tracked postings look healthy.");
  } else {
    const others = r.fixes.fixes.filter((f) => f.id !== "stale_listings");
    if (others.length > 0) {
      sentences.push(
        `${plural(others.length, "further recommendation")} ${others.length === 1 ? "is" : "are"} ready for review in the dashboard below.`
      );
    }
  }

  if (r.benchmarks && r.benchmarks.comparable) {
    const daysCmp = r.benchmarks.comparisons.find((c) => c.metric === "medianDaysListed");
    const peersTxt = r.benchmarks.peerCount === 1 ? "1 tracked company" : `${r.benchmarks.peerCount} tracked companies`;
    sentences.push(
      `Compared with ${peersTxt} in ${r.benchmarks.industry}, your median listing age is ${
        daysCmp?.company ?? "n/a"
      } day${daysCmp?.company === 1 ? "" : "s"} vs a peer median of ${daysCmp?.peerMedian ?? "n/a"} day${daysCmp?.peerMedian === 1 ? "" : "s"}.`
    );
  } else if (r.benchmarks) {
    sentences.push(
      `Benchmark comparison is on hold this quarter — we need at least 3 other tracked companies in ${r.benchmarks.industry} before we can honestly compare.`
    );
  } else {
    sentences.push("Benchmark comparison is n/a this quarter.");
  }

  sentences.push(
    `Keeping these numbers healthy is how your hiring stays credible with candidates and investors — the full signal breakdown and recommendations are in the dashboard.`
  );
  return sentences.join(" ");
}

/* ---------------------------- generation + storage ---------------------------- */

/**
 * Compute + store one company's quarterly report (idempotent — regenerating a
 * (company, quarter) REPLACES the stored row). Returns the report.
 */
export async function generateCompanyReport(
  store: Store,
  company: string,
  quarter: string,
  now: Date = new Date()
): Promise<CompanyReport> {
  if (!QUARTER_RE.test(quarter)) throw new Error(`invalid quarter: ${quarter} (expected YYYY-Qn)`);

  const dashboard = await companyDashboard(store, company);
  if (!dashboard) {
    throw new Error(`no tracked postings for company "${company}" — nothing honest to report`);
  }

  // Quarter-window daily snapshots (first vs last with the company's block).
  const startIso = quarterStartIso(quarter) as string;
  const endIso = quarterEndIso(quarter) as string;
  const startDate = startIso.slice(0, 10);
  const endDate = endIso.slice(0, 10);
  const allSnapshots = await store.listDailySnapshots();
  const inQuarter = allSnapshots
    .filter((s) => s.date >= startDate && s.date < endDate)
    .map((s) => ({ date: s.date, snapshot: s.snapshot as DailySnapshot }));
  const trends = computeQuarterTrends(inQuarter, company);

  const report: CompanyReport = {
    company: dashboard.name,
    quarter,
    generatedAt: now.toISOString(),
    score: dashboard.score,
    summary: dashboard.summary,
    fixes: dashboard.fixes,
    benchmarks: dashboard.benchmarks,
    trends,
    summaryParagraph: "", // filled below (needs the assembled report)
    note: dashboard.note,
    dashboardAt: dashboard.generatedAt,
  };
  report.summaryParagraph = buildSummaryParagraph(report);

  await store.saveCompanyReport(report.company, quarter, report, report.generatedAt);
  return report;
}

/** Read a stored report. Null when never generated. */
export async function loadCompanyReport(
  store: Store,
  company: string,
  quarter: string
): Promise<CompanyReport | null> {
  const row = await store.getCompanyReport(company, quarter);
  return row ? (row.report as CompanyReport) : null;
}

/* ----------------------------- email→company match ----------------------------- */

/**
 * The documented subscriber→company matching rule (used by the quarterly cron
 * AND the report page): an email matches a tracked company when the email's
 * LOCAL PART or its DOMAIN'S FIRST LABEL, normalized (lowercase, stripped to
 * alphanumerics), equals a registry company's normalized name. Exactly one
 * match is required — no match or an ambiguous match yields null (honest skip,
 * never a guess). Example: hiring@greenhouse.io → "greenhouse" → Greenhouse.
 */
export function normalizeCompanyKey(name: string): string {
  return (name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchCompanyForEmail(
  email: string | null | undefined,
  registry: { name: string }[]
): string | null {
  const clean = (email ?? "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) return null;
  const [localPart, domain] = clean.split("@");
  const domainFirst = (domain ?? "").split(".")[0] ?? "";
  const matches = new Set<string>();
  for (const c of registry) {
    const key = normalizeCompanyKey(c.name);
    if (!key) continue;
    if (normalizeCompanyKey(localPart) === key || normalizeCompanyKey(domainFirst) === key) {
      matches.add(c.name);
    }
  }
  return matches.size === 1 ? [...matches][0] : null;
}
