/**
 * /company/report — SHELVED (owner decision 2026-08-14).
 *
 * The quarterly company reputation report was part of the retired Company tier. With the single $9 product, the report is off the nav and its URL
 * redirects to the homepage (honest: everything we track per company is
 * already public on /companies/<slug>). The old report implementation was
 * replaced by this redirect; it can be restored from git history for a future
 * relaunch (engine/company-report.ts stays in the repo, unreferenced by the
 * site).
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/company/report")({
  head: () => ({
    meta: [
      { title: "Quarterly company reputation report | HireClarity Data" },
      {
        name: "description",
        content:
          "Company analytics is shelved for now — everything we track per company (confidence scores, posting histories, per-signal breakdowns) is already public and free.",
      },
      { name: "robots", content: "noindex, follow" },
      { property: "og:title", content: "Quarterly company reputation report | HireClarity Data" },
      { property: "og:url", content: "https://hireclarity-data.vercel.app/company/report" },
      { property: "og:image", content: "https://hireclarity-data.vercel.app/og-image.png" },
    ],
    links: [{ rel: "canonical", href: "https://hireclarity-data.vercel.app/company/report" }],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
  component: () => null,
});
