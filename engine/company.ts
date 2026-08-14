/**
 * COMPANY POSTING-HEALTH LAYER — the honest, deterministic company rubric.
 *
 * Consumes the same tracked observations as the posting scorer (engine/score.ts)
 * and aggregates them per company into a 0–100 posting-health score plus the
 * exact human-readable reasons, per-posting rows, and reputation-protection
 * recommendations. Everything shown traces to observed engine data; we never
 * guess, and we never invent statistics.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COMPANY RUBRIC (documented; this file is the single source of truth)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Score direction: 100 = no ghost signals observed across the company's tracked
 * postings; 0 = strong ghost signals. Every score starts at 100 and points are
 * SUBTRACTED only for red flags actually observed on the tracked postings.
 *
 * INSUFFICIENT DATA (the honest "no read yet" state):
 *   N < 2 tracked postings → NO score, label "Not enough postings tracked yet".
 *   One posting can't honestly claim to represent a company's hiring practice.
 *
 * RED FLAGS (points subtracted; each must be observed, never assumed):
 *   R1 relist cycles ......... total relist events across the company's postings:
 *                              >= 3 → -50; == 2 → -40; == 1 → -25
 *   R2 staleness w/o change .. median days listed >= 180 → -30; >= 90 → -15
 *        only when NO content_changed event was observed on any posting
 *   R3 board spread ........... any posting seen on >= 3 boards → -20; >= 2 → -10
 *   R4 multi-URL identity ..... any posting tracked at >= 3 URLs → -20; >= 2 → -10
 *        R3 + R4 combined cap: -30 (spread and duplication are related signals)
 *   Total red points clamped to 0–100.
 *
 * PROVISIONAL (the honest "early days" label):
 *   observation window < 3 days AND no hard signals observed (no relists, no
 *   removals, no board/URL spread) → the computed score is shown but labelled
 *   provisional: it means "no signals seen so far", not "verified clean".
 *
 * EVIDENCE LEVEL:
 *   high   → window >= 14 days AND avg observations per posting >= 7
 *   medium → window >= 3 days, or a hard signal was observed
 *   low    → otherwise (fresh watching)
 *
 * LABELS (by final score):
 *   80–100 "Clean posting health" | 50–79 "Some signals worth watching"
 *   0–49   "Posting health needs attention" | (N<2 → "Not enough postings tracked yet")
 *
 * HONESTY RULES (hard):
 *   - Sandbox-local fixture postings (loopback hosts) are never surfaced in
 *     company profiles: they are test data with no reachable URL for users.
 *   - Declared posted dates (postedAt) are shown as context, never counted as
 *     observed staleness.
 *   - We never claim any statistic not derived from this store's own records.
 */

import { Store } from "./store";
import { buildSignals } from "./signals";
import { companySignal } from "./score";
import type { ScoreComponent } from "./score";
import type { PostingRecord, PostingSignals } from "./types";
import { industryForCompany } from "./company-industries";

export type CompanyReasonKind = "red" | "green" | "neutral";
export type CompanyEvidence = "low" | "medium" | "high";

export interface CompanyReason {
  kind: CompanyReasonKind;
  /** machine-readable signal id (stable for tests/UI) */
  signal: string;
  /** human-readable reason, phrased from observed facts only */
  text: string;
  /** ghost-evidence points this reason contributed (0 for non-red) */
  points: number;
}

export interface CompanyPostingRow {
  postingId: string;
  title: string | null;
  company: string;
  location: string | null;
  status: string;
  relistCount: number;
  daysListed: number;
  firstSeenAt: string;
  lastCheckedAt: string | null;
  canonicalUrl: string;
  boardsSeen: string[];
  /** posted date the page itself declares (context only, never staleness) */
  postedAt: string | null;
  /** true when the declared posted date predates our first observation by >30 days */
  declaredMuchOlder: boolean;
}

export interface CompanySummary {
  trackedPostings: number;
  /** total observed relist events (sum of relistCount across postings) */
  relistEvents: number;
  /** how many postings have been observed taken down and reposted at least once */
  relistedPostings: number;
  /** relistedPostings / trackedPostings (null when nothing tracked) */
  relistRate: number | null;
  medianDaysListed: number | null;
  maxDaysListed: number | null;
  liveCount: number;
  removedCount: number;
  /** distinct boards observed across the company's postings */
  boards: string[];
  /** distinct canonical URLs observed across the company's postings */
  urls: number;
  /** whole days since the earliest first observation of any of the company's postings */
  observationWindowDays: number;
  checksTotal: number;
}

export interface CompanyScoreResult {
  /** 0–100, or null when there aren't enough tracked postings for a read */
  score: number | null;
  label: string;
  /** true when the score is computed from a very short observation window with no signals */
  provisional: boolean;
  evidence: CompanyEvidence;
  /** raw ghost-evidence points subtracted (0 = none observed) */
  ghostEvidencePoints: number;
  /** per-factor breakdown of the score (one entry per company-rubric factor) */
  components: ScoreComponent[];
}

/* ────────────────────────── fix recommendations ────────────────────────── */

/**
 * One posting affected by a fix — always carries the observed value that
 * triggered it (title + URL + board are the facts; `observed` is the number
 * the signal is about). Never invented: only postings actually in the store.
 */
export interface CompanyFixPosting {
  postingId: string;
  title: string | null;
  canonicalUrl: string;
  /** board(s) the posting was observed on */
  board: string;
  /** observed value driving the fix, e.g. "2 relists" or "45 days listed" */
  observed: string;
}

/**
 * One concrete, actionable fix — framed as reputation protection, never
 * finger-wagging. Only present when the underlying signal was actually
 * observed on the company's tracked postings.
 */
export interface CompanyFix {
  /** stable machine id (same ids as the rubric signals where they overlap) */
  id: "relist_cycles" | "stale_listings" | "board_spread" | "multi_url" | "removed_postings";
  /** headline with the affected count, e.g. "3 postings have relist cycles…" */
  heading: string;
  /** the action to take, phrased as reputation protection */
  action: string;
  /** every tracked posting the fix applies to (title + URL + board + observed value) */
  affected: CompanyFixPosting[];
}

export interface CompanyFixes {
  fixes: CompanyFix[];
  /** true when no signal is weak — the healthy state, not "we didn't look" */
  healthy: boolean;
  healthyMessage: string;
}

/* ────────────────────────── industry benchmarks ─────────────────────────── */

/** The four benchmark metrics the /company page compares (all derive from the
 *  same records the company dashboard itself shows). */
export type BenchmarkMetricId = "medianDaysListed" | "relistShare" | "boardsUsed" | "livePostings";

export interface BenchmarkComparison {
  metric: BenchmarkMetricId;
  label: string;
  /** the company's own value (relistShare is 0..1; others are raw numbers) */
  company: number | null;
  /** median of the same metric across peer companies (null when none) */
  peerMedian: number | null;
  /**
   * For lower-is-better metrics (days listed, relist share): the share of
   * peers the company is strictly ahead of (0–100, rounded) — the honest
   * "you're fresher than X% of tracked peers" math. Null for raw comparisons
   * (boards used, live postings) where we make no value judgment.
   */
  aheadPct: number | null;
  lowerIsBetter: boolean;
  format: "days" | "pct" | "count";
}

export interface CompanyBenchmarks {
  /** the company's industry bucket (our curated classification) */
  industry: string;
  /** other tracked companies in the same industry bucket */
  peerCount: number;
  /** false when peerCount < 3 — show the honest small-sample note instead */
  comparable: boolean;
  /** honest label, e.g. "vs 12 tracked companies in Software/Internet (observed sample)" */
  headline: string;
  /** small-sample honesty note when !comparable */
  note: string | null;
  comparisons: BenchmarkComparison[];
  /**
   * Posting-freshness line: share of peers with a strictly LONGER median
   * listing age (lower is fresher). Null when the company's median is unknown.
   */
  freshness: { companyDays: number; peerMedianDays: number; fresherThanPct: number } | null;
}

export interface CompanyDashboard {
  name: string;
  generatedAt: string;
  summary: CompanySummary;
  score: CompanyScoreResult;
  reasons: CompanyReason[];
  /** structured fix recommendations — each tied to observed signals with the affected postings */
  fixes: CompanyFixes;
  /** industry/peer comparison (never a fake comparison; small samples say so honestly) */
  benchmarks: CompanyBenchmarks | null;
  postings: CompanyPostingRow[];
  /** honest context note (e.g. too few postings for a company read) */
  note: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Sandbox-local fixture postings are test data — never surface them. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function daysBetween(earlierIso: string, laterMs: number): number {
  return Math.max(0, Math.floor((laterMs - Date.parse(earlierIso)) / 86400000));
}

function fmtDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/* ────────────────────────── pure metric/benchmark math ────────────────────────── */

const BENCH_DAY_MS = 24 * 60 * 60 * 1000;

export function medianOf(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * Identity-group days listed per record — the SAME semantics as buildSignals
 * (whole days from the identity's first observation to now when anything in
 * the group is live, else to the group's last observation), computed without
 * the per-posting store round-trips so the peer benchmark can run over the
 * whole store in one pass. Group key = identityKey (falls back to postingId,
 * exactly like the signals layer).
 */
function identityDaysByRecord(records: PostingRecord[], nowMs: number): number[] {
  const groups = new Map<string, PostingRecord[]>();
  for (const r of records) {
    const key = r.identityKey || r.postingId;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  const daysByGroup = new Map<string, number>();
  for (const [key, g] of groups) {
    const firstSeen = Math.min(...g.map((r) => new Date(r.firstSeenAt).getTime()));
    const anythingLive = g.some((r) => r.status === "live" || r.status === "relisted");
    const lastSeen = Math.max(...g.map((r) => new Date(r.lastSeenAt).getTime()));
    const end = anythingLive ? nowMs : lastSeen;
    daysByGroup.set(key, Math.max(0, Math.floor((end - firstSeen) / BENCH_DAY_MS)));
  }
  return records.map((r) => daysByGroup.get(r.identityKey || r.postingId) ?? 0);
}

/**
 * The four benchmark metrics for ONE company, derived from its PostingRecords
 * with the same definitions the dashboard summary uses (per-record identity
 * days for the median, relistCount>0 postings for the relist share, distinct
 * source boards, live/relisted status for the live count).
 */
export interface CompanyMetric {
  medianDaysListed: number | null;
  /** share of tracked postings with >= 1 observed relist (0..1) */
  relistShare: number | null;
  boardsUsed: number;
  livePostings: number;
}

export function companyMetrics(records: PostingRecord[], nowMs = Date.now()): CompanyMetric {
  const days = identityDaysByRecord(records, nowMs);
  const relisted = records.filter((r) => r.relistCount > 0).length;
  return {
    medianDaysListed: medianOf(days),
    relistShare: records.length ? relisted / records.length : null,
    boardsUsed: new Set(records.map((r) => r.sourceBoard)).size,
    livePostings: records.filter((r) => r.status === "live" || r.status === "relisted").length,
  };
}

export type IndustryResolver = (company: string) => string;

/**
 * Industry/peer benchmarks for one company: the company's per-signal values vs
 * the MEDIAN of the same metric across all OTHER tracked companies in the same
 * industry bucket. Pure (records in → result out) so the tests can exercise
 * the math with fixture data and a local resolver.
 *
 * Honesty rules (hard):
 *  - Peers are only OTHER companies — the target is never compared to itself.
 *  - With fewer than 3 comparable companies, `comparable` is false and the
 *    caller shows the small-sample note instead of a fake comparison.
 *  - "Fresher than X% of tracked peers" counts peers with a STRICTLY longer
 *    median listing age — ties don't count, so the claim is never inflated.
 */
export function computeBenchmarks(
  records: PostingRecord[],
  targetCompany: string,
  industryOf: IndustryResolver,
  nowMs = Date.now()
): CompanyBenchmarks {
  const targetKey = targetCompany.toLowerCase();
  const byCompany = new Map<string, PostingRecord[]>();
  for (const r of records) {
    if (!r.company) continue;
    if (isLoopbackUrl(r.canonicalUrl)) continue;
    const key = r.company.toLowerCase();
    const arr = byCompany.get(key);
    if (arr) arr.push(r);
    else byCompany.set(key, [r]);
  }

  const industry = industryOf(targetCompany);
  const peers: { name: string; metric: CompanyMetric }[] = [];
  for (const [key, recs] of byCompany) {
    if (key === targetKey) continue; // only OTHER companies
    if (industryOf(recs[0].company ?? "") !== industry) continue;
    peers.push({ name: recs[0].company ?? key, metric: companyMetrics(recs, nowMs) });
  }
  const peerCount = peers.length;
  const comparable = peerCount >= 3;
  const headline = `vs ${peerCount} tracked compan${peerCount === 1 ? "y" : "ies"} in ${industry} (observed sample)`;
  const note = comparable
    ? null
    : `Not enough comparable companies in our tracked sample yet — we need at least 3 other tracked companies in ${industry} before we can honestly compare, so we won't invent a benchmark.`;

  const targetRecs = byCompany.get(targetKey) ?? [];
  const company = companyMetrics(targetRecs, nowMs);

  const peerMedians = (pick: (m: CompanyMetric) => number | null): number | null => {
    const vals = peers.map((p) => pick(p.metric)).filter((v): v is number => v !== null);
    return medianOf(vals);
  };
  const aheadPct = (companyVal: number | null, pick: (m: CompanyMetric) => number | null): number | null => {
    if (companyVal === null || !comparable) return null;
    const strictlyAhead = peers.filter((p) => (pick(p.metric) ?? -1) > companyVal).length;
    return Math.round((strictlyAhead / peerCount) * 100);
  };

  const comparisons: BenchmarkComparison[] = [
    {
      metric: "medianDaysListed",
      label: "Median days listed",
      company: company.medianDaysListed,
      peerMedian: peerMedians((m) => m.medianDaysListed),
      aheadPct: aheadPct(company.medianDaysListed, (m) => m.medianDaysListed),
      lowerIsBetter: true,
      format: "days",
    },
    {
      metric: "relistShare",
      label: "Relist share",
      company: company.relistShare,
      peerMedian: peerMedians((m) => m.relistShare),
      aheadPct: aheadPct(company.relistShare, (m) => m.relistShare),
      lowerIsBetter: true,
      format: "pct",
    },
    {
      metric: "boardsUsed",
      label: "Boards used",
      company: company.boardsUsed,
      peerMedian: peerMedians((m) => m.boardsUsed),
      aheadPct: null,
      lowerIsBetter: false,
      format: "count",
    },
    {
      metric: "livePostings",
      label: "Live postings",
      company: company.livePostings,
      peerMedian: peerMedians((m) => m.livePostings),
      aheadPct: null,
      lowerIsBetter: false,
      format: "count",
    },
  ];

  let freshness: CompanyBenchmarks["freshness"] = null;
  if (comparable && company.medianDaysListed !== null) {
    const peerDays = peers
      .map((p) => p.metric.medianDaysListed)
      .filter((v): v is number => v !== null);
    const fresherThan = peerDays.filter((d) => d > (company.medianDaysListed as number)).length;
    freshness = {
      companyDays: company.medianDaysListed,
      peerMedianDays: peerMedians((m) => m.medianDaysListed) ?? company.medianDaysListed,
      fresherThanPct: Math.round((fresherThan / peerCount) * 100),
    };
  }

  return { industry, peerCount, comparable, headline, note, comparisons, freshness };
}

/* ────────────────────────── fix recommendations ────────────────────────── */

/**
 * Build the structured fix recommendations from the dashboard's per-posting
 * rows + their signals. Each fix only exists when its signal was actually
 * observed; the healthy state means no signal is weak — never "we didn't look".
 */
export function buildFixes(rows: CompanyPostingRow[], signals: PostingSignals[]): CompanyFixes {
  const sigById = new Map(signals.map((s) => [s.postingId, s]));
  const fixes: CompanyFix[] = [];

  const relisted = rows.filter((r) => r.relistCount > 0);
  if (relisted.length > 0) {
    fixes.push({
      id: "relist_cycles",
      heading: `${relisted.length} ${relisted.length === 1 ? "posting has" : "postings have"} relist cycle${relisted.length === 1 ? "" : "s"} — investigate why ${relisted.length === 1 ? "the role keeps" : "roles keep"} reposting`,
      action:
        "Take-down-and-relist cycles read as an old posting made to look new — the strongest ghost-job signal we track. When a role closes, remove the posting the same day; if a role reopens, post it fresh with a clear, current date.",
      affected: relisted.map((r) => ({
        postingId: r.postingId,
        title: r.title,
        canonicalUrl: r.canonicalUrl,
        board: r.boardsSeen.join(", "),
        observed: `${r.relistCount} relist${r.relistCount === 1 ? "" : "s"}`,
      })),
    });
  }

  const stale = rows.filter((r) => {
    const changed = sigById.get(r.postingId)?.events.some((e) => e.type === "content_changed") ?? false;
    return r.daysListed >= 30 && !changed;
  });
  if (stale.length > 0) {
    fixes.push({
      id: "stale_listings",
      heading: `${stale.length} ${stale.length === 1 ? "posting has" : "postings have"} been listed 30+ days with no change we could observe — refresh or remove ${stale.length === 1 ? "it" : "them"}`,
      action:
        "A role that stays live for weeks with no visible update starts reading as stale, even when it's a genuine long search. If the role is still open, refresh the posting — update the date and details — so candidates can trust it's real; if it's not open anymore, take it down.",
      affected: stale.map((r) => ({
        postingId: r.postingId,
        title: r.title,
        canonicalUrl: r.canonicalUrl,
        board: r.boardsSeen.join(", "),
        observed: `${r.daysListed} days listed`,
      })),
    });
  }

  const spread = rows.filter((r) => r.boardsSeen.length >= 2);
  if (spread.length > 0) {
    fixes.push({
      id: "board_spread",
      heading: `${spread.length} ${spread.length === 1 ? "posting appears" : "postings appear"} on multiple boards — keep one canonical posting per role`,
      action:
        "The same role appearing on multiple boards splits applicants and makes the funnel look padded. Keep one canonical posting per role and make the other boards point to it.",
      affected: spread.map((r) => ({
        postingId: r.postingId,
        title: r.title,
        canonicalUrl: r.canonicalUrl,
        board: r.boardsSeen.join(", "),
        observed: `boards: ${r.boardsSeen.join(", ")}`,
      })),
    });
  }

  const multiUrl = rows.filter((r) => (sigById.get(r.postingId)?.distinctPostingsInIdentity ?? 1) >= 2);
  if (multiUrl.length > 0) {
    fixes.push({
      id: "multi_url",
      heading: `${multiUrl.length} ${multiUrl.length === 1 ? "role is" : "roles are"} tracked at multiple URLs — duplication can inflate how active ${multiUrl.length === 1 ? "it" : "they"} look`,
      action:
        "A role tracked at several URLs looks like several openings — which reads as padding to candidates and investors. Keep one URL per role and make the others redirect to it.",
      affected: multiUrl.map((r) => ({
        postingId: r.postingId,
        title: r.title,
        canonicalUrl: r.canonicalUrl,
        board: r.boardsSeen.join(", "),
        observed: `${sigById.get(r.postingId)?.distinctPostingsInIdentity ?? 2} URLs`,
      })),
    });
  }

  const removed = rows.filter((r) => r.status === "removed");
  if (removed.length > 0) {
    fixes.push({
      id: "removed_postings",
      heading: `${removed.length} ${removed.length === 1 ? "posting is" : "postings are"} currently gone from ${removed.length === 1 ? "its" : "their"} board${removed.length === 1 ? "" : "s"}`,
      action:
        "This may simply mean the role was filled — that's the right outcome. When a role closes, a short status note (filled, withdrawn, or paused) stops candidates and investors from guessing what happened.",
      affected: removed.map((r) => ({
        postingId: r.postingId,
        title: r.title,
        canonicalUrl: r.canonicalUrl,
        board: r.boardsSeen.join(", "),
        observed: "removed from board",
      })),
    });
  }

  const healthy = fixes.length === 0;
  return {
    fixes,
    healthy,
    healthyMessage: "No fixes needed right now — your postings look healthy.",
  };
}

/** Distinct company names with real (non-fixture) tracked postings, sorted. */
export async function trackedCompanies(store: Store): Promise<string[]> {
  const names = new Set<string>();
  for (const r of await store.getAll()) {
    if (r.company && !isLoopbackUrl(r.canonicalUrl)) names.add(r.company);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Build the full company dashboard from the tracking store.
 * Returns null when the store has no real tracked postings for this company
 * (case-insensitive match) — the caller shows the honest empty state.
 */
export async function companyDashboard(store: Store, company: string | null): Promise<CompanyDashboard | null> {
  if (!company) return null;
  const allRecords = await store.getAll();
  const all = allRecords.filter(
    (r) => r.company && r.company.toLowerCase() === company.toLowerCase() && !isLoopbackUrl(r.canonicalUrl)
  );

  const name = all[0]?.company ?? company;
  if (all.length === 0) return null;

  const now = Date.now();
  const signals: PostingSignals[] = await Promise.all(all.map((r) => buildSignals(store, r)));
  const rows: CompanyPostingRow[] = signals.map((s) => ({
    postingId: s.postingId,
    title: s.title,
    company: name,
    location: s.location,
    status: s.status,
    relistCount: s.relistCount,
    daysListed: s.daysListed,
    firstSeenAt: s.firstSeenAt,
    lastCheckedAt: s.lastCheckedAt,
    canonicalUrl: s.canonicalUrl,
    boardsSeen: s.boardsSeen,
    postedAt: s.postedAt,
    declaredMuchOlder:
      !!s.postedAt && daysBetween(s.postedAt, Date.parse(s.firstSeenAt)) > 30,
  }));

  // ── Summary (all derived from observed records) ────────────────────────────
  const relistEvents = all.reduce((n, r) => n + r.relistCount, 0);
  const relistedPostings = all.filter((r) => r.relistCount > 0).length;
  const days = signals.map((s) => s.daysListed).sort((a, b) => a - b);
  const medianDaysListed = days.length ? days[Math.floor((days.length - 1) / 2)] : null;
  const maxDaysListed = days.length ? days[days.length - 1] : null;
  const liveCount = all.filter((r) => r.status === "live" || r.status === "relisted").length;
  const removedCount = all.filter((r) => r.status === "removed").length;
  const boards = [...new Set(signals.flatMap((s) => s.boardsSeen))].sort();
  const urls = new Set(signals.flatMap((s) => s.urlsSeen)).size;
  const minFirst = signals.reduce((a, s) => (s.firstSeenAt < a ? s.firstSeenAt : a), signals[0].firstSeenAt);
  const observationWindowDays = daysBetween(minFirst, now);
  const checksTotal = (await Promise.all(all.map((r) => store.recentChecks(r.postingId, 100000)))).reduce((n, c) => n + c.length, 0);

  const summary: CompanySummary = {
    trackedPostings: all.length,
    relistEvents,
    relistedPostings,
    relistRate: all.length ? relistedPostings / all.length : null,
    medianDaysListed,
    maxDaysListed,
    liveCount,
    removedCount,
    boards,
    urls,
    observationWindowDays,
    checksTotal,
  };

  // ── Reasons (observed facts only) ──────────────────────────────────────────
  const reasons: CompanyReason[] = [];
  reasons.push({
    kind: "neutral",
    signal: "observation_window",
    text: `Watching ${plural(all.length, "posting")} from ${name} since ${fmtDate(minFirst)} — ${observationWindowDays} day${observationWindowDays === 1 ? "" : "s"} of observation so far.`,
    points: 0,
  });
  reasons.push({
    kind: "neutral",
    signal: "board_coverage",
    text: `Board coverage: ${boards.join(", ")}. ${checksTotal} total observations.`,
    points: 0,
  });

  let points = 0;

  // R1 — relist cycles (the strongest ghost signal)
  let relistPts = 0;
  if (relistEvents > 0) {
    relistPts = relistEvents >= 3 ? 50 : relistEvents === 2 ? 40 : 25;
    points += relistPts;
    reasons.push({
      kind: "red",
      signal: "relist_cycles",
      text:
        relistedPostings === relistEvents
          ? `${plural(relistedPostings, "posting")} observed taken down and reposted${relistEvents > 1 ? ` (${relistEvents} relist events total)` : ""} — the strongest ghost-job signal.`
          : `${plural(relistedPostings, "posting")} observed taken down and reposted (${relistEvents} relist events total) — the strongest ghost-job signal.`,
      points: relistPts,
    });
  } else {
    reasons.push({
      kind: "green",
      signal: "no_relist_cycles",
      text: `No take-down-and-relist cycles observed across the ${all.length} posting${all.length === 1 ? "" : "s"} we track from ${name}.`,
      points: 0,
    });
  }

  // R2 — staleness without change (only when nothing was observed changing)
  const anyContentChange = signals.some((s) => s.events.some((e) => e.type === "content_changed"));
  let stalePts = 0;
  if (!anyContentChange && medianDaysListed !== null && medianDaysListed >= 90) {
    stalePts = medianDaysListed >= 180 ? 30 : 15;
    points += stalePts;
    reasons.push({
      kind: "red",
      signal: "stale_no_change",
      text: `Postings from ${name} have been listed for a median of ${medianDaysListed} days with no change we could observe.`,
      points: stalePts,
    });
  }

  // R3 + R4 — board/URL spread (related signals, capped at -30 combined)
  const maxBoards = Math.max(0, ...signals.map((s) => s.boardsSeen.length));
  const maxUrls = Math.max(0, ...signals.map((s) => s.distinctPostingsInIdentity));
  const boardPts = maxBoards >= 2 ? (maxBoards >= 3 ? 20 : 10) : 0;
  const rawUrlPts = maxUrls >= 2 ? (maxUrls >= 3 ? 20 : 10) : 0;
  let spreadPts = 0;
  if (boardPts > 0) {
    spreadPts += boardPts;
    reasons.push({
      kind: "red",
      signal: "board_spread",
      text: `A role from ${name} has been observed on ${maxBoards} boards (${[...new Set(signals.flatMap((s) => s.boardsSeen))].sort().join(", ")}).`,
      points: boardPts,
    });
  }
  if (rawUrlPts > 0) {
    spreadPts += rawUrlPts;
    reasons.push({
      kind: "red",
      signal: "multi_url",
      text: `A role from ${name} is tracked at ${maxUrls} different URLs.`,
      points: rawUrlPts,
    });
  }
  spreadPts = Math.min(spreadPts, 30);
  points += spreadPts;

  // ── Status context + green positives ───────────────────────────────────────
  if (removedCount > 0) {
    reasons.push({
      kind: "neutral",
      signal: "currently_removed",
      text: `${plural(removedCount, "posting")} currently gone from their board${removedCount === 1 ? "" : "s"} — may be filled, withdrawn, or moved.`,
      points: 0,
    });
  } else {
    reasons.push({
      kind: "green",
      signal: "all_live",
      text: `All ${all.length} tracked posting${all.length === 1 ? "" : "s"} from ${name} ${all.length === 1 ? "is" : "are"} currently live.`,
      points: 0,
    });
  }

  const olderDeclared = signals.filter((s) => s.postedAt && daysBetween(s.postedAt, Date.parse(s.firstSeenAt)) > 30);
  if (olderDeclared.length > 0) {
    reasons.push({
      kind: "neutral",
      signal: "declared_older_than_observation",
      text: `${olderDeclared.length === signals.length ? "The" : "Some of the"} posting${olderDeclared.length === 1 ? "" : "s"} declare${olderDeclared.length === 1 ? "s" : ""} a posted date earlier than our first observation — we can only speak to what we've seen since ${fmtDate(minFirst)}.`,
      points: 0,
    });
  }

  const missingTitle = signals.filter((s) => s.dataQuality.title === "missing").length;
  if (missingTitle > 0) {
    reasons.push({
      kind: "neutral",
      signal: "missing_metadata",
      text: `We could not read a job title from ${plural(missingTitle, "posting")} — our extraction is limited to what the pages expose.`,
      points: 0,
    });
  }

  // ── Score ──────────────────────────────────────────────────────────────────
  const N = all.length;
  const hardSignals =
    relistEvents > 0 || removedCount > 0 || maxBoards >= 2 || maxUrls >= 2;
  const provisional = N >= 2 && observationWindowDays < 3 && !hardSignals;
  const avgChecks = checksTotal / N;
  const evidence: CompanyEvidence =
    observationWindowDays >= 14 && avgChecks >= 7
      ? "high"
      : observationWindowDays >= 3 || hardSignals
        ? "medium"
        : "low";

  // ── Components: per-factor breakdown (same rubric math as the reasons; the
  //    URL factor absorbs the residuals of the R3+R4 cap (30) and the global
  //    clamp (100) so the breakdown sums to exactly the deduction the score
  //    reflects) ──────────────────────────────────────────────────────────────
  let urlCompPts = Math.min(rawUrlPts, 30 - boardPts);
  const compTotal = relistPts + stalePts + boardPts + urlCompPts;
  if (compTotal > 100) urlCompPts = Math.max(0, urlCompPts - (compTotal - 100));
  const components: ScoreComponent[] = [
    {
      signalId: "relist_cycles",
      label: "Relist cycles",
      observed: relistEvents > 0 ? `${relistEvents} relist event${relistEvents === 1 ? "" : "s"} observed` : "None observed",
      points: relistPts,
      maxPoints: 50,
      reason:
        relistEvents > 0
          ? "Postings from this company observed taken down and reappearing — the strongest ghost-job signal we track."
          : "No take-down-and-relist cycle observed across the postings we track.",
    },
    {
      signalId: "stale_no_change",
      label: "Listing age (median)",
      observed: medianDaysListed === null ? "n/a" : `Median ${medianDaysListed} day${medianDaysListed === 1 ? "" : "s"} listed`,
      points: stalePts,
      maxPoints: 30,
      reason:
        stalePts > 0
          ? "Postings have been listed for a median of 90+ days with no change we could observe — that reads as stale."
          : medianDaysListed !== null && medianDaysListed < 90
            ? "Median listing age is under 90 days — outside the staleness window, so no deduction."
            : anyContentChange
              ? "We observed content changes on the postings, so the staleness flag doesn't apply."
              : "Not enough days-listed data for a median yet.",
    },
    {
      signalId: "board_spread",
      label: "Board spread",
      observed:
        maxBoards >= 2
          ? `A role seen on ${maxBoards} boards (${boards.join(", ")})`
          : maxBoards === 1
            ? "Each posting seen on 1 board"
            : "n/a",
      points: boardPts,
      maxPoints: 20,
      reason:
        maxBoards >= 2
          ? "A role from this company observed on multiple boards — spread can mean one posting copied around."
          : "No board spread observed across the tracked postings.",
    },
    {
      signalId: "multi_url",
      label: "Duplicate URLs",
      observed: maxUrls >= 2 ? `A role tracked at ${maxUrls} URLs` : maxUrls === 1 ? "Each role tracked at 1 URL" : "n/a",
      points: urlCompPts,
      maxPoints: 20,
      reason:
        maxUrls < 2
          ? "No duplicate URLs observed."
          : urlCompPts < rawUrlPts
            ? "A role is tracked at multiple URLs — spread and duplication deductions are capped (−30 combined, −100 total)."
            : "A role tracked at multiple URLs — duplication can inflate how active a role looks.",
    },
    {
      signalId: "observation_window",
      label: "Observation window",
      observed: `${plural(all.length, "posting")} · ${observationWindowDays} day${observationWindowDays === 1 ? "" : "s"} · ${checksTotal} checks`,
      points: 0,
      maxPoints: 0,
      reason:
        N < 2
          ? "Not enough postings tracked yet — one posting can't honestly represent a company's hiring practice, so there's no score."
          : provisional
            ? "We just started watching (under 3 days) with no hard signals yet — the score is provisional, not verified clean."
            : evidence === "high"
              ? "At least 14 days of observation with an average of 7+ checks per posting — a confident read."
              : evidence === "medium"
                ? "At least 3 days of observation, or a hard signal observed — a usable baseline."
                : "Early watching — more observation will sharpen the score.",
    },
  ];

  let scoreResult: CompanyScoreResult;
  if (N < 2) {
    scoreResult = {
      score: null,
      label: "Not enough postings tracked yet",
      provisional: false,
      evidence,
      ghostEvidencePoints: 0,
      components,
    };
  } else {
    const ghostEvidencePoints = Math.min(100, points);
    const score = 100 - ghostEvidencePoints;
    scoreResult = {
      score,
      label:
        score >= 80
          ? "Clean posting health"
          : score >= 50
            ? "Some signals worth watching"
            : "Posting health needs attention",
      provisional,
      evidence,
      ghostEvidencePoints,
      components,
    };
  }

  // ── Fixes (structured, data-backed, reputation protection) ────────────────
  const fixes = buildFixes(rows, signals);

  // ── Industry/peer benchmarks (same records, peers = OTHER companies) ───────
  const benchmarks = computeBenchmarks(allRecords, name, industryForCompany);

  // ── Honest note (reuses the posting scorer's company aggregation) ──────────
  const cs = await companySignal(store, name);
  const note = cs?.note ?? null;

  return {
    name,
    generatedAt: new Date().toISOString(),
    summary,
    score: scoreResult,
    reasons,
    fixes,
    benchmarks,
    postings: rows,
    note,
  };
}
