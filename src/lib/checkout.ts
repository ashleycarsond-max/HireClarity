/**
 * Client-side checkout helper (pure browser code — never imports server
 * modules; talks to the POST /api/stripe/checkout endpoint via fetch).
 */

export type Tier = "seeker" | "company";

export type CheckoutResponse =
  | { ok: true; url: string }
  | { ok: false; error: string };

export async function startCheckout(tier: Tier, email?: string): Promise<CheckoutResponse> {
  let res: Response;
  try {
    res = await fetch("/api/stripe/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier, email: email?.trim() || undefined }),
    });
  } catch {
    return { ok: false, error: "Couldn't reach the checkout service — please try again." };
  }

  let body: { ok?: boolean; url?: string; error?: string } | null = null;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    body = null;
  }

  if (res.ok && body?.ok && typeof body.url === "string" && body.url.length > 0) {
    return { ok: true, url: body.url };
  }
  return { ok: false, error: body?.error ?? "Something went wrong starting checkout." };
}
