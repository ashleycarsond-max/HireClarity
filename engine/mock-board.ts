/**
 * Local mock job board — a documented test fixture that proves relist
 * detection with real HTTP round-trips (200 → 404 → 200), without touching any
 * third-party site. Serves a permissive robots.txt and a fake posting page.
 *
 * Used by `bun run relist-demo`. Not used in production tracking.
 */

export interface MockBoard {
  url: string;
  setLive: (live: boolean) => void;
  isLive: () => boolean;
  stop: () => void;
}

const PAGE = (live: boolean): string => {
  const body = live
    ? `<html><head><title>Fixture Engineer at FixtureCorp</title>
       <script type="application/ld+json">{"@context":"https://schema.org/","@type":"JobPosting","title":"Fixture Engineer","datePosted":"2026-01-15","hiringOrganization":{"@type":"Organization","name":"FixtureCorp"},"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Fixtureville","addressRegion":"FI","addressCountry":"US"}}}</script>
       </head><body><h1>Fixture Engineer</h1><p>This is a fake posting used to exercise the HireClarity Data tracking engine.</p></body></html>`
    : `<html><head><title>Job not found</title></head><body><h1>404 — Job not found</h1></body></html>`;
  return body;
};

export function startMockBoard(port = 8890): MockBoard {
  let live = true;
  const server = Bun.serve({
    port,
    fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/jobs/fixture-1") {
        if (!live) return new Response("Job not found", { status: 404 });
        return new Response(PAGE(true), { headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${port}`,
    setLive: (v: boolean) => {
      live = v;
    },
    isLive: () => live,
    stop: () => {
      server.stop(true);
    },
  };
}
