/**
 * FIRST-LOOK READ — the real evidence observed for a posting we haven't
 * watched long enough to score.
 *
 * When a check returns "insufficient data" (neutral 50), the UI shows this
 * instead of a flat "not enough data": what the fetch actually saw right now
 * (title, live status, board, declared posted date), whether the company is in
 * the monitored registry, and an honest timeline to a confident score.
 *
 * HONESTY RULES (hard): every field derives from the stored observation or the
 * registry — nothing is estimated. A posting age is only reported when the
 * page itself declares a posted date (never guessed); a board label is only
 * claimed for hosts we can actually identify; absent metadata is reported as
 * absent. This layer is ADDITIVE to the scoring rubric — it never changes the
 * neutral-50 / "insufficient data" rule in score.ts.
 */

import type { Store } from "./store";
import type { MonitoredCompany } from "./companies";
import { boardRefFromUrl, buildRegistry } from "./companies";
import type { ObserveResult, PostingRecord } from "./types";

export interface FirstLook {
  /** Posting title read from the page (og:title / <title> / JSON-LD / h1). */
  title: string | null;
  /** e.g. "Greenhouse board" · "company career page" · "not on a board we can monitor". */
  board: string;
  liveNow: boolean;
  liveNote: string;
  /** ISO date the page itself declares (null = not visible on the page). */
  postedAt: string | null;
  /** Whole days between the declared date and now (null = not computable). */
  postedDaysAgo: number | null;
  ageNote: string;
  /** True when the posting's company is in the monitored registry. */
  inRegistry: boolean;
  registryCompany: string | null;
  /** Postings we're already watching for that company (the "N" in "one of N"). */
  registryCount: number;
  /** When we started watching this posting. */
  firstSeenAt: string;
  /** True when this check created the tracking record ("we've just started watching"). */
  isFirstObservation: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const BOARD_LABELS: Record<string, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  workable: "Workable",
};

/** Honest board label for the first-look read (never claims a board we can't verify). */
export function boardLabelFor(canonicalUrl: string): string {
  const ref = boardRefFromUrl(canonicalUrl);
  if (ref) return `${BOARD_LABELS[ref.board] ?? ref.board} board`;
  try {
    const u = new URL(canonicalUrl);
    const host = u.hostname.toLowerCase();
    if (host.startsWith("careers.") || host.startsWith("jobs.") || /careers?/.test(host) || /\/careers?\//.test(u.pathname)) {
      return "company career page";
    }
  } catch {
    // unparseable URL — fall through to the generic label
  }
  return "not on a board we can monitor";
}

/**
 * Assemble the first-look evidence for a posting that just got observed.
 * Uses only the stored record (what the fetch actually extracted) + the
 * registry (seed + derived from tracked postings — the set the sync scrubs).
 */
export async function buildFirstLook(store: Store, record: PostingRecord, observed: ObserveResult): Promise<FirstLook> {
  const canonical = observed.canonicalUrl ?? record.canonicalUrl;
  const liveNow = record.status === "live" || record.status === "relisted";
  const liveNote = liveNow
    ? `Live right now (HTTP ${record.lastStatusCode ?? 200}).`
    : `Currently gone — HTTP ${record.lastStatusCode ?? 404} on our last check.`;

  let postedDaysAgo: number | null = null;
  if (record.postedAt) {
    const t = new Date(record.postedAt).getTime();
    if (Number.isFinite(t)) postedDaysAgo = Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
  }
  const ageNote = !record.postedAt
    ? "The page doesn't show when this was posted — we don't guess."
    : postedDaysAgo === null
      ? "The page shows a posted date, but we couldn't read it as a date."
      : postedDaysAgo <= 1
        ? "The page shows it was posted today."
        : `The page shows it was posted ${postedDaysAgo} day${postedDaysAgo === 1 ? "" : "s"} ago.`;

  const all = await store.getAll();
  const registry = await buildRegistry(store, all);
  const norm = (s: string) => s.trim().toLowerCase();
  const companyKey = record.company ? norm(record.company) : "";
  let registryCompany: MonitoredCompany | null = null;
  if (companyKey) registryCompany = registry.find((c) => norm(c.name) === companyKey) ?? null;
  let registryCount = 0;
  if (registryCompany) {
    const normName = norm(registryCompany.name);
    registryCount = all.filter((r) => {
      if (r.company && norm(r.company) === normName) return true;
      const rf = boardRefFromUrl(r.canonicalUrl ?? "");
      return rf ? registryCompany!.boards.some((b) => b.board === rf.board && b.boardId === rf.boardId) : false;
    }).length;
  }

  return {
    title: record.title,
    board: boardLabelFor(canonical),
    liveNow,
    liveNote,
    postedAt: record.postedAt,
    postedDaysAgo,
    ageNote,
    inRegistry: registryCompany !== null,
    registryCompany: registryCompany?.name ?? null,
    registryCount,
    firstSeenAt: record.firstSeenAt,
    isFirstObservation: observed.transition === "first_seen",
  };
}
