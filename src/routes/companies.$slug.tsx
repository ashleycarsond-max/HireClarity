import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { Store } from "../../engine/store";
import { companyDetail, type PublicCompanyDetail } from "../server/public-data";
import { slugToCompany } from "../lib/slugs";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { ScoreBreakdown, ScoreRing } from "../components/ScorePanel";

const SITE_URL = "https://hireclarity-data.vercel.app";

const loadDetail = createServerFn({ method: "POST" }).handler(async ({ data }: { data: { name: string } }) => {
  const store = new Store();
  try {
    return await companyDetail(store, data.name);
  } catch {
    return null;
  } finally {
    store.close();
  }
});

export const Route = createFileRoute("/companies/$slug")({
  loader: async ({ params }) => {
    const company = slugToCompany(params.slug);
    if (!company) throw notFound();
    try {
      return { companyName: company.name, detail: await loadDetail({ data: { name: company.name } }) };
    } catch {
      return { companyName: company.name, detail: null };
    }
  },
  head: ({ loaderData, params }) => {
    const name = loaderData.companyName;
    const canonical = `${SITE_URL}/companies/${params.slug}`;
    const detail = loaderData.detail;
    const tracked = detail ? detail.tracked : 0;
    const title = `${name} — Tracked Job Postings (Observed Sample) | HireClarity Data`;
    const description = `What HireClarity Data observes about ${name}'s job postings: ${tracked} tracked posting${tracked === 1 ? "" : "s"} on ATS-hosted boards, with listing durations, relist counts, and a free public confidence score (0-100) for every posting. Observed sample.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { name: "robots", content: "index, follow" },
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
            "@type": "WebPage",
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
  component: CompanyDetailPage,
});

function CompanyDetailPage() {
  const { detail } = Route.useLoaderData();
  if (!detail) {
    return (
      <div className="min-h-screen bg-slate-50">
        <SiteHeader />
        <main className="mx-auto max-w-4xl px-4 py-14 text-center sm:px-6">
          <h1 className="text-2xl font-bold text-slate-900">No tracked postings yet</h1>
          <p className="mt-3 text-slate-600">We haven&apos;t observed postings for this company yet — we report what we actually see.</p>
          <a href="/companies" className="mt-6 inline-block font-semibold text-indigo-600 hover:underline">
            ← All tracked companies
          </a>
        </main>
        <SiteFooter />
      </div>
    );
  }
  return <CompanyDetailView detail={detail} />;
}

export function CompanyDetailView({ detail }: { detail: PublicCompanyDetail }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
        <nav aria-label="Breadcrumb" className="text-sm">
          <a href="/companies" className="font-semibold text-indigo-600 hover:underline">
            ← All tracked companies
          </a>
        </nav>
        <h1 className="mt-5 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{detail.name}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-500">
          Observed sample — we report what we actually see. {detail.tracked} tracked postings ({detail.live} currently
          listed) on {detail.boards.length > 0 ? detail.boards.join(", ") : "ATS-hosted boards"}; durations and relist
          counts are what our tracking observed, not a market claim. Most postings don't show a
          confidence score yet: tracking only started recently, and a score needs history. Every tracked
          posting is re-checked every few hours, so scores populate as that history builds.
        </p>
        {detail.careerUrl && (
          <p className="mt-2 text-sm">
            <a
              href={detail.careerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-indigo-600 hover:underline"
            >
              Company careers page ↗
            </a>
          </p>
        )}

        <div className="mt-8 space-y-4">
          {detail.postings.map((p, i) => (
            <article key={i} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                <div className="min-w-0 max-w-xl">
                  <div className="flex flex-wrap items-center gap-2">
                    {p.url ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-slate-800 hover:text-indigo-600 hover:underline"
                      >
                        {p.title}
                      </a>
                    ) : (
                      <span className="font-medium text-slate-800">{p.title}</span>
                    )}
                    {p.status !== "live" && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {p.status === "relisted" ? "relisted" : "removed"}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {p.board} · listed {p.daysListed} day{p.daysListed === 1 ? "" : "s"}
                    {p.relistCount > 0 ? ` · relisted ×${p.relistCount}` : ""}
                  </p>
                  {p.label && p.verdict && (
                    <p className="mt-2 text-sm text-slate-600">
                      <span className="font-semibold text-slate-800">{p.label}.</span> {p.verdict}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {p.score !== null && p.label ? (
                    <>
                      <div className="text-right">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          Confidence score
                        </p>
                        <p className="mt-0.5 text-2xl font-extrabold text-slate-900">{p.score}</p>
                        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">of 100</p>
                      </div>
                      <ScoreRing score={p.score} label={p.label} size="sm" />
                    </>
                  ) : (
                    <p className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                      score n/a
                    </p>
                  )}
                </div>
              </div>
              {p.score !== null && p.label ? (
                <ScoreBreakdown components={p.components} insufficientData={p.insufficientData} compact />
              ) : (
                <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                  We couldn&apos;t compute a confidence score for this posting — n/a, not a judgment. Scores
                  need history, and tracking is new: every tracked posting is re-checked every few hours,
                  so this posting&apos;s score will populate as its history builds.
                </p>
              )}
            </article>
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-400">
          Observed sample — these are posting facts we actually saw, not judgments. Confidence scores are computed
          from what we observe — 0-100, higher = more confidence the posting is real and active. Everything
          we track is public here — scores, histories and the reasons behind them. Company-level analytics
          aren't for sale right now.
        </p>
        <p className="mt-2 text-sm">
          <a href="/check" className="font-semibold text-indigo-600 hover:underline">
            Check any posting — first 5 checks free →
          </a>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
