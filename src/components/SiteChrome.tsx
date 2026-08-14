/**
 * Shared header + footer for the content pages (blog, companies, industries,
 * data). Keeps the navigation ring consistent: /check, /reports, /blog, /data.
 */
import { COVERAGE_FOOTER } from "./CoverageNote";

export function SiteHeader() {
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
            href="/blog"
            className="hidden rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600 sm:inline-block"
          >
            Blog
          </a>
          <a
            href="/data"
            className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
          >
            Data
          </a>
        </nav>
      </div>
    </header>
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
