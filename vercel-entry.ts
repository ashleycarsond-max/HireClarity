// Vercel Build Output API function entry.
//
// The Build Output Node launcher invokes the default export as a classic Node
// `(req, res)` handler — NOT a web handler. TanStack Start emits a portable web
// fetch handler (dist/server/server.js), so we adapt: Node IncomingMessage → web
// Request, run the fetch handler, stream the web Response back onto ServerResponse.
// Node 22 has global Request/Response/Headers/ReadableStream.
//
// Bundled (with its deps + the SSR handler's dynamic ./assets chunks) into
// .vercel/output/functions/render.func/index.mjs by build-vercel.sh.
import type { IncomingMessage, ServerResponse } from "node:http";

import handler from "./dist/server/server.js";
// Stripe endpoints (POST /api/stripe/checkout, POST /api/stripe/webhook) and
// auth endpoints (POST /api/auth/request, GET /api/auth/verify,
// POST /api/auth/logout, GET /api/auth/me) are served outside the TanStack
// router — the installed react-start build has no API-route support.
// See src/server/http-endpoints.ts and src/server/auth-http.ts.
import { handleAuthHttp } from "./src/server/auth-http.ts";
import { handleStripeHttp } from "./src/server/http-endpoints.ts";
import { handleCronHttp } from "./src/server/cron-http.ts";
import { handleReportHttp } from "./src/server/report-http.ts";
import { handleWatchHttp } from "./src/server/watch-http.ts";

const fetchHandler = handler as {
  fetch: (request: Request) => Response | Promise<Response>;
};

/** Stream a web Response onto a Node ServerResponse (shared by both paths). */
async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => res.setHeader(key, value));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

const toWebRequest = (req: IncomingMessage): Request => {
  const host = req.headers.host ?? "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const url = `${proto}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value != null) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: req as unknown as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
};

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const webReq = toWebRequest(req);
    // Cron + Report + Auth + Watch + Stripe endpoints first; anything else goes through the TanStack handler.
    const cronRes = await handleCronHttp(webReq);
    const reportRes = cronRes ?? (await handleReportHttp(webReq));
    const authRes = reportRes ?? (await handleAuthHttp(webReq));
    const watchRes = authRes ?? (await handleWatchHttp(webReq));
    const webRes = watchRes ?? ((await handleStripeHttp(webReq)) ?? (await fetchHandler.fetch(webReq)));
    await sendWebResponse(res, webRes);
  } catch (error) {
    // Log the detail server-side (captured by the host's function logs); never
    // return a stack trace to the public visitor of the site.
    console.error("[team-site] SSR request failed", error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end("Internal Server Error");
  }
}
