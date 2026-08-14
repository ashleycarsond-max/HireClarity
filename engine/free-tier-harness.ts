/**
 * Free-tier verification harness (dev tooling).
 * Creates a real session for a test email by reusing the auth flow's own
 * primitives against Neon (same DB the live site uses), then prints the
 * hc_session cookie value + the email. The live site will accept this cookie
 * because sessions live in the shared Neon store.
 */
import { writeFileSync } from "node:fs";
import { requestMagicLink, verifyMagicLink } from "../src/server/auth";

function cookieValue(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;
  const m = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return m ? m[1] : null;
}

const email = process.argv[2] ?? `free-tier-test-${Date.now()}@example.com`;
const outPath = process.argv[3] ?? "/tmp/free-session.txt";

(async () => {
  const flow = await requestMagicLink(email, "127.0.0.1", "/check");
  if (!flow.link) {
    // RESEND may have accepted the email (real sender configured) — in that
    // case fall back to minting a token directly via storeMagicLinkToken.
    console.error("no dev link; email may have been delivered. Falling back to direct token mint.");
    const { storeMagicLinkToken, verifyMagicLink: v } = await import("../src/server/auth");
    const raw = "t".repeat(64);
    const exp = new Date(Date.now() + 15 * 60_000).toISOString();
    await storeMagicLinkToken(email, raw, exp);
    const res = await v(raw, "/check");
    if (!res.ok) throw new Error("verify failed: " + JSON.stringify(res));
    writeFileSync(outPath, `${email}\n${res.sessionToken}\n`);
    console.log(`email=${email}`);
    console.log(`hc_session=${res.sessionToken}`);
    console.log(`written ${outPath}`);
    return;
  }
  const rawToken = new URL(flow.link).searchParams.get("token") ?? "";
  const res = await verifyMagicLink(rawToken, "/check");
  if (!res.ok) throw new Error("verify failed: " + JSON.stringify(res));
  writeFileSync(outPath, `${email}\n${res.sessionToken}\n`);
  console.log(`email=${email}`);
  console.log(`hc_session=${res.sessionToken}`);
  console.log(`written ${outPath}`);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
