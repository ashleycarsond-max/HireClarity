/**
 * BOARD API CLIENTS — the discovery layer of the tracking engine.
 *
 * One client per ATS board, all PUBLIC APIs with NO auth (no tokens, no keys):
 *
 *   Greenhouse: GET https://boards-api.greenhouse.io/v1/boards/{boardToken}/jobs
 *               → { jobs: [{ id, title, location:{name}, updated_at,
 *                            absolute_url, first_published, company_name, ... }] }
 *               Board token = the board subdomain, e.g. "greenhouse" for
 *               job-boards.greenhouse.io/greenhouse.
 *   Ashby:      GET https://api.ashbyhq.com/posting-api/job-board/{org}
 *               → { jobs: [{ id, title, location, jobUrl, publishedAt,
 *                            isListed, ... }] }
 *   Lever:      GET https://api.lever.co/v0/postings/{company}?mode=json
 *               → [ { id, text, hostedUrl, createdAt, categories:{location}, ... } ]
 *   Workable:   GET https://apply.workable.com/api/v1/widget/accounts/{subdomain}/jobs
 *               → { jobs: [{ title, location:{city,country}, url, published_on,
 *                            shortcode, ... }] }
 *
 * Every client normalizes jobs into the shared {@link BoardJob} shape and runs
 * the engine's politeness layer (robots.txt check + throttle) before fetching,
 * exactly like the existing fetch.ts/robots.ts pipeline. Failures are returned
 * as a structured {@link BoardFetchResult} — never thrown — so one broken board
 * can never take down a whole sync.
 *
 * HONESTY NOTE (verified live 2026-08-14): the Workable widget API sits behind
 * a bot challenge (HTTP 429 "Security challenge" — DataDome-style, even on
 * /robots.txt) for automated plain-HTTP access. The client is implemented per
 * the documented API and returns structured errors, but NO Workable account can
 * currently be verified/seeded, and syncs will report the 429 honestly until
 * that changes. This mirrors the LinkedIn/Indeed situation: we only track what
 * boards let us read.
 */

import { politeFetch } from "./fetch";
import { checkAllowed, hostOf, throttle } from "./robots";
import { derivePostingId, normalizeUrl } from "./urls";

export type BoardKind = "greenhouse" | "ashby" | "lever" | "workable";

export const BOARD_KINDS: BoardKind[] = ["greenhouse", "ashby", "lever", "workable"];

/** One job as normalized by a board client — the common ingest shape. */
export interface BoardJob {
  board: BoardKind;
  /** Board-native id (Greenhouse numeric id, Ashby/Lever uuid, Workable shortcode). */
  externalId: string;
  title: string | null;
  location: string | null;
  /** ISO timestamp the posting itself declares, or null when absent. */
  postedAt: string | null;
  /** Canonical posting URL (normalized via urls.ts). */
  url: string;
  /** Stable identity anchor derived from the canonical URL (urls.ts). */
  postingId: string;
  /** Original board record — kept for traceability/debugging. */
  raw: unknown;
}

/** Result of one board list fetch — structured, never thrown. */
export interface BoardFetchResult {
  ok: boolean;
  board: BoardKind;
  boardId: string;
  jobs: BoardJob[];
  statusCode: number | null;
  /** Human-readable note: error reason, robots block, or success context. */
  note: string | null;
}

/** Board list APIs can exceed the 2 MB page cap (Notion's Ashby payload ~2 MB+). */
const BOARD_MAX_BYTES = 32 * 1024 * 1024;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Accept an ISO string, or an epoch-millis number (Lever's createdAt). */
function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Normalize a YYYY-MM-DD (Workable published_on) to a full ISO instant. */
function dateOnlyToIso(s: string | null): string | null {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  return s;
}

function locName(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object") return str((v as Record<string, unknown>)["name"]);
  return null;
}

/** Wrap a BoardJob with the derived URL + postingId; null when the URL is unusable. */
function finalizeJob(board: BoardKind, externalId: string, title: string | null, location: string | null, postedAt: string | null, url: string | null, raw: unknown): BoardJob | null {
  const norm = url ? normalizeUrl(url) : null;
  if (!norm) return null; // no URL → nothing honest to track
  return { board, externalId, title, location, postedAt, url: norm, postingId: derivePostingId(norm), raw };
}

async function fetchBoardList(board: BoardKind, boardId: string, url: string, parse: (body: string) => BoardJob[]): Promise<BoardFetchResult> {
  const base = { board, boardId, jobs: [] as BoardJob[], statusCode: null as number | null };
  const { allowed, note: robotsNote, crawlDelay } = await checkAllowed(url);
  if (!allowed) {
    return { ...base, ok: false, note: `blocked by robots.txt (${url})` };
  }
  await throttle(hostOf(url), crawlDelay);
  const res = await politeFetch(url, { maxBytes: BOARD_MAX_BYTES });
  if (!res.ok) {
    return { ...base, statusCode: res.status, ok: false, note: res.note ?? (res.status ? `HTTP ${res.status}` : "fetch error") };
  }
  try {
    const jobs = parse(res.body ?? "");
    const note = robotsNote ? `HTTP ${res.status} (robots: ${robotsNote})` : `HTTP ${res.status}`;
    return { ...base, statusCode: res.status, ok: true, jobs, note };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, statusCode: res.status, ok: false, note: `could not parse ${board} response: ${msg}` };
  }
}

// ── Greenhouse ────────────────────────────────────────────────────────────────
export function fetchGreenhouseBoard(boardToken: string): Promise<BoardFetchResult> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs`;
  return fetchBoardList("greenhouse", boardToken, url, (body) => {
    const data = JSON.parse(body) as { jobs?: unknown[] };
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return jobs
      .map((j) => {
        const o = j as Record<string, unknown>;
        return finalizeJob(
          "greenhouse",
          String(o.id ?? ""),
          str(o.title),
          locName(o.location),
          toIso(str(o.first_published) ?? str(o.updated_at)),
          str(o.absolute_url),
          j
        );
      })
      .filter((x): x is BoardJob => x !== null);
  });
}

// ── Ashby ─────────────────────────────────────────────────────────────────────
export function fetchAshbyBoard(org: string): Promise<BoardFetchResult> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`;
  return fetchBoardList("ashby", org, url, (body) => {
    const data = JSON.parse(body) as { jobs?: unknown[] };
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return jobs
      .filter((j) => (j as Record<string, unknown>)["isListed"] !== false) // only publicly listed roles
      .map((j) => {
        const o = j as Record<string, unknown>;
        return finalizeJob("ashby", str(o.id) ?? "", str(o.title), locName(o.location), toIso(o.publishedAt), str(o.jobUrl), j);
      })
      .filter((x): x is BoardJob => x !== null);
  });
}

// ── Lever ─────────────────────────────────────────────────────────────────────
export function fetchLeverBoard(company: string): Promise<BoardFetchResult> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
  return fetchBoardList("lever", company, url, (body) => {
    const data = JSON.parse(body) as unknown[];
    if (!Array.isArray(data)) throw new Error("expected a JSON array");
    return data
      .map((j) => {
        const o = j as Record<string, unknown>;
        const cats = (o["categories"] ?? {}) as Record<string, unknown>;
        return finalizeJob("lever", str(o.id) ?? "", str(o.text) ?? str(o.title), str(cats["location"]), toIso(o.createdAt), str(o.hostedUrl), j);
      })
      .filter((x): x is BoardJob => x !== null);
  });
}

// ── Workable ──────────────────────────────────────────────────────────────────
export function fetchWorkableBoard(subdomain: string): Promise<BoardFetchResult> {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(subdomain)}/jobs`;
  return fetchBoardList("workable", subdomain, url, (body) => {
    const data = JSON.parse(body) as { jobs?: unknown[] };
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return jobs
      .map((j) => {
        const o = j as Record<string, unknown>;
        const loc = (o["location"] ?? {}) as Record<string, unknown>;
        const city = str(loc["city"]);
        const country = str(loc["country"]);
        const location = city && country ? `${city}, ${country}` : city ?? country;
        return finalizeJob("workable", str(o.shortcode) ?? str(o.id) ?? "", str(o.title), location, dateOnlyToIso(str(o.published_on)), str(o.url), j);
      })
      .filter((x): x is BoardJob => x !== null);
  });
}

/** Dispatch by board kind. */
export function fetchBoard(board: BoardKind, boardId: string): Promise<BoardFetchResult> {
  switch (board) {
    case "greenhouse":
      return fetchGreenhouseBoard(boardId);
    case "ashby":
      return fetchAshbyBoard(boardId);
    case "lever":
      return fetchLeverBoard(boardId);
    case "workable":
      return fetchWorkableBoard(boardId);
  }
}
