import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/subscribe/success")({
  head: () => ({
    meta: [
      { title: "Subscription confirmed | HireClarity Data" },
      {
        name: "description",
        content:
          "Your HireClarity Data subscription is set up. Access is tied to the email you used at checkout; you can cancel anytime from the confirmation email Stripe sent you.",
      },
      { name: "robots", content: "noindex, follow" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "HireClarity Data" },
      { property: "og:title", content: "Subscription confirmed | HireClarity Data" },
      { property: "og:url", content: "https://hireclarity-data.vercel.app/subscribe/success" },
      { property: "og:image", content: "https://hireclarity-data.vercel.app/og-image.png" },
    ],
    links: [{ rel: "canonical", href: "https://hireclarity-data.vercel.app/subscribe/success" }],
  }),
  component: SuccessPage,
});

function SuccessPage() {
  return (
    <>
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
        </div>
      </header>
      <main>
        <section className="relative overflow-hidden">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-gradient-to-b from-indigo-50/80 via-white to-white" />
          <div className="relative mx-auto max-w-2xl px-4 pb-16 pt-16 sm:px-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xl shadow-indigo-950/5 sm:p-10">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50">
                <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7 text-emerald-600" aria-hidden="true">
                  <path d="m5 13 4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
                Subscription confirmed
              </h1>
              <p className="mt-4 text-lg leading-relaxed text-slate-600">
                Thanks for subscribing to HireClarity Data. Your subscription is now active, and
                Stripe has emailed you a receipt with a link to manage or cancel it anytime.
              </p>
              <ul className="mx-auto mt-8 max-w-md space-y-3 text-left text-sm text-slate-600">
                <li className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <span aria-hidden="true" className="mt-0.5 shrink-0">🔑</span>
                  <span>
                    <strong className="text-slate-900">Access is tied to your email.</strong>{" "}
                    Keep the email you checked out with — that's how subscription access is
                    verified on the check tool.
                  </span>
                </li>
                <li className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <span aria-hidden="true" className="mt-0.5 shrink-0">💳</span>
                  <span>
                    <strong className="text-slate-900">Billed monthly.</strong> HireClarity Data is
                    $9/month — one product for everyone, same specs. No trial, no hidden fees — cancel
                    anytime from the Stripe email.
                  </span>
                </li>
                <li className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <span aria-hidden="true" className="mt-0.5 shrink-0">📈</span>
                  <span>
                    Scores populate as tracking history builds; your watched postings are re-checked every
                    few hours.
                  </span>
                </li>
              </ul>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <a
                  href="/check"
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-indigo-600 px-7 py-3 text-base font-semibold text-white shadow-lg shadow-indigo-600/25 transition-colors hover:bg-indigo-700"
                >
                  Check a posting
                </a>
                <a
                  href="/"
                  className="inline-flex items-center justify-center rounded-full border border-slate-300 bg-white px-7 py-3 text-base font-semibold text-slate-700 transition-colors hover:border-indigo-300 hover:text-indigo-600"
                >
                  Back to home
                </a>
              </div>
            </div>
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
