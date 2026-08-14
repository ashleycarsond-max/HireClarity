/**
 * Stripe HTTP endpoints (server-only).
 *
 * The installed TanStack Start build (react-start 1.168.x) has no API-route
 * support (no `createAPIFileRoute`), so the two Stripe endpoints are handled
 * here, OUTSIDE the TanStack router, by the server wrappers:
 *   - serve.ts        (Bun, port 3000 — platform working site)
 *   - vercel-entry.ts (Node, Vercel render function)
 *
 * Both call handleStripeHttp(request) first; when it returns a Response the
 * request is served and never reaches the router.
 *
 * Endpoints:
 *   POST /api/stripe/checkout   { tier: 'seeker'|'company', email?: string }
 *       -> 200 { ok: true, url }                     (redirect the browser here)
 *       -> 503 { ok: false, error: 'billing not configured yet' }  (no keys)
 *       -> 400 { ok: false, error }                  (bad tier/email)
 *       -> 429 / 500 { ok: false, error }
 *   POST /api/stripe/webhook    (Stripe signature header + raw JSON body)
 *       -> 200 { received: true }                    (verified + persisted)
 *       -> 200 { received: true, note }              (webhook secret not set yet)
 *       -> 400 { received: false }                   (bad signature / body)
 *       -> 500 { received: false }                   (verified but storage failed
 *                                                     — Stripe will retry)
 */

import { normalizeEmail } from "../lib/email";
import {
  createCheckoutSession,
  handleStripeEvent,
  isBillingConfigured,
  isTier,
  verifyWebhook,
  type SubscriptionTier,
} from "./stripe";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/* --------------------- per-process checkout rate limit --------------------- */
// Best-effort abuse hygiene (each serverless instance has its own window —
// documented as a follow-up for real per-IP limits). 20 checkout attempts per
// IP per minute is generous for humans, throttles scrapers.

const CHECKOUT_LIMIT = { windowMs: 60_000, max: 20 };
const checkoutAttempts: { at: number; ip: string }[] = [];

function checkoutRateLimited(ip: string): boolean {
  const now = Date.now();
  while (checkoutAttempts.length > 0 && checkoutAttempts[0].at <= now - CHECKOUT_LIMIT.windowMs) {
    checkoutAttempts.shift();
  }
  const recent = checkoutAttempts.filter((a) => a.ip === ip);
  if (recent.length >= CHECKOUT_LIMIT.max) return true;
  checkoutAttempts.push({ at: now, ip });
  return false;
}

/* ------------------------------- endpoints -------------------------------- */

async function handleCheckout(request: Request): Promise<Response> {
  if (!isBillingConfigured()) {
    // Honest, documented unconfigured state: the pricing page shows the
    // email-capture fallback CTA when it sees this.
    return json({ ok: false, error: "billing not configured yet" }, 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "expected a JSON body" }, 400);
  }
  const b = body as { tier?: unknown; email?: unknown };

  if (!isTier(b.tier)) {
    return json({ ok: false, error: "unknown tier — expected 'seeker' or 'company'" }, 400);
  }
  const tier: SubscriptionTier = b.tier;

  let email: string | null = null;
  if (b.email !== undefined && b.email !== null) {
    if (typeof b.email !== "string" || !normalizeEmail(b.email)) {
      return json({ ok: false, error: "that email doesn't look valid — please double-check it" }, 400);
    }
    email = String(b.email).trim();
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (checkoutRateLimited(ip)) {
    return json({ ok: false, error: "too many attempts — please wait a minute and try again" }, 429);
  }

  const origin = new URL(request.url).origin;
  try {
    const { url } = await createCheckoutSession(tier, { origin, email });
    return json({ ok: true, url });
  } catch (err) {
    console.error("[stripe] checkout session failed:", err);
    return json({ ok: false, error: "couldn't start checkout — please try again in a moment" }, 500);
  }
}

async function handleWebhook(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ received: false, error: "could not read request body" }, 400);
  }

  const verified = verifyWebhook(raw, signature);

  if (verified.ok) {
    try {
      await handleStripeEvent(verified.event);
      return json({ received: true });
    } catch (err) {
      // Authentic event, but we failed to persist it — 500 so Stripe retries.
      console.error("[stripe] webhook processing failed:", err);
      return json({ received: false, error: "processing failed" }, 500);
    }
  }

  if (verified.reason === "not-configured") {
    // Decision (documented in billing-README.md): STRIPE_WEBHOOK_SECRET is not
    // set yet, so nothing can be verified or recorded. Return 200 with a note
    // so Stripe stops retrying while we are not set up; the endpoint itself
    // must never crash the site.
    return json({
      received: true,
      note: "webhook endpoint is live but STRIPE_WEBHOOK_SECRET is not configured — events are not being recorded yet",
    });
  }

  return json({ received: false, error: `invalid signature: ${verified.message ?? "unknown error"}` }, 400);
}

/**
 * Route Stripe HTTP requests; returns null when the request is not ours and
 * should continue to the normal site handler.
 */
export async function handleStripeHttp(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/api/stripe/checkout") {
    return handleCheckout(request);
  }
  if (request.method === "POST" && pathname === "/api/stripe/webhook") {
    return handleWebhook(request);
  }
  return null;
}
