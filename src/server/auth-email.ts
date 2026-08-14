/**
 * Magic-link email delivery via Resend (server-only).
 *
 * - With RESEND_API_KEY set: POSTs to https://api.resend.com/emails with
 *   Bearer auth. `from` defaults to the Resend onboarding address and can be
 *   overridden with EMAIL_FROM (must be a verified sender in Resend).
 * - Without RESEND_API_KEY: sends NOTHING, logs the full verify link to the
 *   server console (dev mode — the CLI test harness relies on this) and
 *   returns a structured `sent: false` result. Callers must never report the
 *   email as sent in that case.
 *
 * The verify URL always uses the live host
 * (https://hireclarity-data.vercel.app) — never the old branded host.
 */

/** Live host — the origin used for all magic-link verify URLs. */
export const AUTH_ORIGIN = "https://hireclarity-data.vercel.app";

export interface MagicLinkEmailResult {
  sent: boolean;
  reason: "no-resend-key" | "resend-error" | null;
  /** Full absolute verify URL. Always present (used for logging/tests), but
   *  only meaningful when `sent` is false — the HTTP layer never returns it. */
  link: string;
  error?: string;
}

export async function sendMagicLinkEmail(
  email: string,
  rawToken: string,
  from?: string | null
): Promise<MagicLinkEmailResult> {
  // `from` is a same-site relative path (already sanitized by the caller — it
  // defaults to /check), so the link always carries an explicit destination
  // and returns the user to the page they were on after they tap Continue
  // (e.g. /check).
  const link = `${AUTH_ORIGIN}/api/auth/verify?token=${encodeURIComponent(rawToken)}${
    from ? `&from=${encodeURIComponent(from)}` : ""
  }`;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Dev mode: do NOT send anything; surface the link for local tooling.
    console.log(`[auth] RESEND_API_KEY not set — sign-in email NOT sent. Dev-only link for ${email}: ${link}`);
    return { sent: false, reason: "no-resend-key", link };
  }

  const sender = process.env.EMAIL_FROM ?? "HireClarity Data <onboarding@resend.dev>";
  const subject = "Your HireClarity Data sign-in link";
  // Sign-in is a two-step flow (scanner-safe): tap the link, then tap Continue
  // on the page it opens. The link itself never signs anyone in — the single
  // use is spent by the explicit Continue tap, so phone mail apps' link-safety
  // scanners can prefetch it safely.
  const text =
    `Hi there,\n\n` +
    `Here is your HireClarity Data sign-in link (single-use, expires in 15 minutes):\n\n` +
    `${link}\n\n` +
    `Tap the link, then tap Continue to sign in. If you didn't request this link, you can ignore this email — nothing changes on your account.\n\n` +
    `— HireClarity Data`;
  // Escape the link for the HTML href (it contains `&from=` separators).
  const htmlLink = link.replace(/&/g, "&amp;");
  const html =
    `<p>Hi there,</p>` +
    `<p>Here is your HireClarity Data sign-in link (single-use, expires in 15 minutes):</p>` +
    `<p><a href="${htmlLink}">Sign in to HireClarity Data</a></p>` +
    `<p>Tap the link, then tap <strong>Continue</strong> to sign in.</p>` +
    `<p>If you didn't request this link, you can ignore this email — nothing changes on your account.</p>` +
    `<p>— HireClarity Data</p>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: sender, to: [email], subject, text, html }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[auth] Resend refused the email (${res.status}): ${detail.slice(0, 300)}`);
      return { sent: false, reason: "resend-error", link, error: `resend http ${res.status}` };
    }
    return { sent: true, reason: null, link };
  } catch (err) {
    console.error("[auth] Resend request failed:", err);
    return { sent: false, reason: "resend-error", link, error: String(err) };
  }
}
