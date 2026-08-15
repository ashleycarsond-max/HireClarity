/**
 * CoverageNote — the honest observed-sample disclosure (HireClarity Data).
 *
 * One plain sentence, used in the site footer and on the tool pages: what we
 * track, what we can't, and that everything is an observed sample. Keep it
 * small and factual — this is a transparency note, not a marketing block.
 */

/** Full footer line. */
export const COVERAGE_FOOTER =
  "HireClarity Data tracks job postings on Greenhouse, Ashby and Lever boards and on company career pages. LinkedIn and Indeed restrict automated access and are not tracked, and Workable careers pages expose no parseable public board for automated readers (verified 2026-08-15) — our coverage is an observed sample.";

/** Short one-liner for the tool pages and the subscribe panel. */
export const COVERAGE_SHORT =
  "HireClarity Data tracks Greenhouse, Ashby and Lever boards plus company career pages. LinkedIn, Indeed and Workable are not tracked — our coverage is an observed sample.";

/** Small, unobtrusive disclosure block (tool pages). */
export function CoverageNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-slate-400 ${className}`}>{COVERAGE_SHORT}</p>
  );
}
