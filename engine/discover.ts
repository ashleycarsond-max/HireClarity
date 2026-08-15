/**
 * DISCOVERY — verify candidate companies against their live ATS board APIs and
 * produce the VERIFIED registry the sync loop seeds from.
 *
 *   bun run discover [--limit N] [--all]
 *
 * Flow:
 *   1. Candidates come from engine/candidates.ts (built-in fallback) plus
 *      /home/team/shared/ats-candidates.md when present (lines: `Name|board|id`
 *      or `Name,board,id`, `#` comments allowed). Deduped by (board, boardId).
 *   2. Every candidate is verified LIVE through the SAME politeness layer as
 *      the sync loop (robots.txt check + per-host throttle, boards.ts
 *      fetchBoard — no bypass, no hammering). Workable is excluded (no real
 *      account in the candidate lists; the API 404s for unknown subdomains —
 *      see boards.ts, re-verified 2026-08-15).
 *   3. Each result is classified HONESTLY:
 *        verified       — HTTP 200 + at least one job
 *        empty          — HTTP 200 + zero jobs
 *        http-404/429/5xx/other — non-200 status
 *        robots-blocked — robots.txt forbids the fetch
 *        parse-error    — 200 but the body did not parse as a job list
 *        fetch-error    — network/timeout/redirect failure
 *   4. State persists in engine/data/discovery-state.json, so re-runs skip
 *      already-verified candidates (pass --all to re-check everything, or
 *      --limit N to cap fetches per run — unverified candidates continue on
 *      the next run).
 *   5. Outputs:
 *        engine/verified-companies.ts — VERIFIED_COMPANIES: MonitoredCompany[]
 *          (multi-board companies merged by normalized name; verifiedAt date).
 *        engine/data/discovery-report-<ts>.txt — per-candidate hits/failures
 *          by reason, plus a summary. Never checked into a live path.
 *
 * HONESTY RULE: only verified-live companies are ever emitted to
 * verified-companies.ts / seeded. Everything else is REPORTED, not seeded.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchBoard } from "./boards";
import { FALLBACK_CANDIDATES, candidateKey, type DiscoveryCandidate } from "./candidates";
import type { MonitoredCompany } from "./companies";
import { isoNow } from "./store";

export type DiscoveryReason =
  | "verified"
  | "empty"
  | "http-404"
  | "http-429"
  | "http-5xx"
  | "http-other"
  | "robots-blocked"
  | "parse-error"
  | "fetch-error";

export interface DiscoveryState {
  reason: DiscoveryReason;
  jobs: number;
  statusCode: number | null;
  note: string | null;
  at: string;
}

export interface DiscoveryOutcome extends DiscoveryState {
  candidate: DiscoveryCandidate;
}

const HERE = new URL(".", import.meta.url).pathname;
const DATA_DIR = `${HERE}data`;
const STATE_FILE = `${DATA_DIR}/discovery-state.json`;
const VERIFIED_FILE = `${HERE}verified-companies.ts`;
const SHARED_CANDIDATES_FILE = "/home/team/shared/ats-candidates.md";

/**
 * Classify one board-list fetch into the honest 9-way reason set. Exported
 * for the scheduled discovery pass (engine/discovery-sync.ts) so the daily
 * cron and the offline bootstrap tool share ONE classification — no
 * duplication, identical honesty rules. `parseOk` mirrors what the fetch
 * note implies ("could not parse ..."), but callers pass it explicitly so
 * the mock-board test path stays faithful.
 */
export function classify(status: number | null, note: string | null, ok: boolean, jobs: number, parseOk: boolean): DiscoveryReason {
  if (!ok) {
    if (note?.startsWith("blocked by robots.txt")) return "robots-blocked";
    if (note?.startsWith("could not parse")) return "parse-error";
    if (status === 404) return "http-404";
    if (status === 429) return "http-429";
    if (status !== null && status >= 500) return "http-5xx";
    return "fetch-error";
  }
  if (!parseOk) return "parse-error";
  return jobs > 0 ? "verified" : "empty";
}

/** Load /home/team/shared/ats-candidates.md when present (simple pipe/CSV format). */
function loadSharedCandidates(): DiscoveryCandidate[] {
  if (!existsSync(SHARED_CANDIDATES_FILE)) return [];
  const out: DiscoveryCandidate[] = [];
  for (const raw of readFileSync(SHARED_CANDIDATES_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[|,]/).map((p) => p.trim());
    if (parts.length < 3) continue;
    const [name, board, boardId] = parts;
    const b = board.toLowerCase();
    if (b !== "greenhouse" && b !== "ashby" && b !== "lever") continue;
    out.push({ name, board: b, boardId, careerUrl: parts[3] || undefined });
  }
  return out;
}

/** Dedupe candidates by (board, boardId); name collisions on the same board keep the first. */
function mergeCandidates(shared: DiscoveryCandidate[], fallback: DiscoveryCandidate[]): DiscoveryCandidate[] {
  const byKey = new Map<string, DiscoveryCandidate>();
  for (const c of [...shared, ...fallback]) {
    const key = candidateKey(c);
    if (!byKey.has(key)) byKey.set(key, c);
  }
  return [...byKey.values()];
}

/** Turn verified state entries into MonitoredCompany[] (multi-board merged). */
export function verifiedCompaniesFromState(state: Record<string, DiscoveryState>, candidates: DiscoveryCandidate[], verifiedAt: string): MonitoredCompany[] {
  const byName = new Map<string, MonitoredCompany>();
  const norm = (n: string) => n.trim().toLowerCase();
  for (const c of candidates) {
    const st = state[candidateKey(c)];
    if (!st || st.reason !== "verified") continue;
    const key = norm(c.name);
    const existing = byName.get(key);
    if (existing) {
      if (!existing.boards.some((b) => b.board === c.board && b.boardId === c.boardId)) {
        existing.boards.push({ board: c.board, boardId: c.boardId });
      }
    } else {
      byName.set(key, {
        name: c.name,
        boards: [{ board: c.board, boardId: c.boardId }],
        ...(c.careerUrl ? { careerUrl: c.careerUrl } : {}),
        verifiedAt,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function writeVerifiedFile(companies: MonitoredCompany[]): void {
  const body = companies
    .map((c) => {
      const boards = c.boards.map((b) => `    { board: "${b.board}", boardId: ${JSON.stringify(b.boardId)} },`).join("\n");
      const extra = c.careerUrl ? `\n    careerUrl: ${JSON.stringify(c.careerUrl)},` : "";
      return `  {\n    name: ${JSON.stringify(c.name)},${extra}\n    boards: [\n${boards}\n    ],\n    verifiedAt: ${JSON.stringify(c.verifiedAt ?? "2026-08-14")},\n  },`;
    })
    .join("\n");
  const out = `/**
 * VERIFIED COMPANIES — generated by \`bun run discover\` (engine/discover.ts).
 * DO NOT EDIT BY HAND: re-run discovery to regenerate. Only companies that
 * returned HTTP 200 with at least one job are listed here — everything else is
 * reported in engine/data/discovery-report-*.txt and never seeded.
 * Merged into SEED_COMPANIES (engine/companies.ts) by normalized name.
 * Generated ${isoNow()}.
 */
import type { MonitoredCompany } from "./companies";

export const VERIFIED_COMPANIES: MonitoredCompany[] = [
${body}
];
`;
  writeFileSync(VERIFIED_FILE, out);
}

function summaryLine(counts: Record<string, number>): string {
  const order: DiscoveryReason[] = ["verified", "empty", "http-404", "http-429", "http-5xx", "http-other", "robots-blocked", "parse-error", "fetch-error"];
  return order.filter((r) => counts[r] > 0).map((r) => `${r}=${counts[r]}`).join(", ") || "(no results)";
}

export async function runDiscovery(opts: { limit?: number; all?: boolean } = {}): Promise<{
  candidates: number;
  checked: number;
  outcomes: DiscoveryOutcome[];
  verified: MonitoredCompany[];
  reportPath: string;
}> {
  const candidates = mergeCandidates(loadSharedCandidates(), FALLBACK_CANDIDATES);
  let state: Record<string, DiscoveryState> = {};
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      state = {};
    }
  }

  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const outcomes: DiscoveryOutcome[] = [];
  let checked = 0;
  const counts: Record<string, number> = {};

  for (const c of candidates) {
    const key = candidateKey(c);
    const prior = state[key];
    if (!opts.all && prior?.reason === "verified") {
      outcomes.push({ candidate: c, ...prior });
      continue; // already verified — do not re-fetch
    }
    if (checked >= limit) break;
    checked++;

    const fetched = await fetchBoard(c.board, c.boardId);
    const parseOk = !(fetched.note?.startsWith("could not parse"));
    const reason = classify(fetched.statusCode, fetched.note, fetched.ok, fetched.jobs.length, parseOk);
    const st: DiscoveryState = {
      reason,
      jobs: fetched.jobs.length,
      statusCode: fetched.statusCode,
      note: fetched.note,
      at: isoNow(),
    };
    state[key] = st;
    counts[reason] = (counts[reason] ?? 0) + 1;
    outcomes.push({ candidate: c, ...st });
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

  const verifiedAt = new Date().toISOString().slice(0, 10);
  const verified = verifiedCompaniesFromState(state, candidates, verifiedAt);
  writeVerifiedFile(verified);

  // Human-readable report (hits + failures by reason, plus full per-candidate lines).
  const lines: string[] = [];
  lines.push(`DISCOVERY REPORT ${isoNow()}`);
  lines.push(`candidates: ${candidates.length} (shared file: ${loadSharedCandidates().length} merged) | checked this run: ${checked} | limit: ${limit === Infinity ? "unlimited" : String(limit)} | --all: ${opts.all ? "yes" : "no"}`);
  lines.push(`summary: ${summaryLine(counts)}`);
  lines.push(`verified companies emitted: ${verified.length}`);
  lines.push("");
  lines.push("per-candidate results:");
  for (const o of outcomes) {
    lines.push(`  ${o.reason.padEnd(13)} ${o.candidate.board}/${o.candidate.boardId.padEnd(22)} ${o.candidate.name} jobs=${o.jobs} status=${o.statusCode ?? "-"}${o.note ? ` (${o.note})` : ""}`);
  }
  lines.push("");
  lines.push("failures by reason:");
  const fails = outcomes.filter((o) => o.reason !== "verified" && o.reason !== "empty");
  const byReason = new Map<string, DiscoveryOutcome[]>();
  for (const o of fails) {
    const list = byReason.get(o.reason) ?? [];
    list.push(o);
    byReason.set(o.reason, list);
  }
  for (const [reason, list] of [...byReason.entries()].sort()) {
    lines.push(`  ${reason} (${list.length}): ${list.map((o) => `${o.candidate.name} (${o.candidate.board}/${o.candidate.boardId})`).join(", ")}`);
  }
  if (!fails.length) lines.push("  (none)");

  const reportPath = `${DATA_DIR}/discovery-report-${Date.now()}.txt`;
  writeFileSync(reportPath, lines.join("\n") + "\n");

  return { candidates: candidates.length, checked, outcomes, verified, reportPath };
}
