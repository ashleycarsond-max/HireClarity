import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { Store } from "../../engine/store";
import { companiesByIndustry, industriesIndex } from "../server/public-data";
import { industrySlugToName } from "../lib/slugs";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

const SITE_URL = "https://hireclarity-data.vercel.app";

interface IndustryDetailData {
  name: string;
  companies: { name: string; slug: string; tracked: number }[];
  postings: number;
}

const loadIndustry = createServerFn({ method: "POST" }).handler(
  async ({ data }: { data: { name: string } }): Promise<IndustryDetailData | null> => {
    const store = new Store();
    try {
      const { industries } = await industriesIndex(store);
      const industry = industries.find((i) => i.name === data.name);
      if (!industry) return null;
      const companies = await companiesByIndustry(store, data.name);
      return { name: data.name, companies, postings: industry.postings };
    } catch {
      return null;
    } finally {
      store.close();
    }
  }
);

export const Route = createFileRoute("/industries/$slug")({
  loader: async ({ params }) => {
    const name = industrySlugToName(params.slug);
    if (!name) throw notFound();
    try {
      return await loadIndustry({ data: { name } });
    } catch {
      return null;
    }
  },
  head: ({ loaderData, params }) => {
    const name = loaderData?.name ?? params.slug;
    const canonical = `${SITE_URL}/industries/${params.slug}`;
    const title = `${name} — Observed Job Posting Data | HireClarity Data`;
    const description = `Companies in ${name} that HireClarity Data tracks, with observed posting counts. Our curated classification, not a standard taxonomy.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { name: "robots", content: loaderData ? "index, follow" : "noindex, follow" },
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "HireClarity Data" },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:url", content: canonical },
        { property: "og:image", content: `${SITE_URL}/og-image.png` },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: description },
        { name: "twitter:image", content: `${SITE_URL}/og-image.png` },
      ],
      links: [{ rel: "canonical", href: canonical }],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "@id": canonical,
            url: canonical,
            name: title,
            description,
            isPartOf: { "@id": `${SITE_URL}/#website` },
          })
            .replace(/</g, "\u003c")
            .replace(/</g, "\u003c"),
        },
      ],
    };
  },
  component: IndustryDetailPage,
});

function IndustryDetailPage() {
  const data = Route.useLoaderData();
  if (!data) {
    return (
      <div className="min-h-screen bg-slate-50">
        <SiteHeader />
        <main className="mx-auto max-w-4xl px-4 py-14 text-center sm:px-6">
          <h1 className="text-2xl font-bold text-slate-900">No tracked companies yet</h1>
          <p className="mt-3 text-slate-600">We haven&apos;t observed postings for this industry yet.</p>
          <a href="/industries" className="mt-6 inline-block font-semibold text-indigo-600 hover:underline">
            ← All industries
          </a>
        </main>
        <SiteFooter />
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
        <nav aria-label="Breadcrumb" className="text-sm">
          <a href="/industries" className="font-semibold text-indigo-600 hover:underline">
            ← All industries
          </a>
        </nav>
        <h1 className="mt-5 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{data.name}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-500">
          {data.companies.length} tracked {data.companies.length === 1 ? "company" : "companies"} ·{" "}
          {data.postings.toLocaleString()} tracked postings. <strong>Our curated classification, not a standard
          taxonomy</strong> — each company gets one primary-industry label chosen by us.
        </p>

        <div className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3 font-semibold">
                  Company
                </th>
                <th scope="col" className="px-5 py-3 font-semibold">
                  Tracked postings
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.companies.map((c) => (
                <tr key={c.slug} className="transition-colors hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <a href={`/companies/${c.slug}`} className="font-semibold text-indigo-600 hover:underline">
                      {c.name}
                    </a>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{c.tracked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-400">
          Observed sample — posting counts are what our tracking actually saw, labeled with our own industry
          classification.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
