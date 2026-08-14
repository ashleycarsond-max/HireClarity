import { createFileRoute } from "@tanstack/react-router";

import { BLOG_POSTS } from "../../generated/blog-content";
import { SiteFooter, SiteHeader } from "../../components/SiteChrome";

const SITE_URL = "https://hireclarity-data.vercel.app";

const TITLE = "Blog: Ghost Jobs, Stale Postings & Job Posting Data | HireClarity Data";
const DESCRIPTION =
  "Guides from HireClarity Data on ghost jobs, stale and relisted postings, and how to tell if a job posting is real — written from the data we actually observe.";

export const Route = createFileRoute("/blog/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "HireClarity Data" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:url", content: `${SITE_URL}/blog` },
      { property: "og:image", content: `${SITE_URL}/og-image.png` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/og-image.png` },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/blog` }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "CollectionPage",
              "@id": `${SITE_URL}/blog`,
              url: `${SITE_URL}/blog`,
              name: TITLE,
              description: DESCRIPTION,
              isPartOf: { "@id": `${SITE_URL}/#website` },
              about: "ghost jobs",
            },
            {
              "@type": "ItemList",
              "@id": `${SITE_URL}/blog#posts`,
              name: "Blog posts",
              itemListElement: BLOG_POSTS.map((p, i) => ({
                "@type": "ListItem",
                position: i + 1,
                url: `${SITE_URL}/blog/${p.slug}`,
                name: p.title,
              })),
            },
          ],
        })
          .replace(/</g, "\u003c")
          .replace(/</g, "\u003c"),
      },
    ],
  }),
  component: BlogIndexPage,
});

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function BlogIndexPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">The HireClarity Data Blog</h1>
        <p className="mt-4 max-w-3xl text-lg leading-relaxed text-slate-600">
          What we learn from watching job postings every day — ghost jobs, stale listings, relisted roles, and how
          to tell a real posting from a time sink. Written from the <strong>observed sample</strong> we track, never
          from guesswork.
        </p>

        <div className="mt-10 space-y-6">
          {BLOG_POSTS.map((p) => (
            <a
              key={p.slug}
              href={`/blog/${p.slug}`}
              className="block rounded-xl border border-slate-200 bg-white p-6 transition-colors hover:border-indigo-300 hover:shadow-sm"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-xl font-bold tracking-tight text-slate-900">{p.title}</h2>
              </div>
              <p className="mt-1.5 text-xs font-medium text-slate-400">
                {fmtDate(p.date)} · {p.readingTimeMinutes} min read
              </p>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{p.description}</p>
              <p className="mt-3 text-sm font-semibold text-indigo-600">Read the post →</p>
            </a>
          ))}
        </div>

        <div className="mt-12 rounded-2xl bg-slate-900 p-8 text-center">
          <h2 className="text-2xl font-bold tracking-tight text-white">Enough reading — check a posting</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-300">
            Paste any job posting URL into the check tool for a confidence score with plain-language reasons. Your
            first 5 checks each month are free.
          </p>
          <a
            href="/check"
            className="mt-6 inline-block rounded-full bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
          >
            Check any posting — first 5 checks free
          </a>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
