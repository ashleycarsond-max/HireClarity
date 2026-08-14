/**
 * SubscriptionGate — wraps a paid tool page in the access gate.
 *
 *  - Resolves access through the route's verifyAccess server fn, which reads
 *    the hc_session cookie server-side (httpOnly — the client can't fake it)
 *    and checks the subscriptions + usage tables in Neon.
 *  - /check (tier "seeker"): signed-out → "sign in" panel; signed-in with an
 *    active Job Seeker subscription → unlimited; signed-in without one → the
 *    free tier (5 scored checks/month); at the monthly limit → honest upgrade
 *    panel with the checkout CTA. The limit is ALSO enforced inside the check
 *    server fn itself, so it can't be bypassed client-side.
 *  - /company (tier "company"): only an active Company subscription unlocks
 *    it — the free tier does NOT unlock the company dashboard. Copy is honest
 *    about that.
 *  - "Sign out" calls POST /api/auth/logout (deletes the session row + clears
 *    the cookie) and re-checks access.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { startCheckout } from "../lib/checkout";
import { COVERAGE_SHORT } from "./CoverageNote";

export type AccessResult = {
  gated: boolean;
  allowed: boolean;
  error?: string;
  /** Why the user is gated: needs sign-in, monthly free limit hit, or no
   *  subscription for a tier the free tier doesn't unlock. */
  reason?: "signin" | "limit" | "nosub" | "unknown-tier";
  /** How access is granted when allowed: unlimited (paid) or free (5/mo). */
  plan?: "unlimited" | "free";
  /** Free tier: how many scored checks remain this month. */
  checksRemaining?: number;
};
export type VerifyFn = (opts: { data: { tier: string } }) => Promise<AccessResult>;
const TIER_COPY: Record<"seeker" | "company", { tool: string; plan: string; price: string; tierName: string }> = {
  seeker: {
    tool: "the job-seeker check tool",
    plan: "a Job Seeker subscription",
    price: "$9/month",
    tierName: "Job Seeker",
  },
  company: {
    tool: "the company posting-health dashboard",
    plan: "a Company subscription",
    price: "$149/month",
    tierName: "Company",
  },
};
type GateState =
  | { phase: "resolving" }
  | { phase: "open" }
  | { phase: "gate" }
  | { phase: "signin-sending" }
  | { phase: "signin-sent"; email: string }
  | { phase: "signin-error"; message: string }
  | { phase: "subscribe-starting" }
  | { phase: "subscribe-note"; message: string };
export function SubscriptionGate({
  tier,
  verify,
  children,
}: {
  tier: "seeker" | "company";
  verify: VerifyFn;
  children: ReactNode;
}) {
  const [state, setState] = useState<GateState>({ phase: "resolving" });
  const [access, setAccess] = useState<AccessResult | null>(null);
  const [signInEmail, setSignInEmail] = useState("");
  const [checkoutEmail, setCheckoutEmail] = useState("");
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  /** Re-resolve access from the session (server fn reads the request cookie). */
  const checkAccess = useCallback(async () => {
    try {
      const res = await verify({ data: { tier } });
      setAccess(res);
      setState(res.gated && !res.allowed ? { phase: "gate" } : { phase: "open" });
    } catch {
      // Fail closed: if the gate check errors, show the gate rather than
      // silently opening the tool.
      setState({ phase: "gate" });
    }
  }, [tier, verify]);
  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);
  // Non-blocking: learn the signed-in email for display (\"Signed in as X —\"
  // and for the signed-in gate panels). Never blocks the page if /me fails.
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { headers: { accept: "application/json" } })
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json()) as { email?: string };
        if (alive && typeof body.email === "string") {
          setSessionEmail(body.email);
          setCheckoutEmail((prev) => prev || body.email!);
        }
      })
      .catch(() => {
        // ignore — /me is display-only
      });
    return () => {
      alive = false;
    };
  }, []);
  const isSignedIn = Boolean(sessionEmail);
  if (state.phase === "open") {
    return (
      <>
        {children}
        {sessionEmail && (
          <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-full border border-slate-200 bg-white/95 py-1.5 pl-4 pr-1.5 text-xs font-medium text-slate-600 shadow-lg shadow-slate-950/10 backdrop-blur">
            <span className="max-w-40 truncate" title={sessionEmail}>
              Signed in as {sessionEmail}
            </span>
            {access?.plan === "free" && (
              <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 font-semibold text-indigo-700">
                Free plan
              </span>
            )}
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded-full border border-slate-300 px-3 py-1 font-semibold text-slate-700 transition-colors hover:border-rose-300 hover:text-rose-600"
            >
              Sign out
            </button>
          </div>
        )}
      </>
    );
  }
  const showPanel =
    state.phase === "gate" ||
    state.phase === "resolving" ||
    state.phase === "signin-sending" ||
    state.phase === "signin-sent" ||
    state.phase === "signin-error" ||
    state.phase === "subscribe-starting" ||
    state.phase === "subscribe-note";
  if (!showPanel) return <>{children}</>;
  const copy = TIER_COPY[tier];
  const atLimit = tier === "seeker" && access?.reason === "limit";
  async function requestLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = signInEmail.trim();
    if (!trimmed) {
      setState({ phase: "signin-error", message: "Enter your email to sign in." });
      return;
    }
    setState({ phase: "signin-sending" });
    // Returning the user to the page they were on after they click the link
    // (the verify endpoint only accepts same-site relative paths).
    const from =
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : undefined;
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed, from }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (res.ok && body?.ok) {
        setState({ phase: "signin-sent", email: trimmed });
      } else {
        // Honest failure: show the server's message (e.g. the 502 \"we couldn't
        // send the sign-in email\" — never a fake success).
        setState({
          phase: "signin-error",
          message:
            body?.error ?? "We couldn't send the sign-in email right now — please try again in a moment.",
        });
      }
    } catch {
      setState({
        phase: "signin-error",
        message: "We couldn't reach the sign-in service — please try again in a moment.",
      });
    }
  }
  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // The cookie is cleared by the browser on any successful logout response;
      // if the request failed entirely, the re-check below still resolves the
      // truth server-side.
    }
    setSessionEmail(null);
    setCheckoutEmail("");
    await checkAccess();
  }
  async function subscribe() {
    setState({ phase: "subscribe-starting" });
    const res = await startCheckout(tier, checkoutEmail || undefined);
    if (res.ok) {
      window.location.assign(res.url);
      return;
    }
    setState({
      phase: "subscribe-note",
      message:
        res.error === "billing not configured yet"
          ? "Billing isn't set up yet — no charges today. Please try again shortly."
          : `${res.error} No charges were made.`,
    });
  }
  const heading = atLimit
    ? "You've used your 5 free checks this month"
    : tier === "seeker"
      ? "Sign in to check postings"
      : "Subscribe to continue";
  const body = atLimit
    ? "Your 5 free posting checks for this month are used up. Job Seeker is $9/month for unlimited checks, watchlists and alerts — no trial. Subscribe to keep checking."
    : tier === "seeker"
      ? "Your first 5 posting checks each month are free — sign in to start. For unlimited checks, watchlists and alerts, Job Seeker is $9/month. Published scores stay free and public either way."
      : "The company posting-health dashboard is for active Company subscribers — $149/month. Your own data, private: your posting-health scores, hiring trends, external job tracking, alerts on any listing with confidence below 80, job posting clean-up, competitor benchmarking, and confidential quarterly reports. The free tier covers 5 posting checks on the check tool; it doesn't unlock this dashboard. Sign in with the email you subscribed with, or subscribe below.";
  return (
    <section aria-label="Subscribe to continue" className="mx-auto mt-10 max-w-xl px-4 sm:px-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xl shadow-indigo-950/5 sm:p-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50">
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 text-indigo-600" aria-hidden="true">
            <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-slate-900">{heading}</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-600">{body}</p>
        {sessionEmail && (
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-600">
            Signed in as <span className="font-bold text-slate-800">{sessionEmail}</span>
            {atLimit ? " — you're on the free plan (5 checks/month)." : ` — no active ${copy.tierName} subscription on this account.`}
            <button
              type="button"
              onClick={() => void signOut()}
              className="ml-1 rounded-full border border-slate-300 px-2.5 py-0.5 font-semibold text-slate-700 transition-colors hover:border-rose-300 hover:text-rose-600"
            >
              Sign out
            </button>
          </p>
        )}
        {!atLimit && !isSignedIn && (
          <form className="mt-8 flex flex-col gap-3" onSubmit={(e) => void requestLink(e)}>
            <label htmlFor="gate-email" className="sr-only">
              Email
            </label>
            <input
              id="gate-email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={signInEmail}
              onChange={(e) => setSignInEmail(e.target.value)}
              className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
            <button
              type="submit"
              disabled={state.phase === "signin-sending"}
              className="w-full rounded-full border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-wait disabled:opacity-70"
            >
              {state.phase === "signin-sending" ? "Sending your link…" : "Email me a sign-in link"}
            </button>
          </form>
        )}
        {state.phase === "signin-sent" && (
          <div role="status" aria-live="polite" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            <p>Check your inbox — the link expires in 15 minutes.</p>
            <p className="mt-1 font-normal text-emerald-700">
              We emailed a single-use sign-in link to {state.email}. Click it and you'll come
              right back here.
            </p>
            <button
              type="button"
              onClick={() => setState({ phase: "gate" })}
              className="mt-2 text-xs font-semibold text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
            >
              Didn't get it? Send another link
            </button>
          </div>
        )}
        {state.phase === "signin-error" && (
          <p role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
            {state.message}
          </p>
        )}
        {!atLimit && !isSignedIn && (
          <div className="mt-6 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
            or subscribe
            <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
          </div>
        )}
        <label htmlFor="subscribe-email" className="sr-only">
          Email for the subscription
        </label>
        <input
          id="subscribe-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com (for the subscription)"
          value={checkoutEmail}
          onChange={(e) => setCheckoutEmail(e.target.value)}
          className={`w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 ${atLimit || isSignedIn ? "mt-6" : "mt-3"}`}
        />
        <button
          type="button"
          onClick={() => void subscribe()}
          disabled={state.phase === "subscribe-starting"}
          className="mt-3 w-full rounded-full bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
        >
          {state.phase === "subscribe-starting" ? "Taking you to checkout…" : `Subscribe — ${copy.price}`}
        </button>
        {state.phase === "subscribe-note" && (
          <p role="status" aria-live="polite" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
            {state.message}
          </p>
        )}
        <p className="mt-6 text-xs text-slate-400">
          Cancel anytime — no questions asked. After subscribing, sign in with the same email to
          unlock the tool.
        </p>
        <p className="mt-4 border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-400">
          {COVERAGE_SHORT}
        </p>
      </div>
    </section>
  );
}
