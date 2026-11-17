# $臭企鹅 buy & burn — how it works and how to start it

## Flow (fully automatic)
1. **Reserve**: 0.5% of every Rookery trade (in ZRO) increases the `plaunch_burn` counter in the ledger.
2. **Burn start**: every 24 h (default), if the reserve holds at least 20 ZRO, the system takes up to 5,000 ZRO and queues a burn job. The reserve counter decreases by exactly that amount.
3. **Transfer to the burn wallet**: the hot wallet sends ZRO on Arbitrum to the burn wallet `0x56a5a970160C24da39500af1C933e3Eed08c83A1`. If the burn wallet has no gas, the hot wallet tops it up with 0.0006 ETH.
4. **Bridge**: the burn wallet swaps ZRO on Arbitrum for ETH on Robinhood Chain through Relay (approve and deposit, then wait for `success`). If Relay returns the funds, the step retries automatically.
5. **Buy and burn**: on Robinhood Chain the burn wallet buys $臭企鹅 on Uniswap V3 (the WETH/$臭企鹅 pool with the deepest liquidity, priced through QuoterV2, max 3% slippage). The recipient is `0x000000000000000000000000000000000000dEaD`, so the tokens are bought and burned in a single transaction. 0.0003 ETH stays for gas.
6. **Publishing**: every step with transaction links is on https://rookery.stinkypenguin.xyz/#/proofs/burns.

The job advances one step per minute (Worker cron) with a lock against double execution. After 15 failed attempts it is marked `failed`; if the ZRO never left the hot wallet it returns to the reserve.

## Starting it after $臭企鹅 is listed on Robinhood Chain
Requirements: the token is deployed on Robinhood Chain and has a **WETH/$臭企鹅 pool on Uniswap V3** with liquidity (factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`).

One command:
```bash
K=$(cat .admin_key)
curl -s -X POST "https://rookery.stinkypenguin.xyz/api/admin/burn/config?key=$K" \
  -H 'x-pl: 1' -H 'content-type: application/json' \
  -d '{"token":"0xTOKEN_ADDRESS_ON_ROBINHOOD"}'
```
From then on auto-burn starts on the next tick (within a minute) and spends the whole accumulated reserve (up to 5,000 ZRO at a time).

Options (same endpoint): `auto` (true/false), `intervalH`, `minZro`, `maxZro`, `slippageBps`, `source` (`arbitrum`, `base`, `ethereum`, `optimism`, `bsc`).

Manual burn right now: `POST /api/admin/burn/run?key=…`.

## What has to be funded
- **Hot wallet** `0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D` on **Arbitrum**: ZRO equal to the reserve plus a little ETH for gas.
- No gas is needed on Robinhood Chain, because it comes from the ETH received through the bridge.

## Verified on mainnet (read-only, 13 Nov)
- Uniswap V3 on Robinhood Chain: pool selection and pricing work (tested on WETH/USDG: 0.01 ETH → 19.48 USDG).
- Relay: 100 ZRO from Arbitrum → 0.0814 ETH on Robinhood Chain (≈ $158.56), approve and deposit steps.
