/**
 * Server-only data assembly for the public programmatic pages
 * (/companies, /companies/<slug>, /industries, /industries/<slug>).
 *
 * OWNER DECISIONS 2026-08-14: all published data is free and public — so each
 * posting row on /companies/<slug> now carries its per-posting confidence
 * score + per-signal breakdown, computed with the SAME rubric as /check
 * (scoreCore in engine/score.ts is the single source; scorePosting consumes
 * its components, so the breakdown can never drift from the score).
 *
 * What STAYS PRIVATE (never returned here): company-level posting-health
 * scores, benchmarks, fix recommendations, hiring trends, and quarterly
 * reports — those were the retired Company product in engine/company.ts, which
 * is SHELVED (owner decision 2026-08-14) and must never surface here.
 */
import type { Store } from "../../engine/store";
import { SEED_COMPANIES } from "../../engine/companies";
import { industryForCompany } from "../../engine/company-industries";
import { companySlugFor, industrySlug } from "../lib/slugs";
import type { PostingRecord, PostingEvent } from "../../engine/types";
import type { ScoreComponent, ScoreLabel } from "../../engine/score";
import { scoreCore } from "../../engine/score";
import { buildSignals, type SignalContext } from "../../engine/signals";

export interface PublicCompanyRow {
  name: string;
  slug: string;
  tracked: number; // postings observed for this company (excl. loopback fixtures)
  boards: string[]; // board labels we monitor for this company
}

export interface PublicPostingRow {
  title: string;
  board: string; // label, e.g. "Greenhouse"
  daysListed: number;
  relistCount: number;
  status: string; // "live" | "removed" | "relisted"
  url: string | null; // canonical URL when http(s)
  // ── Per-posting confidence score (owner decision 2026-08-14: public) ──
  // Computed by scoreCore — the same rubric source scorePosting (/check) uses.
  // `null` means scoring genuinely failed for this posting (honest n/a).
  score: number | null;
  label: ScoreLabel | null;
  verdict: string | null;
  insufficientData: boolean;
  components: ScoreComponent[];
}

export interface PublicCompanyDetail {
  name: string;
  slug: string;
  careerUrl: string | null;
  boards: string[];
  tracked: number;
  live: number;
  postings: PublicPostingRow[];
}

export interface PublicIndustryRow {
  name: string;
  slug: string;
  companies: number;
  postings: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function daysListed(r: PostingRecord, now: number): number {
  const endIso = r.status === "live" || r.status === "relisted" ? new Date(now).toISOString() : r.lastSeenAt;
  return Math.max(0, Math.floor((Date.parse(endIso) - Date.parse(r.firstSeenAt)) / 86400000));
}

function registryBoardsFor(name: string): string[] {
  const match = SEED_COMPANIES.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
  if (match) return match.boards.map((b) => b.board);
  return [];
}

const BOARD_LABELS: Record<string, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  workable: "Workable",
};

export function boardLabel(board: string): string {
  return BOARD_LABELS[board] ?? board;
}

/** /companies index — one row per company with observed postings. */
export async function companiesIndex(store: Store): Promise<{ companies: PublicCompanyRow[]; totalPostings: number }> {
  const all = await store.getAll();
  const byCompany = new Map<string, PostingRecord[]>();
  for (const r of all) {
    if (!r.company || isLoopbackUrl(r.canonicalUrl)) continue;
    const key = r.company.toLowerCase();
    const arr = byCompany.get(key);
    if (arr) arr.push(r);
    else byCompany.set(key, [r]);
  }
  const companies: PublicCompanyRow[] = [...byCompany.entries()]
    .map(([key, rows]) => {
      const name = rows[0].company ?? key;
      const boards = registryBoardsFor(name);
      return {
        name,
        slug: companySlugFor(name),
        tracked: rows.length,
        boards,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const totalPostings = companies.reduce((n, c) => n + c.tracked, 0);
  return { companies, totalPostings };
}

/** /companies/<slug> — observed facts + per-posting confidence scores, or null. */
export async function companyDetail(store: Store, name: string): Promise<PublicCompanyDetail | null> {
  const allRows = await store.getAll();
  const all = allRows.filter(
    (r) => r.company && r.company.toLowerCase() === name.toLowerCase() && !isLoopbackUrl(r.canonicalUrl)
  );
  if (all.length === 0) return null;
  const now = Date.now();
  const registry = SEED_COMPANIES.find((c) => c.name.toLowerCase() === name.toLowerCase());
  // ── Batched scoring context (same pattern as the monthly report) ─────────
  // buildSignals normally queries identity groups + events per posting; we
  // prefetch once over the whole store so the page needs ~3 queries total
  // instead of N+1, while producing EXACTLY the same signals scorePosting
  // (/check) would use for each posting.
  const identityGroups = new Map<string, PostingRecord[]>();
  for (const r of allRows) {
    const key = r.identityKey || r.postingId;
    const list = identityGroups.get(key) ?? [];
    list.push(r);
    identityGroups.set(key, list);
  }
  const eventsByPosting = new Map<string, PostingEvent[]>();
  for (const e of await store.allEvents()) {
    const list = eventsByPosting.get(e.postingId) ?? [];
    list.push(e);
    eventsByPosting.set(e.postingId, list);
  }
  const ctx: SignalContext = { identityGroups, eventsByPosting };
  const checkCounts = new Map((await store.checksByPosting()).map((c) => [c.postingId, c.count]));
  const postings: PublicPostingRow[] = (
    await Promise.all(
      all.map(async (r) => {
        const base = {
          title: r.title ?? "Untitled posting",
          board: boardLabel(r.sourceBoard),
          daysListed: daysListed(r, now),
          relistCount: r.relistCount,
          status: r.status,
          url: /^https?:\/\//i.test(r.canonicalUrl) ? r.canonicalUrl : null,
        };
        try {
          // scoreCore is the single rubric source: scorePosting (/check)
          // consumes the same components, so the public number and breakdown
          // can never drift from the paid tool's math.
          const signals = await buildSignals(store, r, ctx);
          const core = scoreCore(signals, checkCounts.get(r.postingId) ?? 0);
          return {
            ...base,
            score: core.score,
            label: core.label,
            verdict: core.verdict,
            insufficientData: core.insufficientData,
            components: core.components,
          };
        } catch (err) {
          // Honest n/a — scoring failed for this posting; never fabricate a number.
          console.warn(`[public-data] scoring failed for ${r.postingId}:`, err);
          return { ...base, score: null, label: null, verdict: null, insufficientData: true, components: [] };
        }
      })
    )
  ).sort((a, b) => {
    // live first, then by days listed descending
    const la = a.status === "live" || a.status === "relisted" ? 1 : 0;
    const lb = b.status === "live" || b.status === "relisted" ? 1 : 0;
    if (la !== lb) return lb - la;
    return b.daysListed - a.daysListed;
  });
  const live = all.filter((r) => r.status === "live" || r.status === "relisted").length;
  return {
    name: all[0].company ?? name,
    slug: companySlugFor(name),
    careerUrl: registry?.careerUrl ?? null,
    boards: registryBoardsFor(name),
    tracked: all.length,
    live,
    postings,
  };
}

/** /industries + /industries/<slug> — curated classification, labeled as ours. */
export async function industriesIndex(
  store: Store
): Promise<{ industries: PublicIndustryRow[]; totalPostings: number }> {
  const { companies } = await companiesIndex(store);
  const byIndustry = new Map<string, PublicIndustryRow>();
  for (const c of companies) {
    const name = industryForCompany(c.name);
    const existing = byIndustry.get(name);
    if (existing) {
      existing.companies += 1;
      existing.postings += c.tracked;
    } else {
      byIndustry.set(name, { name, slug: industrySlug(name), companies: 1, postings: c.tracked });
    }
  }
  const industries = [...byIndustry.values()].sort((a, b) => b.postings - a.postings);
  const totalPostings = industries.reduce((n, i) => n + i.postings, 0);
  return { industries, totalPostings };
}

/** /industries/<slug> — the companies in one industry, with observed counts. */
export async function companiesByIndustry(
  store: Store,
  industryName: string
): Promise<{ name: string; slug: string; tracked: number }[]> {
  const { companies } = await companiesIndex(store);
  return companies
    .filter((c) => industryForCompany(c.name) === industryName)
    .map((c) => ({ name: c.name, slug: c.slug, tracked: c.tracked }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
