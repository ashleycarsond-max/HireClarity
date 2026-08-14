/**
 * Deterministic URL slugs for the programmatic pages (pure TS — no React).
 *
 * Used by: /companies, /companies/<slug>, /industries, /industries/<slug>,
 * and the sitemap generator. Slugs derive from names only (never the DB), so
 * pages are stable across deploys. Duplicate slugs are impossible for the
 * current registry (asserted at gen time); if one ever appears, the map below
 * resolves deterministically by appending a numeric suffix.
 */
import { SEED_COMPANIES } from "../../engine/companies";
import { COMPANY_INDUSTRIES, FALLBACK_INDUSTRY, industryForCompany } from "../../engine/company-industries";
import type { MonitoredCompany } from "../../engine/companies";

/** "Hims & Hers" → "hims-and-hers"; "10x Genomics" → "10x-genomics". */
export function companySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "Developer Tools/Infrastructure" → "developer-tools-infrastructure". */
export function industrySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Board kind → public label (used on /companies pages). */
export const BOARD_LABELS: Record<string, string> = {
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  workable: "Workable",
};

export function boardLabel(board: string): string {
  return BOARD_LABELS[board] ?? board;
}

interface SlugMapEntry {
  name: string;
  slug: string;
  company: MonitoredCompany;
}

/** Registry company → slug, with deterministic duplicate resolution. */
function buildCompanySlugMap(): Map<string, SlugMapEntry> {
  const bySlug = new Map<string, SlugMapEntry>();
  const used = new Map<string, number>();
  for (const c of SEED_COMPANIES) {
    const base = companySlug(c.name);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    bySlug.set(slug, { name: c.name, slug, company: c });
  }
  return bySlug;
}

const COMPANY_SLUG_MAP: Map<string, SlugMapEntry> = buildCompanySlugMap();

export function slugToCompany(slug: string): MonitoredCompany | null {
  return COMPANY_SLUG_MAP.get(slug)?.company ?? null;
}

export function companySlugFor(name: string): string {
  for (const e of COMPANY_SLUG_MAP.values()) {
    if (e.name.toLowerCase() === name.trim().toLowerCase()) return e.slug;
  }
  return companySlug(name); // fallback for names outside the registry
}

/** Distinct industries that actually contain registry companies, sorted. */
export interface IndustryInfo {
  name: string;
  slug: string;
}

export function registryIndustries(): IndustryInfo[] {
  const byName = new Map<string, IndustryInfo>();
  for (const c of SEED_COMPANIES) {
    const name = industryForCompany(c.name);
    if (!byName.has(name)) byName.set(name, { name, slug: industrySlug(name) });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function industrySlugToName(slug: string): string | null {
  for (const i of registryIndustries()) if (i.slug === slug) return i.name;
  return null;
}

/** Companies in one industry (registry order), with slugs. */
export function companiesInIndustry(industryName: string): MonitoredCompany[] {
  return SEED_COMPANIES.filter((c) => industryForCompany(c.name) === industryName);
}

export { COMPANY_INDUSTRIES, FALLBACK_INDUSTRY, industryForCompany };
