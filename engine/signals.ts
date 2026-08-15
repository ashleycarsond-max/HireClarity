/**
 * Signals output — the raw, explainable inputs for the future ghost-job
 * scoring layer. Every field derives from stored observations (postings,
 * checks, events); nothing is estimated or synthesized.
 */

import type { PayInfo, PostingEvent, PostingRecord, PostingSignals } from "./types";
import { Store } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prefetched lookup tables that let `buildSignals` skip the per-posting store
 * round-trips (identity groups + events + pay rows). The monthly report and
 * the public company pages build one context for the whole store and pass it
 * to every call — same results, ~5 queries instead of N+1 over Neon HTTP. When
 * absent, buildSignals falls back to the store (unchanged behavior for /check,
 * /company, CLI).
 */
export interface SignalContext {
  /** identityKey → every record sharing that key (must include the record itself) */
  identityGroups: Map<string, PostingRecord[]>;
  /** postingId → its transition events (chronological) */
  eventsByPosting: Map<string, PostingEvent[]>;
  /** postingId → its pay row (the pay signal; absent = pay not checked yet) */
  payByPosting: Map<string, PayInfo>;
}

export async function buildSignals(
  store: Store,
  record: PostingRecord,
  ctx?: SignalContext
): Promise<PostingSignals> {
  // Identity group: all records that share the same normalized title+company.
  // If identity fell back to the postingId (no title/company observed), the
  // group is just this record — honest, documented behavior.
  const groupRecords = ctx
    ? ctx.identityGroups.get(record.identityKey) ?? []
    : await store.getByIdentity(record.identityKey);
  const group = groupRecords.length ? groupRecords : [record];

  const boardsSeen = [...new Set(group.map((r) => r.sourceBoard))].sort();
  const urlsSeen = [...new Set(group.map((r) => r.canonicalUrl))].sort();
  const postingIds = [...new Set(group.map((r) => r.postingId))].sort();

  const eventLists = ctx
    ? group.map((r) => ctx.eventsByPosting.get(r.postingId) ?? [])
    : await Promise.all(group.map((r) => store.eventsForPosting(r.postingId)));
  const events: PostingEvent[] = eventLists
    .flat()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // ── Pay signal (owner decision 2026-08-15) ────────────────────────────────
  // `pay` = this posting's row (null = pay not checked yet — never a "not
  // stated" claim). `payGroup` = the pay rows of the same-role comparison
  // group: the identity group, narrowed to listings sharing this posting's
  // location when both declare one (same title at two offices legitimately
  // pays differently — that must not read as a pay conflict).
  const payRows = ctx
    ? postingIds.map((id) => ctx.payByPosting.get(id)).filter((p): p is PayInfo => Boolean(p))
    : await store.getPaysForPostingIds(postingIds);
  const myLocation = record.location ? record.location.trim().toLowerCase() : null;
  const payGroupRecords = myLocation
    ? group.filter((g) => {
        const gl = g.location ? g.location.trim().toLowerCase() : null;
        return !gl || gl === myLocation; // missing location can't be ruled out
      })
    : group;
  const payGroup = payRows.filter((p) => payGroupRecords.some((g) => g.postingId === p.postingId));
  const pay = payRows.find((p) => p.postingId === record.postingId) ?? null;

  // daysListed: whole days from the identity's first observation to now when
  // anything in the group is live/relisted, else to the group's last removal.
  const firstSeen = new Date(Math.min(...group.map((r) => new Date(r.firstSeenAt).getTime())));
  const anythingLive = group.some((r) => r.status === "live" || r.status === "relisted");
  const lastSeen = new Date(Math.max(...group.map((r) => new Date(r.lastSeenAt).getTime())));
  const end = anythingLive ? new Date() : lastSeen;
  const daysListed = Math.max(0, Math.floor((end.getTime() - firstSeen.getTime()) / DAY_MS));

  // statusHistory derived from the event stream (chronological segments).
  const statusHistory: PostingSignals["statusHistory"] = [];
  let current: { status: PostingSignals["statusHistory"][number]["status"]; from: string } | null = null;
  for (const e of events) {
    let next: PostingSignals["statusHistory"][number]["status"] | null = null;
    if (e.type === "first_seen") next = "live";
    else if (e.type === "removed") next = "removed";
    else if (e.type === "relisted") next = "relisted";
    else continue;
    if (current && current.status !== next) {
      statusHistory.push({ status: current.status, from: current.from, to: e.at });
    }
    current = { status: next, from: e.at };
  }
  if (current) statusHistory.push({ status: current.status, from: current.from, to: null });

  return {
    postingId: record.postingId,
    canonicalUrl: record.canonicalUrl,
    requestedUrl: record.requestedUrl,
    title: record.title,
    company: record.company,
    location: record.location,
    postedAt: record.postedAt,
    sourceBoard: record.sourceBoard,
    status: record.status,
    relistCount: record.relistCount,
    daysListed,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    lastCheckedAt: record.lastCheckedAt || null,
    lastStatusCode: record.lastStatusCode,
    lastNote: record.lastNote,
    boardsSeen,
    urlsSeen,
    distinctPostingsInIdentity: postingIds.length,
    events,
    statusHistory,
    pay,
    payGroup,
    dataQuality: {
      title: record.title ? "observed" : "missing",
      location: record.location ? "observed" : "missing",
      postedAt: record.postedAt ? "observed" : "missing",
      identityFromContent: record.identityKey !== record.postingId,
    },
  };
}

export async function signalsForAll(store: Store): Promise<PostingSignals[]> {
  const records = await store.getAll();
  return Promise.all(records.map((r) => buildSignals(store, r)));
}
