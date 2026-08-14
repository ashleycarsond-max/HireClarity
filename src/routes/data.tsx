import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { Store } from "../../engine/store";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

const SITE_URL = "https://hireclarity-data.vercel.app";

const TITLE = "Data Hub: Observed-Sample Job-Market Data | HireClarity Data";
const DESCRIPTION =
  "HireClarity Data's public data hub: observed-sample job-market reports (refreshed daily during our first 6 months, then monthly), tracked companies, industries, and guides — all labeled as our observed sample, never a market census.";

const latestReport = createServerFn({ method: "POST" }).handler(async (): Promise<{ period: string } | null> => {
  const store = new Store();
  try {
    const rows = await store.listReportSnapshots();
    if (rows.length === 0) return null;
    const latest = rows.sort((a, b) => b.period.localeCompare(a.period))[0];
    return { period: latest.period };
  } catch {
    return null;
  } finally {
    store.close();
  }
});

export const Route = createFileRoute("/data")({
  loader: async () => {
    try {
      return await latestReport();
    } catch {
      return null;
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
      { property: "og:url", content: `${SITE_URL}/data` },
      { property: "og:image", content: `${SITE_URL}/og-image.png` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/og-image.png` },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/data` }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          "@id": `${SITE_URL}/data`,
          url: `${SITE_URL}/data`,
          name: TITLE,
          description: DESCRIPTION,
          isPartOf: { "@id": `${SITE_URL}/#website` },
        })
          .replace(/</g, "\u003c")
          .replace(/</g, "\u003c"),
      },
    ],
  }),
  component: DataHubPage,
});

interface HubLink {
  href: string;
  title: string;
  blurb: string;
}

function DataHubPage() {
  const latest = Route.useLoaderData();
  const links: HubLink[] = [
    {
      href: latest ? `/reports/${latest.period}` : "/reports",
      title: latest ? `Job-market report (latest: ${latest.period})` : "Job-market reports",
      blurb:
        "Observed-sample job-market data: ghost-job share, recycled postings, listing durations, board split, score distributions, industries hiring most, top titles and degree/experience requirements — refreshed daily during our first 6 months, then monthly.",
    },
    {
      href: "/companies",
      title: "Tracked companies",
      blurb:
        "The companies we actively monitor, with observed posting counts and boards — an observed sample, labeled as exactly that.",
    },
    {
      href: "/industries",
      title: "Industries",
      blurb:
        "Observed posting data grouped by industry — our curated classification, not a standard taxonomy.",
    },
    {
      href: "/blog",
      title: "Blog",
      blurb:
        "Guides on ghost jobs, stale postings and how to tell if a posting is real — written from what we observe, not guesswork.",
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Data Hub</h1>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-600">
          Everything we publish from the tracking engine in one place — <strong>observed-sample job-market data</strong>:
          we report what we actually see on the boards we monitor, never an estimate of the whole market.
        </p>

        <div className="mt-8 space-y-4">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="block rounded-xl border border-slate-200 bg-white p-6 transition-colors hover:border-indigo-300 hover:shadow-sm"
            >
              <h2 className="text-lg font-bold text-slate-900">{l.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{l.blurb}</p>
              <p className="mt-3 text-sm font-semibold text-indigo-600">Open →</p>
            </a>
          ))}
        </div>

        <p className="mt-8 max-w-3xl text-xs leading-relaxed text-slate-400">
          Coverage note: we track postings on Greenhouse, Ashby, Lever and Workable boards and public company career
          pages. LinkedIn and Indeed restrict automated access and are not tracked — every number here is labeled as
          our observed sample.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
