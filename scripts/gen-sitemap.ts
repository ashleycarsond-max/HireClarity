/**
 * gen-sitemap.ts — regenerate public/sitemap.xml from the registry + blog content.
 * Run: bun run scripts/gen-sitemap.ts (wired into build-vercel.sh/publish.sh).
 * Keeps every existing URL; adds the new content pages (blog, companies,
 * industries, data) with deterministic slugs.
 *
 * ARCHIVE URLs (owner direction 2026-08-15): every archived report period gets
 * a permanent public page — daily /reports/YYYY-MM-DD, weekly /reports/YYYY-Www,
 * monthly /reports/YYYY-MM, yearly /reports/YYYY. When DATABASE_URL is
 * available (the build runs in the sandbox with it set) the generator reads the
 * live archive tables and lists every existing archive URL; without the DB it
 * falls back to the static set (never fails the build).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { SEED_COMPANIES } from "../engine/companies";
import { companySlugFor, registryIndustries } from "../src/lib/slugs";
import { BLOG_POSTS } from "../src/generated/blog-content";
import { Store } from "../engine/store";

const ORIGIN = "https://hireclarity-data.vercel.app";

interface UrlEntry {
  loc: string;
  changefreq: string;
  priority: string;
}

const entries: UrlEntry[] = [
  { loc: `${ORIGIN}/`, changefreq: "weekly", priority: "1.0" },
  { loc: `${ORIGIN}/check`, changefreq: "weekly", priority: "0.9" },
  { loc: `${ORIGIN}/reports`, changefreq: "monthly", priority: "0.8" },
  { loc: `${ORIGIN}/reports/2026-08`, changefreq: "daily", priority: "0.7" },
  { loc: `${ORIGIN}/data`, changefreq: "weekly", priority: "0.8" },
  { loc: `${ORIGIN}/blog`, changefreq: "weekly", priority: "0.8" },
  { loc: `${ORIGIN}/companies`, changefreq: "weekly", priority: "0.7" },
  { loc: `${ORIGIN}/industries`, changefreq: "weekly", priority: "0.6" },
];

for (const p of BLOG_POSTS) {
  entries.push({ loc: `${ORIGIN}/blog/${p.slug}`, changefreq: "monthly", priority: "0.7" });
}
for (const c of SEED_COMPANIES) {
  entries.push({
    loc: `${ORIGIN}/companies/${companySlugFor(c.name)}`,
    changefreq: "weekly",
    priority: "0.6",
  });
}
for (const i of registryIndustries()) {
  entries.push({ loc: `${ORIGIN}/industries/${i.slug}`, changefreq: "weekly", priority: "0.5" });
}

// Permanent archive pages (owner direction 2026-08-15): every stored daily
// snapshot (day), weekly rollup, and yearly rollup gets its own URL. Archives
// never change once written, so changefreq is monthly; the reports index is the
// discovery hub. Monthly archive URLs are the published reports (the static
// /reports/2026-08 entry above; future months are added by the published-report
// path below when the DB is available).
async function addArchiveUrls(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log("gen-sitemap: DATABASE_URL unset — archive URLs not enumerated (static set only)");
    return;
  }
  const store = new Store();
  try {
    const days = await store.listDailySnapshots();
    for (const r of days) {
      entries.push({ loc: `${ORIGIN}/reports/${r.date}`, changefreq: "monthly", priority: "0.5" });
    }
    const weeks = await store.listRollups("week");
    for (const r of weeks) {
      entries.push({ loc: `${ORIGIN}/reports/${r.period}`, changefreq: "monthly", priority: "0.5" });
    }
    const years = await store.listRollups("year");
    for (const r of years) {
      entries.push({ loc: `${ORIGIN}/reports/${r.period}`, changefreq: "monthly", priority: "0.5" });
    }
    const months = await store.listReportSnapshots();
    for (const r of months) {
      entries.push({ loc: `${ORIGIN}/reports/${r.period}`, changefreq: "monthly", priority: "0.7" });
    }
    console.log(`gen-sitemap: added ${days.length} daily + ${weeks.length} weekly + ${years.length} yearly + ${months.length} monthly archive URLs`);
  } catch (err) {
    console.log(`gen-sitemap: archive enumeration skipped (${err instanceof Error ? err.message : String(err)}) — static set only`);
  } finally {
    store.close();
  }
}

await addArchiveUrls();

// Dedupe by loc (the static /reports/2026-08 entry and the DB-backed monthly
// list can overlap) — sitemaps tolerate duplicates but clean output is better.
const seen = new Set<string>();
const unique: UrlEntry[] = [];
for (const e of entries) {
  if (seen.has(e.loc)) continue;
  seen.add(e.loc);
  unique.push(e);
}

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...unique.map(
    (e) =>
      `  <url>\n    <loc>${e.loc}</loc>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`
  ),
  "</urlset>",
  "",
].join("\n");

const out = join(import.meta.dirname, "..", "public", "sitemap.xml");
writeFileSync(out, xml);
console.log(`gen-sitemap: wrote ${out} (${unique.length} URLs)`);
