/**
 * gen-sitemap.ts — regenerate public/sitemap.xml from the registry + blog content.
 * Run: bun run scripts/gen-sitemap.ts (wired into build-vercel.sh/publish.sh).
 * Keeps every existing URL; adds the new content pages (blog, companies,
 * industries, data) with deterministic slugs.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { SEED_COMPANIES } from "../engine/companies";
import { companySlugFor, registryIndustries } from "../src/lib/slugs";
import { BLOG_POSTS } from "../src/generated/blog-content";

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

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...entries.map(
    (e) =>
      `  <url>\n    <loc>${e.loc}</loc>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority}</priority>\n  </url>`
  ),
  "</urlset>",
  "",
].join("\n");

const out = join(import.meta.dirname, "..", "public", "sitemap.xml");
writeFileSync(out, xml);
console.log(`gen-sitemap: wrote ${out} (${entries.length} URLs)`);
