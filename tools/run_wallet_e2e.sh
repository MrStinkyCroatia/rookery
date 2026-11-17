#!/bin/bash
# Full-stack rehearsal of one-signature wallet buys, with no real funds:
#   anvil forks of Base and Arbitrum  +  the real worker under `wrangler dev --local`  +  tools/test_wallet_buy_e2e.mjs
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
W=/home/user/412832f0-09bf-4a6c-846e-8a45ae49c7eb/wr/node_modules/.bin/wrangler
STATE=/tmp/rk-e2e-state
rm -rf "$STATE"
cleanup() { kill $(jobs -p) 2>/dev/null || true; rm -f tools/.dev.vars; }
trap cleanup EXIT

anvil --fork-url https://base-rpc.publicnode.com --port 8547 --silent &
anvil --fork-url https://arb1.arbitrum.io/rpc --port 8548 --silent &

# throwaway keys for this run only
XPRV=$(node -e "const {HDNodeWallet}=require('ethers');console.log(HDNodeWallet.createRandom().extendedKey)")
ADMIN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
cat > tools/.dev.vars <<EOF
MASTER_XPRV=$XPRV
ADMIN_KEY=$ADMIN
STELLAR_NET=testnet
RPC_OVERRIDE={"base":"http://127.0.0.1:8547","arbitrum":"http://127.0.0.1:8548","ethereum":"http://127.0.0.1:9","bsc":"http://127.0.0.1:9","optimism":"http://127.0.0.1:9"}
EOF

for p in 8547 8548; do
  for i in $(seq 1 60); do curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:$p >/dev/null && break; sleep 1; done
done

WRANGLER_SEND_METRICS=false "$W" dev --config tools/wrangler.e2e.jsonc --local --port 8787 --persist-to "$STATE" --test-scheduled > /tmp/rk-e2e-wrangler.log 2>&1 &
for i in $(seq 1 90); do curl -s http://127.0.0.1:8787/api/stats >/dev/null && break; sleep 1; done

E2E_ADMIN_KEY=$ADMIN node ${E2E_SCRIPT:-tools/test_wallet_buy_e2e.mjs}
