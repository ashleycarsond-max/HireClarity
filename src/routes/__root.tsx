import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import appCss from "~/styles/app.css?url";

const SITE_URL = "https://hireclarity-data.vercel.app";
const TITLE = "Ghost Jobs: Spot Them Before You Apply | HireClarity Data";
const DESCRIPTION =
  "Is a job posting real? HireClarity Data tracks how long it's listed, how often it's reposted, and where it appears — one confidence score, public for every posting we track, with honest 'Insufficient data' states while history builds. Plus 5 free checks a month, then $9/month for unlimited.";
const OG_IMAGE_ALT =
  "HireClarity Data — dark card with the wordmark and the line: Know if a job posting is real before you apply.";

// Structured data: WebSite + Organization. Rendered as JSON-LD in <head>.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: "HireClarity Data",
      description: DESCRIPTION,
      publisher: { "@id": `${SITE_URL}/#organization` },
      // SearchAction → the check tool: "site:hireclarity-data.vercel.app <url>"
      // style queries resolve to the live /check endpoint (?url= auto-runs a check).
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${SITE_URL}/check?url={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "HireClarity Data",
      url: `${SITE_URL}/`,
      description: DESCRIPTION,
    },
  ],
};

// Structured data: FAQPage — mirrors the visible FAQ section on the landing page verbatim.
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "Do all postings have a score yet?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Scores populate as tracking history builds — a posting needs at least a few days of observations before the score moves off neutral. Postings we've just started watching honestly show 'Insufficient data'. Every tracked posting is re-reviewed every few hours, so scores firm up automatically as we watch.",
      },
    },
    {
      "@type": "Question",
      name: "What is a ghost job?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "A job posting that was never realistically going to be filled — listed for months, reposted to look fresh, spread across many boards, or left up after the role was cancelled.",
      },
    },
    {
      "@type": "Question",
      name: "How can I tell if a job posting is fake?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Look for postings that stay up for months, reappear after being taken down, or appear in identical form on many boards. HireClarity Data measures exactly those signals and turns them into one score.",
      },
    },
    {
      "@type": "Question",
      name: "Why do job postings stay up for months?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Roles can stay open for many reasons — a slow pipeline, an evergreen talent pool, or a posting left running after hiring paused. The posting itself rarely explains which; its history does.",
      },
    },
    {
      "@type": "Question",
      name: "Are reposted job listings a bad sign?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Not always — a role can be reposted because it changed. But frequent take-down-and-relist cycles are one of the clearest ghost-job signals, because they make an old posting look new.",
      },
    },
    {
      "@type": "Question",
      name: "How much does HireClarity Data cost?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Free: all published data is free and public — every posting's confidence score and history — plus 5 checks a month with sign-in. HireClarity Data: $9/month for everyone — unlimited checks, watchlists and alerts. No trial.",
      },
    },
  ],
};

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { name: "theme-color", content: "#4f46e5" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "HireClarity Data" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:url", content: `${SITE_URL}/` },
      { property: "og:image", content: `${SITE_URL}/og-image.png` },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: OG_IMAGE_ALT },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/og-image.png` },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      // NOTE: no canonical here — TanStack merges route heads by APPENDING
      // links (meta tags are deduped, links are not), so a root canonical would
      // duplicate the per-route canonical on every page. Each route sets its own.
    ],
    scripts: [
      {
        type: "application/ld+json",
        // Escape "</" so the string can never terminate the script tag early.
        children: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c"),
      },
    ],
  }),
  notFoundComponent: () => <div>Page not found</div>,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
