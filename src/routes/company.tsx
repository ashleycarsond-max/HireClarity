import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { CompanyBenchmarks, CompanyDashboard, CompanyFixes } from "../../engine/company";
import type { BenchmarkComparison } from "../../engine/company";
import { companyDashboard, trackedCompanies } from "../../engine/company";
import type { ScoreComponent } from "../../engine/score";
import { Store } from "../../engine/store";
import { SubscriptionGate } from "../components/SubscriptionGate";
import type { AccessResult } from "../components/SubscriptionGate";
import { CoverageNote } from "../components/CoverageNote";
import { currentUserEmail } from "../server/auth";
import { earlyAccessFree } from "../server/gate";
import { isSubscribed } from "../server/subscriptions";

export const Route = createFileRoute("/company")({
  head: () => ({
    meta: [
      { title: "Company Posting Health: How Job Postings Look to Candidates | HireClarity Data" },
      {
        name: "description",
        content:
          "See how a company's job postings look to candidates and investors: days listed, take-down-and-relist cycles, board spread — built only from observed posting history. Reputation protection, not finger-wagging.",
      },
      { name: "robots", content: "index, follow" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "HireClarity Data" },
      { property: "og:title", content: "Company Posting Health: How Job Postings Look to Candidates | HireClarity Data" },
      {
        property: "og:description",
        content:
          "See how a company's job postings look to candidates and investors: days listed, take-down-and-relist cycles, board spread — built only from observed posting history.",
      },
      { property: "og:url", content: "https://hireclarity-data.vercel.app/company" },
      { property: "og:image", content: "https://hireclarity-data.vercel.app/og-image.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Company Posting Health: How Job Postings Look to Candidates | HireClarity Data" },
      {
        name: "twitter:description",
        content:
          "See how a company's job postings look to candidates and investors — built only from observed posting history.",
      },
    ],
    links: [{ rel: "canonical", href: "https://hireclarity-data.vercel.app/company" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebPage",
          "@id": "https://hireclarity-data.vercel.app/company",
          url: "https://hireclarity-data.vercel.app/company",
          name: "Company Posting Health | HireClarity Data",
          description:
            "How a company's job postings look to candidates and investors — built from observed posting history.",
          isPartOf: { "@id": "https://hireclarity-data.vercel.app/#website" },
          about: "job posting health",
        }).replace(/</g, "\\u003c"),
      },
    ],
  }),
  component: CompanyPage,
});

/* ----------------------------- server function ---------------------------- */

/**
 * Access gate for the company dashboard. With EARLY_ACCESS_FREE on the
 * dashboard is open to everyone. When off, access requires an ACTIVE company
 * subscription for the signed-in user — the free tier (5 posting checks a
 * month on /check) does NOT unlock this dashboard. Identity ALWAYS comes from
 * the hc_session cookie (httpOnly — the client can't fake it); there is no
 * email-keyed fallback anymore: sign-in is the only way in.
 * See billing-README.md "Auth".
 */
const verifyAccess = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { tier: string })
  .handler(async ({ data }): Promise<AccessResult> => {
    if (earlyAccessFree()) return { gated: false, allowed: true };
    const tier = data?.tier;
    if (tier !== "seeker" && tier !== "company") {
      return { gated: true, allowed: false, reason: "unknown-tier", error: "Unknown subscription tier." };
    }
    // Session-first identity: resolved from the request cookie, never from
    // client-supplied data. No session → gated with an honest prompt to sign in.
    let sessionEmail: string | null = null;
    try {
      sessionEmail = await currentUserEmail(getRequest());
    } catch {
      sessionEmail = null; // no HTTP request context — treat as signed out
    }
    if (!sessionEmail) {
      return { gated: true, allowed: false, reason: "signin", error: "Sign in to continue." };
    }
    const allowed = await isSubscribed("company", sessionEmail); // fail-closed on DB errors
    return { gated: true, allowed, reason: "nosub" };
  });

type CompanyResult =
  | { ok: true; companies: string[]; profile: CompanyDashboard | null; error: string | null }
  | { ok: false; companies: string[]; profile: null; error: string };

const loadCompanyProfile = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { name: string })
  .handler(async ({ data }): Promise<CompanyResult> => {
    // Reads the same Neon tracking store the check tool writes to. No
    // company-side monitoring workers yet — the dashboard shows whatever the
    // engine has already tracked.
    const store = new Store();
    try {
      const companies = await trackedCompanies(store);
      const name = (data?.name ?? "").trim();
      if (!name) {
        return { ok: true, companies, profile: null, error: "Type a company name to see its posting health." };
      }
      return { ok: true, companies, profile: await companyDashboard(store, name), error: null };
    } finally {
      store.close();
    }
  });

/* --------------------------------- icons --------------------------------- */

type IconName = "arrowRight" | "check" | "info" | "warning" | "search" | "xcircle" | "gauge" | "building" | "link" | "calendar" | "chevronDown";

const iconPaths: Record<IconName, ReactNode> = {
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  check: <path d="m5 13 4 4L19 7" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  warning: (
    <>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  xcircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
    </>
  ),
  gauge: (
    <>
      <path d="M12 14l4-4" />
      <path d="M5.6 18a8 8 0 1 1 12.8 0" />
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
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
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
    <header className="border-b border-slate-200/70 bg-white/85 backdrop-blur">
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
          <a href="/company/report" className="hidden rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 sm:inline-block">
            Quarterly report
          </a>
          <a href="/check" className="hidden rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 sm:inline-block">
            Check a posting
          </a>
          <a href="/" className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600">
            Back to home
          </a>
        </nav>
      </div>
    </header>
  );
}

/* ------------------------------- score visuals ----------------------------- */

const COMPANY_LABEL_STYLES: Record<string, { chip: string; ring: string; ringColor: string }> = {
  "Clean posting health": {
    chip: "bg-emerald-50 text-emerald-700",
    ring: "stroke-emerald-500",
    ringColor: "#10b981",
  },
  "Some signals worth watching": {
    chip: "bg-amber-50 text-amber-700",
    ring: "stroke-amber-500",
    ringColor: "#f59e0b",
  },
  "Posting health needs attention": {
    chip: "bg-rose-50 text-rose-700",
    ring: "stroke-rose-500",
    ringColor: "#f43f5e",
  },
  "Not enough postings tracked yet": {
    chip: "bg-slate-100 text-slate-600",
    ring: "stroke-slate-400",
    ringColor: "#94a3b8",
  },
};

function ScoreRing({ score, label }: { score: number; label: string }) {
  const styles = COMPANY_LABEL_STYLES[label] ?? COMPANY_LABEL_STYLES["Not enough postings tracked yet"];
  const pct = Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * 264;
  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg viewBox="0 0 100 100" className="h-28 w-28 -rotate-90">
        <circle cx="50" cy="50" r="42" fill="none" stroke="#e2e8f0" strokeWidth="10" />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke={styles.ringColor}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray="264"
          strokeDashoffset={String(264 - dash)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-slate-900">{score}</span>
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">of 100</span>
      </div>
    </div>
  );
}

const REASON_ICONS: Record<string, IconName> = { red: "warning", green: "check", neutral: "info" };
const REASON_COLORS: Record<string, string> = {
  red: "text-rose-600",
  green: "text-emerald-600",
  neutral: "text-slate-400",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

/* -------------------------------- dashboard -------------------------------- */

function StatCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1.5 text-xl font-bold text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

/**
 * Expandable per-signal breakdown of the company score — one row per
 * company-rubric factor, with the observed value, the contribution ("−N of M"
 * plus a small bar), and a plain-language reason. When there's no score yet
 * (fewer than 2 tracked postings) the whole panel reads as neutral — the
 * observation-window row explains honestly why no score exists.
 */
function ScoreBreakdown({ components, neutral }: { components: ScoreComponent[]; neutral: boolean }) {
  return (
    <details className="group mt-6 rounded-xl border border-slate-200 bg-slate-50/60 px-5 py-4 open:bg-slate-50">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-bold uppercase tracking-wide text-slate-600 [&::-webkit-details-marker]:hidden">
        How this score was built
        <Icon name="chevronDown" className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-4 space-y-3">
        {components.map((c) => {
          const isNeutral = neutral || c.points === 0;
          return (
            <div key={c.signalId} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800">{c.label}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{c.observed}</p>
                </div>
                {c.maxPoints > 0 ? (
                  <div className="shrink-0 text-right">
                    <p className={`text-sm font-bold ${isNeutral ? "text-slate-500" : "text-rose-600"}`}>
                      {c.points > 0 ? `−${c.points} of ${c.maxPoints}` : `0 of ${c.maxPoints}`}
                    </p>
                    <div className="ml-auto mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${isNeutral ? "bg-slate-300" : "bg-rose-400"}`}
                        style={{ width: `${Math.min(100, (c.points / c.maxPoints) * 100)}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">context</p>
                )}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{c.reason}</p>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/* ------------------------- recommended fixes (Batch 3A) ------------------------ */

/**
 * Structured fix recommendations — one card per weak rubric signal, each with
 * the affected postings (title + URL + board + observed value). Framed as
 * reputation protection, never finger-wagging. When no signal is weak the
 * healthy state is shown instead of an empty list.
 */
function RecommendedFixes({ fixes }: { fixes: CompanyFixes }) {
  return (
    <div className="mt-8">
      <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">Recommended fixes</h3>
      {fixes.healthy ? (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm leading-relaxed text-slate-700">
          <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>
            {fixes.healthyMessage}{" "}
            <span className="text-slate-500">
              The best way to keep it that way: only list roles that are actually open, and refresh or take them down
              the moment they close.
            </span>
          </span>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {fixes.fixes.map((fix) => (
            <div key={fix.id} className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
              <div className="flex items-start gap-2.5">
                <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold leading-snug text-slate-800">{fix.heading}</p>
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">{fix.action}</p>
                </div>
              </div>
              {fix.affected.length > 0 && (
                <details className="group mt-3 overflow-hidden rounded-lg border border-indigo-100 bg-white">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-xs font-bold uppercase tracking-wide text-indigo-700 [&::-webkit-details-marker]:hidden">
                    <span>
                      Affected posting{fix.affected.length === 1 ? "" : "s"} ({fix.affected.length})
                    </span>
                    <Icon name="chevronDown" className="h-3.5 w-3.5 shrink-0 text-indigo-400 transition-transform group-open:rotate-180" />
                  </summary>
                  <ul className="divide-y divide-slate-100 border-t border-slate-100">
                    {fix.affected.map((p) => (
                      <li key={p.postingId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2.5">
                        <div className="min-w-0">
                          {p.title ? (
                            <a
                              href={p.canonicalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm font-semibold text-slate-800 transition-colors hover:text-indigo-600"
                            >
                              {p.title}
                            </a>
                          ) : (
                            <span className="text-sm text-slate-500">Title not readable</span>
                          )}
                          <p className="text-xs text-slate-400">{p.board}</p>
                        </div>
                        <span className="shrink-0 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                          {p.observed}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-2.5 text-xs leading-relaxed text-slate-400">
        This profile reflects only what we can observe on public boards. Keeping your postings accurate is the version
        candidates and investors actually check.
      </p>
    </div>
  );
}

/* ----------------------- industry benchmarks (Batch 3A) ----------------------- */

function fmtBenchmarkValue(c: BenchmarkComparison): string {
  switch (c.format) {
    case "days":
      return c.company === null ? "—" : `${c.company} day${c.company === 1 ? "" : "s"}`;
    case "pct":
      return c.company === null ? "—" : `${Math.round(c.company * 100)}%`;
    default:
      return c.company === null ? "—" : String(c.company);
  }
}

function fmtPeerMedian(c: BenchmarkComparison): string {
  switch (c.format) {
    case "days":
      return c.peerMedian === null ? "—" : `${c.peerMedian} day${c.peerMedian === 1 ? "" : "s"}`;
    case "pct":
      return c.peerMedian === null ? "—" : `${Math.round(c.peerMedian * 100)}%`;
    default:
      return c.peerMedian === null ? "—" : String(c.peerMedian);
  }
}

function CompareRow({ c }: { c: BenchmarkComparison }) {
  const maxVal = Math.max(c.company ?? 0, c.peerMedian ?? 0);
  const companyW = maxVal > 0 ? ((c.company ?? 0) / maxVal) * 100 : 0;
  const peerW = maxVal > 0 ? ((c.peerMedian ?? 0) / maxVal) * 100 : 0;
  const aheadText =
    c.metric === "medianDaysListed"
      ? "Fresher than"
      : c.metric === "relistShare"
        ? "Lower relist share than"
        : "Ahead of";
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold text-slate-800">{c.label}</p>
        <p className="text-xs font-medium text-slate-400">{c.lowerIsBetter ? "lower is better" : "raw comparison"}</p>
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-xs font-semibold text-indigo-700 sm:w-28">You</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(0, Math.min(100, companyW))}%` }} />
          </div>
          <span className="w-20 shrink-0 text-right text-xs font-bold text-slate-700 sm:w-24">{fmtBenchmarkValue(c)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-xs font-medium text-slate-500 sm:w-28">Industry median</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-slate-400" style={{ width: `${Math.max(0, Math.min(100, peerW))}%` }} />
          </div>
          <span className="w-20 shrink-0 text-right text-xs font-semibold text-slate-500 sm:w-24">{fmtPeerMedian(c)}</span>
        </div>
      </div>
      {c.aheadPct !== null && c.aheadPct > 0 && c.lowerIsBetter && (
        <p className="mt-1.5 text-xs font-medium text-emerald-700">
          {aheadText} {c.aheadPct}% of tracked peers on this metric.
        </p>
      )}
    </div>
  );
}

/**
 * "How you compare" — the company's per-signal values vs the industry median
 * (peers = OTHER tracked companies in the same industry bucket; our own
 * classification, labeled honestly). With fewer than 3 comparable companies
 * the small-sample honesty note is shown instead of a fabricated comparison.
 */
function BenchmarksSection({ benchmarks }: { benchmarks: CompanyBenchmarks }) {
  return (
    <div className="mt-8">
      <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">How you compare</h3>
      {!benchmarks.comparable ? (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">
          {benchmarks.note}
        </div>
      ) : (
        <>
          <p className="mt-2 text-sm text-slate-600">
            Your metrics vs the median of {benchmarks.peerCount} tracked companies in {benchmarks.industry} —{" "}
            <span className="font-medium text-slate-700">observed sample</span>.
          </p>
          {benchmarks.freshness && (
            <p
              className={`mt-3 rounded-xl border p-3.5 text-sm leading-relaxed ${
                benchmarks.freshness.fresherThanPct > 0
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-amber-200 bg-amber-50 text-amber-900"
              }`}
            >
              {benchmarks.freshness.fresherThanPct > 0
                ? `Your median listing age (${benchmarks.freshness.companyDays} days) is fresher than ${benchmarks.freshness.fresherThanPct}% of tracked peers in your industry.`
                : `Your median listing age (${benchmarks.freshness.companyDays} days) is at or above the industry median (${benchmarks.freshness.peerMedianDays} days) — the comparison below shows the gap.`}
            </p>
          )}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {benchmarks.comparisons.map((c) => (
              <CompareRow key={c.metric} c={c} />
            ))}
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-slate-400">
            Industry is our own classification; peers are other tracked companies in that bucket, and every number
            comes from postings this engine actually watched. No comparison is shown when the tracked sample is too
            small to be honest.
          </p>
        </>
      )}
    </div>
  );
}

function Dashboard({ profile }: { profile: CompanyDashboard }) {
  const { score, summary, note } = profile;
  const styles = COMPANY_LABEL_STYLES[score.label] ?? COMPANY_LABEL_STYLES["Not enough postings tracked yet"];
  const relistRatePct = summary.relistRate === null ? null : Math.round(summary.relistRate * 100);

  return (
    <section aria-label={`Posting-health dashboard for ${profile.name}`} className="mx-auto mt-10 max-w-5xl px-4 sm:px-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-indigo-950/5 sm:p-8">
        {/* Score header */}
        <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
          {score.score !== null ? (
            <ScoreRing score={score.score} label={score.label} />
          ) : (
            <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full border-4 border-slate-200 bg-slate-50">
              <span className="text-2xl font-bold text-slate-400">—</span>
            </div>
          )}
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <Icon name="building" className="h-4 w-4" />
              Company posting-health score
            </p>
            <h2 className="mt-1.5 text-2xl font-extrabold tracking-tight text-slate-900">{profile.name}</h2>
            <p className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${styles.chip}`}>
              <Icon name="gauge" className="h-4 w-4" />
              {score.label}
            </p>
            {score.provisional && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">
                <Icon name="info" className="h-3.5 w-3.5" />
                Provisional — we just started watching
              </p>
            )}
            <p className="mt-2 text-sm text-slate-500">
              Evidence: {score.evidence} · {summary.observationWindowDays} day{summary.observationWindowDays === 1 ? "" : "s"} of observation
              {score.score === null ? " · no score until we track more postings" : ""}
            </p>
          </div>
        </div>

        <ScoreBreakdown components={score.components} neutral={score.score === null} />

        <RecommendedFixes fixes={profile.fixes} />

        {profile.benchmarks && <BenchmarksSection benchmarks={profile.benchmarks} />}

        {note && (
          <p className="mt-5 rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">{note}</p>
        )}

        {/* Signal summary */}
        <h3 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Signal summary</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCell
            label="Postings tracked"
            value={String(summary.trackedPostings)}
            sub={summary.trackedPostings === 1 ? "too few for a company read" : "enough for a company read"}
          />
          <StatCell
            label="Relist rate"
            value={relistRatePct === null ? "—" : `${relistRatePct}%`}
            sub={`${summary.relistedPostings} of ${summary.trackedPostings} posting${summary.trackedPostings === 1 ? "" : "s"} · ${summary.relistEvents} relist event${summary.relistEvents === 1 ? "" : "s"} observed`}
          />
          <StatCell
            label="Days listed"
            value={`${summary.medianDaysListed ?? "—"} median · ${summary.maxDaysListed ?? "—"} max`}
            sub="calendar days since first observed"
          />
          <StatCell
            label="Live vs removed"
            value={`${summary.liveCount} live · ${summary.removedCount} removed`}
            sub={`${summary.boards.join(" · ")} · ${summary.urls} URL${summary.urls === 1 ? "" : "s"}`}
          />
        </div>

        {/* Reasons */}
        <h3 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Why this score</h3>
        <ul className="mt-3 space-y-2.5">
          {profile.reasons.map((r, i) => (
            <li key={`${r.signal}-${i}`} className="flex items-start gap-2.5 text-sm text-slate-600">
              <Icon name={REASON_ICONS[r.kind]} className={`mt-0.5 h-4 w-4 shrink-0 ${REASON_COLORS[r.kind]}`} />
              <span>
                {r.text}
                {r.points > 0 && <span className="ml-1.5 font-semibold text-rose-600">(−{r.points})</span>}
              </span>
            </li>
          ))}
        </ul>

        {/* Per-posting table */}
        <h3 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">
          Tracked postings from {profile.name}
        </h3>
        <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th scope="col" className="px-4 py-3">Title</th>
                <th scope="col" className="px-4 py-3">First seen</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3">Days listed</th>
                <th scope="col" className="px-4 py-3">Relists</th>
                <th scope="col" className="px-4 py-3">Boards</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">Link</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {profile.postings.map((p) => (
                <tr key={p.postingId} className="align-top">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-800">{p.title ?? "Title not readable"}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {p.location ?? "Location not shown"}
                      {p.declaredMuchOlder && p.postedAt ? ` · declares posted ${fmtDate(p.postedAt)}` : ""}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{fmtDate(p.firstSeenAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        p.status === "removed"
                          ? "bg-rose-50 text-rose-700"
                          : p.status === "relisted"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{p.daysListed}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{p.relistCount}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">{p.boardsSeen.join(", ")}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    <a
                      href={p.canonicalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-semibold text-indigo-600 transition-colors hover:text-indigo-800"
                    >
                      Open <Icon name="link" className="h-3.5 w-3.5" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Honest caveats */}
        <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
          <p className="font-semibold">What this profile can and can't tell you</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Every number here comes from postings this engine actually watched: first observed {fmtDate(profile.postings[0]?.firstSeenAt ?? null)}, {summary.checksTotal} total observations.
            </li>
            <li>Boards that block automated reading (LinkedIn, Indeed, and most aggregators) are out of scope — postings that only exist there aren't in this profile yet.</li>
            <li>A clean profile means we saw no ghost signals — not a guarantee every role is real or that the company replies to candidates.</li>
            <li>Declared posted dates are the company's own words; we only count what we observed ourselves.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ empty state ------------------------------- */

function EmptyState({ name, companies }: { name: string; companies: string[] }) {
  return (
    <section aria-label="No data yet" className="mx-auto mt-10 max-w-3xl px-4 sm:px-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xl shadow-indigo-950/5 sm:p-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
          <Icon name="building" className="h-7 w-7 text-slate-400" />
        </div>
        <h2 className="mt-5 text-2xl font-extrabold tracking-tight text-slate-900">
          We haven't tracked {name} yet
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-600">
          Check a posting from {name} on the ghost-job tool and their profile starts building from real
          observations. Until then, we won't invent one.
        </p>
        <a
          href="/check"
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-full bg-indigo-600 px-7 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700"
        >
          Check a posting from {name}
          <Icon name="arrowRight" className="h-4 w-4" />
        </a>
        {companies.length > 0 && (
          <p className="mt-8 text-xs font-semibold uppercase tracking-wide text-slate-400">Companies we're watching</p>
        )}
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {companies.map((c) => (
            <a
              key={c}
              href={`/company?name=${encodeURIComponent(c)}`}
              className="rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
            >
              {c}
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------- page ---------------------------------- */

type ViewState =
  | { phase: "idle" }
  | { phase: "loading"; name: string }
  | { phase: "done"; name: string; profile: CompanyDashboard | null; companies: string[] }
  | { phase: "error"; message: string };

/**
 * The company dashboard, wrapped in the subscription gate. EARLY_ACCESS_FREE
 * on (default): gate never engages, dashboard open to everyone. Off: replaced
 * by the honest "Subscribe to continue" panel unless the checkout email has an
 * active company subscription.
 */
function CompanyPage() {
  return (
    <SubscriptionGate tier="company" verify={verifyAccess}>
      <CompanyDashboardPage />
    </SubscriptionGate>
  );
}

function CompanyDashboardPage() {
  const [name, setName] = useState("");
  const [view, setView] = useState<ViewState>({ phase: "idle" });
  const autoRan = useRef(false);

  async function loadCompany(target: string) {
    const trimmed = target.trim();
    if (!trimmed) {
      setView({ phase: "error", message: "Type a company name to see its posting health." });
      return;
    }
    setView({ phase: "loading", name: trimmed });
    try {
      const res = await loadCompanyProfile({ data: { name: trimmed } });
      if (res.ok) {
        setView({ phase: "done", name: trimmed, profile: res.profile, companies: res.companies });
      } else {
        setView({ phase: "error", message: res.error });
      }
    } catch {
      setView({ phase: "error", message: "The lookup failed on our side — please try again in a moment." });
    }
  }

  // Auto-load when arriving with ?name= (deep link from /check and elsewhere).
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search).get("name");
    if (q && q.trim()) {
      setName(q.trim());
      void loadCompany(q);
    } else {
      // Still surface tracked companies for the quick picks.
      void loadCompanyProfile({ data: { name: "" } }).then((res) => {
        if (res.ok) setView((v) => (v.phase === "idle" ? { phase: "done", name: "", profile: null, companies: res.companies } : v));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trackedCompanies = view.phase === "done" ? view.companies : [];

  return (
    <>
      <Header />
      <main>
        <section className="relative overflow-hidden">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-50/80 via-white to-white" />
          <div className="relative mx-auto max-w-3xl px-4 pb-12 pt-16 sm:px-6">
            <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-xs font-semibold text-indigo-700">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
              For companies · reputation protection, not finger-wagging
            </p>
            <h1 className="mt-6 text-4xl font-extrabold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl">
              How do your job postings look to candidates?
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
              Candidates and investors check your postings the same way ghost-job hunters do. This dashboard shows
              what they see — how long roles stay up, how often they're taken down and reposted, and where the same
              role appears — built only from real observations, with plain-language fixes.
            </p>

            <form
              className="mt-8 flex flex-col gap-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void loadCompany(name);
              }}
            >
              <label htmlFor="company-name" className="sr-only">
                Company name
              </label>
              <input
                id="company-name"
                type="text"
                required
                autoComplete="off"
                list="tracked-companies"
                placeholder="e.g. Greenhouse, Notion…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full flex-1 rounded-full border border-slate-300 bg-white px-5 py-3 text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
              <datalist id="tracked-companies">
                {trackedCompanies.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <button
                type="submit"
                disabled={view.phase === "loading"}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-indigo-600 px-7 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
              >
                {view.phase === "loading" ? "Loading…" : "View company profile"}
                <Icon name="arrowRight" className="h-4 w-4" />
              </button>
            </form>
            <CoverageNote className="mt-4" />

            {trackedCompanies.length > 0 && (
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className="text-sm text-slate-400">Tracking now:</span>
                {trackedCompanies.map((c) => (
                  <a
                    key={c}
                    href={`/company?name=${encodeURIComponent(c)}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3.5 py-1 text-sm font-semibold text-slate-600 transition-colors hover:border-indigo-300 hover:text-indigo-600"
                  >
                    <Icon name="building" className="h-3.5 w-3.5" />
                    {c}
                  </a>
                ))}
              </div>
            )}

            {view.phase === "loading" && (
              <div role="status" aria-live="polite" className="mt-6 flex items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm font-medium text-indigo-800">
                <Icon name="search" className="h-5 w-5 animate-pulse" />
                Aggregating what we've observed from {view.name}…
              </div>
            )}

            {view.phase === "error" && (
              <div role="alert" className="mt-6 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
                <Icon name="xcircle" className="mt-0.5 h-5 w-5 shrink-0" />
                <span>{view.message}</span>
              </div>
            )}
          </div>
        </section>

        {view.phase === "done" && view.profile && <Dashboard profile={view.profile} />}
        {view.phase === "done" && view.name && !view.profile && <EmptyState name={view.name} companies={view.companies} />}

        <section className="bg-white">
          <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
            <h2 className="flex items-center gap-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              <Icon name="calendar" className="h-7 w-7 text-indigo-600" />
              What shapes a company's score
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-slate-600">
              The score starts at 100 (no ghost signals observed) and points are subtracted only for red flags that
              were actually seen across the postings we track — never for things we couldn't check.
            </p>
            <ul className="mt-8 space-y-4">
              {[
                ["Taken down and reposted", "Relist cycles are the strongest ghost-job signal: −25 to −50 points depending on how many were observed."],
                ["Listed for months without change", "A median of 90+ days listed with no observed change to any posting: −15 to −30 points."],
                ["The same role everywhere", "A role on 2+ boards or at 2+ URLs: −10 to −20 each, capped at −30 combined."],
                ["Too few postings tracked", "With fewer than 2 tracked postings there is no score — one posting can't honestly represent a company's hiring practice."],
              ].map(([t, b]) => (
                <li key={t} className="flex gap-3.5">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                    <Icon name="info" className="h-4.5 w-4.5" />
                  </span>
                  <div>
                    <h3 className="font-bold text-slate-900">{t}</h3>
                    <p className="mt-1 text-slate-600">{b}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <footer className="border-t border-slate-800 bg-slate-950">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-10 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} HireClarity Data. Built openly, with honest copy.</p>
          <div className="flex items-center gap-4">
            <a href="/check" className="font-semibold text-indigo-400 transition-colors hover:text-indigo-300">
              Check a posting
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
