#!/bin/bash
# Deploy the SAME code to a separate staging worker: own Durable Object storage, own test wallet seed,
# no custom domain (workers.dev only), no Telegram bot. Production is never touched by this script.
set -e
WR=/home/user/412832f0-09bf-4a6c-846e-8a45ae49c7eb/wr
W="$WR/node_modules/.bin/wrangler"
export CLOUDFLARE_API_TOKEN=$(cat "$WR/.cf_token")
export CLOUDFLARE_ACCOUNT_ID=fa6c629eb1cfc4c5286d0c1735702f20
APP=/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch
STG=$APP/.staging
mkdir -p "$STG"
cat > "$STG/wrangler.jsonc" <<EOF
{
  "name": "rookery-staging",
  "main": "$APP/worker/index.js",
  "account_id": "$CLOUDFLARE_ACCOUNT_ID",
  "compatibility_date": "2025-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "$APP/site", "binding": "ASSETS", "not_found_handling": "single-page-application" },
  "durable_objects": { "bindings": [{ "name": "BOOKS", "class_name": "Books" }] },
  "r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "rookery-staging-backups" }],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Books"] }],
  "triggers": { "crons": ["* * * * *"] },
  "observability": { "enabled": true },
  "vars": { "STELLAR_NET": "testnet" },
  "workers_dev": true
}
EOF
cd "$STG"
$W deploy --config "$STG/wrangler.jsonc" 2>&1 | grep -viE "token" | tail -8
echo STAGING_DEPLOYED
