#!/bin/bash
# RookerySniperBot end to end: real worker under `wrangler dev --local` + a fake Telegram API (tools/tg_mock.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
W=/home/user/412832f0-09bf-4a6c-846e-8a45ae49c7eb/wr/node_modules/.bin/wrangler
STATE=/tmp/rk-snb-state
rm -rf "$STATE"
cleanup() { kill $(jobs -p) 2>/dev/null || true; rm -f tools/.dev.vars; }
trap cleanup EXIT
node tools/tg_mock.mjs 8899 &
XPRV=$(node -e "const {HDNodeWallet}=require('ethers');console.log(HDNodeWallet.createRandom().extendedKey)")
ADMIN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
cat > tools/.dev.vars <<EOF
MASTER_XPRV=$XPRV
ADMIN_KEY=$ADMIN
STELLAR_NET=testnet
SNIPER_BOT_TOKEN=test:token
SNB_SYNC=1
TG_API_BASE=http://127.0.0.1:8899
RPC_OVERRIDE={"base":"http://127.0.0.1:9","arbitrum":"http://127.0.0.1:9","ethereum":"http://127.0.0.1:9","bsc":"http://127.0.0.1:9","optimism":"http://127.0.0.1:9"}
EOF
WRANGLER_SEND_METRICS=false "$W" dev --config tools/wrangler.e2e.jsonc --local --port 8787 --persist-to "$STATE" --test-scheduled > /tmp/rk-snb-wrangler.log 2>&1 &
for i in $(seq 1 90); do curl -s http://127.0.0.1:8787/api/stats >/dev/null && break; sleep 1; done
E2E_ADMIN_KEY=$ADMIN node ${E2E_SCRIPT:-tools/test_sniper_e2e.mjs}
