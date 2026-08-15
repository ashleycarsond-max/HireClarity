import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import type { ReportSnapshot } from "../../../engine/report";
import { periodLabel, reportSummaryLine } from "../../../engine/report";
import { Store } from "../../../engine/store";
import { CoverageNote } from "../../components/CoverageNote";
import { SiteHeader } from "../../components/SiteChrome";

const SITE_URL = "https://hireclarity-data.vercel.app";

/* ----------------------------- server function ---------------------------- */

export interface ReportListItem {
  period: string;
  generatedAt: string;
  snapshot: ReportSnapshot;
}

/**
 * List published monthly snapshots (public, ungated). Each entry carries its
 * stored snapshot so the index can show an honest one-line summary per issue.
 */
const listReports = createServerFn({ method: "POST" }).handler(async (): Promise<ReportListItem[]> => {
  const store = new Store();
  try {
    const rows = await store.listReportSnapshots();
    return rows.map((r) => ({
      period: r.period,
      generatedAt: r.generatedAt,
      snapshot: r.payload as ReportSnapshot,
    }));
  } catch {
    return [];
  } finally {
    store.close();
  }
});

/* ---------------------------------- route --------------------------------- */

const TITLE = "Job-Market Reports: Ghost Jobs, Recycled Postings, Score Data | HireClarity Data";
const DESCRIPTION =
  "Observed-sample job-market reports from HireClarity Data: ghost-job share, recycled postings, listing durations, board split and score distributions across the postings we track — refreshed daily during our first 6 months, then monthly.";

export const Route = createFileRoute("/reports/")({
  loader: async (): Promise<ReportListItem[]> => {
    try {
      return await listReports();
    } catch {
      return [];
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
      { property: "og:url", content: `${SITE_URL}/reports` },
      { property: "og:image", content: `${SITE_URL}/og-image.png` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/og-image.png` },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/reports` }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "CollectionPage",
              "@id": `${SITE_URL}/reports`,
              url: `${SITE_URL}/reports`,
              name: TITLE,
              description: DESCRIPTION,
              isPartOf: { "@id": `${SITE_URL}/#website` },
              about: "ghost jobs",
            },
            {
              "@type": "WebPage",
              "@id": `${SITE_URL}/reports#webpage`,
              url: `${SITE_URL}/reports`,
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
  component: ReportsIndexPage,
});

/* --------------------------------- layout -------------------------------- */

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/* ------------------------------- page body -------------------------------- */

function ReportsIndexPage() {
  const reports = Route.useLoaderData();

  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Job-Market Reports</h1>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-600">
          We publish what our tracking actually saw: ghost-job share, recycled postings, listing durations,
          board split and score distributions — an <strong>observed sample</strong> of the postings we track,
          never an estimate of the whole market. During our first 6 months the current report refreshes
          <strong> daily</strong> from the 02:30 UTC compile so you can watch change as data compiles; after
          that it refreshes monthly.
        </p>

        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-600">
          <h2 className="text-base font-bold text-slate-900">What this report is</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              Every figure counts only what we observed: <strong>N postings we track since a date</strong>.
              We never say "X% of all jobs".
            </li>
            <li>
              We track Greenhouse, Ashby, Lever and Workable boards plus company career pages. LinkedIn and
              Indeed restrict automated access and are not tracked — so our coverage is an observed sample,
              not the whole job market.
            </li>
            <li>
              Companies appear only as a count. Everything we track per company is public on its
              company page — there's no separate private company product right now.
            </li>
            <li>
              Each published snapshot carries a "data as of" label. During our first 6 months the current
              month's snapshot refreshes daily from the latest compile (same URL per month, never a new page
              per day); after that, each month gets its own snapshot on the 1st.
            </li>
          </ul>
        </div>

        <h2 className="mt-10 text-xl font-bold tracking-tight text-slate-900">Published reports</h2>

        {reports.length === 0 ? (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center">
            <p className="font-semibold text-slate-900">No reports published yet.</p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-500">
              We're still watching. The first report appears here as soon as we have a snapshot worth
              publishing — meanwhile you can check any posting yourself, free.
            </p>
            <a
              href="/check"
              className="mt-5 inline-block rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700"
            >
              Check a posting — first 5 checks free
            </a>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {reports.map((r) => (
              <a
                key={r.period}
                href={`/reports/${r.period}`}
                className="block rounded-xl border border-slate-200 bg-white p-6 transition-colors hover:border-indigo-300 hover:shadow-sm"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-lg font-bold text-slate-900">Job-Market Report, {periodLabel(r.period)}</h3>
                  <span className="text-xs text-slate-400">Last refreshed {fmtDay(r.generatedAt)}</span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{reportSummaryLine(r.snapshot)}</p>
                <p className="mt-3 text-sm font-semibold text-indigo-600">Read the report →</p>
              </a>
            ))}
          </div>
        )}

        <div className="mt-12 rounded-2xl bg-slate-900 p-8 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-white">Don't wait for next month</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300">
            Check any job posting right now for its confidence score and the reasons behind it — your first 5
            checks each month are free.
          </p>
          <a
            href="/check"
            className="mt-6 inline-block rounded-full bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
          >
            Check any posting — first 5 checks free
          </a>
        </div>

        <div className="mt-8">
          <CoverageNote />
        </div>
      </main>
    </div>
  );
}
