import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import type { ReportSnapshot } from "../../engine/report";
import { DAILY_REPORT_UNTIL, isDailyReportWindow, periodLabel, periodStartIso, reportSummaryLine } from "../../engine/report";
import { Store } from "../../engine/store";
import { CoverageNote } from "../components/CoverageNote";
import { SiteHeader } from "../components/SiteChrome";

const SITE_URL = "https://hireclarity-data.vercel.app";

/* ----------------------------- server function ---------------------------- */

type ReportPageResult =
  | { ok: true; snapshot: ReportSnapshot }
  | { ok: false; period: string; error: "invalid-period" | "not-published" | "other" };

/**
 * Load the stored monthly snapshot for a period (public, ungated — report
 * pages render ONLY stored snapshots, never live store data, so a published
 * report stays stable). Reads the same Neon store as the check tool.
 */
const loadReport = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { period: string })
  .handler(async ({ data }): Promise<ReportPageResult> => {
    const period = (data?.period ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(period) || !periodStartIso(period)) {
      return { ok: false, period, error: "invalid-period" };
    }
    const store = new Store();
    try {
      const snap = await store.getReportSnapshot(period);
      if (!snap) return { ok: false, period, error: "not-published" };
      return { ok: true, snapshot: snap.payload as ReportSnapshot };
    } catch {
      return { ok: false, period, error: "other" };
    } finally {
      store.close();
    }
  });

/* --------------------------------- helpers -------------------------------- */

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function pct(share: number | null): string {
  if (share === null) return "n/a";
  return `${Math.round(share * 1000) / 10}%`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}
/* --------------- helpers for the daily compile-layer sections --------------- */
function trendVal(v: number | null, format: "count" | "percent" | "days"): string {
  if (v === null) return "n/a";
  if (format === "percent") return pct(v);
  if (format === "days") return `${v} day${v === 1 ? "" : "s"}`;
  return v.toLocaleString("en-US");
}
function trendArrow(direction: string): string {
  if (direction === "up") return "\u2191";
  if (direction === "down") return "\u2193";
  if (direction === "flat") return "\u2192";
  return "n/a";
}

/* ---------------------------------- route --------------------------------- */

export const Route = createFileRoute("/reports/$period")({
  loader: async ({ params }): Promise<ReportPageResult> => {
    try {
      return await loadReport({ data: { period: params.period } });
    } catch {
      return { ok: false, period: params.period, error: "other" };
    }
  },
  head: ({ params, loaderData }) => {
    const period = params.period;
    const published = loaderData?.ok === true;
    const label = /^\d{4}-\d{2}$/.test(period) ? periodLabel(period) : period;
    const canonical = `${SITE_URL}/reports/${period}`;
    const title = published
      ? `Job-Market Report, ${label}: Ghost Jobs, Recycled Postings, Score Data | HireClarity Data`
      : `Job-Market Report, ${label} — Not Published Yet | HireClarity Data`;
    const description = published
      ? `Observed-sample job-market data for ${label}: ghost-job share, recycled postings, listing durations, board split, score distribution, industries hiring most, most popular job titles, and education & experience requirements across the postings HireClarity Data tracks.`
      : "This monthly job-market report has not been published yet — see published reports or check a posting yourself (first 5 checks free).";
    const snapshot = published ? (loaderData as { ok: true; snapshot: ReportSnapshot }).snapshot : null;

    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Dataset",
          "@id": `${canonical}#dataset`,
          name: `HireClarity Data Job-Market Report, ${label}`,
          description: `Observed-sample aggregates for ${label}: postings tracked, take-down-and-relist cycles, listing durations, board split, checks, score distribution, industries hiring most, top job titles and education & experience requirements. An observed sample of ATS-hosted boards and company career pages — LinkedIn and Indeed are not tracked.`,
          url: canonical,
          datePublished: snapshot ? fmtDate(snapshot.generatedAt) : undefined,
          dateModified: snapshot ? fmtDate(snapshot.generatedAt) : undefined,
          temporalCoverage: /^\d{4}-\d{2}$/.test(period) ? period : undefined,
          publisher: { "@id": `${SITE_URL}/#organization` },
          about: "ghost jobs",
          variableMeasured: snapshot
            ? [
                { "@type": "PropertyValue", name: "postings tracked", value: snapshot.postings.totalTracked },
                { "@type": "PropertyValue", name: "postings observed taken down and reposted", value: snapshot.postings.relistedAtLeastOnce },
                { "@type": "PropertyValue", name: "median days listed (live postings)", value: snapshot.postings.medianDaysListed ?? "n/a" },
                { "@type": "PropertyValue", name: "distinct companies tracked", value: snapshot.postings.distinctCompanies },
                { "@type": "PropertyValue", name: "checks performed in period", value: snapshot.checks.inPeriod },
                ...(snapshot.daily && snapshot.daily.snapshotsUsed > 0
                  ? [
                      { "@type": "PropertyValue", name: "top industry (summed daily counts)", value: snapshot.daily.industries[0] ? snapshot.daily.industries[0].industry : "n/a" },
                      { "@type": "PropertyValue", name: "top job title (summed daily counts)", value: snapshot.daily.titles[0] ? snapshot.daily.titles[0].title : "n/a" },
                      { "@type": "PropertyValue", name: "descriptions read (requirement shares)", value: snapshot.daily.requirements.postingsWithDescriptionRead },
                    ]
                  : []),
              ]
            : undefined,
        },
        {
          "@type": "WebPage",
          "@id": canonical,
          url: canonical,
          name: title,
          description,
          isPartOf: { "@id": `${SITE_URL}/#website` },
        },
      ],
    };

    return {
      meta: [
        { title },
        { name: "description", content: description },
        { name: "robots", content: published ? "index, follow" : "noindex, follow" },
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
          children: JSON.stringify(jsonLd).replace(/</g, "\u003c").replace(/</g, "\u003c"),
        },
      ],
    };
  },
  component: ReportPage,
});

/* --------------------------------- layout -------------------------------- */

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{value}</p>
      {sub ? <p className="mt-1 text-xs leading-relaxed text-slate-400">{sub}</p> : null}
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-12">
      <h2 className="text-xl font-bold tracking-tight text-slate-900">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/* ------------------------------- page body -------------------------------- */

function ReportPage() {
  const result = Route.useLoaderData();

  if (result.ok === false) {
    const label = /^\d{4}-\d{2}$/.test(result.period) ? periodLabel(result.period) : result.period;
    const invalid = result.error === "invalid-period";
    return (
      <div className="min-h-screen bg-slate-50">
        <SiteHeader />
        <main className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Job-Market Report, {label}</h1>
          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-8 text-center">
            {invalid ? (
              <p className="text-lg text-slate-700">
                That doesn't look like a report period — reports live at <span className="font-mono text-sm">/reports/YYYY-MM</span>.
              </p>
            ) : (
              <>
                <p className="text-lg font-semibold text-slate-900">Not published yet.</p>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                  Reports are generated from the postings we track. {label} doesn't have one yet — check the published
                  reports, or check a posting yourself while you wait (your first 5 checks are free).
                </p>
              </>
            )}
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <a
                href="/reports"
                className="rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700"
              >
                View published reports
              </a>
              <a
                href="/check"
                className="rounded-full border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
              >
                Check a posting — first 5 checks free
              </a>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const s = result.snapshot;
  const p = s.postings;
  const label = periodLabel(s.period);
  const windowLabel = s.observation.earliestFirstSeenAt
    ? `since ${fmtDay(s.observation.earliestFirstSeenAt)}`
    : "no postings tracked yet";
  const sampleLabel = `of the ${plural(p.totalTracked, "posting")} we track (${windowLabel})`;
  const d = s.daily ?? null;

  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <nav className="text-sm text-slate-500" aria-label="Breadcrumb">
          <a href="/" className="transition-colors hover:text-indigo-600">Home</a>
          <span className="mx-2">/</span>
          <a href="/reports" className="transition-colors hover:text-indigo-600">Reports</a>
          <span className="mx-2">/</span>
          <span className="font-medium text-slate-700">{label}</span>
        </nav>

        <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          Job-Market Report, {label}
        </h1>
        <p className="mt-3 max-w-3xl text-lg leading-relaxed text-slate-600">
          Ghost jobs, recycled postings, industries, titles, requirements and score data — every figure below is an{" "}
          <strong>observed sample</strong> {sampleLabel}. We report what we actually see; we never estimate
          the whole market.
        </p>
        <p className="mt-2 text-sm text-slate-400">
          Generated {fmtDay(s.generatedAt)}
          {d?.lastDate ? ` · daily-compiled sections as of ${fmtDay(d.lastDate)}` : ""} · observation window:{" "}
          {fmtDay(s.observation.earliestFirstSeenAt)} → {fmtDay(s.generatedAt)} (
          {s.observation.windowDays} day{s.observation.windowDays === 1 ? "" : "s"})
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {isDailyReportWindow()
            ? `During our first 6 months this report refreshes daily from the 02:30 UTC compile (daily until ${fmtDay(
                DAILY_REPORT_UNTIL
              )}), then monthly. The URL stays /reports/${s.period} — no new pages per day.`
            : "This report refreshes monthly on the 1st."}
        </p>

        {/* Overview cards */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Postings we track" value={p.totalTracked.toLocaleString("en-US")} sub={windowLabel} />
          <StatCard
            label="Observed taken down & reposted"
            value={`${p.relistedAtLeastOnce.toLocaleString("en-US")} (${pct(p.relistShare)})`}
            sub={`${sampleLabel} — the strongest ghost-job signal`}
          />
          <StatCard
            label="Median days listed"
            value={p.medianDaysListed === null ? "n/a" : `${p.medianDaysListed}`}
            sub={`across ${plural(p.daysListedSample, "live posting")}`}
          />
          <StatCard label="Companies tracked" value={p.distinctCompanies.toLocaleString("en-US")} sub="names are never published on report pages" />
        </div>

        <Section id="postings" title="1 · The postings we track">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 font-semibold">Count</th>
                  <th className="px-5 py-3 font-semibold">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr>
                  <td className="px-5 py-3.5 font-medium text-slate-800">Currently live</td>
                  <td className="px-5 py-3.5 text-slate-600">{p.live.toLocaleString("en-US")}</td>
                  <td className="px-5 py-3.5 text-slate-600">{p.totalTracked ? pct(p.live / p.totalTracked) : "—"}</td>
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-slate-800">Live again after a relist</td>
                  <td className="px-5 py-3.5 text-slate-600">{p.relisted.toLocaleString("en-US")}</td>
                  <td className="px-5 py-3.5 text-slate-600">{p.totalTracked ? pct(p.relisted / p.totalTracked) : "—"}</td>
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-slate-800">Currently removed</td>
                  <td className="px-5 py-3.5 text-slate-600">{p.removed.toLocaleString("en-US")}</td>
                  <td className="px-5 py-3.5 text-slate-600">{p.totalTracked ? pct(p.removed / p.totalTracked) : "—"}</td>
                </tr>
                <tr>
                  <td className="px-5 py-3.5 font-medium text-slate-800">Tracked total</td>
                  <td className="px-5 py-3.5 font-semibold text-slate-900">{p.totalTracked.toLocaleString("en-US")}</td>
                  <td className="px-5 py-3.5 text-slate-500">100% of this sample</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            A posting is "removed" when our last check of it returned gone (HTTP 404 or the board's own
            "not found" signal). "Relisted" means we observed it taken down and later reappearing.
          </p>
        </Section>

        <Section id="recycled" title="2 · Take-down-and-relist cycles (recycled postings)">
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <p className="text-2xl font-bold text-slate-900">
              {p.relistedAtLeastOnce.toLocaleString("en-US")} of {p.totalTracked.toLocaleString("en-US")}{" "}
              {sampleLabel} — {pct(p.relistShare)} — have been observed taken down and reposted at least once.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-500">
              A posting taken down and reposted is the strongest ghost-job signal we track: it can make an old
              posting look new. {p.relistedAtLeastOnce === 0
                ? "None of the postings in this sample show that pattern yet — the tracker has been watching for a short window, so the absence of relists is a fact about this window, not a guarantee."
                : "The rest of the sample shows no take-down-and-relist cycle within our observation window."}
            </p>
          </div>
        </Section>

        <Section id="duration" title="3 · How long postings stay listed">
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label="Median days listed"
              value={p.medianDaysListed === null ? "n/a" : `${p.medianDaysListed} day${p.medianDaysListed === 1 ? "" : "s"}`}
              sub={`half of the ${plural(p.daysListedSample, "live posting")} we track have been listed at most this long`}
            />
            <StatCard
              label="Longest days listed"
              value={p.maxDaysListed === null ? "n/a" : `${p.maxDaysListed} day${p.maxDaysListed === 1 ? "" : "s"}`}
              sub={`the longest-listed live posting in this sample`}
            />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            Days listed counts from when we first observed the posting — a posting may have existed before we
            started watching it, so these are minimums.
          </p>
        </Section>

        <Section id="boards" title="4 · Where the postings appear">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3 font-semibold">Board</th>
                  <th className="px-5 py-3 font-semibold">Postings</th>
                  <th className="px-5 py-3 font-semibold">Share of sample</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {s.boards.map((b) => (
                  <tr key={b.board}>
                    <td className="px-5 py-3.5 font-medium capitalize text-slate-800">{b.board}</td>
                    <td className="px-5 py-3.5 text-slate-600">{b.count.toLocaleString("en-US")}</td>
                    <td className="px-5 py-3.5 text-slate-600">{pct(b.share)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            "web" = postings tracked directly on a company career page rather than an ATS board. We track
            Greenhouse, Ashby, Lever and Workable boards plus company career pages; LinkedIn and Indeed
            restrict automated access and are not tracked.
          </p>
        </Section>

        <Section id="checks" title={`5 · Checks performed in ${label}`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label="Observations recorded" value={s.checks.inPeriod.toLocaleString("en-US")} sub={`across ${plural(s.checks.distinctPostings, "posting")}`} />
            <StatCard label="Score distribution" value={`${s.checks.scoreBuckets.reduce((n, b) => n + b.count, 0).toLocaleString("en-US")} scored`} sub="scores recomputed at report generation (see note)" />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <h3 className="border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                What we observed
              </h3>
              <table className="w-full text-left text-sm">
                <tbody className="divide-y divide-slate-100">
                  {s.checks.byOutcome.map((o) => (
                    <tr key={o.observedStatus}>
                      <td className="px-5 py-3 font-medium capitalize text-slate-800">{o.observedStatus.replace(/_/g, " ")}</td>
                      <td className="px-5 py-3 text-slate-600">{o.count.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <h3 className="border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Confidence score buckets (0–100, higher = fewer ghost signals)
              </h3>
              <table className="w-full text-left text-sm">
                <tbody className="divide-y divide-slate-100">
                  {s.checks.scoreBuckets.map((b) => (
                    <tr key={b.bucket}>
                      <td className="px-5 py-3 font-medium text-slate-800">{b.bucket}</td>
                      <td className="px-5 py-3 text-slate-600">{b.count.toLocaleString("en-US")}</td>
                      <td className="px-5 py-3 text-slate-600">{pct(b.share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">{s.checks.scoreMethod}</p>
        </Section>

        <Section id="limits" title="6 · What this report is — and isn't">
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-600">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Every number is an <strong>observed sample</strong>: {sampleLabel}. We never claim these
                figures describe all job postings.
              </li>
              <li>
                We track Greenhouse, Ashby, Lever and Workable boards plus company career pages. LinkedIn and
                Indeed restrict automated access and are not tracked, so postings that only live there are
                outside this sample.
              </li>
              <li>
                Companies appear only as a count ({p.distinctCompanies} distinct companies in this sample).
                Everything we track per company is public on its company page — there's no separate private
                company product right now.
              </li>
              <li>
                This snapshot was generated {fmtDay(s.generatedAt)}. During our first 6 months (daily until{" "}
                {fmtDay(DAILY_REPORT_UNTIL)}) the current month's report refreshes each day from the 02:30 UTC
                compile, so the numbers here can change day to day — the URL stays /reports/{s.period}. After
                that window the report refreshes monthly on the 1st, and each month keeps its own snapshot.
              </li>
            </ul>
          </div>
        </Section>

        {/* 7 — Industries hiring the most (daily compile layer) */}
        <Section id="industries" title="7 · Industries hiring the most">
          {!d || d.snapshotsUsed === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-500">
              We compile industries from our daily snapshots — {d ? d.note : "this report predates the daily compile."}
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <table className="w-full text-left text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {d.industries.map((row, i) => {
                      const max = d.industries[0].count;
                      return (
                        <tr key={row.industry}>
                          <td className="w-2/5 px-5 py-2.5 font-medium text-slate-800">
                            <span className="mr-2 text-xs text-slate-400">{i + 1}</span>
                            {row.industry}
                          </td>
                          <td className="px-5 py-2.5">
                            <div className="flex items-center gap-3">
                              <div className="h-2 w-56 max-w-full overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="h-full rounded-full bg-indigo-500"
                                  style={{ width: `${Math.max(2, Math.round((row.count / max) * 100))}%` }}
                                />
                              </div>
                              <span className="text-slate-600">{row.count.toLocaleString("en-US")}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                Counts are summed across the period's {plural(d.snapshotsUsed, "daily snapshot")} — a posting
                visible all month counts once per daily snapshot. Industry labels are our curated
                single-label classification, <strong>not a standard taxonomy</strong>; each tracked company is
                mapped to one label.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                Unclassified (postings with no company name, or a company outside our map):{" "}
                <strong>{d.unclassifiedCount.toLocaleString("en-US")}</strong> — counted separately, not part
                of the rows above.
              </p>
            </>
          )}
        </Section>
        {/* 8 — Most popular job titles (daily compile layer) */}
        <Section id="titles" title="8 · Most popular job titles">
          {!d || d.snapshotsUsed === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-500">
              We compile titles from our daily snapshots — {d ? d.note : "this report predates the daily compile."}
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <table className="w-full text-left text-sm">
                  <tbody className="divide-y divide-slate-100">
                    {d.titles.map((row, i) => {
                      const max = d.titles[0].count;
                      return (
                        <tr key={row.title}>
                          <td className="w-2/5 px-5 py-2.5 font-medium text-slate-800">
                            <span className="mr-2 text-xs text-slate-400">{i + 1}</span>
                            {row.title}
                          </td>
                          <td className="px-5 py-2.5">
                            <div className="flex items-center gap-3">
                              <div className="h-2 w-56 max-w-full overflow-hidden rounded-full bg-slate-100">
                                <div
                                  className="h-full rounded-full bg-indigo-500"
                                  style={{ width: `${Math.max(2, Math.round((row.count / max) * 100))}%` }}
                                />
                              </div>
                              <span className="text-slate-600">{row.count.toLocaleString("en-US")}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-400">
                <strong>Normalized exact titles</strong>: case, spacing and common suffixes are normalized, so
                "Senior Software Engineer" and "senior software engineer" count as one title. Counts are summed
                across the period's daily snapshots (a posting visible all month counts once per daily
                snapshot); each day's top-10 normalized titles feed the aggregate.
              </p>
            </>
          )}
        </Section>
        {/* 9 — Education & experience requirements (daily compile layer) */}
        <Section id="requirements" title="9 · Education & experience requirements">
          {!d || d.snapshotsUsed === 0 || !d.requirements.asOf ? (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-500">
              {d ? d.note : "This report predates the daily compile."}
            </div>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-slate-500">
                Requirement shares <strong>as of {fmtDay(d.requirements.asOf)}</strong>, over the{" "}
                {plural(d.requirements.postingsWithDescriptionRead, "posting")} whose description we could
                read — never over all postings.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <StatCard
                  label="Require a bachelor's degree"
                  value={pct(d.requirements.bachelorShare)}
                  sub={`${d.requirements.requiresBachelor.toLocaleString("en-US")} of ${d.requirements.postingsWithDescriptionRead.toLocaleString("en-US")} read descriptions`}
                />
                <StatCard
                  label="Require a master's degree"
                  value={pct(d.requirements.mastersShare)}
                  sub={`${d.requirements.requiresMasters.toLocaleString("en-US")} of ${d.requirements.postingsWithDescriptionRead.toLocaleString("en-US")} read descriptions`}
                />
                <StatCard
                  label="Require 5+ years of experience"
                  value={pct(d.requirements.fivePlusShare)}
                  sub={`${d.requirements.requires5PlusYears.toLocaleString("en-US")} of ${d.requirements.postingsWithDescriptionRead.toLocaleString("en-US")} read descriptions`}
                />
              </div>
              <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5 text-sm leading-relaxed text-slate-600">
                <p>
                  We read descriptions on {plural(d.requirements.postingsWithDescriptionRead, "posting")} of
                  the {plural(d.requirements.livePostings, "live tracked posting")} we watch (as of{" "}
                  {fmtDay(d.requirements.asOf)}). {d.requirements.postingsWithFetchError.toLocaleString("en-US")}{" "}
                  had pages we couldn't read, and{" "}
                  {d.requirements.postingsNotYetExtracted.toLocaleString("en-US")} haven't been read yet —
                  those are never counted as zeros.
                </p>
                {d.requirements.livePostings > 0 &&
                d.requirements.postingsWithDescriptionRead / d.requirements.livePostings < 0.8 ? (
                  <p className="mt-3 rounded-lg bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">
                    We're still reading descriptions —{" "}
                    {d.requirements.postingsWithDescriptionRead.toLocaleString("en-US")} of{" "}
                    {d.requirements.livePostings.toLocaleString("en-US")} live postings read so far (
                    {Math.round((d.requirements.postingsWithDescriptionRead / d.requirements.livePostings) * 100)}
                    %). These shares will firm up as coverage grows.
                  </p>
                ) : null}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-400">{d.requirements.method}</p>
            </>
          )}
        </Section>
        {/* 10 — Trends (daily compile layer) */}
        <Section id="trends" title="10 · Trends">
          {/* Day over day — the daily-refresh window's primary view (owner decision 2026-08-14) */}
          <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Day over day (vs previous compile)</h3>
          {!d || !d.dailyTrends || d.dailyTrends.length === 0 ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-500">
              n/a — day-over-day trend rows need two daily compiles in this period. The daily pipeline has
              compiled{" "}
              {d ? plural(d.snapshotsUsed, "snapshot") : "no snapshots"}{" "}
              {d?.firstDate
                ? `so far (${fmtDay(d.firstDate)}${d.lastDate && d.lastDate !== d.firstDate ? ` → ${fmtDay(d.lastDate)}` : ""})`
                : "so far"}
              . Once a second compile lands, this table shows how each metric moved vs the previous compile.
            </div>
          ) : (
            <>
              <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Metric</th>
                      <th className="px-5 py-3 font-semibold">Latest compile</th>
                      <th className="px-5 py-3 font-semibold">Previous compile</th>
                      <th className="px-5 py-3 font-semibold">Direction</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.dailyTrends.map((t) => (
                      <tr key={t.key}>
                        <td className="px-5 py-2.5 font-medium text-slate-800">{t.label}</td>
                        <td className="px-5 py-2.5 text-slate-600">{trendVal(t.current, t.format)}</td>
                        <td className="px-5 py-2.5 text-slate-600">{trendVal(t.previous, t.format)}</td>
                        <td className="px-5 py-2.5">
                          <span className="font-semibold text-slate-700">{trendArrow(t.direction)}</span>
                          {t.delta !== null && t.direction !== "n-a" && t.direction !== "flat" ? (
                            <span className="ml-1 text-xs text-slate-400">
                              ({t.delta > 0 ? "+" : ""}
                              {trendVal(t.delta, t.format)})
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {d.dailyTrends.every((t) => t.direction === "n-a") ? (
                <p className="mt-3 rounded-lg bg-slate-100 px-4 py-3 text-xs font-medium text-slate-600">
                  n/a — a metric gets a direction only when both compiles have a comparable value for it. Some
                  metrics (e.g. requirement shares) may stay n/a while descriptions are still being read.
                </p>
              ) : (
                <p className="mt-3 text-xs leading-relaxed text-slate-400">
                  Direction is the literal change in the metric between the two most recent daily compiles (
                  {fmtDay(d.dailyTrendDates?.previous)} → {fmtDay(d.dailyTrendDates?.latest)}, UTC). A rise or
                  fall is not a judgment — a rising description-read count is progress, a rising relist share is
                  a warning, and the report never scores either.
                </p>
              )}
            </>
          )}

          {/* Month over month — preserved behavior; needs 2+ monthly periods */}
          <h3 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Month over month</h3>
          {!d || d.trends.length === 0 ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-white p-6 text-sm leading-relaxed text-slate-500">
              n/a — month-over-month rows compare this period against the previous period's daily compiles.
              This period is the baseline; once the previous period has snapshots, the comparison appears here.
            </div>
          ) : (
            <>
              <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Metric</th>
                      <th className="px-5 py-3 font-semibold">This period</th>
                      <th className="px-5 py-3 font-semibold">Previous period</th>
                      <th className="px-5 py-3 font-semibold">Direction</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.trends.map((t) => (
                      <tr key={t.key}>
                        <td className="px-5 py-2.5 font-medium text-slate-800">{t.label}</td>
                        <td className="px-5 py-2.5 text-slate-600">{trendVal(t.current, t.format)}</td>
                        <td className="px-5 py-2.5 text-slate-600">{trendVal(t.previous, t.format)}</td>
                        <td className="px-5 py-2.5">
                          <span className="font-semibold text-slate-700">{trendArrow(t.direction)}</span>
                          {t.delta !== null && t.direction !== "n-a" && t.direction !== "flat" ? (
                            <span className="ml-1 text-xs text-slate-400">
                              ({t.delta > 0 ? "+" : ""}
                              {trendVal(t.delta, t.format)})
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {d.trends.every((t) => t.direction === "n-a") ? (
                <p className="mt-3 rounded-lg bg-slate-100 px-4 py-3 text-xs font-medium text-slate-600">
                  n/a — we need a previous period with daily snapshots before month-over-month directions can
                  be computed. This period's baseline is being recorded; next month's report will show
                  directions against it.
                </p>
              ) : (
                <p className="mt-3 text-xs leading-relaxed text-slate-400">
                  Direction is the literal change in the metric between this period's latest daily snapshot and
                  the previous period's latest daily snapshot ({d.previousPeriod ?? "the previous period"}). A
                  rise or fall is not a judgment — a rising description-read count is progress, a rising relist
                  share is a warning, and the report never scores either.
                </p>
              )}
            </>
          )}
        </Section>
        {/* CTA */}
        <div className="mt-12 rounded-2xl bg-slate-900 p-8 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-white">See it per posting, not just per market</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300">
            Paste any job posting URL for its confidence score and reasons — your first 5 checks each month are
            free. Companies can see their own posting health behind the Company dashboard.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a
              href="/check"
              className="rounded-full bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
            >
              Check any posting — first 5 checks free
            </a>
            <a
              href="/company"
              className="rounded-full border border-slate-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:border-slate-400"
            >
              Company posting health
            </a>
          </div>
        </div>

        <div className="mt-8">
          <CoverageNote />
          <p className="mt-2 text-xs text-slate-400">
            Summary: {reportSummaryLine(s)} — <a href="/reports" className="underline decoration-slate-300 underline-offset-2 hover:text-indigo-600">all reports</a>
          </p>
        </div>
      </main>
    </div>
  );
}
