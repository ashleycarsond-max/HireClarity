import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { Store } from "../../../engine/store";
import { companiesIndex, boardLabel } from "../../server/public-data";
import { SiteFooter, SiteHeader } from "../../components/SiteChrome";

const SITE_URL = "https://hireclarity-data.vercel.app";

const TITLE = "Tracked Companies: Observed Job Postings | HireClarity Data";
const DESCRIPTION =
  "The companies HireClarity Data actively monitors — observed postings on Greenhouse, Ashby, Lever and Workable boards, labeled as our observed sample. Every tracked company's confidence scores and posting histories are public and free.";

const loadData = createServerFn({ method: "POST" }).handler(async () => {
  const store = new Store();
  try {
    return await companiesIndex(store);
  } catch {
    return { companies: [], totalPostings: 0 };
  } finally {
    store.close();
  }
});

export const Route = createFileRoute("/companies/")({
  loader: async () => {
    try {
      return await loadData();
    } catch {
      return { companies: [], totalPostings: 0 };
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
      { property: "og:url", content: `${SITE_URL}/companies` },
      { property: "og:image", content: `${SITE_URL}/og-image.png` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/og-image.png` },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/companies` }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "CollectionPage",
              "@id": `${SITE_URL}/companies`,
              url: `${SITE_URL}/companies`,
              name: TITLE,
              description: DESCRIPTION,
              isPartOf: { "@id": `${SITE_URL}/#website` },
              about: "job postings",
            },
            {
              "@type": "WebPage",
              "@id": `${SITE_URL}/companies#webpage`,
              url: `${SITE_URL}/companies`,
              name: TITLE,
              description: DESCRIPTION,
              isPartOf: { "@id": `${SITE_URL}/#website` },
            },
          ],
        })
          .replace(/</g, "\u003c")
          .replace(/</g, "\u003c"),
      },
    ],
  }),
  component: CompaniesIndexPage,
});

function CompaniesIndexPage() {
  const { companies, totalPostings } = Route.useLoaderData();

  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Tracked Companies</h1>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-600">
          <strong>Observed sample — companies we actively track.</strong> We monitor their public job boards and
          career pages daily and report exactly what we see: {companies.length} companies, {totalPostings.toLocaleString()}{" "}
          tracked postings. LinkedIn and Indeed restrict automated access and are not tracked. Every tracked company's
          scores and histories are public and free — unlimited checks, watchlists and alerts are the $9 product.
          Scores populate as tracking history builds — every tracked posting is re-reviewed every few hours, so a
          posting's score appears once it has enough history.
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
                <th scope="col" className="px-5 py-3 font-semibold">
                  Boards
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {companies.map((c) => (
                <tr key={c.slug} className="transition-colors hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <a href={`/companies/${c.slug}`} className="font-semibold text-indigo-600 hover:underline">
                      {c.name}
                    </a>
                  </td>
                  <td className="px-5 py-3 text-slate-600">{c.tracked}</td>
                  <td className="px-5 py-3 text-slate-600">
                    {c.boards.length > 0 ? c.boards.map(boardLabel).join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-400">
          Observed sample — we report what we actually see on the boards we monitor; this is not a market-wide
          census. Confidence scores are public and free.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
