import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { currentQuarter, generateCompanyReport, loadCompanyReport, matchCompanyForEmail, quarterLabel, type CompanyReport } from "../../engine/company-report";
import { SEED_COMPANIES } from "../../engine/companies";
import { Store } from "../../engine/store";
import { SubscriptionGate } from "../components/SubscriptionGate";
import type { AccessResult } from "../components/SubscriptionGate";
import { currentUserEmail } from "../server/auth";
import { earlyAccessFree } from "../server/gate";
import { isSubscribed } from "../server/subscriptions";

export const Route = createFileRoute("/company/report")({
  head: () => ({
    meta: [
      { title: "Quarterly Reputation Report | HireClarity Data" },
      {
        name: "description",
        content:
          "Your private quarterly posting-health report: confidence-style company score, quarter trends, fix recommendations and industry benchmarks — for active Company subscribers.",
      },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "HireClarity Data" },
      { property: "og:title", content: "Quarterly Reputation Report | HireClarity Data" },
      {
        property: "og:description",
        content:
          "Your private quarterly posting-health report: score, quarter trends, fix recommendations and industry benchmarks.",
      },
      { property: "og:url", content: "https://hireclarity-data.vercel.app/company/report" },
    ],
    links: [{ rel: "canonical", href: "https://hireclarity-data.vercel.app/company/report" }],
  }),
  component: ReportPage,
});

/* ----------------------------- server functions ---------------------------- */

/**
 * Access gate — identical contract to /company: EARLY_ACCESS_FREE on (dev)
 * opens the page; otherwise only an ACTIVE company subscription for the
 * signed-in user unlocks it. Identity always comes from the hc_session cookie.
 */
const verifyAccess = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { tier: string })
  .handler(async ({ data }): Promise<AccessResult> => {
    if (earlyAccessFree()) return { gated: false, allowed: true };
    const tier = data?.tier;
    if (tier !== "seeker" && tier !== "company") {
      return { gated: true, allowed: false, reason: "unknown-tier", error: "Unknown subscription tier." };
    }
    let sessionEmail: string | null = null;
    try {
      sessionEmail = await currentUserEmail(getRequest());
    } catch {
      sessionEmail = null;
    }
    if (!sessionEmail) {
      return { gated: true, allowed: false, reason: "signin", error: "Sign in to continue." };
    }
    const allowed = await isSubscribed("company", sessionEmail); // fail-closed
    return { gated: true, allowed, reason: "nosub" };
  });

type ReportResult =
  | { ok: true; matched: true; company: string; quarter: string; report: CompanyReport; quarters: string[] }
  | { ok: true; matched: false; quarters: string[] }
  | { ok: false; error: string };

const loadReport = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { quarter?: string })
  .handler(async ({ data }): Promise<ReportResult> => {
    // Fail-closed: the report is PRIVATE (paid Company tier). Same session +
    // subscription check as the gate — a direct server-fn call can't bypass it.
    if (!earlyAccessFree()) {
      let sessionEmail: string | null = null;
      try {
        sessionEmail = await currentUserEmail(getRequest());
      } catch {
        sessionEmail = null;
      }
      if (!sessionEmail) return { ok: false, error: "Sign in to view your report." };
      const subscribed = await isSubscribed("company", sessionEmail);
      if (!subscribed) {
        return { ok: false, error: "The quarterly reputation report is part of the Company subscription — $149/month." };
      }
    }

    const store = new Store();
    try {
      // Resolve the signed-in user's email → tracked company (documented rule:
      // matchCompanyForEmail — local part or domain's first label vs registry).
      let email: string | null = null;
      try {
        email = await currentUserEmail(getRequest());
      } catch {
        email = null;
      }
      const company = matchCompanyForEmail(email, SEED_COMPANIES);
      if (!company) {
        return { ok: true, matched: false, quarters: [] };
      }
      const requested = data?.quarter;
      const quarter = requested && /^\d{4}-Q[1-4]$/.test(requested) ? requested : currentQuarter();
      let report = await loadCompanyReport(store, company, quarter);
      if (!report) {
        // First visit this quarter: generate + store (idempotent).
        report = await generateCompanyReport(store, company, quarter);
      }
      const stored = await store.listCompanyReports(company);
      return {
        ok: true,
        matched: true,
        company,
        quarter,
        report,
        quarters: stored.map((q) => q.quarter),
      };
    } finally {
      store.close();
    }
  });

/* --------------------------------- icons --------------------------------- */

type IconName = "arrowRight" | "building" | "calendar" | "check" | "chevronDown" | "gauge" | "info" | "link" | "printer" | "warning";

const iconPaths: Record<IconName, ReactNode> = {
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" />
      <path d="M15 9h4a1 1 0 0 1 1 1v11" />
      <path d="M3 21h18" />
      <path d="M7.5 7h2M7.5 11h2M7.5 15h2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ),
  check: <path d="m5 13 4 4L19 7" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  gauge: (
    <>
      <path d="M12 14l4-4" />
      <path d="M5.6 18a8 8 0 1 1 12.8 0" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  printer: (
    <>
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
};

function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {iconPaths[name]}
    </svg>
  );
}

/* --------------------------------- header --------------------------------- */

function Header() {
  return (
    <header className="border-b border-slate-200/70 bg-white/85 backdrop-blur print:hidden">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="/" className="flex items-center gap-2.5" aria-label="HireClarity Data home">
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 text-indigo-600" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2" />
            <path
              d="M3.5 12h4l1.5-2.5 2.5 5 1.5-2.5h7.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-lg font-bold tracking-tight text-slate-900">HireClarity Data</span>
        </a>
        <nav className="flex items-center gap-3">
          <a href="/company" className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600">
            Company dashboard
          </a>
          <a href="/" className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600">
            Back to home
          </a>
        </nav>
      </div>
    </header>
  );
}

/* ------------------------------ report document ------------------------------ */

const LABEL_STYLES: Record<string, { chip: string }> = {
  "Clean posting health": { chip: "bg-emerald-50 text-emerald-700" },
  "Some signals worth watching": { chip: "bg-amber-50 text-amber-700" },
  "Posting health needs attention": { chip: "bg-rose-50 text-rose-700" },
  "Not enough postings tracked yet": { chip: "bg-slate-100 text-slate-600" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function fmtTrendValue(t: { first: number | null; last: number | null; format: "count" | "days" | "pct" }, v: number | null): string {
  if (v === null) return "n/a";
  switch (t.format) {
    case "days":
      return `${v} day${v === 1 ? "" : "s"}`;
    case "pct":
      return `${Math.round(v * 100)}%`;
    default:
      return String(v);
  }
}

function directionWord(t: { direction: string }): string {
  switch (t.direction) {
    case "up":
      return "up";
    case "down":
      return "down";
    case "flat":
      return "unchanged";
    default:
      return "n/a";
  }
}

function ReportDocument({ report, quarters, onPickQuarter }: { report: CompanyReport; quarters: string[]; onPickQuarter: (q: string) => void }) {
  const styles = LABEL_STYLES[report.score.label] ?? LABEL_STYLES["Not enough postings tracked yet"];
  const qLabel = quarterLabel(report.quarter) ?? report.quarter;
  const relistRatePct = report.summary.relistRate === null ? null : Math.round(report.summary.relistRate * 100);

  return (
    <section aria-label={`Quarterly reputation report for ${report.company}`} className="mx-auto mt-8 max-w-4xl px-4 sm:px-6">
      {/* Toolbar (hidden when printing) */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        {quarters.length > 1 ? (
          <div className="flex items-center gap-2">
            <Icon name="calendar" className="h-4 w-4 text-slate-400" />
            {quarters.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => onPickQuarter(q)}
                className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors ${
                  q === report.quarter
                    ? "bg-indigo-600 text-white"
                    : "border border-slate-300 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-600"
                }`}
              >
                {quarterLabel(q) ?? q}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-sm text-slate-400">{qLabel}</span>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
          >
            <Icon name="printer" className="h-4 w-4" />
            Print / Save as PDF
          </button>
          <a
            href="/company"
            className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700"
          >
            Company dashboard
            <Icon name="arrowRight" className="h-4 w-4" />
          </a>
        </div>
      </div>

      {/* The report document (printable) */}
      <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-indigo-950/5 sm:p-10">
        {/* Letterhead */}
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-6">
          <div>
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-indigo-600">
              <Icon name="building" className="h-4 w-4" />
              HireClarity Data · Company reputation report
            </p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-900">{report.company}</h1>
            <p className="mt-1 text-sm text-slate-500">{qLabel} · generated {fmtDate(report.generatedAt)} · private & confidential</p>
          </div>
          <span className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ${styles.chip}`}>{report.score.label}</span>
        </div>

        {/* Executive summary */}
        <div className="mt-6 rounded-xl border border-indigo-100 bg-indigo-50/60 p-5">
          <p className="text-sm font-bold uppercase tracking-wide text-indigo-700">Executive summary</p>
          <p className="mt-2 text-[15px] leading-relaxed text-slate-700">{report.summaryParagraph}</p>
        </div>

        {/* Score */}
        <h2 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Posting-health score</h2>
        <div className="mt-3 flex flex-wrap items-center gap-6 rounded-xl border border-slate-200 p-5">
          <div className="flex items-center gap-4">
            <span className="text-5xl font-extrabold text-slate-900">{report.score.score ?? "—"}</span>
            <div>
              <p className="text-sm font-semibold text-slate-700">of 100</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {report.score.evidence} evidence · {report.summary.observationWindowDays} days of observation
              </p>
            </div>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tracked postings</p>
              <p className="font-bold text-slate-800">{report.summary.trackedPostings}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Relist rate</p>
              <p className="font-bold text-slate-800">{relistRatePct === null ? "—" : `${relistRatePct}%`}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Median days listed</p>
              <p className="font-bold text-slate-800">{report.summary.medianDaysListed ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Live now</p>
              <p className="font-bold text-slate-800">{report.summary.liveCount}</p>
            </div>
          </div>
        </div>

        {/* Score components */}
        <details className="group mt-4 rounded-xl border border-slate-200 bg-slate-50/60 px-5 py-4 open:bg-slate-50">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-bold uppercase tracking-wide text-slate-600 [&::-webkit-details-marker]:hidden">
            How this score was built
            <Icon name="chevronDown" className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-4 space-y-3">
            {report.score.components.map((c) => (
              <div key={c.signalId} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800">{c.label}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{c.observed}</p>
                  </div>
                  {c.maxPoints > 0 ? (
                    <p className={`shrink-0 text-sm font-bold ${c.points > 0 ? "text-rose-600" : "text-slate-500"}`}>
                      {c.points > 0 ? `−${c.points} of ${c.maxPoints}` : `0 of ${c.maxPoints}`}
                    </p>
                  ) : (
                    <p className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">context</p>
                  )}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{c.reason}</p>
              </div>
            ))}
          </div>
        </details>

        {/* Quarter trends */}
        <h2 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Quarter trends</h2>
        <p className="mt-1 text-xs text-slate-400">
          First vs last daily snapshot of the quarter that carries {report.company}'s per-company data. n/a until at least two
          snapshots exist — we never reconstruct history.
        </p>
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-4 py-3">Metric</th>
                <th scope="col" className="px-4 py-3">First</th>
                <th scope="col" className="px-4 py-3">Last</th>
                <th scope="col" className="px-4 py-3">Change</th>
                <th scope="col" className="px-4 py-3">Direction</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {report.trends.map((t) => (
                <tr key={t.metric}>
                  <td className="px-4 py-3 font-semibold text-slate-800">{t.label}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {fmtTrendValue(t, t.first)}
                    {t.firstDate && <span className="block text-xs text-slate-400">{fmtDate(t.firstDate)}</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {fmtTrendValue(t, t.last)}
                    {t.lastDate && <span className="block text-xs text-slate-400">{fmtDate(t.lastDate)}</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{t.delta === null ? "n/a" : `${t.delta > 0 ? "+" : ""}${t.format === "pct" ? `${Math.round(t.delta * 100)}%` : t.delta}`}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        t.direction === "n-a"
                          ? "bg-slate-100 text-slate-500"
                          : t.direction === "up"
                            ? "bg-emerald-50 text-emerald-700"
                            : t.direction === "down"
                              ? "bg-rose-50 text-rose-700"
                              : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {directionWord(t)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report.trends[0]?.samples < 2 && (
          <p className="mt-2 text-xs text-slate-400">
            Trend rows need two or more daily snapshots with your company's data in {qLabel} ({report.trends[0]?.samples ?? 0} found so far) —
            they'll fill in as the quarter's daily compiles accumulate.
          </p>
        )}

        {/* Fix recommendations */}
        <h2 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Fix recommendations</h2>
        {report.fixes.healthy ? (
          <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm leading-relaxed text-slate-700">
            <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <span>{report.fixes.healthyMessage}</span>
          </div>
        ) : (
          <ul className="mt-3 space-y-3">
            {report.fixes.fixes.map((fix) => (
              <li key={fix.id} className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
                <div className="flex items-start gap-2.5">
                  <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-snug text-slate-800">{fix.heading}</p>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600">{fix.action}</p>
                    {fix.affected.length > 0 && (
                      <p className="mt-1.5 text-xs font-medium text-slate-500">
                        Affected: {fix.affected.map((p) => p.title ?? "Title not readable").join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Benchmarks */}
        <h2 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">How you compare</h2>
        {!report.benchmarks ? (
          <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">Benchmark comparison is n/a this quarter.</p>
        ) : !report.benchmarks.comparable ? (
          <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">{report.benchmarks.note}</p>
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <th scope="col" className="px-4 py-3">Metric</th>
                  <th scope="col" className="px-4 py-3">Your value</th>
                  <th scope="col" className="px-4 py-3">Peer median</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {report.benchmarks.comparisons.map((c) => (
                  <tr key={c.metric}>
                    <td className="px-4 py-3 font-semibold text-slate-800">{c.label}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.company === null
                        ? "—"
                        : c.format === "days"
                          ? `${c.company} day${c.company === 1 ? "" : "s"}`
                          : c.format === "pct"
                            ? `${Math.round(c.company * 100)}%`
                            : String(c.company)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {c.peerMedian === null
                        ? "—"
                        : c.format === "days"
                          ? `${c.peerMedian} day${c.peerMedian === 1 ? "" : "s"}`
                          : c.format === "pct"
                            ? `${Math.round(c.peerMedian * 100)}%`
                            : String(c.peerMedian)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">
              {report.benchmarks.headline} — peers are other tracked companies in the same industry bucket (our classification).
            </p>
          </div>
        )}

        {/* Caveats */}
        <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
          <p className="font-semibold">What this report can and can't tell you</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Every number comes from postings this engine actually watched — an observed sample, not the whole job market.</li>
            <li>Boards that block automated reading (LinkedIn, Indeed, aggregators) are out of scope.</li>
            <li>A healthy score means we saw no ghost signals — not a guarantee every role is real or that candidates get replies.</li>
            <li>Declared posted dates are the company's own words; we only count what we observed ourselves.</li>
          </ul>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          HireClarity Data · quarterly reputation report · generated {fmtDate(report.generatedAt)} · observed sample
        </p>
      </article>
    </section>
  );
}

/* ---------------------------------- page ---------------------------------- */

type ViewState =
  | { phase: "loading" }
  | { phase: "done"; company: string | null; quarter: string; report: CompanyReport | null; quarters: string[] }
  | { phase: "error"; message: string };

/**
 * The quarterly reputation report page, wrapped in the company subscription
 * gate. Anonymous/free/seeker visitors see the gate panel; an active Company
 * subscriber whose email matches a tracked company sees their report.
 */
function ReportPage() {
  return (
    <SubscriptionGate tier="company" verify={verifyAccess}>
      <ReportContent />
    </SubscriptionGate>
  );
}

function ReportContent() {
  const [view, setView] = useState<ViewState>({ phase: "loading" });
  const loadSeq = useRef(0);

  async function load(quarter?: string) {
    const seq = ++loadSeq.current;
    setView({ phase: "loading" });
    try {
      const res = await loadReport({ data: { quarter } });
      if (seq !== loadSeq.current) return;
      if (res.ok) {
        setView(
          res.matched
            ? { phase: "done", company: res.company, quarter: res.quarter, report: res.report, quarters: res.quarters }
            : { phase: "done", company: null, quarter: "", report: null, quarters: [] }
        );
      } else {
        setView({ phase: "error", message: res.error });
      }
    } catch {
      if (seq !== loadSeq.current) return;
      setView({ phase: "error", message: "The report couldn't be loaded right now — please try again in a moment." });
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Header />
      <main className="min-h-[60vh] bg-slate-50/50 pb-20">
        <section className="relative overflow-hidden">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-50/80 via-white to-white" />
          <div className="relative mx-auto max-w-4xl px-4 pb-4 pt-14 sm:px-6 print:hidden">
            <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-xs font-semibold text-indigo-700">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
              For companies · your quarterly reputation report
            </p>
            <h1 className="mt-5 text-4xl font-extrabold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl">
              How your hiring looked this quarter
            </h1>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-600">
              Your private report: posting-health score, quarter trends, fix recommendations and honest industry
              benchmarks — built only from postings we actually watched.
            </p>
          </div>
        </section>

        {view.phase === "loading" && (
          <p role="status" className="mx-auto mt-10 max-w-md rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-center text-sm font-medium text-indigo-800">
            Preparing your report…
          </p>
        )}
        {view.phase === "error" && (
          <p role="alert" className="mx-auto mt-10 max-w-md rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-center text-sm font-medium text-rose-800">
            {view.message}
          </p>
        )}
        {view.phase === "done" && view.report && (
          <ReportDocument report={view.report} quarters={view.quarters} onPickQuarter={(q) => void load(q)} />
        )}
        {view.phase === "done" && !view.report && (
          <section aria-label="No matched company" className="mx-auto mt-10 max-w-2xl px-4 sm:px-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xl shadow-indigo-950/5 sm:p-10">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
                <Icon name="building" className="h-7 w-7 text-slate-400" />
              </div>
              <h2 className="mt-5 text-2xl font-extrabold tracking-tight text-slate-900">
                We couldn't match your account to a tracked company
              </h2>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-slate-600">
                To show you a report, we match your subscribed email against our tracked registry: the email's local part
                or its domain's first label must uniquely equal a tracked company's name (e.g. hiring@greenhouse.io →
                Greenhouse). If your address doesn't match a company we monitor, we won't guess — you'll still see your
                live dashboard below.
              </p>
              <a
                href="/company"
                className="mt-6 inline-flex items-center justify-center gap-2 rounded-full bg-indigo-600 px-7 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700"
              >
                Open the company dashboard
                <Icon name="arrowRight" className="h-4 w-4" />
              </a>
            </div>
          </section>
        )}
      </main>
      <footer className="border-t border-slate-800 bg-slate-950 print:hidden">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-10 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} HireClarity Data. Built openly, with honest copy.</p>
          <div className="flex items-center gap-4">
            <a href="/company" className="font-semibold text-indigo-400 transition-colors hover:text-indigo-300">
              Company dashboard
            </a>
            <a href="/" className="font-semibold text-indigo-400 transition-colors hover:text-indigo-300">
              Back to home
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
