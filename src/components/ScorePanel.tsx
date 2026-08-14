/**
 * Shared confidence-score UI — used by the public company pages (/companies/<slug>)
 * and the /check tool. The numeric score, label and per-signal components are all
 * DERIVED from engine/score.ts (scoreCore — the single rubric source), so every
 * surface shows the same numbers and the same honest language. Never fabricates:
 * "Insufficient data" (score 50) is the honest state for postings we haven't
 * watched long enough, and "n/a" means we genuinely couldn't observe a factor.
 */
import type { PostingScore } from "../../engine/score";
import type { ScoreComponent } from "../../engine/score";
export type ScoreLabel = PostingScore["label"];
export const LABEL_STYLES: Record<ScoreLabel, { chip: string; ring: string; ringColor: string }> = {
  "Looks real": {
    chip: "bg-emerald-50 text-emerald-700",
    ring: "stroke-emerald-500",
    ringColor: "#10b981",
  },
  "Watch it": {
    chip: "bg-amber-50 text-amber-700",
    ring: "stroke-amber-500",
    ringColor: "#f59e0b",
  },
  "Strong ghost signals": {
    chip: "bg-rose-50 text-rose-700",
    ring: "stroke-rose-500",
    ringColor: "#f43f5e",
  },
  "Insufficient data": {
    chip: "bg-slate-100 text-slate-600",
    ring: "stroke-slate-400",
    ringColor: "#94a3b8",
  },
};
export function ScoreRing({
  score,
  label,
  size = "lg",
}: {
  score: number;
  label: ScoreLabel;
  size?: "lg" | "sm";
}) {
  const styles = LABEL_STYLES[label];
  const pct = Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * 264;
  const box = size === "lg" ? "h-28 w-28" : "h-16 w-16";
  return (
    <div className={`relative ${box} shrink-0`}>
      <svg viewBox="0 0 100 100" className={`${box} -rotate-90`} aria-hidden="true">
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
/** Small inline label chip — used in table rows and cards where a ring is too heavy. */
export function ScoreChip({ label }: { label: ScoreLabel }) {
  const styles = LABEL_STYLES[label];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles.chip}`}>
      {label}
    </span>
  );
}
function ChevronIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/**
 * Expandable per-signal breakdown of the score — one row per rubric factor,
 * with the observed value, the contribution ("−N of M" plus a small bar), and
 * a plain-language reason. Renders for both scored and insufficient-data
 * results: in the insufficient case each factor honestly shows what we could
 * and couldn't observe yet, and the whole panel reads as neutral (no read
 * yet), never as a green "clean".
 */
export function ScoreBreakdown({
  components,
  insufficientData,
  compact = false,
}: {
  components: ScoreComponent[];
  insufficientData: boolean;
  compact?: boolean;
}) {
  return (
    <details
      className={`group rounded-xl border border-slate-200 bg-slate-50/60 px-5 py-4 open:bg-slate-50 ${compact ? "mt-3" : "mt-6"}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-bold uppercase tracking-wide text-slate-600 [&::-webkit-details-marker]:hidden">
        How this score was built
        <ChevronIcon className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-4 space-y-3">
        {components.map((c) => {
          const neutral = insufficientData || c.points === 0;
          return (
            <div key={c.signalId} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800">{c.label}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{c.observed}</p>
                </div>
                {c.maxPoints > 0 ? (
                  <div className="shrink-0 text-right">
                    <p className={`text-sm font-bold ${neutral ? "text-slate-500" : "text-rose-600"}`}>
                      {c.points > 0 ? `−${c.points} of ${c.maxPoints}` : `0 of ${c.maxPoints}`}
                    </p>
                    <div className="ml-auto mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${neutral ? "bg-slate-300" : "bg-rose-400"}`}
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
