/**
 * Shared headline trend metrics — a LEAF module (no runtime imports) so the
 * two aggregation layers can both use them without a circular import.
 *
 * WHY (2026-09-18, pipeline-outage follow-up): TREND_METRICS used to live in
 * engine/daily-stats.ts, and engine/report.ts spread it at module top level
 * (`export const REPORT_TREND_METRICS = [...TREND_METRICS, ...]`) while
 * daily-stats.ts imported REPORT_BOARDS back from report.ts. That cycle is
 * harmless when a bundler happens to order the modules favourably (the Vite
 * production bundle did), but in a plain Bun/Node module graph it throws
 * `ReferenceError: Cannot access 'TREND_METRICS' before initialization` — which
 * broke `bun run daily-stats`, the CLI paths and the verification/test scripts.
 * Living here, the array is initialized before either consumer's body runs.
 * No behavior change: same keys, labels and picks.
 */
import type { DailySnapshot } from "./daily-stats";

/** Headline metrics that get a delta + direction in every snapshot. */
export const TREND_METRICS: { key: string; label: string; pick: (s: DailySnapshot) => number | null }[] = [
  { key: "totalTracked", label: "postings tracked", pick: (s) => s.postings.totalTracked },
  { key: "live", label: "live postings", pick: (s) => s.postings.live },
  { key: "removed", label: "removed postings", pick: (s) => s.postings.removed },
  { key: "relisted", label: "relisted postings", pick: (s) => s.postings.relisted },
  { key: "relistShare", label: "relist share", pick: (s) => s.postings.relistShare },
  { key: "medianDaysListed", label: "median days listed", pick: (s) => s.postings.medianDaysListed },
  { key: "distinctCompanies", label: "distinct companies", pick: (s) => s.postings.distinctCompanies },
  { key: "bachelorShare", label: "bachelor share", pick: (s) => s.requirements.bachelorShare },
  { key: "mastersShare", label: "masters share", pick: (s) => s.requirements.mastersShare },
  { key: "fivePlusShare", label: "5+ years share", pick: (s) => s.requirements.fivePlusShare },
  { key: "postingsWithDescriptionRead", label: "descriptions read", pick: (s) => s.requirements.postingsWithDescriptionRead },
  { key: "topIndustryCount", label: "top industry postings", pick: (s) => s.industries[0]?.count ?? null },
  { key: "topTitleCount", label: "top title postings", pick: (s) => s.titles[0]?.count ?? null },
];
