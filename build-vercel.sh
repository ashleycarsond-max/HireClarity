#!/usr/bin/env bash
# Produce a Vercel Build Output API bundle (.vercel/output) for this site, then
# deploy it with:  bunx vercel deploy --prebuilt
#
# Why Build Output API instead of Vercel's Vite/framework detection:
#  - TanStack Start emits a host-agnostic fetch handler (dist/server/server.js)
#    that dynamic-imports its own ./assets chunks and externalizes node deps.
#    Letting Vercel trace/detect that is fragile.
#  - Bundling it into one self-contained file (deps + dynamic chunks inlined) in a
#    single render.func removes all tracing/detection risk. vercel-entry.ts adapts
#    the Node (req,res) launcher to the web fetch handler.
set -euo pipefail
cd "$(dirname "$0")"
umask 002

echo "[1/3] vite build (light — safe under the sandbox memory cap)"
# The workspace starts as sources only (deps live with the image's pre-built
# placeholder copy); no-op once node_modules is current.
bun install
# Regenerate static content before building: blog posts from blog-content/*.md
# and the sitemap from the registry + blog slugs.
bun run scripts/gen-blog.ts
bun run scripts/gen-sitemap.ts
bun run build

echo "[2/3] assemble .vercel/output (Build Output API v3)"
rm -rf .vercel/output
mkdir -p .vercel/output/functions/render.func
cp -R dist/client .vercel/output/static
rm -f .vercel/output/static/index.html   # SSR owns "/", not a static shell

echo "[3/3] bundle SSR handler + deps into the render function"
bun build vercel-entry.ts --target node \
  --outfile .vercel/output/functions/render.func/index.mjs

cat > .vercel/output/functions/render.func/.vc-config.json <<'JSON'
{ "runtime": "nodejs22.x", "handler": "index.mjs", "launcherType": "Nodejs", "supportsResponseStreaming": true, "maxDuration": 60 }
JSON
# IMPORTANT (2026-08-15, cron pipeline fix): with `vercel deploy --prebuilt` the
# platform uses ONLY .vercel/output/config.json — the `crons` field in vercel.json
# is IGNORED for prebuilt deployments (vercel.json is only read on source builds).
# The crons MUST be declared here (Build Output API v3 config, documented at
# https://vercel.com/docs/build-output-api/configuration#crons) or Vercel's
# scheduler never registers them and /api/cron/* never fires. Keep this array in
# sync with vercel.json. Cron auth still requires CRON_SECRET as a PROJECT-level
# env var (deploy-time `-e` is not enough — Vercel Cron reads it from the
# project's env to attach the Authorization header).
cat > .vercel/output/config.json <<'JSON'
{ "version": 3, "routes": [ { "handle": "filesystem" }, { "src": "/(.*)", "dest": "/render" } ], "crons": [ { "path": "/api/cron/sync", "schedule": "0 * * * *" }, { "path": "/api/cron/report", "schedule": "0 9 * * *" }, { "path": "/api/cron/daily", "schedule": "30 2 * * *" }, { "path": "/api/cron/discover", "schedule": "45 1 * * *" } ] }
JSON

echo "done -> .vercel/output ready for: bunx vercel deploy --prebuilt"
