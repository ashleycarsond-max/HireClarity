import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { useEffect, useState } from "react";
import { SiteHeader } from "../components/SiteChrome";

import { Store } from "../../engine/store";
import { currentUserEmail } from "../server/auth";
import { isSubscribed } from "../server/subscriptions";
import { startCheckout } from "../lib/checkout";

export const Route = createFileRoute("/watchlist")({
  head: () => ({
    meta: [
      { title: "My Watchlist — Track Job Postings for Take-Downs & Relists | HireClarity Data" },
      {
        name: "description",
        content:
          "Your watched postings: live/removed/relisted status, days listed, and the last alert we sent. Watchlists and alerts are part of HireClarity Data — $9/month.",
      },
      { name: "robots", content: "noindex, nofollow" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "HireClarity Data" },
      { property: "og:title", content: "My Watchlist — Track Job Postings for Take-Downs & Relists | HireClarity Data" },
      {
        property: "og:description",
        content: "Your watched postings: live/removed/relisted status, days listed, and the last alert we sent.",
      },
      { property: "og:url", content: "https://hireclarity-data.vercel.app/watchlist" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "My Watchlist — Track Job Postings | HireClarity Data" },
      {
        name: "twitter:description",
        content: "Your watched postings: live/removed/relisted status, days listed, and the last alert we sent.",
      },
    ],
    links: [{ rel: "canonical", href: "https://hireclarity-data.vercel.app/watchlist" }],
  }),
  component: WatchlistPage,
});

/* ----------------------------- server function ---------------------------- */

export interface WatchlistItem {
  postingId: string;
  title: string | null;
  board: string | null;
  status: string;
  canonicalUrl: string | null;
  daysListed: number | null;
  lastAlertAt: string | null;
}

type WatchlistResult =
  | { gated: true; reason: "signin" | "nosub" }
  | { gated: false; email: string; watches: WatchlistItem[] };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Load the signed-in user's watchlist. HARD seeker gate — no early-access
 * bypass: watchlists and alerts are part of the $9 HireClarity Data product
 * and the free tier stays check-only. Identity ALWAYS from the hc_session
 * cookie (httpOnly).
 */
const loadWatchlist = createServerFn({ method: "POST" }).handler(async (): Promise<WatchlistResult> => {
  let sessionEmail: string | null = null;
  try {
    sessionEmail = await currentUserEmail(getRequest());
  } catch {
    sessionEmail = null;
  }
  if (!sessionEmail) return { gated: true, reason: "signin" };
  const subscribed = await isSubscribed("seeker", sessionEmail).catch((err: unknown) => {
    console.error("[watchlist] isSubscribed failed:", err);
    return false; // fail closed — never reveal a watchlist on a storage fault
  });
  if (!subscribed) return { gated: true, reason: "nosub" };

  const store = new Store();
  try {
    const rows = await store.listWatches(sessionEmail);
    const records = await store.getByPostingIds(rows.map((r) => r.postingId));
    const byId = new Map(records.map((r) => [r.postingId, r]));
    const now = new Date();
    const watches: WatchlistItem[] = rows.map((r) => {
      const rec = byId.get(r.postingId);
      let daysListed: number | null = null;
      if (rec) {
        const end = rec.status === "live" || rec.status === "relisted" ? now.getTime() : new Date(rec.lastSeenAt).getTime();
        daysListed = Math.max(0, Math.floor((end - new Date(rec.firstSeenAt).getTime()) / DAY_MS));
      }
      return {
        postingId: r.postingId,
        title: rec?.title ?? null,
        board: rec?.sourceBoard ?? null,
        status: rec?.status ?? "gone",
        canonicalUrl: rec?.canonicalUrl ?? null,
        daysListed,
        lastAlertAt: r.lastAlertAt,
      };
    });
    return { gated: false, email: sessionEmail, watches };
  } finally {
    store.close();
  }
});

/* ---------------------------------- UI ---------------------------------- */

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  live: { label: "Live", cls: "bg-emerald-50 text-emerald-700" },
  relisted: { label: "Relisted", cls: "bg-amber-50 text-amber-700" },
  removed: { label: "Removed", cls: "bg-rose-50 text-rose-700" },
  gone: { label: "Gone", cls: "bg-slate-100 text-slate-500" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function WatchlistGate({ reason }: { reason: "signin" | "nosub" }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [checkoutEmail, setCheckoutEmail] = useState("");
  const [subscribeState, setSubscribeState] = useState<"idle" | "starting" | "note">("idle");
  const [subscribeNote, setSubscribeNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { headers: { accept: "application/json" } })
      .then(async (r) => (r.ok ? ((await r.json()) as { email?: string }) : null))
      .then((b) => {
        if (alive && b?.email) {
          setCheckoutEmail(b.email);
          setEmail(b.email);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function requestLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setMessage("Enter your email to sign in.");
      setState("error");
      return;
    }
    setState("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed, from: "/watchlist" }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && body?.ok) {
        setState("sent");
        setMessage(null);
      } else {
        setState("error");
        setMessage(body?.error ?? "We couldn't send the sign-in email right now — please try again in a moment.");
      }
    } catch {
      setState("error");
      setMessage("We couldn't reach the sign-in service — please try again in a moment.");
    }
  }

  async function subscribe() {
    setSubscribeState("starting");
    setSubscribeNote(null);
    const res = await startCheckout("seeker", checkoutEmail || undefined);
    if (res.ok) {
      window.location.assign(res.url);
      return;
    }
    setSubscribeState("note");
    setSubscribeNote(
      res.error === "billing not configured yet"
        ? "Billing isn't set up yet — no charges today. Please try again shortly."
        : `${res.error} No charges were made.`
    );
  }

  return (
    <section aria-label="Subscribe to continue" className="mx-auto mt-10 max-w-xl px-4 sm:px-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xl shadow-indigo-950/5 sm:p-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50">
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 text-indigo-600" aria-hidden="true">
            <path d="M12 3v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M5 6.5 7 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M19 6.5 17 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
            <path d="M8 13.5h.01M12 13.5h.01M16 13.5h.01M8 17h.01M12 17h.01M16 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-slate-900">
          {reason === "signin" ? "Sign in to see your watchlist" : "Watchlists are part of HireClarity Data"}
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-600">
          {reason === "signin"
            ? "Your watchlist is tied to your account. Sign in with the email you subscribed with — or subscribe below if you haven't yet."
            : "Watchlists and alerts are part of HireClarity Data — $9/month. We watch postings you check and email you the moment one is taken down, relisted, or goes stale. The free tier stays check-only; published scores stay free and public."}
        </p>
        {reason === "signin" && (
          <form className="mt-8 flex flex-col gap-3" onSubmit={(e) => void requestLink(e)}>
            <label htmlFor="watchlist-email" className="sr-only">Email</label>
            <input
              id="watchlist-email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
            />
            <button
              type="submit"
              disabled={state === "sending"}
              className="w-full rounded-full border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-wait disabled:opacity-70"
            >
              {state === "sending" ? "Sending your link…" : "Email me a sign-in link"}
            </button>
          </form>
        )}
        {state === "sent" && (
          <div role="status" aria-live="polite" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            <p>Check your inbox — the link expires in 15 minutes.</p>
            <p className="mt-1 font-normal text-emerald-700">We emailed a single-use sign-in link. Click it and you'll come right back to your watchlist.</p>
          </div>
        )}
        {state === "error" && message && (
          <p role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
            {message}
          </p>
        )}
        <div className="mt-6 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
          <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
          or subscribe
          <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
        </div>
        <label htmlFor="watchlist-sub-email" className="sr-only">Email for the subscription</label>
        <input
          id="watchlist-sub-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com (for the subscription)"
          value={checkoutEmail}
          onChange={(e) => setCheckoutEmail(e.target.value)}
          className="mt-3 w-full rounded-full border border-slate-300 bg-white px-5 py-3 text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
        />
        <button
          type="button"
          onClick={() => void subscribe()}
          disabled={subscribeState === "starting"}
          className="mt-3 w-full rounded-full bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
        >
          {subscribeState === "starting" ? "Taking you to checkout…" : "Subscribe — $9/month"}
        </button>
        {subscribeState === "note" && subscribeNote && (
          <p role="status" aria-live="polite" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
            {subscribeNote}
          </p>
        )}
        <p className="mt-6 text-xs text-slate-400">
          Cancel anytime — no questions asked. After subscribing, sign in with the same email to unlock watchlists.
        </p>
      </div>
    </section>
  );
}

function WatchlistTable({ items }: { items: WatchlistItem[] }) {
  const [rows, setRows] = useState<WatchlistItem[]>(items);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(postingId: string) {
    if (busy) return;
    setBusy(postingId);
    setError(null);
    try {
      const res = await fetch("/api/watch/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postingId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Couldn't remove that watch — try again.");
        return;
      }
      setRows((prev) => prev.filter((r) => r.postingId !== postingId));
    } catch {
      setError("Couldn't reach the watch service — try again.");
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-xl shadow-indigo-950/5">
        <h2 className="text-xl font-bold text-slate-900">Nothing watched yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">
          Check a posting and hit <strong>Watch this posting</strong> — we'll email you the moment it's taken down,
          relisted, or goes stale.
        </p>
        <a
          href="/check"
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700"
        >
          Check a posting
        </a>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl shadow-indigo-950/5">
      {error && (
        <p role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm font-medium text-amber-800">
          {error}
        </p>
      )}
      <ul className="divide-y divide-slate-100">
        {rows.map((r) => {
          const st = STATUS_LABELS[r.status] ?? STATUS_LABELS.gone;
          return (
            <li key={r.postingId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{r.title ?? "Untitled posting"}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>{st.label}</span>
                  {r.board && <span>{r.board}</span>}
                  {r.daysListed !== null && <span>listed {r.daysListed} day{r.daysListed === 1 ? "" : "s"}</span>}
                  <span>last alert {fmtDate(r.lastAlertAt)}</span>
                </p>
                {r.canonicalUrl && (
                  <a href={r.canonicalUrl} target="_blank" rel="noopener noreferrer" className="mt-1 block truncate text-xs text-indigo-600 hover:text-indigo-800">
                    {r.canonicalUrl}
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => void remove(r.postingId)}
                disabled={busy === r.postingId}
                className="shrink-0 rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 transition-colors hover:border-rose-300 hover:text-rose-600 disabled:cursor-wait disabled:opacity-60"
              >
                {busy === r.postingId ? "Removing…" : "Remove watch"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WatchlistPage() {
  const [result, setResult] = useState<WatchlistResult | null>(null);

  useEffect(() => {
    let alive = true;
    loadWatchlist()
      .then((r) => {
        if (alive) setResult(r);
      })
      .catch(() => {
        if (alive) setResult({ gated: true, reason: "signin" });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <SiteHeader />
      <main className="bg-slate-50/60">
        <section className="mx-auto max-w-3xl px-4 pb-16 pt-12 sm:px-6">
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">My watchlist</h1>
          <p className="mt-3 text-base leading-relaxed text-slate-600">
            Postings you're watching — status, days listed, and when we last alerted you. We send at most one alert
            per posting per day, and only when something actually changes.
          </p>
          <div className="mt-8">
            {result === null ? (
              <div role="status" className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm font-medium text-slate-500">
                Loading your watchlist…
              </div>
            ) : result.gated ? (
              <WatchlistGate reason={result.reason} />
            ) : (
              <WatchlistTable items={result.watches} />
            )}
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
