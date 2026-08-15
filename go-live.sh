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
#
# NOTE (2026-08-15, cron pipeline fix): deploy-time `-e` is NOT enough for cron
# auth — Vercel's Cron service attaches `Authorization: Bearer <CRON_SECRET>`
# only when CRON_SECRET is a PROJECT-LEVEL env var (Settings → Environment
# Variables, target Production). It must be set on the project once
# (`echo "$CRON_SECRET" | vercel env add CRON_SECRET production` or the
# dashboard). The `-e` pass below is harmless overlap (deploy env wins for the
# function runtime) but the scheduler reads the project env. Also: crons are
# registered from .vercel/output/config.json (see build-vercel.sh), not from
# vercel.json, for --prebuilt deploys — verify with `vercel crons ls`.
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
# visitors to /check see the honest subscribe panel; signed-in accounts get
# the free tier (5 posting checks/month); HireClarity Data ($9/month) unlocks
# unlimited checks, watchlists and alerts — one product for everyone (the
# $149 Company tier was retired 2026-08-14). EARLY_ACCESS_FREE defaults to 0
# so every deploy keeps the gate; unset it explicitly
# (export EARLY_ACCESS_FREE=1) to open the tools to everyone (dev only).
if [ -z "${EARLY_ACCESS_FREE:-}" ]; then EARLY_ACCESS_FREE=0; fi
# Auth env: RESEND_API_KEY enables magic-link email delivery; EMAIL_FROM
# overrides the sender (must be verified in Resend). CRON_SECRET guards the
# /api/cron/sync endpoint (Vercel Cron sends it as `Authorization: Bearer …`
# on every scheduled invocation). COMPANIES_PER_RUN sizes each hourly sync
# invocation (see engine/sync.ts — scaled registry tuning); DISCOVERY_PER_RUN /
# DISCOVERY_HOST_CAP / DISCOVERY_TIME_BUDGET_MS size the daily registry-growth
# pass (see engine/discovery-sync.ts). Passed only when set — without
# RESEND_API_KEY the auth endpoints stay live but honestly refuse to send (see
# billing-README.md "Auth"); without CRON_SECRET the cron endpoint returns 401
# (fail closed).
#
# Sizing vars are read from .env (Bun-style KEY=VALUE, gitignored) when the
# shell env doesn't already set them — a deploy must never silently drop the
# hourly sync to 1 company/run (~88h cycle) just because COMPANIES_PER_RUN
# wasn't exported. Only these four non-secret vars are read; secrets are never
# sourced from .env (the shell env is the source of truth for those).
if [ -f "$(dirname "$0")/.env" ]; then
  for VAR in COMPANIES_PER_RUN DISCOVERY_PER_RUN DISCOVERY_HOST_CAP DISCOVERY_TIME_BUDGET_MS; do
    if [ -z "${!VAR:-}" ]; then
      VAL="$(sed -n "s/^${VAR}=//p" "$(dirname "$0")/.env" | head -1 | tr -d '\r')"
      if [ -n "$VAL" ]; then export "$VAR=$VAL"; fi
    fi
  done
fi
for VAR in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET EARLY_ACCESS_FREE RESEND_API_KEY EMAIL_FROM CRON_SECRET COMPANIES_PER_RUN DISCOVERY_PER_RUN DISCOVERY_HOST_CAP DISCOVERY_TIME_BUDGET_MS; do
  if [ -n "${!VAR:-}" ]; then ENV_ARGS+=(-e "$VAR=${!VAR}"); fi
done

echo "==> deploying${VERCEL_SCOPE:+ (scope: $VERCEL_SCOPE)}"
# --prod: the deploy becomes the PRODUCTION deployment. Vercel Cron Jobs only
# fire against the production deployment (docs), so without this the scheduled
# sync would never run even though vercel.json declares it. The
# hireclarity-data.vercel.app alias is re-pointed to the fresh deployment URL
# at the end of this script (see below).
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
# Re-point the canonical alias to the fresh deployment (last step so a deploy
# can't ship without it). Hostname WITHOUT the https:// prefix; no --yes flag.
# Safe when VERCEL_TOKEN is unset: skip with a warning, never fail the deploy.
echo "==> re-pointing the hireclarity-data.vercel.app alias"
if [ -n "${VERCEL_TOKEN:-}" ]; then
  ALIAS_HOST="$(printf '%s' "$LIVE_URL" | sed -E 's#^https?://##')"
  if ! $VERCEL alias set "$ALIAS_HOST" hireclarity-data.vercel.app \
    --token "$VERCEL_TOKEN" --scope hire-clarity-data 2>&1; then
    echo "warning: alias re-point FAILED — site is live at $LIVE_URL but hireclarity-data.vercel.app still points at the previous deployment" >&2
    echo "  run manually: bunx vercel alias set $ALIAS_HOST hireclarity-data.vercel.app --token \$VERCEL_TOKEN --scope hire-clarity-data" >&2
  else
    echo "alias: hireclarity-data.vercel.app -> $LIVE_URL"
  fi
else
  echo "warning: VERCEL_TOKEN unset — skipping alias re-point (deploy is live at $LIVE_URL; run the alias manually)" >&2
fi
