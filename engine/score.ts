/**
 * GHOST-JOB SCORING LAYER — the honest, deterministic rubric.
 *
 * Consumes `PostingSignals` (raw, traceable observations from the tracking
 * engine) and produces a 0–100 confidence score plus the exact human-readable
 * reasons and per-factor components that drove it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUBRIC (documented; this file is the single source of truth)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Score direction: 100 = no ghost signals observed ("looks real"); 0 = strong
 * ghost signals. Every score starts at 100 and ghost-evidence points are
 * SUBTRACTED for red flags that were actually observed. We never add points
 * for things we did not see, and we never guess.
 *
 * EVIDENCE LEVEL (how much we actually watched):
 *   checks      = number of stored HTTP observations of this posting
 *   days        = calendar days since first observation (daysListed)
 *   hard signal = relistCount > 0, or same identity on >1 URL/board, or an
 *                 observed removal (statusHistory length >= 2)
 *   high   → checks >= 7  AND days >= 14
 *   medium → checks >= 3  AND days >= 3
 *   low    → otherwise
 *   A hard signal raises evidence to at least medium (we SAW something).
 *
 * INSUFFICIENT DATA (the honest "no read yet" state):
 *   no hard signal AND (checks < 3 OR days < 3)
 *   → score = 50 (neutral midpoint), label "Insufficient data". This is a
 *     feature, not a weakness: a posting watched once today carries no signal.
 *
 * RED FLAGS (points subtracted; each must be observed, never assumed):
 *   R1 relist cycles ......... relistCount >= 1 → -25; >= 2 → -40; >= 3 → -50
 *        (a posting observed taken down and reappearing is the strongest
 *         ghost signal; each additional cycle adds diminishing weight)
 *   R2 staleness w/o change .. days >= 180 → -30; >= 90 → -15
 *        only when NO content_changed event was observed (the posting demonstrably
 *        changed, so "stale and unchanged" does not hold). daysListed measures
 *        "first seen N days ago" — the posting may be even older; reasons say so.
 *   R3 board spread ........... boardsSeen >= 3 → -20; >= 2 → -10
 *   R4 multi-URL identity ..... distinctPostingsInIdentity >= 3 → -20; >= 2 → -10
 *        R3 + R4 combined cap: -30 (spread and duplication are related signals)
 *   R5 pay conflict (2026-08-15, owner decision) → -15
 *        the same role states pay on 2+ listings we track and the bands
 *        disagree (or the currencies differ). A real role has one real salary
 *        band, so cross-listing pay conflicts are a ghost-job tell. Judged
 *        only when 2+ listings actually state pay — missing pay is NEVER a
 *        conflict and never a deduction.
 *   Total red points are clamped to 0–100.
 *
 * GREEN CREDIT (points added back; each must be observed, never assumed):
 *   G1 pay listed (2026-08-15, owner decision) → +5 back, only when this
 *        posting states pay AND the role has no pay conflict. Pay transparency
 *        is a sign of an honest posting — a modest credit that offsets up to 5
 *        points of observed red flags, never pushing a clean posting above 100
 *        (the credit is capped at the current deduction total, so the net can
 *        never go negative). The pay signal can therefore RAISE confidence
 *        (pay listed), LOWER it (pay conflict), or leave it alone (pay not
 *        stated / not checked yet) — never mechanically in one direction.
 *
 * LABELS (by final score):
 *   80–100  "Looks real"              | 50–79 "Watch it"
 *   0–49    "Strong ghost signals"    | (insufficient → "Insufficient data")
 *
 * VERDICT ("worth your time?"):
 *   >= 80 "Worth applying" · 50–79 "Proceed with awareness" · < 50 "Approach
 *   with caution" · insufficient "Not enough data yet" · removed "Not currently
 *   listed".
 *
 * HONESTY RULES (hard):
 *   - A fresh posting with one URL and no history ALWAYS returns the
 *     insufficient-data path, never a damning score.
 *   - A posting currently removed (HTTP 404) is reported as "gone" — we cannot
 *     score ghost-ness of something that is not there. If it has relist history
 *     the red flags speak for themselves.
 *   - We never claim "X% of postings are ghost jobs" or any statistic not
 *     derived from this store's own observations.
 *
 * COMPANY VIEW: `companySignal()` aggregates every tracked posting sharing the
 * company name → relist rate + median days listed. With fewer than 2 tracked
 * postings it says so honestly instead of inventing a company profile.
 */

import { Store } from "./store";
import { buildSignals } from "./signals";
import { payConsistency } from "./pay";
import type { PayInfo, PostingSignals } from "./types";

export type EvidenceLevel = "low" | "medium" | "high";
export type ScoreLabel = "Looks real" | "Watch it" | "Strong ghost signals" | "Insufficient data";
export type ReasonKind = "red" | "green" | "neutral";

export interface ScoreReason {
  kind: ReasonKind;
  /** machine-readable signal id (stable for tests/UI) */
  signal: string;
  /** human-readable reason, phrased from observed facts only */
  text: string;
  /** ghost-evidence points this reason contributed (0 for non-red) */
  points: number;
}

/**
 * One rubric factor's contribution to the score — the per-signal breakdown
 * shown in the "How this score was built" panel. Every entry is DERIVED from
 * the same computation as the overall score (scoreCore is the single source);
 * observed values are factual, and "n/a" means we genuinely couldn't observe
 * the factor yet — never a guess.
 */
export interface ScoreComponent {
  /** machine-readable factor id (stable for tests/UI) */
  signalId: string;
  /** human-readable factor label */
  label: string;
  /** human-readable observed value ("n/a" when not observable yet) */
  observed: string;
  /** points this factor subtracted (0 = no red flag observed) */
  points: number;
  /** maximum points this factor can subtract (contribution denominator) */
  maxPoints: number;
  /** plain-language reason for this factor's contribution/status */
  reason: string;
}

export interface CompanySignal {
  name: string;
  /** tracked postings sharing this company name in the store */
  trackedPostings: number;
  /** share of tracked postings with >= 1 observed relist (0..1, null if none tracked) */
  relistRate: number | null;
  /** median days listed across the company's tracked postings */
  medianDaysListed: number | null;
  /** longest days listed across the company's tracked postings */
  maxDaysListed: number | null;
  /** honest context note (e.g. too few postings for a company read) */
  note: string | null;
}

export interface PostingScore {
  postingId: string;
  canonicalUrl: string;
  /** 0–100. Higher = fewer ghost signals observed. 50 = neutral/insufficient. */
  score: number;
  /** the raw ghost-evidence points subtracted (0 = none observed) */
  ghostEvidencePoints: number;
  label: ScoreLabel;
  /** the "worth your time?" answer */
  verdict: string;
  insufficientData: boolean;
  evidence: EvidenceLevel;
  /** every reason that drove the score + neutral context, in display order */
  reasons: ScoreReason[];
  /** per-factor breakdown of the score (one entry per rubric factor) */
  components: ScoreComponent[];
  /** aggregated company-level signal for the posting's company (if any) */
  company: CompanySignal | null;
  // ── Posting metadata (copied from signals so the result is self-contained) ──
  title: string | null;
  companyName: string | null;
  location: string | null;
  daysListed: number;
  status: string;
  postedAt: string | null;
  firstSeenAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Stored observation count for a posting (the traceability layer). */
async function checkCount(store: Store, postingId: string): Promise<number> {
  return (await store.recentChecks(postingId, 100000)).length;
}

/** Aggregate company-level signals across all tracked postings of one company. */
export async function companySignal(store: Store, company: string | null): Promise<CompanySignal | null> {
  if (!company) return null;
  const all = await store.getAll();
  const rows = all.filter((r) => r.company && r.company.toLowerCase() === company.toLowerCase());
  if (rows.length === 0) return null;

  const relisted = rows.filter((r) => r.relistCount > 0).length;
  const days = (await Promise.all(rows.map((r) => buildSignals(store, r)))).map((s) => s.daysListed).sort((a, b) => a - b);
  const median = days.length ? days[Math.floor((days.length - 1) / 2)] : null;

  let note: string | null = null;
  if (rows.length < 2) {
    note = `We've only tracked ${rows.length} posting${rows.length === 1 ? "" : "s"} from ${company} so far — not enough for a company-level read yet.`;
  } else if (relisted === 0) {
    note = `None of the ${rows.length} postings we track from ${company} has been observed taken down and reposted.`;
  } else {
    note = `${relisted} of ${rows.length} postings we track from ${company} have been observed taken down and reposted at least once.`;
  }

  return {
    name: company,
    trackedPostings: rows.length,
    relistRate: rows.length ? relisted / rows.length : null,
    medianDaysListed: median,
    maxDaysListed: days.length ? days[days.length - 1] : null,
    note,
  };
}

/**
 * Pure scoring math — the exact same rubric as scorePosting, minus the reasons
 * narrative and the company lookup. The monthly job-market report uses this with
 * prefetched data (one check-count argument instead of a per-posting store
 * query), so its score distribution always matches what scorePosting would
 * produce.
 *
 * Single source of truth for the rubric: relist/staleness/spread points,
 * evidence level, insufficiency, the final score/label/verdict logic, AND the
 * per-factor `components` breakdown. scorePosting consumes the components from
 * here (no separate math), so the breakdown can never drift from the score.
 */
export function scoreCore(
  signals: Pick<
    PostingSignals,
    "postingId" | "status" | "relistCount" | "daysListed" | "boardsSeen" | "distinctPostingsInIdentity" | "events" | "pay" | "payGroup"
  >,
  checks: number
): { score: number; ghostEvidencePoints: number; label: ScoreLabel; verdict: string; insufficientData: boolean; evidence: EvidenceLevel; components: ScoreComponent[] } {
  const { status, relistCount, daysListed, boardsSeen, distinctPostingsInIdentity, events } = signals;
  const hasContentChange = events.some((e) => e.type === "content_changed");
  const hasRemoval = events.some((e) => e.type === "removed");
  const hardSignal = relistCount > 0 || distinctPostingsInIdentity > 1 || boardsSeen.length > 1 || hasRemoval;

  // ── Factor points (each observed, never assumed) ───────────────────────────
  const relistPts = relistCount > 0 ? (relistCount >= 3 ? 50 : relistCount === 2 ? 40 : 25) : 0;
  const staleNoChange = !hasContentChange && (status === "live" || status === "relisted") && daysListed >= 90;
  const stalePts = staleNoChange ? (daysListed >= 180 ? 30 : 15) : 0;
  const boardPts = boardsSeen.length >= 2 ? (boardsSeen.length >= 3 ? 20 : 10) : 0;
  const rawUrlPts = distinctPostingsInIdentity >= 2 ? (distinctPostingsInIdentity >= 3 ? 20 : 10) : 0;
  // R3 + R4 are related signals (one role copied around) — combined cap at 30,
  // and the overall red-flag total is clamped at 100. The URL factor (then the
  // pay-conflict factor, for the rare combined case) absorbs the residual of
  // the caps so per-factor points always sum to exactly the deduction the
  // score reflects.
  let urlPts = Math.min(rawUrlPts, 30 - boardPts);
  const baseRed = relistPts + stalePts + boardPts + urlPts;

  // ── Pay signals (owner decision 2026-08-15; rubric R5 + G1 above) ─────────
  // The verdict is computed over the same-role pay group (identity ∩ same
  // location when both declare one). Missing pay and "not checked yet" are
  // NEVER deductions and NEVER conflicts — the signals say so honestly.
  const payVerdict = payConsistency(signals.payGroup ?? []);
  const payConflict = payVerdict.verdict === "conflict";
  const payListed = Boolean(signals.pay?.hasPay && !signals.pay.fetchError);
  let conflictPts = payConflict ? 15 : 0;
  // G1: pay-listed credit — offsets up to 5 points of observed red flags, but
  // only when there is no pay conflict, and never below a net of 0.
  const creditPts = payListed && !payConflict ? Math.min(5, baseRed + conflictPts) : 0;

  const rawNet = baseRed + conflictPts - creditPts;
  const ghostEvidencePoints = Math.max(0, Math.min(100, rawNet));
  if (rawNet > 100) {
    // Absorb the excess over 100 into the URL factor first (legacy behavior),
    // then the pay-conflict factor — keeps per-factor points summing exactly.
    const excess = rawNet - 100;
    const urlReduction = Math.min(urlPts, excess);
    urlPts -= urlReduction;
    conflictPts = conflictPts - Math.min(conflictPts, excess - urlReduction);
  }

  let evidence: EvidenceLevel = checks >= 7 && daysListed >= 14 ? "high" : checks >= 3 && daysListed >= 3 ? "medium" : "low";
  if (hardSignal && evidence === "low") evidence = "medium";

  const currentlyGone = status === "removed";
  const insufficientData = !hardSignal && !currentlyGone && (checks < 3 || daysListed < 3);

  let score: number;
  let label: ScoreLabel;
  let verdict: string;

  if (insufficientData) {
    score = 50;
    label = "Insufficient data";
    verdict = "Not enough data yet — we haven't watched this posting long enough for a real read. Check back in a few days, or watch it for alerts.";
  } else if (currentlyGone && relistCount === 0 && ghostEvidencePoints === 0) {
    score = 50;
    label = "Insufficient data";
    verdict = "Not currently listed — the URL is gone. Don't spend an application on it until it reappears.";
  } else {
    score = 100 - ghostEvidencePoints;
    label = score >= 80 ? "Looks real" : score >= 50 ? "Watch it" : "Strong ghost signals";
    verdict = score >= 80 ? "Worth applying — no ghost signals observed." : score >= 50 ? "Proceed with awareness — some signals worth a second look." : "Approach with caution — this posting shows strong ghost-job signals.";
    if (currentlyGone) verdict = "Not currently listed — the URL is gone. If it reappears, the red flags above still apply.";
  }

  // ── Components: every rubric factor, derived from the same computation ─────
  const urlCapApplied = urlPts < rawUrlPts;
  const pay = signals.pay ?? null;
  const payObserved = !pay
    ? "Pay not checked yet — we'll read the posting on its next check."
    : pay.fetchError
      ? "Pay couldn't be read — the listing data was not readable."
      : pay.hasPay
        ? `States ${pay.payText ?? fmtBand(pay.payMin, pay.payMax, pay.currency, pay.period)}`
        : "Not stated in the listing data we read";
  const payVerdictText =
    payVerdict.verdict === "consistent"
      ? `Same pay on all ${payVerdict.payingListings} listings we track for this role`
      : payVerdict.verdict === "conflict"
        ? `Pay differs across the ${payVerdict.payingListings} listings we track (e.g. ${payGroupBands(signals.payGroup ?? [])})`
        : payVerdict.verdict === "only-one-listing"
          ? "Only one listing states pay — nothing to compare"
          : payVerdict.verdict === "not-checked"
            ? "Pay not checked yet — nothing to compare"
            : "No listing states pay — nothing to compare";
  const components: ScoreComponent[] = [
    {
      signalId: "relist_cycles",
      label: "Relist cycles",
      observed: relistCount > 0 ? `${relistCount} observed` : "None observed",
      points: relistPts,
      maxPoints: 50,
      reason:
        relistCount === 0
          ? "No take-down-and-relist cycle observed for this posting."
          : "A posting observed taken down and reappearing is the strongest ghost-job signal we track.",
    },
    {
      signalId: "stale_no_change",
      label: "Listing age",
      observed: `Listed ${daysListed} day${daysListed === 1 ? "" : "s"}${staleNoChange ? " with no observed change" : ""}`,
      points: stalePts,
      maxPoints: 30,
      reason: staleNoChange
        ? "First seen 90+ days ago and still live with no change we could observe — that reads as stale."
        : daysListed < 90
          ? "First seen less than 90 days ago — outside the staleness window, so no deduction."
          : "The posting changed while we watched, so the staleness flag doesn't apply.",
    },
    {
      signalId: "board_spread",
      label: "Board spread",
      observed:
        boardsSeen.length >= 2
          ? `Seen on ${boardsSeen.length} boards (${boardsSeen.join(", ")})`
          : boardsSeen.length === 1
            ? `Seen on 1 board (${boardsSeen[0]})`
            : "n/a",
      points: boardPts,
      maxPoints: 20,
      reason:
        boardsSeen.length >= 2
          ? "The same role observed on multiple boards — spread can mean one posting copied around."
          : "Seen on a single board — no spread signal.",
    },
    {
      signalId: "multi_url",
      label: "Duplicate URLs",
      observed: distinctPostingsInIdentity >= 2 ? `Same role at ${distinctPostingsInIdentity} URLs` : "1 URL for this role",
      points: urlPts,
      maxPoints: 20,
      reason:
        distinctPostingsInIdentity < 2
          ? "No duplicate URLs observed."
          : urlCapApplied
            ? "The same role is tracked at multiple URLs — spread and duplication deductions are capped (−30 combined, −100 total)."
            : "The same role is tracked at multiple URLs — duplication can inflate how active a role looks.",
    },
    {
      signalId: "pay_listed",
      label: "Pay listed",
      observed: payObserved,
      points: -creditPts, // negative = green credit (raises confidence)
      maxPoints: 5,
      reason:
        payListed && !payConflict
          ? "This posting states a pay range — pay transparency is a sign of an honest posting. It offsets up to 5 points of observed red flags."
          : payListed && payConflict
            ? "This posting states pay, but the same role lists different pay elsewhere — the conflict below dominates."
            : !pay
              ? "We haven't re-read this posting since pay tracking started — no read yet, no judgment."
              : pay.fetchError
                ? "We couldn't read the listing data to check for pay — reported honestly, never guessed."
                : "No pay is stated in the listing data we read. That's common and honest — it neither helps nor hurts this score (a real role can still omit pay).",
    },
    {
      signalId: "pay_consistent",
      label: "Pay across listings",
      observed: payVerdictText,
      points: conflictPts,
      maxPoints: 15,
      reason:
        payVerdict.verdict === "conflict"
          ? "The same role is listed with different pay on different boards/URLs we track — a real role has one real salary band, so this is a ghost-job tell."
          : payVerdict.verdict === "consistent"
            ? "Pay matches across every listing we track for this role — that's what a genuine posting looks like."
            : payVerdict.verdict === "only-one-listing"
              ? "Pay consistency can only be judged when the same role appears on 2+ listings — we don't guess."
              : payVerdict.verdict === "not-checked"
                ? "Pay hasn't been read for the listings yet — no read, no judgment."
                : "No listing states pay, so there's nothing to compare — missing pay is never counted as a conflict.",
    },
    {
      signalId: "observation_window",
      label: "Observation window",
      observed: `Watched ${checks} time${checks === 1 ? "" : "s"} over ${daysListed} day${daysListed === 1 ? "" : "s"}`,
      points: 0,
      maxPoints: 0,
      reason: insufficientData
        ? "We haven't watched long enough (fewer than 3 checks or fewer than 3 days) — that's why the score holds at the neutral 50: no read yet."
        : evidence === "high"
          ? "At least 7 checks over at least 14 days — a confident read."
          : evidence === "medium"
            ? "At least 3 checks over at least 3 days, or a hard signal observed — a usable baseline."
            : "Early watching — more observation will sharpen the score.",
    },
  ];

  return { score, ghostEvidencePoints, label, verdict, insufficientData, evidence, components };
}

/** Format an observed band like "$120,000–$150,000 per year" for the breakdown. */
function fmtBand(min: number | null, max: number | null, currency: string | null, period: PayInfo["period"] | null): string {
  const cur = currency ?? "";
  const fmt = (n: number) => `${cur}${n.toLocaleString("en-US")}`;
  const band = min != null && max != null ? `${fmt(min)} – ${fmt(max)}` : fmt(min ?? max ?? 0);
  return period ? `${band} per ${period}` : band;
}

/** A short band summary for the conflict reason (e.g. "$120,000/yr vs $90,000/yr"). */
function payGroupBands(rows: PayInfo[]): string {
  const readable = rows.filter((r) => r.hasPay && !r.fetchError).slice(0, 3);
  return readable
    .map((r) => fmtBand(r.payMin, r.payMax, r.currency, r.period))
    .join(" vs ");
}

/** Score one posting's signals against the rubric above. */
export async function scorePosting(store: Store, signals: PostingSignals): Promise<PostingScore> {
  const { postingId, status, relistCount, daysListed, boardsSeen, distinctPostingsInIdentity, events, dataQuality } = signals;

  const checks = await checkCount(store, postingId);
  const reasons: ScoreReason[] = [];
  // Numeric truth comes from scoreCore (single source of the rubric math).
  const core = scoreCore(signals, checks);
  let points = core.ghostEvidencePoints;

  const hasContentChange = events.some((e) => e.type === "content_changed");
  const hasRemoval = events.some((e) => e.type === "removed");
  const hardSignal = relistCount > 0 || distinctPostingsInIdentity > 1 || boardsSeen.length > 1 || hasRemoval;

  // ── Red flags (observed only) ──────────────────────────────────────────────
  let relistPts = 0;
  if (relistCount > 0) {
    relistPts = relistCount >= 3 ? 50 : relistCount === 2 ? 40 : 25;
    reasons.push({
      kind: "red",
      signal: "relist_cycles",
      text:
        relistCount === 1
          ? "Taken down and reposted once since we first saw it — the strongest ghost-job signal."
          : `Taken down and reposted ${relistCount} times since we first saw it — the strongest ghost-job signal.`,
      points: relistPts,
    });
  }

  let stalePts = 0;
  const staleNoChange = !hasContentChange && (status === "live" || status === "relisted") && daysListed >= 90;
  if (staleNoChange) {
    stalePts = daysListed >= 180 ? 30 : 15;
    reasons.push({
      kind: "red",
      signal: "stale_no_change",
      text: `First seen ${daysListed} days ago and still live, with no change we could observe.`,
      points: stalePts,
    });
  }

  let spreadPts = 0;
  if (boardsSeen.length >= 2) {
    const p = boardsSeen.length >= 3 ? 20 : 10;
    spreadPts += p;
    reasons.push({
      kind: "red",
      signal: "board_spread",
      text: `The same role has been observed on ${boardsSeen.length} boards (${boardsSeen.join(", ")}).`,
      points: p,
    });
  }

  if (distinctPostingsInIdentity >= 2) {
    const p = distinctPostingsInIdentity >= 3 ? 20 : 10;
    spreadPts += p;
    reasons.push({
      kind: "red",
      signal: "multi_url",
      text: `The same role is tracked at ${distinctPostingsInIdentity} different URLs.`,
      points: p,
    });
  }
  // R3 + R4 are related signals (one role copied around) — cap their combined weight at 30.
  spreadPts = Math.min(spreadPts, 30);

  // ── Pay signals (owner decision 2026-08-15): red conflict + green credit ──
  const payVerdict = payConsistency(signals.payGroup ?? []);
  const payListed = Boolean(signals.pay?.hasPay && !signals.pay.fetchError);
  if (payVerdict.verdict === "conflict") {
    reasons.push({
      kind: "red",
      signal: "pay_consistent",
      text: `The same role is listed with different pay on different boards/URLs we track — a real role has one real salary band.`,
      points: 15,
    });
  }
  if (payListed && payVerdict.verdict !== "conflict") {
    reasons.push({
      kind: "green",
      signal: "pay_listed",
      text: "The posting states a pay range — pay transparency is a sign of an honest posting.",
      points: -5,
    });
  }

  // ── Evidence level + insufficiency (used for the reason texts; the return
  //    values come from scoreCore — same formulas, single source of truth) ─────
  const currentlyGone = status === "removed";
  const insufficientData = !hardSignal && !currentlyGone && (checks < 3 || daysListed < 3);

  // ── Reasons: context + green (positive facts, never promises) ──────────────
  reasons.unshift({
    kind: "neutral",
    signal: "observation_window",
    text: `First observed ${formatDate(signals.firstSeenAt)}; listed for at least ${daysListed} day${daysListed === 1 ? "" : "s"}.`,
    points: 0,
  });
  reasons.push({
    kind: "neutral",
    signal: "check_count",
    text: `Watched ${checks} time${checks === 1 ? "" : "s"} so far.`,
    points: 0,
  });

  if (currentlyGone) {
    reasons.push({
      kind: "red",
      signal: "currently_gone",
      text: `Currently gone — this URL returned HTTP ${signals.lastStatusCode ?? "404"} on our last check (${formatDate(signals.lastCheckedAt ?? signals.lastSeenAt)}). It may have been filled, withdrawn, or moved.`,
      points: 0,
    });
  }

  if (hasContentChange) {
    reasons.push({
      kind: "green",
      signal: "content_maintained",
      text: "The posting's title or company has changed since we started watching — it is being maintained, not recycled.",
      points: 0,
    });
  }

  if (points === 0 && !currentlyGone && !insufficientData) {
    if (checks >= 3) {
      reasons.push({
        kind: "green",
        signal: "no_churn",
        text: `No take-downs or reposts observed in ${daysListed} days of watching.`,
        points: 0,
      });
    }
    if (daysListed <= 30) {
      reasons.push({
        kind: "green",
        signal: "fresh_posting",
        text: `Fresh posting — first observed ${daysListed === 0 ? "today" : `${daysListed} day${daysListed === 1 ? "" : "s"} ago`}.`,
        points: 0,
      });
    }
  }

  if (signals.postedAt) {
    reasons.push({
      kind: "neutral",
      signal: "declared_posted_date",
      text: `The posting itself declares a posted date of ${formatDate(signals.postedAt)}.`,
      points: 0,
    });
  }

  if (dataQuality.title === "missing") {
    reasons.push({
      kind: "neutral",
      signal: "missing_metadata",
      text: "We could not read a job title from the page — our extraction is limited to what the page actually exposes.",
      points: 0,
    });
  }

  // ── Final score, label, verdict (from scoreCore — the single rubric source) ──
  const { score, ghostEvidencePoints, label, verdict, insufficientData: coreInsufficient, evidence: coreEvidence, components } = core;

  const company = await companySignal(store, signals.company);

  return {
    postingId,
    canonicalUrl: signals.canonicalUrl,
    score,
    ghostEvidencePoints,
    label,
    verdict,
    insufficientData: coreInsufficient,
    evidence: coreEvidence,
    reasons,
    components,
    company,
    title: signals.title,
    companyName: signals.company,
    location: signals.location,
    daysListed,
    status: signals.status,
    postedAt: signals.postedAt,
    firstSeenAt: signals.firstSeenAt,
  };
}

/** Convenience: look up a record by id, score it. Returns null if untracked. */
export async function scoreById(store: Store, postingId: string): Promise<PostingScore | null> {
  const record = await store.getByPostingId(postingId);
  if (!record) return null;
  return scorePosting(store, await buildSignals(store, record));
}

/** Convenience: score every tracked posting (used by `bun run score`). */
export async function scoreAll(store: Store): Promise<PostingScore[]> {
  const records = await store.getAll();
  return Promise.all(records.map(async (r) => scorePosting(store, await buildSignals(store, r))));
}

/** Human-readable summary of the rubric (for the CLI/UI footer). */
export const RUBRIC_SUMMARY: { name: string; points: string }[] = [
  { name: "Relist cycles observed", points: "−25 to −50" },
  { name: "Listed 90+ days with no observed change", points: "−15 to −30" },
  { name: "Same role on 2+ boards", points: "−10 to −20" },
  { name: "Same role at 2+ URLs", points: "−10 to −20 (spread+URLs capped at −30)" },
  { name: "Pay differs across listings of the same role", points: "−15" },
  { name: "Pay listed on this posting (no conflict)", points: "+5 back (offsets red flags)" },
  { name: "Insufficient observation (<3 checks or <3 days)", points: "neutral 50 — no read yet" },
];
