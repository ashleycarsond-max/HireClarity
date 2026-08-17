import { createFileRoute, notFound } from "@tanstack/react-router";

import { BLOG_POSTS, postBySlug, type BlogPost } from "../generated/blog-content";
import { renderMarkdown } from "../lib/markdown";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

const SITE_URL = "https://hireclarity-data.vercel.app";

/**
 * Extract FAQ question/answer pairs from a post body. The FAQ section is an
 * "## Frequently asked questions" heading followed by **Question** lines with
 * answer paragraphs beneath each. Used to emit FAQPage JSON-LD on posts that
 * carry a real FAQ block (the site's first FAQPage usage).
 */
function parseFaq(bodyMd: string): { question: string; answer: string }[] {
  const lines = bodyMd.split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s+frequently asked questions\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const faq: { question: string; answer: string }[] = [];
  let current: { question: string; answer: string } | null = null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const q = /^\*\*(.+?)\*\*\s*$/.exec(line);
    if (q) {
      current = { question: q[1].trim(), answer: "" };
      faq.push(current);
    } else if (current) {
      // Plain-text answer: drop markdown emphasis markers, keep everything else.
      current.answer = [current.answer, line.replace(/\*\*/g, "")].filter(Boolean).join(" ").trim();
    }
  }
  return faq.filter((f) => f.question && f.answer);
}

export const Route = createFileRoute("/blog/$slug")({
  loader: ({ params }): BlogPost => {
    const post = postBySlug(params.slug);
    if (!post) throw notFound();
    return post;
  },
  head: ({ loaderData }) => {
    const post = loaderData;
    const canonical = `${SITE_URL}/blog/${post.slug}`;
    const title = `${post.title} | HireClarity Data`;
    const faq = parseFaq(post.bodyMd);
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": [
        ...(faq.length > 0
          ? [
              {
                "@type": "FAQPage",
                "@id": `${canonical}#faq`,
                url: canonical,
                isPartOf: { "@id": canonical },
                mainEntity: faq.map((f) => ({
                  "@type": "Question",
                  name: f.question,
                  acceptedAnswer: { "@type": "Answer", text: f.answer },
                })),
              },
            ]
          : []),
        {
          "@type": "BlogPosting",
          "@id": canonical,
          mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
          headline: post.title,
          description: post.description,
          datePublished: post.date,
          dateModified: post.date,
          keywords: post.keywords.join(", "),
          author: { "@type": "Organization", name: "HireClarity Data", url: `${SITE_URL}/` },
          publisher: { "@type": "Organization", name: "HireClarity Data", url: `${SITE_URL}/` },
        },
        {
          "@type": "WebPage",
          "@id": `${canonical}#webpage`,
          url: canonical,
          name: title,
          description: post.description,
          isPartOf: { "@id": `${SITE_URL}/#website` },
        },
      ],
    };
    return {
      meta: [
        { title },
        { name: "description", content: post.description },
        { name: "robots", content: "index, follow" },
        { property: "og:type", content: "article" },
        { property: "og:site_name", content: "HireClarity Data" },
        { property: "og:title", content: title },
        { property: "og:description", content: post.description },
        { property: "og:url", content: canonical },
        { property: "og:image", content: `${SITE_URL}/og-image.png` },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: post.description },
        { name: "twitter:image", content: `${SITE_URL}/og-image.png` },
      ],
      links: [{ rel: "canonical", href: canonical }],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify(jsonLd)
            .replace(/</g, "\u003c")
            .replace(/</g, "\u003c"),
        },
      ],
    };
  },
  component: BlogPostPage,
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

function BlogPostPage() {
  const post = Route.useLoaderData();
  const others = BLOG_POSTS.filter((p) => p.slug !== post.slug);
  const html = renderMarkdown(post.bodyMd);

  return (
    <div className="min-h-screen bg-slate-50">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <nav aria-label="Breadcrumb" className="text-sm">
          <a href="/blog" className="font-semibold text-indigo-600 hover:underline">
            ← All posts
          </a>
        </nav>
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{post.title}</h1>
        <p className="mt-3 text-sm font-medium text-slate-400">
          {fmtDate(post.date)} · {post.readingTimeMinutes} min read · HireClarity Data
        </p>
        <p className="mt-4 text-lg leading-relaxed text-slate-600">{post.description}</p>

        <article
          className="blog-body mt-10 rounded-xl border border-slate-200 bg-white p-6 text-slate-700 sm:p-10"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <aside className="mt-10 rounded-2xl bg-slate-900 p-8">
          <h2 className="text-xl font-bold tracking-tight text-white">{post.ctaTitle}</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">{post.ctaBody}</p>
          <a
            href="/check"
            className="mt-5 inline-block rounded-full bg-indigo-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-indigo-500"
          >
            Open the check tool — first 5 checks free
          </a>
        </aside>

        <section className="mt-12" aria-label="More from the blog">
          <h2 className="text-xl font-bold tracking-tight text-slate-900">More from the blog</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {others.map((p) => (
              <a
                key={p.slug}
                href={`/blog/${p.slug}`}
                className="block rounded-xl border border-slate-200 bg-white p-5 transition-colors hover:border-indigo-300 hover:shadow-sm"
              >
                <h3 className="text-sm font-bold leading-snug text-slate-900">{p.title}</h3>
                <p className="mt-2 text-xs text-slate-400">
                  {fmtDate(p.date)} · {p.readingTimeMinutes} min read
                </p>
              </a>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
