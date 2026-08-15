/**
 * WatchButton — "Watch this posting" toggle for HireClarity Data subscribers.
 *
 * Shown on /check results and the First Look card. Server-side enforcement
 * lives in the /api/watch/* endpoints (identity from the httpOnly hc_session
 * cookie; POST /add and /remove require an active HireClarity Data
 * subscription). The client only renders what the server says:
 *   - 200 from /api/watch/list  -> watching/not-watching toggle
 *   - 401 (anonymous) or 403 (free tier) -> the honest paywall variant
 *     ("Watchlists and alerts are part of HireClarity Data — $9/month" +
 *     subscribe)
 */
import { useCallback, useEffect, useState } from "react";
import { startCheckout } from "../lib/checkout";

type WatchState =
  | { phase: "loading" }
  | { phase: "ready"; watching: boolean }
  | { phase: "paywall" }
  | { phase: "error"; message: string };

export function WatchButton({ postingId, compact = false }: { postingId: string; compact?: boolean }) {
  const [state, setState] = useState<WatchState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [subscribeNote, setSubscribeNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await fetch("/api/watch/list", { headers: { accept: "application/json" } });
      if (res.status === 401 || res.status === 403) {
        setState({ phase: "paywall" });
        return;
      }
      if (!res.ok) {
        setState({ phase: "error", message: "Couldn't load your watch state — refresh the page." });
        return;
      }
      const body = (await res.json()) as { watching?: string[] };
      setState({ phase: "ready", watching: (body.watching ?? []).includes(postingId) });
    } catch {
      setState({ phase: "error", message: "Couldn't reach the watch service — refresh the page." });
    }
  }, [postingId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle() {
    if (busy || state.phase !== "ready") return;
    setBusy(true);
    try {
      const res = await fetch(`/api/watch/${state.watching ? "remove" : "add"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postingId }),
      });
      if (res.status === 401 || res.status === 403) {
        setState({ phase: "paywall" });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setState({ phase: "error", message: body?.error ?? "That didn't work — try again." });
        return;
      }
      setState({ phase: "ready", watching: !state.watching });
    } catch {
      setState({ phase: "error", message: "That didn't work — check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  async function subscribe() {
    setSubscribeNote(null);
    const res = await startCheckout("seeker");
    if (res.ok) {
      window.location.assign(res.url);
      return;
    }
    setSubscribeNote(
      res.error === "billing not configured yet"
        ? "Billing isn't set up yet — no charges today. Please try again shortly."
        : `${res.error} No charges were made.`
    );
  }

  if (state.phase === "paywall") {
    return (
      <div className={`rounded-xl border border-indigo-200 bg-indigo-50 p-4 ${compact ? "" : "mt-6"}`}>
        <p className="text-sm font-semibold text-slate-800">Watch this posting</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          Watchlists and alerts are part of <strong>HireClarity Data — $9/month</strong>. We'll email you the moment this
          posting is taken down, relisted, or goes stale.
        </p>
        <button
          type="button"
          onClick={() => void subscribe()}
          className="mt-3 inline-flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow shadow-indigo-600/25 transition-colors hover:bg-indigo-700"
        >
          Subscribe — $9/month
        </button>
        {subscribeNote && (
          <p role="status" className="mt-2 text-xs font-medium text-amber-800">{subscribeNote}</p>
        )}
      </div>
    );
  }

  const watching = state.phase === "ready" && state.watching;
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy || state.phase !== "ready"}
      aria-pressed={watching}
      className={`inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${
        watching
          ? "border border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-emerald-400 hover:bg-emerald-100"
          : "bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700"
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${watching ? "bg-emerald-500" : "bg-white/70"}`}
      />
      {busy ? "Working…" : state.phase === "loading" ? "Loading…" : watching ? "Watching — alerts on" : "Watch this posting"}
    </button>
  );
}
