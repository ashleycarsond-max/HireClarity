import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { Store } from "../../../engine/store";
import { industriesIndex } from "../../server/public-data";
import { SiteFooter, SiteHeader } from "../../components/SiteChrome";

const SITE_URL = "https://hireclarity-data.vercel.app";

const TITLE = "Industries: Job Posting Data by Industry | HireClarity Data";
const DESCRIPTION =
  "Observed job-posting data grouped by industry from the companies HireClarity Data tracks — our curated classification, labeled as ours, not a standard taxonomy.";

const loadData = createServerFn({ method: "POST" }).handler(async () => {
  const store = new Store();
  try {
    return await industriesIndex(store);
  } catch {
    return { industries: [], totalPostings: 0 };
  } finally {
    store.close();
  }
});

export const Route = createFileRoute("/industries/")({
  loader: async () => {
    try {
      return await loadData();
    } catch {
      return { industries: [], totalPostings: 0 };
    }
  },
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "HireClarity Data" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:url", content: `${SITE_URL}/industries` },
      { property: "og:image", content: `${SITE_URL}/og-image.png` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/og-image.png` },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/industries` }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          "@id": `${SITE_URL}/industries`,
          url: `${SITE_URL}/industries`,
          name: TITLE,
          description: DESCRIPTION,
          isPartOf: { "@id": `${SITE_URL}/#website` },
        })
          .replace(/</g, "\u003c")
          .replace(/</g, "\u003c"),
      },
    ],
  }),
  component: IndustriesIndexPage,
});

function IndustriesIndexPage() {
  const { industries, totalPostings } = Route.useLoaderData();

  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Industries</h1>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-600">
          Observed job-posting data grouped by industry — {industries.length} industries, {totalPostings.toLocaleString()}{" "}
          tracked postings. <strong>Our curated classification, not a standard taxonomy:</strong> each company gets one
          primary-industry label chosen by us, so treat these as a useful grouping rather than an official standard.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {industries.map((i) => (
            <a
              key={i.slug}
              href={`/industries/${i.slug}`}
              className="block rounded-xl border border-slate-200 bg-white p-6 transition-colors hover:border-indigo-300 hover:shadow-sm"
            >
              <h2 className="text-lg font-bold text-slate-900">{i.name}</h2>
              <p className="mt-2 text-sm text-slate-500">
                {i.companies} {i.companies === 1 ? "company" : "companies"} · {i.postings.toLocaleString()} tracked
                postings
              </p>
              <p className="mt-3 text-sm font-semibold text-indigo-600">View companies →</p>
            </a>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
