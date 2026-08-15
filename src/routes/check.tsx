import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useEffect, useRef, useState } from "react";
import { SiteHeader } from "../components/SiteChrome";
import type { ReactNode } from "react";

import type { PostingScore } from "../../engine/score";
import { observeUrl } from "../../engine/observe";
import { scorePosting } from "../../engine/score";
import { buildSignals } from "../../engine/signals";
import { Store } from "../../engine/store";
import { buildFirstLook } from "../../engine/firstlook";
import type { FirstLook } from "../../engine/firstlook";
import { derivePostingId, normalizeUrl } from "../../engine/urls";
import { companySlugFor } from "../lib/slugs";
import { SubscriptionGate } from "../components/SubscriptionGate";
import type { AccessResult } from "../components/SubscriptionGate";
import { CoverageNote } from "../components/CoverageNote";
import { WatchButton } from "../components/WatchButton";
import { LABEL_STYLES, ScoreBreakdown, ScoreRing } from "../components/ScorePanel";
import { startCheckout } from "../lib/checkout";
import { currentUserEmail } from "../server/auth";
import { earlyAccessFree } from "../server/gate";
import { isSubscribed } from "../server/subscriptions";
import { FREE_MONTHLY_CHECKS, getChecksUsed, incrementChecksUsed } from "../server/usage";

export const Route = createFileRoute("/check")({
  head: () => ({
    meta: [
      { title: "Is This Job Posting Legit? Ghost-Job Check | HireClarity Data" },
      {
        name: "description",
        content:
          "Paste any job posting URL for a confidence score: how long it's listed, how often it's reposted, where it appears — reasons shown. Public data is free; 5 checks a month with sign-in, then $9/month for unlimited.",
      },
      { name: "robots", content: "index, follow" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "HireClarity Data" },
      { property: "og:title", content: "Is This Job Posting Legit? Ghost-Job Check | HireClarity Data" },
      {
        property: "og:description",
        content:
          "Paste any job posting URL for a confidence score: how long it's listed, how often it's reposted, where it appears — reasons shown. Public data is free; 5 checks a month with sign-in, then $9/month for unlimited.",
      },
      { property: "og:url", content: "https://hireclarity-data.vercel.app/check" },
      { property: "og:image", content: "https://hireclarity-data.vercel.app/og-image.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Is This Job Posting Legit? Ghost-Job Check | HireClarity Data" },
      {
        name: "twitter:description",
        content:
          "Paste any job posting URL for a confidence score: how long it's listed, how often it's reposted, where it appears — reasons shown.",
      },
    ],
    links: [{ rel: "canonical", href: "https://hireclarity-data.vercel.app/check" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebPage",
          "@id": "https://hireclarity-data.vercel.app/check",
          url: "https://hireclarity-data.vercel.app/check",
          name: "Is This Job Posting Legit? Ghost-Job Check | HireClarity Data",
          description:
            "Paste any job posting URL for a confidence score: how long it's listed, how often it's reposted, where it appears — reasons shown. Public data is free; 5 checks a month with sign-in, then $9/month for unlimited.",
          isPartOf: { "@id": "https://hireclarity-data.vercel.app/#website" },
          about: "ghost jobs",
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: "https://hireclarity-data.vercel.app/check?url={search_term_string}",
            },
            "query-input": "required name=search_term_string",
          },
        }).replace(/</g, "\\u003c"),
      },
    ],
  }),
  component: CheckPage,
});

/* ----------------------------- server function ---------------------------- */
/**
 * Access gate for the check tool. With EARLY_ACCESS_FREE on the tool is open
 * to everyone. When off, resolution order (identity ALWAYS from the hc_session
 * cookie — httpOnly, the client can't fake it):
 *   no session                  → gated: sign in
 *   active subscription         → open, unlimited
 *   session, no subscription    → open while checks_used < 5 this month
 *                                 (plan "free", checksRemaining included);
 *                                 at the limit → gated with reason "limit"
 * There is ONE product (HireClarity Data, $9/month — owner decision
 * 2026-08-14); the retired "company" tier is not a valid input and fails
 * closed. The limit is ALSO enforced inside checkPosting, so it can't be
 * bypassed client-side. See billing-README.md "Auth" and src/server/usage.ts.
 */
const verifyAccess = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { tier: string })
  .handler(async ({ data }): Promise<AccessResult> => {
    if (earlyAccessFree()) return { gated: false, allowed: true };
    const tier = data?.tier;
    if (tier !== "seeker") {
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
    // Subscriber → unlimited; otherwise the free tier.
    const subscribed = await isSubscribed("seeker", sessionEmail);
    if (subscribed) return { gated: false, allowed: true, plan: "unlimited" };
    const used = await getChecksUsed(sessionEmail); // throws → gate fails closed
    const remaining = Math.max(0, FREE_MONTHLY_CHECKS - used);
    if (remaining > 0) {
      return { gated: false, allowed: true, plan: "free", checksRemaining: remaining };
    }
    return {
      gated: true,
      allowed: false,
      reason: "limit",
      checksRemaining: 0,
      error: "You've used your 5 free checks this month.",
    };
  });
type CheckResult =
  | { ok: true; score: PostingScore; firstLook: FirstLook; plan?: "free" | "unlimited"; checksRemaining?: number }
  | { ok: false; error: string; code?: "limit" | "signin" | "other" };

/** The actual fetch → signals → score pipeline (shared by free + subscriber). */
async function runCheckPipeline(raw: string): Promise<CheckResult> {
  // Server-side work only: polite fetch (robots.txt, rate limit, no bypass),
  // then signals + score. The store is Neon serverless Postgres — safe to
  // open per request (stateless HTTP driver).
  const store = new Store();
  try {
    const existing = await store.getByPostingId(derivePostingId(normalizeUrl(raw)!));
    const observed = await observeUrl(raw, { store, isRecheck: Boolean(existing) });
    if (observed.transition === "blocked_by_robots") {
      return {
        ok: false,
        error:
          "This page tells robots not to read it, so we won't — no bypassing. Try a posting on the company's own career site or ATS board (Greenhouse, Ashby, Lever, Workable).",
      };
    }
    if (!observed.ok && observed.status === "error") {
      return { ok: false, error: `We couldn't fetch that page right now — ${observed.note ?? "try again in a minute"}.` };
    }
    if (!observed.postingId) {
      return { ok: false, error: "Something went wrong reading that posting — try again." };
    }
    const record = await store.getByPostingId(observed.postingId);
    if (!record) return { ok: false, error: "Something went wrong reading that posting — try again." };
    const signals = await buildSignals(store, record);
    const score = await scorePosting(store, signals);
    const firstLook = await buildFirstLook(store, record, observed);
    return { ok: true, score, firstLook };
  } finally {
    store.close();
  }
}
const checkPosting = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { url: string })
  .handler(async ({ data }): Promise<CheckResult> => {
    const raw = (data?.url ?? "").trim();
    if (!raw) return { ok: false, error: "Paste a job posting URL to check it." };
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { ok: false, error: "That doesn't look like a valid URL — paste the full link, e.g. https://boards.greenhouse.io/company/jobs/123." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: "Only http(s) URLs can be checked." };
    }
    if (!normalizeUrl(raw)) {
      return { ok: false, error: "We couldn't read that URL — paste the full link from the job posting." };
    }
    // Server-side access enforcement (cannot be bypassed from the client):
    // anonymous → blocked; active seeker subscriber → unlimited; otherwise the
    // free tier — allow while under 5 scored checks this month, and count a
    // check ONLY when it produces a score result (failed/invalid don't consume).
    if (!earlyAccessFree()) {
      let sessionEmail: string | null = null;
      try {
        sessionEmail = await currentUserEmail(getRequest());
      } catch {
        sessionEmail = null;
      }
      if (!sessionEmail) {
        return {
          ok: false,
          code: "signin",
          error: "Sign in to check postings — your first 5 checks each month are free.",
        };
      }
      const subscribed = await isSubscribed("seeker", sessionEmail);
      if (subscribed) {
        return runCheckPipeline(raw);
      }
      const used = await getChecksUsed(sessionEmail);
      const remaining = Math.max(0, FREE_MONTHLY_CHECKS - used);
      if (remaining <= 0) {
        return {
          ok: false,
          code: "limit",
          error: "You've used your 5 free checks this month — subscribe for unlimited checks, $9/month.",
        };
      }
      const result = await runCheckPipeline(raw);
      if (result.ok) {
        const newUsed = await incrementChecksUsed(sessionEmail);
        return {
          ...result,
          plan: "free",
          checksRemaining: Math.max(0, FREE_MONTHLY_CHECKS - newUsed),
        };
      }
      return result; // failed/invalid submission — NOT counted
    }
    return runCheckPipeline(raw);
  });
/* --------------------------------- icons --------------------------------- */

type IconName = "arrowRight" | "check" | "info" | "warning" | "search" | "xcircle" | "gauge" | "chevronDown";

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

/* -------------------------------- results --------------------------------- */

function Metadata({ score }: { score: PostingScore }) {
  const rows: { label: string; value: string }[] = [
    { label: "Title", value: score.title ?? "Not readable from this page" },
    { label: "Company", value: score.companyName ?? "Not shown on this page" },
    { label: "Location", value: score.location ?? "Not shown on this page" },
    { label: "First seen", value: fmtDate(score.firstSeenAt) },
    { label: "Listed for", value: `${score.daysListed} day${score.daysListed === 1 ? "" : "s"} (so far)` },
    { label: "Current status", value: score.status },
    { label: "Posted date (declared)", value: score.postedAt ? fmtDate(score.postedAt) : "Not declared on the page" },
  ];
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-4 border-b border-slate-100 pb-2">
          <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">{r.label}</dt>
          <dd className="text-right text-sm font-medium text-slate-700">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
function ResultCard({ score, firstLook, checkedAt }: { score: PostingScore; firstLook: FirstLook; checkedAt: string }) {
  const styles = LABEL_STYLES[score.label];
  return (
    <section aria-label="Check result" className="mx-auto mt-10 max-w-3xl">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-indigo-950/5 sm:p-8">
        <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
          <ScoreRing score={score.score} label={score.label} />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Confidence score</p>
            <p className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${styles.chip}`}>
              <Icon name="gauge" className="h-4 w-4" />
              {score.label}
            </p>
            <p className="mt-2 text-base font-semibold text-slate-800">{score.verdict}</p>
            <p className="mt-1 text-sm text-slate-500">
              Evidence: {score.evidence} · checked {fmtDate(checkedAt)}
            </p>
          </div>
        </div>

        <ScoreBreakdown components={score.components} insufficientData={score.insufficientData} />

        {firstLook &&
          (score.insufficientData ? (
            <FirstLookCard firstLook={firstLook} postingId={score.postingId} />
          ) : (
            <p className="mt-6 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-relaxed text-slate-600">
              <span className="font-semibold text-slate-700">First look:</span>{" "}
              {firstLook.title ?? "Title not readable"} · {firstLook.board} ·{" "}
              {firstLook.liveNow ? "live" : "gone"} · watching since {fmtDate(firstLook.firstSeenAt)}.
            </p>
          ))}

        {!score.insufficientData && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50/70 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-800">Want alerts on this posting?</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Watch it and we'll email you the moment it's taken down, relisted, or goes stale.
              </p>
            </div>
            <WatchButton postingId={score.postingId} />
          </div>
        )}

        <h3 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">Why this score</h3>
        <ul className="mt-3 space-y-2.5">
          {score.reasons.map((r, i) => (
            <li key={`${r.signal}-${i}`} className="flex items-start gap-2.5 text-sm text-slate-600">
              <Icon name={REASON_ICONS[r.kind]} className={`mt-0.5 h-4 w-4 shrink-0 ${REASON_COLORS[r.kind]}`} />
              <span>
                {r.text}
                {r.points > 0 && <span className="ml-1.5 font-semibold text-rose-600">(−{r.points})</span>}
              </span>
            </li>
          ))}
        </ul>

        <h3 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">The posting</h3>
        <div className="mt-3">
          <Metadata score={score} />
        </div>

        {score.company && (
          <>
            <h3 className="mt-8 text-sm font-bold uppercase tracking-wide text-slate-500">
              Company signal — {score.company.name}
            </h3>
            <div className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
              <p>
                {score.company.trackedPostings} posting{score.company.trackedPostings === 1 ? "" : "s"} tracked · relist
                rate {score.company.relistRate === null ? "—" : `${Math.round(score.company.relistRate * 100)}%`} ·
                median listed {score.company.medianDaysListed === null ? "—" : `${score.company.medianDaysListed} day${score.company.medianDaysListed === 1 ? "" : "s"}`}
              </p>
              {score.company.note && <p className="mt-2 text-slate-500">{score.company.note}</p>}
            </div>
            <p className="mt-3">
              <a
                href={`/companies/${companySlugFor(score.company.name)}`}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 transition-colors hover:text-indigo-800"
              >
                View {score.company.name}'s public posting history
                <Icon name="arrowRight" className="h-4 w-4" />
              </a>
            </p>
          </>
        )}

        <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
          <p className="font-semibold">What this score can and can't tell you</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              It is built only from what we actually observed: {score.reasons.find((r) => r.signal === "check_count")?.text.toLowerCase() ?? "a limited number of checks"}, starting {fmtDate(score.firstSeenAt)}.
            </li>
            <li>Boards that block automated reading (LinkedIn, Indeed, and most aggregators) are out of scope — if a posting only exists there, we can't check it yet.</li>
            <li>A clean score means we saw no ghost signals — not a guarantee the role will be filled or that the company will reply.</li>
            <li>If the page returns a 404 we report it honestly instead of guessing.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

/**
 * "First look — what we see right now": the real evidence for a posting with
 * no history yet. Shown only in the insufficient-data case, alongside the
 * neutral-50 score — it never fabricates signals; absent metadata is stated
 * as absent, and the timeline is honest about what a confident read needs.
 */
function FirstLookCard({ firstLook, postingId }: { firstLook: FirstLook; postingId: string }) {
  const started = firstLook.isFirstObservation
    ? "We've just started watching this one."
    : `We're already watching this posting — first observed ${fmtDate(firstLook.firstSeenAt)}.`;
  const registryNote =
    firstLook.inRegistry && firstLook.registryCompany
      ? firstLook.registryCount > 1
        ? `This company's board is in our monitored set — this posting is now one of ${firstLook.registryCount} we're watching for ${firstLook.registryCompany}.`
        : `This company's board is in our monitored set — this is the first posting we're watching for ${firstLook.registryCompany}.`
      : "This posting has just been added to our watch set.";
  const rows: { label: string; value: string }[] = [
    { label: "Title", value: firstLook.title ?? "We couldn't read a title from this page." },
    { label: "Live status", value: firstLook.liveNote },
    { label: "Board", value: firstLook.board },
    { label: "Posted", value: firstLook.ageNote },
    { label: "Watching", value: `${started} ${registryNote}` },
  ];
  return (
    <div className="mt-8 rounded-xl border border-indigo-100 bg-indigo-50/60 p-5">
      <div className="flex items-center gap-2">
        <Icon name="search" className="h-4 w-4 text-indigo-600" />
        <h3 className="text-sm font-bold uppercase tracking-wide text-indigo-900">First look — what we see right now</h3>
      </div>
      <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4 border-b border-indigo-100 pb-2">
            <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">{r.label}</dt>
            <dd className="text-right text-sm font-medium text-slate-700">{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 rounded-lg border border-indigo-200 bg-white px-4 py-3 text-sm leading-relaxed text-slate-600">
        <span className="font-semibold text-slate-800">What happens next:</span>{" "}
        A confident score needs time — we look for take-down/relist cycles and listing age. We need at
        least 3 observations over at least 3 days before the score can move off neutral, and a genuinely confident
        read takes about 2 weeks. Check back then, or subscribe to watch this posting and get alerted the moment it
        changes.
      </div>
      <div className="mt-4">
        <WatchButton postingId={postingId} compact />
      </div>
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */

type ViewState =
  | { phase: "idle" }
  | { phase: "loading"; url: string }
  | { phase: "done"; score: PostingScore; firstLook: FirstLook; checkedAt: string; url: string; plan?: "free" | "unlimited"; checksRemaining?: number }
  | { phase: "error"; message: string; code?: "limit" | "signin" | "other" };
/** Honest "5 free checks used up" panel with the $9 checkout CTA. */
function LimitPanel() {
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function subscribe() {
    if (starting) return;
    setStarting(true);
    const res = await startCheckout("seeker");
    if (res.ok) {
      window.location.assign(res.url);
      return;
    }
    setNote(
      res.error === "billing not configured yet"
        ? "Billing isn't set up yet — no charges today. Please try again shortly."
        : `${res.error} No charges were made.`
    );
    setStarting(false);
  }
  return (
    <div role="alert" className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 px-6 py-5">
      <p className="text-base font-bold text-slate-900">You've used your 5 free checks this month</p>
      <p className="mt-1 text-sm leading-relaxed text-slate-600">
        Subscribe to HireClarity Data for unlimited checks, watchlists, alerts and
        "worth your time?" recommendations — $9/month, no trial.
      </p>
      <button
        type="button"
        onClick={() => void subscribe()}
        disabled={starting}
        className="mt-4 inline-flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
      >
        {starting ? "Taking you to checkout…" : "Subscribe — $9/month"}
      </button>
      {note && (
        <p role="status" className="mt-3 text-xs font-medium text-amber-800">{note}</p>
      )}
    </div>
  );
}

/**
 * The check tool, wrapped in the subscription gate. EARLY_ACCESS_FREE on
 * (default): gate never engages, tool open to everyone. Off: replaced by the
 * honest "Subscribe to continue" panel unless the checkout email has an
 * active job-seeker subscription.
 */
function CheckPage() {
  return (
    <SubscriptionGate tier="seeker" verify={verifyAccess}>
      <CheckTool />
    </SubscriptionGate>
  );
}

function CheckTool() {
  const [url, setUrl] = useState("");
  const [view, setView] = useState<ViewState>({ phase: "idle" });
  const autoRan = useRef(false);

  async function runCheck(target: string) {
    const trimmed = target.trim();
    if (!trimmed) {
      setView({ phase: "error", message: "Paste a job posting URL first." });
      return;
    }
    try {
      const u = new URL(trimmed);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      setView({ phase: "error", message: "That doesn't look like a valid URL — paste the full link, e.g. https://boards.greenhouse.io/company/jobs/123." });
      return;
    }
    setUrl(trimmed);
    setView({ phase: "loading", url: trimmed });
    try {
      const res = await checkPosting({ data: { url: trimmed } });
      if (res.ok) {
        setView({
          phase: "done",
          score: res.score,
          firstLook: res.firstLook,
          checkedAt: new Date().toISOString(),
          url: trimmed,
          plan: res.plan,
          checksRemaining: res.checksRemaining,
        });
      } else {
        setView({ phase: "error", message: res.error, code: res.code ?? "other" });
      }
    } catch {
      setView({ phase: "error", message: "The check failed on our side — please try again in a moment.", code: "other" });
    }
  }

  // Auto-check when arriving with ?url= (powers the SearchAction schema).
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search).get("url");
    if (q && q.trim()) void runCheck(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <SiteHeader />
      <main>
        <section className="relative overflow-hidden">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-50/80 via-white to-white" />
          <div className="relative mx-auto max-w-3xl px-4 pb-12 pt-16 sm:px-6">
            <p className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-3.5 py-1.5 text-xs font-semibold text-indigo-700">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />
              Start free — 5 checks a month
            </p>
            <h1 className="mt-6 text-4xl font-extrabold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl">
              Is this job posting legit?
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
              Paste the posting URL and get a confidence score built from real observations — how long it's been
              listed, how often it's been taken down and reposted, and everywhere the same role appears. The reasons
              are always shown.
            </p>

            <form
              className="mt-8 flex flex-col gap-3 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                void runCheck(url);
              }}
            >
              <label htmlFor="posting-url" className="sr-only">
                Job posting URL
              </label>
              <input
                id="posting-url"
                type="url"
                required
                inputMode="url"
                autoComplete="off"
                placeholder="https://boards.greenhouse.io/company/jobs/123"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full flex-1 rounded-full border border-slate-300 bg-white px-5 py-3 text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
              <button
                type="submit"
                disabled={view.phase === "loading"}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-indigo-600 px-7 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
              >
                {view.phase === "loading" ? "Checking…" : "Check posting"}
                <Icon name="arrowRight" className="h-4 w-4" />
              </button>
            </form>
            <p className="mt-4 text-sm text-slate-400">
              We read the page politely — robots.txt respected, rate-limited, no bypassing. A first check can take a
              few seconds.
            </p>
            <CoverageNote className="mt-3" />

            {view.phase === "loading" && (
              <div role="status" aria-live="polite" className="mt-6 flex items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm font-medium text-indigo-800">
                <Icon name="search" className="h-5 w-5 animate-pulse" />
                Watching {view.url} — fetching, extracting, and scoring…
              </div>
            )}

            {view.phase === "error" &&
              (view.code === "limit" ? (
                <LimitPanel />
              ) : (
                <div role="alert" className="mt-6 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
                  <Icon name="xcircle" className="mt-0.5 h-5 w-5 shrink-0" />
                  <span>{view.message}</span>
                </div>
              ))}
            {view.phase === "done" && view.plan === "free" && (
              <p
                role="status"
                aria-live="polite"
                className="mt-5 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-700"
              >
                {view.checksRemaining && view.checksRemaining > 0
                  ? `${view.checksRemaining} of 5 free checks left this month`
                  : "0 of 5 free checks left this month — subscribe for unlimited checks, $9/month"}
              </p>
            )}
          </div>
        </section>

        {view.phase === "done" && <ResultCard score={view.score} firstLook={view.firstLook} checkedAt={view.checkedAt} />}

        <section className="bg-white">
          <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">What goes into the score</h2>
            <p className="mt-4 text-lg leading-relaxed text-slate-600">
              The score starts at 100 (no ghost signals observed) and points are subtracted only for red flags that
              were actually seen — never for things we couldn't check.
            </p>
            <ul className="mt-8 space-y-4">
              {[
                ["Taken down and reposted", "A posting observed removed and then reappearing is the strongest ghost-job signal: −25 to −50 points."],
                ["Listed for months without change", "First seen 90+ days ago and still live, with no observed change to the posting: −15 to −30 points."],
                ["The same role everywhere", "Identical role observed on multiple boards or at multiple URLs: −10 to −20 each, capped at −30 combined."],
                ["Insufficient data", "Fewer than 3 observations, or less than 3 days of watching, and no red flags — the score stays neutral (50) with an honest 'not enough data yet'. That's a feature: it's why watchlists matter."],
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

            <h2 className="mt-16 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">The honest caveats</h2>
            <ul className="mt-6 space-y-4 text-slate-600">
              <li className="flex gap-3.5">
                <Icon name="info" className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                <span>
                  <strong className="text-slate-900">We can only score what we can observe.</strong> Boards that block
                  automated reading — LinkedIn, Indeed, and most aggregators — are outside our reach, by design. A
                  posting that only exists there can't be checked yet.
                </span>
              </li>
              <li className="flex gap-3.5">
                <Icon name="info" className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                <span>
                  <strong className="text-slate-900">A clean score is not a guarantee.</strong> It means we observed no
                  ghost signals — not that the role will be filled, or that you'll get a reply.
                </span>
              </li>
              <li className="flex gap-3.5">
                <Icon name="info" className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                <span>
                  <strong className="text-slate-900">The history grows with time.</strong> A posting checked today for
                  the first time has no history yet — that's why the honest answer can be "not enough data". Watch it
                  and the score gets sharper.
                </span>
              </li>
            </ul>
          </div>
        </section>
      </main>
      <footer className="border-t border-slate-800 bg-slate-950">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-10 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} HireClarity Data. Built openly, with honest copy.</p>
          <a href="/" className="font-semibold text-indigo-400 transition-colors hover:text-indigo-300">
            Back to home
          </a>
        </div>
      </footer>
    </>
  );
}
