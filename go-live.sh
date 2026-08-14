#!/usr/bin/env bash
# Publish this site live to Vercel and print the live URL.
#
# Contract:
#   VERCEL_TOKEN   (required) — collected from the owner via the go-live flow.
#   DATABASE_URL   (optional) — passed as a runtime env var when the site uses a DB.
#   VERCEL_SCOPE   (optional) — team slug; auto-resolved from the token if unset.
#   VERCEL_TEAM_ID (optional) — team id; auto-resolved from the token if unset.
#
# Scope + team id are auto-resolved from the token (personal tokens have neither;
# team tokens report their default team), so the owner only ever pastes the token.
# Making the project public drops the org SSO protection new projects inherit,
# which would otherwise put a login wall in front of a site meant for the public.
set -euo pipefail
cd "$(dirname "$0")"
umask 002

: "${VERCEL_TOKEN:?set VERCEL_TOKEN (collect it from the owner first)}"
PROJECT_NAME="${VERCEL_PROJECT_NAME:-$(basename "$(pwd)")}"
VERCEL="bunx vercel@latest"

# CRON_SECRET (auth for the /api/cron/sync endpoint): auto-loaded from the
# .cron-secret file next to this script when not already exported, so every
# deploy carries the same secret the scheduled cron jobs rely on. The file is
# team-private (chmod 600); never echo its contents.
if [ -z "${CRON_SECRET:-}" ] && [ -f "$(dirname "$0")/.cron-secret" ]; then
  export CRON_SECRET="$(tr -d '\r\n' < "$(dirname "$0")/.cron-secret")"
fi

# Resolve the token's team (slug for --scope, id for the make-public API call).
# Empty for a personal-account token. bun is always present in the sandbox.
if [ -z "${VERCEL_SCOPE:-}" ] || [ -z "${VERCEL_TEAM_ID:-}" ]; then
  RESOLVED="$(VERCEL_TOKEN="$VERCEL_TOKEN" bun -e '
    const h = { headers: { Authorization: "Bearer " + process.env.VERCEL_TOKEN } };
    const [u, tj] = await Promise.all([
      fetch("https://api.vercel.com/v2/user", h).then((r) => r.json()).catch(() => ({})),
      fetch("https://api.vercel.com/v2/teams?limit=50", h).then((r) => r.json()).catch(() => ({})),
    ]);
    const teams = tj.teams || [];
    const def = (u.user || u || {}).defaultTeamId;
    const t = teams.find((x) => x.id === def) || teams[0];
    if (t) process.stdout.write(t.id + " " + t.slug);
  ' 2>/dev/null || true)"
  VERCEL_TEAM_ID="${VERCEL_TEAM_ID:-${RESOLVED%% *}}"
  [ "$RESOLVED" != "${RESOLVED#* }" ] && VERCEL_SCOPE="${VERCEL_SCOPE:-${RESOLVED##* }}"
fi

echo "==> building Vercel bundle"
bash ./build-vercel.sh

SCOPE_ARGS=()
if [ -n "${VERCEL_SCOPE:-}" ]; then SCOPE_ARGS=(--scope "$VERCEL_SCOPE"); fi
ENV_ARGS=()
if [ -n "${DATABASE_URL:-}" ]; then ENV_ARGS=(-e "DATABASE_URL=$DATABASE_URL"); fi
# Billing env (owner-provided secrets + the access-gate flag). Only vars that
# are actually set are passed, so an unconfigured deploy stays honest.
# Owner decision (2026-08-13/14): the subscription gate is ON — anonymous
# visitors to /check and /company see the honest subscribe panel; signed-in
# accounts get the free tier (5 posting checks/month), Job Seeker $25 unlocks
# unlimited checks, Company $149 unlocks the dashboard. EARLY_ACCESS_FREE
# defaults to 0 so every deploy keeps the gate; unset it explicitly
# (export EARLY_ACCESS_FREE=1) to open the tools to everyone (dev only).
if [ -z "${EARLY_ACCESS_FREE:-}" ]; then EARLY_ACCESS_FREE=0; fi
# Auth env: RESEND_API_KEY enables magic-link email delivery; EMAIL_FROM
# overrides the sender (must be verified in Resend). CRON_SECRET guards the
# /api/cron/sync endpoint (Vercel Cron sends it as `Authorization: Bearer …`
# on every scheduled invocation). COMPANIES_PER_RUN sizes each hourly sync
# invocation (see engine/sync.ts — scaled registry tuning). Passed only when
# set — without RESEND_API_KEY the auth endpoints stay live but honestly refuse
# to send (see billing-README.md "Auth"); without CRON_SECRET the cron endpoint
# returns 401 (fail closed).
for VAR in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET EARLY_ACCESS_FREE RESEND_API_KEY EMAIL_FROM CRON_SECRET COMPANIES_PER_RUN; do
  if [ -n "${!VAR:-}" ]; then ENV_ARGS+=(-e "$VAR=${!VAR}"); fi
done

echo "==> deploying${VERCEL_SCOPE:+ (scope: $VERCEL_SCOPE)}"
# --prod: the deploy becomes the PRODUCTION deployment. Vercel Cron Jobs only
# fire against the production deployment (docs), so without this the scheduled
# sync would never run even though vercel.json declares it. The alias is
# re-pointed to the fresh deployment URL right after (see the caller).
DEPLOY_OUT="$($VERCEL deploy --prebuilt --prod --yes --token "$VERCEL_TOKEN" \
  --name "$PROJECT_NAME" "${SCOPE_ARGS[@]}" "${ENV_ARGS[@]}" 2>&1)" || {
  printf '%s\n' "$DEPLOY_OUT" >&2
  exit 1
}
LIVE_URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.vercel\.app' | tail -1)"

if [ -z "$LIVE_URL" ]; then
  echo "deploy finished but no live URL was parsed — output above" >&2
  printf '%s\n' "$DEPLOY_OUT" >&2
  exit 1
fi

echo "==> making the project public"
TEAM_QS=""
if [ -n "${VERCEL_TEAM_ID:-}" ]; then TEAM_QS="?teamId=$VERCEL_TEAM_ID"; fi
curl -sf -X PATCH "https://api.vercel.com/v9/projects/${PROJECT_NAME}${TEAM_QS}" \
  -H "Authorization: Bearer $VERCEL_TOKEN" -H "Content-Type: application/json" \
  -d '{"ssoProtection":null}' >/dev/null ||
  echo "warning: could not disable SSO protection (site may show a login wall)" >&2

echo "LIVE: $LIVE_URL"
