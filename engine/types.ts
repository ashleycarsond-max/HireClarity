/**
 * HireClarity Data posting-tracking engine — shared types.
 *
 * Every value in these records is derived from an actual HTTP observation made
 * by this engine (status code, page content, robots.txt). Fields that could not
 * be observed are null — never fabricated. See README at
 * /home/team/shared/engine-README.md for the full design notes.
 */

export type PostingStatus = "live" | "removed" | "relisted";

/** State transitions recorded for a posting (or an identity, across URLs). */
export type EventType =
  | "first_seen" // first observation of a posting (new record)
  | "still_live" // re-check found it live again (appended at most once per check run)
  | "removed" // a live posting was observed gone (HTTP 404/410/451, or a not-found page)
  | "relisted" // a previously removed posting reappeared (same URL or same identity at a new URL)
  | "content_changed"; // still live, but extracted title/company changed since last check

export interface PostingEvent {
  postingId: string; // postingId of the record the event belongs to
  identityKey: string; // identity group (normalized title|company) the event belongs to
  type: EventType;
  at: string; // ISO timestamp
  detail: string | null;
}

/** One raw HTTP check of a posting URL. Append-only; the traceability layer. */
export interface CheckRecord {
  id: number;
  postingId: string;
  at: string; // ISO timestamp
  observedStatus: PostingStatus | "blocked_by_robots" | "error";
  statusCode: number | null;
  note: string | null;
}

/**
 * One posting's description-requirement extraction (table posting_requirements,
 * one row per postingId). Every boolean is derived ONLY from the posting's own
 * readable description text; a fetch that produced no readable description is
 * recorded honestly (descriptionPresent=false + fetchError), never guessed.
 */
export interface PostingRequirement {
  postingId: string;
  requiresBachelor: boolean;
  requiresMasters: boolean;
  requires5PlusYears: boolean;
  /** true when a readable description was extracted from the fetched page */
  descriptionPresent: boolean;
  /** character length of the extracted visible description text (0 when none) */
  descriptionLen: number;
  /** ISO timestamp of the extraction attempt */
  extractedAt: string;
  /** set when the description could not be read (fetch error, robots block, ...) */
  fetchError: string | null;
}

/** Pay period normalization (as declared on the listing; null = not declared). */
export type PayPeriod = "year" | "month" | "week" | "day" | "hour";

/**
 * Pay-consistency verdict for one posting (owner decision 2026-08-15 — the pay
 * signal). Computed over the same-role group (identity + location):
 *   consistent        — 2+ listings state pay and the bands agree
 *   conflict          — 2+ listings state pay and the bands disagree (ghost tell)
 *   only-one-listing  — exactly 1 listing states pay: nothing to compare
 *   not-stated        — listings were read and none states pay (never a conflict)
 *   not-checked       — no listing has been re-read since pay tracking started
 */
export type PayConsistencyVerdict = "consistent" | "conflict" | "only-one-listing" | "not-stated" | "not-checked";

/**
 * One posting's pay extraction (table posting_pay, one row per postingId).
 * Derived ONLY from data the engine actually read — a structured ATS field or a
 * salary phrase in the listing text. A row with hasPay=false is the honest
 * "we read this listing and it does not state pay" record; a posting with NO
 * row at all means "pay not checked yet" (distinguishable, never guessed).
 */
export interface PayInfo {
  postingId: string;
  /** true when a salary/compensation figure was actually read */
  hasPay: boolean;
  /** low end of the band as observed (major currency units; null when single/unread) */
  payMin: number | null;
  /** high end of the band as observed (null when single/unread) */
  payMax: number | null;
  /** currency as observed ("USD", "$", "EUR", "£", ...; null when not declared) */
  currency: string | null;
  /** pay period as declared; null when the listing doesn't say */
  period: PayPeriod | null;
  /** the raw salary phrase we read (e.g. "$120,000 – $150,000 per year") */
  payText: string | null;
  /** where the pay was read: "structured" (ATS/JSON-LD field) or "description" */
  source: "structured" | "description" | null;
  /** set when the listing data could not be read (honest "not readable") */
  fetchError: string | null;
  /** ISO timestamp of this extraction */
  extractedAt: string;
}

/** A tracked posting. One row per normalized postingId (URL identity anchor). */
export interface PostingRecord {
  postingId: string; // normalized identity anchor derived from the URL (see urls.ts)
  canonicalUrl: string; // final URL after redirects, tracking params stripped
  requestedUrl: string | null; // the URL the user originally asked to track
  title: string | null;
  company: string | null;
  location: string | null;
  postedAt: string | null; // ISO date the posting itself declares (e.g. datePosted)
  sourceBoard: string; // e.g. "greenhouse", "ashby", "web", "fixture"
  identityKey: string; // normalized title + company; fallback = postingId
  fingerprint: string | null; // sha1 of normalized page text (change detection)
  status: PostingStatus;
  relistCount: number;
  firstSeenAt: string; // ISO
  lastSeenAt: string; // ISO — last time the URL was observed in ANY state
  lastCheckedAt: string; // ISO — last successful check
  lastStatusCode: number | null;
  lastNote: string | null;
  createdAt: string; // ISO
}

/** What a single fetch+extract pass extracted from a posting page/API. */
export interface ExtractedPosting {
  title: string | null;
  company: string | null;
  location: string | null;
  postedAt: string | null;
  sourceBoard: string | null; // e.g. "greenhouse" | "ashby" | "lever" | "web"
  canonicalUrl: string | null; // page-declared canonical (e.g. JSON API absolute_url)
  notFound: boolean; // page is a 200 "job not found" shell
  notFoundReason: string | null;
}

/** Result of a polite fetch. */
export interface FetchResult {
  ok: boolean;
  status: number | null; // null when blocked/errored before HTTP
  finalUrl: string | null; // final URL after redirects
  contentType: string | null;
  body: string | null; // text body (decoded), truncated at MAX_BYTES
  truncated: boolean;
  note: string | null; // human-readable note (robots block, redirects, errors)
}

/** Result of observing one URL (used by both `track` and `recheck`). */
export interface ObserveResult {
  ok: boolean;
  postingId: string | null;
  canonicalUrl: string | null;
  transition: "first_seen" | "still_live" | "removed" | "relisted" | "no_change" | "blocked_by_robots" | "error";
  status: PostingStatus | "blocked_by_robots" | "error";
  statusCode: number | null;
  note: string | null;
}

/** What robots.txt says for a URL (audit/debug output). */
export interface RobotsInspection {
  origin: string | null;
  rules: {
    allow: { pattern: RegExp; length: number }[];
    disallow: { pattern: RegExp; length: number }[];
    crawlDelay: number | null;
    note: string | null;
  };
}

/** Signals output — the raw inputs the ghost-job scoring layer consumes. */
export interface PostingSignals {
  postingId: string;
  canonicalUrl: string;
  requestedUrl: string | null;
  title: string | null;
  company: string | null;
  location: string | null;
  postedAt: string | null;
  sourceBoard: string;
  status: PostingStatus;
  relistCount: number;
  /** Whole days between the identity's first observation and (now if live, else last observation). */
  daysListed: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckedAt: string | null;
  lastStatusCode: number | null;
  lastNote: string | null;
  /** Distinct boards this role identity has been observed on (across all URLs sharing the identity). */
  boardsSeen: string[];
  /** Distinct canonical URLs observed for this role identity. */
  urlsSeen: string[];
  /** Number of distinct posting records (URLs) in the identity group. */
  distinctPostingsInIdentity: number;
  /** Transition events for the identity group, chronological. */
  events: PostingEvent[];
  /** Derived status timeline (status segments with from/to timestamps). */
  statusHistory: { status: PostingStatus; from: string; to: string | null }[];
  /**
   * This posting's pay extraction (null = pay not checked yet — never a
   * "not stated" claim, and never a score deduction).
   */
  pay: PayInfo | null;
  /**
   * Pay extractions for every posting in the same-role comparison group
   * (identity group ∩ same location, when this posting declares a location).
   * The pay-consistency verdict is computed over this list.
   */
  payGroup: PayInfo[];
  /** Honesty metadata: which fields were actually observed. */
  dataQuality: {
    title: "observed" | "missing";
    location: "observed" | "missing";
    postedAt: "observed" | "missing";
    identityFromContent: boolean; // false when identity fell back to the URL
  };
}
