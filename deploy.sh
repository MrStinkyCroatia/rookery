#!/bin/bash
# Deploy PreLaunch to the owner's Cloudflare account (default: prelaunch.zerodex.sbs)
set -e
WR=/home/user/412832f0-09bf-4a6c-846e-8a45ae49c7eb/wr
W="$WR/node_modules/.bin/wrangler"
export CLOUDFLARE_API_TOKEN=$(cat "$WR/.cf_token")
export CLOUDFLARE_ACCOUNT_ID=fa6c629eb1cfc4c5286d0c1735702f20
APP=/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch
DOMAIN=${PRELAUNCH_DOMAIN:-rookery.stinkypenguin.xyz}

cd "$APP"
cat > wrangler.jsonc <<EOF
{
  "name": "prelaunch",
  "main": "worker/index.js",
  "account_id": "$CLOUDFLARE_ACCOUNT_ID",
  "compatibility_date": "2025-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "$APP/site", "binding": "ASSETS", "not_found_handling": "single-page-application" },
  "durable_objects": { "bindings": [{ "name": "BOOKS", "class_name": "Books" }] },
  "r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "rookery-backups" }],
  "vars": { "STELLAR_NET": "mainnet" },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Books"] }],
  "triggers": { "crons": ["* * * * *"] },
  "observability": { "enabled": true },
  "routes": [{ "pattern": "$DOMAIN", "custom_domain": true }],
  "workers_dev": true
}
EOF
$W deploy 2>&1 | grep -viE "token" | tail -14
echo DEPLOYED
