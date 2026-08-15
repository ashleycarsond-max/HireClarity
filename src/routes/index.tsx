import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { startCheckout, type Tier } from "../lib/checkout";
import { normalizeEmail } from "../lib/email";
import { addSignup, type SignupResult } from "../server/signup";
import { COVERAGE_FOOTER } from "../components/CoverageNote";
import { LearnDropdown } from "../components/SiteChrome";
import { BLOG_POSTS } from "../generated/blog-content";

export const Route = createFileRoute("/")({
  head: () => ({
    links: [{ rel: "canonical", href: "https://hireclarity-data.vercel.app/" }],
  }),
  component: Home,
});

/* --------------------------- email signup fn --------------------------- */
// Defined inline in the route (same pattern as check.tsx) so the Neon import
// in ../server/signup stays out of the browser bundle.

const subscribeEmail = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { email?: unknown })
  .handler(async ({ data }): Promise<SignupResult> => {
    return addSignup(data?.email);
  });

/* ------------------------------- icons ------------------------------- */

type IconName =
  | "clock"
  | "info"
  | "eye"
  | "calendar"
  | "layers"
  | "refresh"
  | "gauge"
  | "search"
  | "check"
  | "xcircle"
  | "users"
  | "trend"
  | "star"
  | "bell"
  | "shield"
  | "chevronDown"
  | "arrowRight";

const iconPaths: Record<IconName, ReactNode> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 10 6-10 6L2 8z" />
      <path d="m2 14 10 6 10-6" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.3" />
      <path d="M21 3v6h-6" />
    </>
  ),
  gauge: (
    <>
      <path d="M12 14l4-4" />
      <path d="M5.6 18a8 8 0 1 1 12.8 0" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  check: <path d="m5 13 4 4L19 7" />,
  xcircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6" />
      <path d="m15 9-6 6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
      <path d="M21.5 20a6.5 6.5 0 0 0-4.6-6.2" />
    </>
  ),
  trend: (
    <>
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </>
  ),
  star: (
    <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z" />
  ),
  bell: (
    <>
      <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
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

/* ------------------------------ small bits ------------------------------ */

function Logo() {
  return (
    <a href="#top" className="flex items-center gap-2.5" aria-label="HireClarity Data home">
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
  );
}

const NAV_LINKS = [
  { href: "#problem", label: "The problem" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#job-seekers", label: "For job seekers" },
  { href: "#companies", label: "For companies" },
  { href: "/reports", label: "Reports" },
  { href: "/data", label: "Data hub" },
  { href: "#pricing", label: "Pricing" },
];

function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/70 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav aria-label="Primary" className="hidden items-center gap-7 lg:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-slate-600 transition-colors hover:text-indigo-600"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <span className="hidden lg:inline-block">
          <LearnDropdown />
        </span>
        <a
          href="/check"
          className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
        >
          Check a posting
        </a>
      </div>
    </header>
  );
}

/* Illustrative product preview — clearly labelled, not a live feature. */
function GhostScoreCard() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-indigo-950/5">
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
          Marketing Manager
        </span>
        <span className="text-xs text-slate-400">acme.example</span>
      </div>
      <div className="mt-6 flex items-center gap-5">
        <div className="relative h-24 w-24 shrink-0">
          <svg viewBox="0 0 100 100" className="h-24 w-24 -rotate-90">
            <circle cx="50" cy="50" r="42" fill="none" stroke="#e2e8f0" strokeWidth="10" />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="#e11d48"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray="264"
              strokeDashoffset="203"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold text-slate-900">23</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
              of 100
            </span>
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Confidence score
          </p>
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-sm font-semibold text-rose-700">
            <Icon name="xcircle" className="h-4 w-4" />
            Strong ghost signals
          </p>
          <p className="mt-1.5 text-xs text-slate-400">Likely a dead end</p>
        </div>
      </div>
      <ul className="mt-6 space-y-2.5 border-t border-slate-100 pt-5 text-sm text-slate-600">
        <li className="flex items-center gap-2.5">
          <Icon name="calendar" className="h-4 w-4 shrink-0 text-slate-400" />
          Listed 403 days — first seen 14 months ago
        </li>
        <li className="flex items-center gap-2.5">
          <Icon name="refresh" className="h-4 w-4 shrink-0 text-slate-400" />
          Taken down &amp; reposted 6 times
        </li>
        <li className="flex items-center gap-2.5">
          <Icon name="layers" className="h-4 w-4 shrink-0 text-slate-400" />
          Appears on 9 job boards
        </li>
      </ul>
      <p className="mt-5 text-xs leading-relaxed text-slate-400">
        Illustrative example — real scores are live now in the{" "}
        <a href="/check" className="font-semibold text-indigo-500 hover:underline">
          check tool
        </a>
        .
      </p>
    </div>
  );
}

/* ------------------------------- sections ------------------------------- */

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-50/80 via-white to-white"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:py-28">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-xs font-semibold text-indigo-700">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
            Live · subscriptions open
          </p>
          <h1 className="mt-6 text-4xl font-extrabold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl lg:text-[3.4rem]">
            Know if a job posting is real —{" "}
            <span className="text-indigo-600">before you apply.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-600">
            Ever applied to thirty jobs, heard nothing back, and wondered{" "}
            <em className="font-medium not-italic">are job postings even real?</em> HireClarity Data
            tracks postings across the web — how long they've been listed, how often they're
            reposted, everywhere they appear — and turns that into one clear confidence score.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a
              href="/check"
              className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700"
            >
              Check a posting
              <Icon name="arrowRight" className="h-4 w-4" />
            </a>
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
            >
              See how it works
            </a>
          </div>
          <p className="mt-6 text-sm text-slate-400">
            Every posting we track gets a public confidence score — some are still gathering history and honestly show 'Insufficient data'. No sign-in needed. Sign in for 5 free checks a
            month, or go unlimited with HireClarity Data, $9/month. No trial.
          </p>
        </div>
        <div className="mx-auto w-full max-w-md lg:max-w-none">
          <GhostScoreCard />
        </div>
      </div>
    </section>
  );
}

function Problem() {
  return (
    <section id="problem" className="bg-white">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-wider text-indigo-600">
            The problem
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Ghost jobs waste your applications — and quietly erode trust in the job market.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-slate-600">
            A ghost job is a posting that was never really going to be filled: listed for
            months, reposted until it looks fresh, spread across a dozen boards, or left up
            after the role was cancelled. Job seekers feel the cost first. Companies feel it
            too — eventually.
          </p>
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-8">
            <h3 className="text-xl font-bold text-slate-900">What they cost job seekers</h3>
            <ul className="mt-6 space-y-5">
              <li className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-600">
                  <Icon name="clock" className="h-4.5 w-4.5" />
                </span>
                <span className="text-slate-600">
                  Hours spent tailoring applications that never get a reply — time you can't
                  get back.
                </span>
              </li>
              <li className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-600">
                  <Icon name="xcircle" className="h-4.5 w-4.5" />
                </span>
                <span className="text-slate-600">
                  The creeping feeling that "no one is actually hiring" — even when great
                  companies are.
                </span>
              </li>
              <li className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-600">
                  <Icon name="eye" className="h-4.5 w-4.5" />
                </span>
                <span className="text-slate-600">
                  Fifty similar postings, no way to tell them apart — so strong applications
                  go to dead ends.
                </span>
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-8">
            <h3 className="text-xl font-bold text-slate-900">What they cost companies</h3>
            <ul className="mt-6 space-y-5">
              <li className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
                  <Icon name="users" className="h-4.5 w-4.5" />
                </span>
                <span className="text-slate-600">
                  Candidates who've been burned once don't come back — and they talk.
                </span>
              </li>
              <li className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
                  <Icon name="trend" className="h-4.5 w-4.5" />
                </span>
                <span className="text-slate-600">
                  Postings that look stale or fake read as disorganization to investors and
                  future hires.
                </span>
              </li>
              <li className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
                  <Icon name="star" className="h-4.5 w-4.5" />
                </span>
                <span className="text-slate-600">
                  Hiring reputations take years to build — and one ghost-job story can dent
                  them.
                </span>
              </li>
            </ul>
          </div>
        </div>

        <p className="mt-10 max-w-2xl text-base text-slate-500">
          Nobody tracks this systematically at market scale — we do, and the data is free and public.
          Job seekers can spot a ghost job at a glance, and companies can keep their postings
          honest.
        </p>
      </div>
    </section>
  );
}

function Solution() {
  const features = [
    {
      icon: "layers" as IconName,
      title: "Every board we track",
      body: "We track where a role appears across the ATS-hosted boards and career pages we monitor, from the day it's first listed — so one posting can't hide behind a dozen copies of itself.",
    },
    {
      icon: "calendar" as IconName,
      title: "Listing-age tracking",
      body: "How long has this posting really been live? We measure from first appearance, so \"just posted\" can't mask a role that's been open for a year.",
    },
    {
      icon: "refresh" as IconName,
      title: "Take-down & re-list detection",
      body: "The clearest ghost signal: postings taken down and reposted to look fresh. We detect that churn automatically, every time it happens.",
    },
    {
      icon: "gauge" as IconName,
      title: "A clear confidence score",
      body: "Every posting we've watched long enough gets one number from 0 to 100 — high means \"likely a real, active role\", low means \"apply elsewhere\". Postings still gathering history honestly show 'Insufficient data' instead of a judgment. The reasons are always shown.",
    },
  ];
  return (
    <section id="solution" className="bg-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-wider text-indigo-600">
            The solution
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            One score, built from continuous tracking.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-slate-600">
            A confidence score isn't a snapshot or a guess — it's the result of watching
            postings over time, across every board we track.
          </p>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {features.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm transition-shadow hover:shadow-md"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white">
                <Icon name={f.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-5 text-lg font-bold text-slate-900">{f.title}</h3>
              <p className="mt-2.5 leading-relaxed text-slate-600">{f.body}</p>
            </div>
          ))}
        </div>

        <p className="mt-10 text-sm text-slate-500">
          All of this is live in the{" "}
          <a href="/check" className="font-semibold text-indigo-600 hover:underline">
            check tool
          </a>{" "}
          — paste any posting URL and see it for yourself.
        </p>
      </div>
    </section>
  );
}

function HealthyScoreCard() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-indigo-950/5">
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
          Senior Product Designer
        </span>
        <span className="text-xs text-slate-400">northstar.example</span>
      </div>
      <div className="mt-6 flex items-center gap-5">
        <div className="relative h-24 w-24 shrink-0">
          <svg viewBox="0 0 100 100" className="h-24 w-24 -rotate-90">
            <circle cx="50" cy="50" r="42" fill="none" stroke="#e2e8f0" strokeWidth="10" />
            <circle
              cx="50"
              cy="50"
              r="42"
              fill="none"
              stroke="#059669"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray="264"
              strokeDashoffset="42"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-bold text-slate-900">84</span>
            <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
              of 100
            </span>
          </div>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Confidence score
          </p>
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-sm font-semibold text-emerald-700">
            <Icon name="check" className="h-4 w-4" />
            Looks real
          </p>
          <p className="mt-1.5 text-xs text-slate-400">Worth applying to</p>
        </div>
      </div>
      <ul className="mt-6 space-y-2.5 border-t border-slate-100 pt-5 text-sm text-slate-600">
        <li className="flex items-center gap-2.5">
          <Icon name="calendar" className="h-4 w-4 shrink-0 text-slate-400" />
          Listed 9 days — fresh posting
        </li>
        <li className="flex items-center gap-2.5">
          <Icon name="refresh" className="h-4 w-4 shrink-0 text-slate-400" />
          Never taken down or reposted
        </li>
        <li className="flex items-center gap-2.5">
          <Icon name="layers" className="h-4 w-4 shrink-0 text-slate-400" />
          On 2 boards — the company's own site plus one
        </li>
      </ul>
      <p className="mt-5 text-xs leading-relaxed text-slate-400">
        Illustrative example — real scores are live now in the{" "}
        <a href="/check" className="font-semibold text-indigo-500 hover:underline">
          check tool
        </a>
        .
      </p>
    </div>
  );
}

function JobSeekers() {
  const points = [
    {
      icon: "search" as IconName,
      title: "Paste a link, get a score",
      body: "One job posting URL is all you need. We read the full history behind it — not just what the page says today.",
      href: "/check",
    },
    {
      icon: "info" as IconName,
      title: "See why, not just a number",
      body: "Listing age, relists, board spread — the score always comes with the reasons that produced it.",
    },
    {
      icon: "bell" as IconName,
      title: "Watch your shortlist",
      body: "Roles you care about: we alert you when a posting is reposted, removed, or finally expires.",
    },
    {
      icon: "check" as IconName,
      title: "Apply where it counts",
      body: "Spend your hours on postings that are likely to end in a real offer — not on ghosts.",
    },
  ];
  return (
    <section id="job-seekers" className="bg-white">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-sm font-bold uppercase tracking-wider text-indigo-600">
              For job seekers
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Check any posting — or any company — before you apply.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-slate-600">
              Stop guessing which applications are worth your time. See the score, the reasons
              behind it, and the company's posting history — then decide in seconds.
            </p>
            <ul className="mt-8 space-y-6">
              {points.map((p) => {
                const inner = (
                  <>
                    <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                      <Icon name={p.icon} className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="font-bold text-slate-900">{p.title}</h3>
                      <p className="mt-1 text-slate-600">{p.body}</p>
                    </div>
                  </>
                );
                return (
                  <li key={p.title} className="flex gap-4">
                    {p.href ? (
                      <a href={p.href} className="group flex gap-4" aria-label={`${p.title} — open the check tool`}>
                        {inner}
                        <span className="sr-only">Open the check tool</span>
                      </a>
                    ) : (
                      inner
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-8 text-sm text-slate-500">
              The check tool is live —{" "}
              <a href="/check" className="font-semibold text-indigo-600 hover:underline">
                try it with any posting URL
              </a>
              . Watchlists and alerts are part of HireClarity Data — $9/month.
            </p>
          </div>
          <div className="mx-auto w-full max-w-md">
            <HealthyScoreCard />
          </div>
        </div>
      </div>
    </section>
  );
}

function Companies() {
  const points = [
    {
      icon: "eye" as IconName,
      title: "See how your postings look",
      body: "Listing ages, repost patterns, and board spread across all your open roles — the way candidates and investors actually see them.",
    },
    {
      icon: "refresh" as IconName,
      title: "Catch stale roles early",
      body: "Spot postings that linger or churn and clean them up — before they become a reputation problem.",
    },
    {
      icon: "shield" as IconName,
      title: "Reputation protection, not finger-wagging",
      body: "Everything we publish is public and framed to help — our job is to make you look good to candidates and investors, never to call you out. The $9 product adds unlimited checks, watchlists and alerts so your team can watch its own listings.",
    },
  ];
  return (
    <section id="companies" className="bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <p className="text-sm font-bold uppercase tracking-wider text-indigo-400">
              For companies
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Protect your hiring reputation — before it costs you.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-slate-300">
              Your postings are the first thing candidates — and investors — read about your
              hiring. We help you see them the way they do, so you can keep your posting health
              strong and fix small issues before they become reputation problems.
            </p>
            <ul className="mt-8 space-y-6">
              {points.map((p) => (
                <li key={p.title} className="flex gap-4">
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-300">
                    <Icon name={p.icon} className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="font-bold text-white">{p.title}</h3>
                    <p className="mt-1 text-slate-400">{p.body}</p>
                  </div>
                </li>
              ))}
            </ul>
            <a
              href="/companies"
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-base font-semibold text-slate-900 transition-colors hover:bg-slate-100"
            >
              See how your company looks to candidates
              <Icon name="arrowRight" className="h-4 w-4" />
            </a>
          </div>
          <div className="rounded-2xl border border-slate-700 bg-slate-800/70 p-8">
            <h3 className="text-xl font-bold text-white">A healthier posting pattern</h3>
            <p className="mt-2 text-sm text-slate-400">
              What a well-maintained hiring presence looks like — the goal, not the promise of
              instant perfection.
            </p>
            <ul className="mt-6 space-y-4 text-sm">
              {[
                "Every open role listed on your site and one or two boards — not eight",
                "Postings refreshed when the role changes, never recycled to look new",
                "Closed roles removed within days, not left up for months",
                "Candidates can see a company that's serious about hiring",
              ].map((t) => (
                <li key={t} className="flex gap-3 text-slate-300">
                  <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      title: "Paste a posting — or search a company",
      body: "Drop in a job link or a company name. We pull the posting's history: when it first appeared, everywhere it's listed, every time it's been reposted.",
    },
    {
      title: "Get your confidence score",
      body: "One clear number from 0 to 100 — with the reasons shown, so you know exactly why a posting scores the way it does.",
    },
    {
      title: "Apply with confidence — or move on",
      body: "Know before you invest an hour. And when you're watching roles, we alert you the moment a posting changes.",
    },
  ];
  return (
    <section id="how-it-works" className="bg-white">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-bold uppercase tracking-wider text-indigo-600">
            How it works
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Three steps to know where you stand.
          </h2>
        </div>
        <ol className="mt-12 grid gap-8 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className="relative rounded-2xl border border-slate-200 bg-slate-50/60 p-8">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-600 text-lg font-bold text-white">
                {i + 1}
              </span>
              <h3 className="mt-5 text-lg font-bold text-slate-900">{s.title}</h3>
              <p className="mt-2.5 leading-relaxed text-slate-600">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-10 text-center text-sm text-slate-500">
          The check tool is live —{" "}
          <a href="/check" className="font-semibold text-indigo-600 hover:underline">
            check any posting URL
          </a>{" "}
          free 5 times a month with sign-in, then $9/month for unlimited. Cancel anytime.
        </p>
      </div>
    </section>
  );
}

type SubscribeState =
  | { phase: "idle" }
  | { phase: "calling" }
  | { phase: "note"; message: string };

/**
 * Pricing-card CTA. Tries Stripe checkout first; when billing isn't configured
 * (no STRIPE_SECRET_KEY), falls back to the email-capture CTA with an honest
 * note — the locked prices are never changed.
 */
function SubscribeButton({ tier, accent }: { tier: Tier; accent: boolean }) {
  const [state, setState] = useState<SubscribeState>({ phase: "idle" });

  async function onClick() {
    if (state.phase === "calling") return;
    setState({ phase: "calling" });
    const res = await startCheckout(tier);
    if (res.ok) {
      window.location.assign(res.url);
      return;
    }
    setState({
      phase: "note",
      message:
        res.error === "billing not configured yet"
          ? "Billing isn't open yet — no charges today."
          : "We couldn't start checkout right now — no charges were made.",
    });
  }

  const cls = accent
    ? "mt-8 inline-flex w-full items-center justify-center rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
    : "mt-8 inline-flex w-full items-center justify-center rounded-full border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-wait disabled:opacity-70";

  return (
    <div>
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={state.phase === "calling"}
        className={cls}
      >
        {state.phase === "calling" ? "Taking you to checkout…" : "Subscribe"}
      </button>
      {state.phase === "note" && (
        <p role="status" aria-live="polite" className="mt-3 text-center text-xs leading-relaxed text-slate-500">
          {state.message}{" "}
          <a href="#get-access" className="font-semibold text-indigo-600 hover:underline">
            Join the report email list instead
          </a>
          .
        </p>
      )}
    </div>
  );
}

function Pricing() {
  const plans: Array<{
    name: string;
    tagline: string;
    price: string;
    tier?: Tier;
    cta: { kind: "checkout" } | { kind: "link"; href: string; label: string };
    features: string[];
    accent: boolean;
  }> = [
    {
      name: "Free",
      tagline: "All published data is free and public.",
      price: "$0",
      cta: { kind: "link", href: "/companies", label: "Browse tracked companies" },
      features: [
        "Every posting's confidence score and history — public, no sign-in. Postings still gathering history honestly show 'Insufficient data'",
        "5 posting checks a month with sign-in",
        "No card, no trial",
      ],
      accent: false,
    },
    {
      name: "HireClarity Data",
      tagline: "One product for everyone — $9/month, same specs.",
      price: "$9",
      tier: "seeker" as Tier,
      cta: { kind: "checkout" },
      features: [
        "Unlimited posting checks — paste any URL, get a confidence score and why",
        "Watchlists and alerts on stale, relisted, or vanished postings",
        "“Worth your time?” recommendation on every posting",
        "For companies: see how candidates experience your listings and protect your reputation",
      ],
      accent: true,
    },
  ];
  return (
    <section id="pricing" className="bg-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-bold uppercase tracking-wider text-indigo-600">Pricing</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Public data is free. The service is $9.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-slate-600">
            All published data is free and public — every posting's confidence score and history.
            HireClarity Data ($9/month, the same product for everyone) adds unlimited checks,
            watchlists and alerts — for job seekers who don't want to waste time on ghost postings,
            and for companies that want to see how candidates experience their listings. No trial —
            cancel anytime, no questions asked. Scores populate as tracking history builds — postings are
            re-reviewed every few hours, and honest 'not enough data yet' states are part of the design.
          </p>
        </div>
        <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
          {plans.map((p) => (
            <div
              key={p.name}
              className={
                p.accent
                  ? "rounded-2xl border-2 border-indigo-600 bg-white p-8 shadow-lg shadow-indigo-600/10"
                  : "rounded-2xl border border-slate-200 bg-white p-8"
              }
            >
              <h3 className="text-lg font-bold text-slate-900">{p.name}</h3>
              <p className="mt-1 text-sm text-slate-500">{p.tagline}</p>
              <p className="mt-5 text-3xl font-extrabold tracking-tight text-slate-900">
                {p.price}
                <span className="text-base font-semibold text-slate-500">/month</span>
              </p>
              <ul className="mt-6 space-y-3">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-3 text-sm text-slate-600">
                    <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    {f}
                  </li>
                ))}
              </ul>
              {p.cta.kind === "link" ? (
                <a
                  href={p.cta.href}
                  className="mt-8 inline-flex w-full items-center justify-center rounded-full border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
                >
                  {p.cta.label}
                </a>
              ) : (
                <SubscribeButton tier={p.tier!} accent={p.accent} />
              )}
            </div>
          ))}
        </div>
        <p className="mt-10 text-center text-sm text-slate-500">
          Prices are locked: Free is public data + 5 checks a month; HireClarity Data is $9/month for
          everyone — unlimited checks, watchlists and alerts.
        </p>
      </div>
    </section>
  );
}
function Faq() {
  const faqs = [
    {
      q: "Do all postings have a score yet?",
      a: "Scores populate as tracking history builds — a posting needs at least a few days of observations before the score moves off neutral. Postings we've just started watching honestly show 'Insufficient data'. Every tracked posting is re-reviewed every few hours, so scores firm up automatically as we watch.",
    },
    {
      q: "What is a ghost job?",
      a: "A job posting that was never realistically going to be filled — listed for months, reposted to look fresh, spread across many boards, or left up after the role was cancelled.",
    },
    {
      q: "How can I tell if a job posting is fake?",
      a: "Look for postings that stay up for months, reappear after being taken down, or appear in identical form on many boards. HireClarity Data measures exactly those signals and turns them into one score.",
    },
    {
      q: "Why do job postings stay up for months?",
      a: "Roles can stay open for many reasons — a slow pipeline, an evergreen talent pool, or a posting left running after hiring paused. The posting itself rarely explains which; its history does.",
    },
    {
      q: "Are reposted job listings a bad sign?",
      a: "Not always — a role can be reposted because it changed. But frequent take-down-and-relist cycles are one of the clearest ghost-job signals, because they make an old posting look new.",
    },
    {
      q: "How much does HireClarity Data cost?",
      a: "Free: all published data is free and public — every posting's confidence score and history — plus 5 checks a month with sign-in. HireClarity Data: $9/month for everyone — unlimited checks, watchlists and alerts. No trial.",
    },
  ];
  return (
    <section id="faq" className="bg-white">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-wider text-indigo-600">FAQ</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            What is a ghost job? (FAQ)
          </h2>
          <div className="mt-10 space-y-3">
            {faqs.map((f) => (
              <details
                key={f.q}
                className="group rounded-2xl border border-slate-200 bg-slate-50/60 px-6 py-4 open:bg-white"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <Icon
                    name="chevronDown"
                    className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 leading-relaxed text-slate-600">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

type EmailFormState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "success" }
  | { phase: "duplicate" }
  | { phase: "error"; message: string };

function EmailForm() {
  const [email, setEmail] = useState("");
  const [formState, setFormState] = useState<EmailFormState>({ phase: "idle" });

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    // Validate client-side first (same rules as the server) so bad input gets
    // an honest message without a round-trip.
    if (!normalizeEmail(trimmed)) {
      setFormState({
        phase: "error",
        message: "That doesn't look like a valid email address — please double-check it.",
      });
      return;
    }

    setFormState({ phase: "submitting" });
    try {
      const res = await subscribeEmail({ data: { email: trimmed } });
      if (res.status === "ok") {
        setEmail("");
        setFormState({ phase: "success" });
      } else if (res.status === "duplicate") {
        setFormState({ phase: "duplicate" });
      } else {
        setFormState({ phase: "error", message: "Something went wrong — please try again." });
      }
    } catch {
      setFormState({ phase: "error", message: "Something went wrong — please try again." });
    }
  }

  const status: { icon: IconName; cls: string; msg: string } | null = (() => {
    switch (formState.phase) {
      case "success":
        return {
          icon: "check" as IconName,
          cls: "border-emerald-200 bg-emerald-50 text-emerald-800",
          msg: "Thanks — you're on the list. We'll email you when the next monthly report is out.",
        };
      case "duplicate":
        return {
          icon: "info" as IconName,
          cls: "border-amber-200 bg-amber-50 text-amber-800",
          msg: "You're already on the list — we'll be in touch with the next report.",
        };
      case "error":
        return {
          icon: "xcircle" as IconName,
          cls: "border-rose-200 bg-rose-50 text-rose-800",
          msg: formState.message,
        };
      default:
        return null;
    }
  })();

  return (
    <div className="mx-auto max-w-xl">
      <form
        className="flex flex-col gap-3 sm:flex-row"
        noValidate
        onSubmit={(e) => {
          void handleSubmit(e);
        }}
      >
        <label htmlFor="email" className="sr-only">
          Email address
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full flex-1 rounded-full border border-slate-600 bg-slate-800 px-5 py-3 text-white placeholder:text-slate-500 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
        />
        <button
          type="submit"
          disabled={formState.phase === "submitting"}
          className="shrink-0 rounded-full bg-indigo-500 px-6 py-3 font-semibold text-white transition-colors hover:bg-indigo-400 disabled:cursor-wait disabled:opacity-70"
        >
          {formState.phase === "submitting" ? "Signing up…" : "Notify me"}
        </button>
      </form>
      {status && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-4 flex items-center justify-center gap-3 rounded-full border px-6 py-4 text-sm font-medium ${status.cls}`}
        >
          <Icon name={status.icon} className="h-5 w-5 shrink-0" />
          {status.msg}
        </div>
      )}
    </div>
  );
}

function EmailCapture() {
  return (
    <section id="get-access" className="bg-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Stay in the loop on ghost-job data.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-slate-300">
            One email a month with our latest public ghost-job report — no spam, no drip
            campaigns.
          </p>
        </div>
        <div className="mt-10">
          <EmailForm />
        </div>
        <p className="mx-auto mt-6 max-w-xl text-center text-xs text-slate-500">
          HireClarity Data is live — the check tool runs on real tracking
          data. This list is for our public ghost-job reports.
        </p>
      </div>
    </section>
  );
}

function BlogTeaser() {
  const posts = BLOG_POSTS.slice(0, 2);
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  };
  return (
    <section className="border-t border-slate-100 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">Latest from the blog</h2>
          <a href="/blog" className="text-sm font-semibold text-indigo-600 hover:underline">
            All posts →
          </a>
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          {posts.map((p) => (
            <a
              key={p.slug}
              href={`/blog/${p.slug}`}
              className="block rounded-xl border border-slate-200 p-6 transition-colors hover:border-indigo-300 hover:shadow-sm"
            >
              <p className="text-xs font-medium text-slate-400">{fmt(p.date)}</p>
              <h3 className="mt-2 text-lg font-bold leading-snug text-slate-900">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{p.description}</p>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-slate-800 bg-slate-950">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-4">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-400">
              Ghost jobs waste candidates' time and companies' reputations. We make hiring
              visible — for both sides.
            </p>
          </div>
          <nav aria-label="Product">
            <h3 className="text-sm font-semibold text-white">Product</h3>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              <li>
                <a href="#problem" className="transition-colors hover:text-white">
                  The problem
                </a>
              </li>
              <li>
                <a href="#solution" className="transition-colors hover:text-white">
                  The solution
                </a>
              </li>
              <li>
                <a href="#how-it-works" className="transition-colors hover:text-white">
                  How it works
                </a>
              </li>
              <li>
                <a href="#pricing" className="transition-colors hover:text-white">
                  Pricing
                </a>
              </li>
            </ul>
          </nav>
          <nav aria-label="Audiences">
            <h3 className="text-sm font-semibold text-white">Audiences</h3>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              <li>
                <a href="#job-seekers" className="transition-colors hover:text-white">
                  For job seekers
                </a>
              </li>
              <li>
                <a href="#companies" className="transition-colors hover:text-white">
                  For companies
                </a>
              </li>
              <li>
                <a href="#pricing" className="transition-colors hover:text-white">
                  Pricing
                </a>
              </li>
            </ul>
          </nav>
          <nav aria-label="Learn">
            <h3 className="text-sm font-semibold text-white">Learn</h3>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              <li>
                <a href="/reports" className="transition-colors hover:text-white">
                  Reports
                </a>
              </li>
              <li>
                <a href="/blog" className="transition-colors hover:text-white">
                  Blog
                </a>
              </li>
              <li>
                <a href="/data" className="transition-colors hover:text-white">
                  Data hub
                </a>
              </li>
              <li>
                <a href="/companies" className="transition-colors hover:text-white">
                  Tracked companies
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <p className="mt-10 max-w-3xl text-xs leading-relaxed text-slate-500">
          {COVERAGE_FOOTER}
        </p>
        <div className="mt-6 flex flex-col gap-2 border-t border-slate-800 pt-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} HireClarity Data. All rights reserved.</p>
          <p>Live — built openly, with honest copy.</p>
        </div>
      </div>
    </footer>
  );
}

/* --------------------------------- page --------------------------------- */

function Home() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-indigo-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <Problem />
        <Solution />
        <JobSeekers />
        <Companies />
        <HowItWorks />
        <Pricing />
        <Faq />
        <EmailCapture />
        <BlogTeaser />
      </main>
      <Footer />
    </>
  );
}
