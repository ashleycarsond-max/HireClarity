/**
 * Shared header + footer for the content pages (blog, companies, industries,
 * data). Keeps the navigation ring consistent: /check, /reports, /companies,
 * /industries, /blog, /data — with the four public-data destinations grouped
 * under a "Data" dropdown in the top ribbon (owner decision 2026-08-15), and
 * the blog's learn subjects under a "Learn" dropdown (owner decision 2026-08-15).
 */
import { useEffect, useRef, useState } from "react";
import { COVERAGE_FOOTER } from "./CoverageNote";
import { BLOG_POSTS } from "../generated/blog-content";

const DATA_LINKS = [
  { href: "/reports", label: "Reports" },
  { href: "/companies", label: "Companies" },
  { href: "/industries", label: "Industries" },
  { href: "/data", label: "Data hub" },
];

/** The blog's learn subjects — surfaced in the header (owner decision 2026-08-15). */
const LEARN_LINKS = BLOG_POSTS.map((p) => ({ href: `/blog/${p.slug}`, label: p.title }));

export function SiteHeader() {
  const [dataOpen, setDataOpen] = useState(false);
  const dataRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dataOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (dataRef.current && !dataRef.current.contains(e.target as Node)) {
        setDataOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDataOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dataOpen]);

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
        <nav className="flex items-center gap-2 sm:gap-3">
          <a
            href="/check"
            className="hidden rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 sm:inline-block"
          >
            Check a posting
          </a>
          <a
            href="/reports"
            className="hidden rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 sm:inline-block"
          >
            Reports
          </a>
          <a
            href="/data"
            className="hidden rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 sm:inline-block"
          >
            Data hub
          </a>
          <div ref={dataRef} className="relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={dataOpen}
              onClick={() => setDataOpen((v) => !v)}
              className="flex items-center gap-1 rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
            >
              Data
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
                className={`h-4 w-4 transition-transform ${dataOpen ? "rotate-180" : ""}`}
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            {dataOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-2 w-48 rounded-xl border border-slate-200 bg-white py-2 shadow-lg"
              >
                {DATA_LINKS.map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    role="menuitem"
                    onClick={() => setDataOpen(false)}
                    className="block px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-indigo-600"
                  >
                    {l.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
          <LearnDropdown />
        </nav>
      </div>
    </header>
  );
}

/** "Learn" dropdown — the blog's learn subjects, reachable from every header. */
export function LearnDropdown() {
  const [learnOpen, setLearnOpen] = useState(false);
  const learnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!learnOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (learnRef.current && !learnRef.current.contains(e.target as Node)) {
        setLearnOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLearnOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [learnOpen]);

  return (
    <div ref={learnRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={learnOpen}
        onClick={() => setLearnOpen((v) => !v)}
        className="flex items-center gap-1 rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
      >
        Learn
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className={`h-4 w-4 transition-transform ${learnOpen ? "rotate-180" : ""}`}
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {learnOpen ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-slate-200 bg-white py-2 shadow-lg"
        >
          <a
            href="/blog"
            role="menuitem"
            onClick={() => setLearnOpen(false)}
            className="block border-b border-slate-100 px-4 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-50 hover:text-indigo-600"
          >
            All articles
          </a>
          {LEARN_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              role="menuitem"
              onClick={() => setLearnOpen(false)}
              className="block px-4 py-2 text-sm font-medium leading-snug text-slate-700 transition-colors hover:bg-slate-50 hover:text-indigo-600"
            >
              {l.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-slate-800 bg-slate-950">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 md:grid-cols-3">
          <div>
            <p className="text-lg font-bold tracking-tight text-white">HireClarity Data</p>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-slate-400">
              Ghost jobs waste candidates&apos; time and companies&apos; reputations. We make hiring
              visible — for both sides.
            </p>
          </div>
          <nav aria-label="Data">
            <h3 className="text-sm font-semibold text-white">Data</h3>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              <li>
                <a href="/reports" className="transition-colors hover:text-white">
                  Monthly job-market reports
                </a>
              </li>
              <li>
                <a href="/companies" className="transition-colors hover:text-white">
                  Tracked companies
                </a>
              </li>
              <li>
                <a href="/industries" className="transition-colors hover:text-white">
                  Industries
                </a>
              </li>
              <li>
                <a href="/data" className="transition-colors hover:text-white">
                  Data hub
                </a>
              </li>
            </ul>
          </nav>
          <nav aria-label="Learn">
            <h3 className="text-sm font-semibold text-white">Learn</h3>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              <li>
                <a href="/blog" className="transition-colors hover:text-white">
                  Blog
                </a>
              </li>
              <li>
                <a href="/check" className="transition-colors hover:text-white">
                  Check a posting (free)
                </a>
              </li>
              <li>
                <a href="/" className="transition-colors hover:text-white">
                  Home
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <p className="mt-10 max-w-3xl text-xs leading-relaxed text-slate-500">{COVERAGE_FOOTER}</p>
        <div className="mt-6 flex flex-col gap-2 border-t border-slate-800 pt-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
          <p>© {year} HireClarity Data. All rights reserved.</p>
          <p>Live — built openly, with honest copy.</p>
        </div>
      </div>
    </footer>
  );
}
