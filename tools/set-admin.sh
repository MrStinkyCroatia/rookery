#!/bin/bash
# Rotates the PreLaunch ADMIN_KEY: generates a new one, stores it as a Worker secret,
# redeploys (so the Durable Object picks it up) and prints it once.
set -e
WR=/home/user/412832f0-09bf-4a6c-846e-8a45ae49c7eb/wr
APP=/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch
export CLOUDFLARE_API_TOKEN=$(cat "$WR/.cf_token")
export CLOUDFLARE_ACCOUNT_ID=fa6c629eb1cfc4c5286d0c1735702f20
K=$(openssl rand -hex 16)
cd "$APP"
printf '%s' "$K" > .admin_key
echo -n "$K" | "$WR/node_modules/.bin/wrangler" secret put ADMIN_KEY --config wrangler.jsonc >/dev/null 2>&1
./deploy.sh >/dev/null 2>&1
echo "Nowy ADMIN_KEY: $K"
echo "Zapisany tez w $APP/.admin_key"
