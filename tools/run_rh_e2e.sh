#!/bin/bash
# Full-stack rehearsal of the Robinhood Chain on-chain launchpad (RookeryCurve2), with no real funds:
#   local replica of Robinhood Chain (real Uniswap V2/V3 + WETH bytecode, chainId 4663)
#   + a stand-in stock token + the real worker under `wrangler dev --local` + tools/test_rh_onchain_e2e.mjs as wallet users
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
W=/home/user/412832f0-09bf-4a6c-846e-8a45ae49c7eb/wr/node_modules/.bin/wrangler
STATE=/tmp/rk-rh-state
rm -rf "$STATE"
cleanup() { kill $(jobs -p) 2>/dev/null || true; rm -f tools/.dev.vars; }
trap cleanup EXIT

# local replica (public RPCs refuse archive reads, so a fork goes stale within a minute)
anvil --chain-id 4663 --port 8550 --base-fee 20000000 --silent &
for i in $(seq 1 60); do curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' http://127.0.0.1:8550 >/dev/null && break; sleep 1; done

RH_LOCAL=http://127.0.0.1:8550 node tools/rh_replica.mjs
(cd rhcurve && forge build >/dev/null 2>&1)
# a stand-in stock token (anvil account 0, nonce 0 -> fixed address 0x5FbD...0aa3)
(cd rhcurve && forge create test/mocks/MockStock.sol:MockStock --rpc-url http://127.0.0.1:8550 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 2>&1 | grep -E "Deployed to")

XPRV=$(node -e "const {HDNodeWallet}=require('ethers');console.log(HDNodeWallet.createRandom().extendedKey)")
ADMIN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
cat > tools/.dev.vars <<EOF
MASTER_XPRV=$XPRV
ADMIN_KEY=$ADMIN
STELLAR_NET=testnet
RPC_OVERRIDE={"robinhood":"http://127.0.0.1:8550","base":"http://127.0.0.1:9","arbitrum":"http://127.0.0.1:9","ethereum":"http://127.0.0.1:9","bsc":"http://127.0.0.1:9","optimism":"http://127.0.0.1:9"}
RH_QUOTES_STATIC=[{"symbol":"TSLA","name":"Tesla","address":"0x5FbDB2315678afecb367f032d93F642f64180aa3","usd":400,"logo":""}]
EOF

WRANGLER_SEND_METRICS=false "$W" dev --config tools/wrangler.e2e.jsonc --local --port 8787 --persist-to "$STATE" > /tmp/rk-rh-wrangler.log 2>&1 &
for i in $(seq 1 90); do curl -s http://127.0.0.1:8787/api/stats >/dev/null && break; sleep 1; done

E2E_ADMIN_KEY=$ADMIN node tools/test_rh_onchain_e2e.mjs
if [ -n "${UI:-}" ]; then node tools/rh_ui_check.mjs http://127.0.0.1:8787 $(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/rh_mids.json')).join(' '))"); fi
