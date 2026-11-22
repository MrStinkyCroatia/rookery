# Rookery (by Stinky Penguin) — a launchpad for chains that are not live yet

[![security](https://github.com/MrStinkyCroatia/rookery/actions/workflows/security.yml/badge.svg)](https://github.com/MrStinkyCroatia/rookery/actions/workflows/security.yml)
[![license](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
[![secret scan](https://img.shields.io/badge/secrets-gitleaks%20on%20every%20push-black.svg)](.gitleaks.toml)

![Open Source is Live](docs/open-source-live.png)

Site: **https://rookery.stinkypenguin.xyz**

Networks: **Zero** (LayerZero, mainnet 30 Nov, pre-market), **GIWA** (Upbit, pre-market, mainnet TBA), **LitVM** (Litecoin EVM, pre-market with zkLTC), plus **Stellar** and **Robinhood Chain** live on mainnet (Robinhood fully on-chain).
Trading currency: **ZRO**, every price shown in **USD** (ZRO rate from OKX, fallbacks Bybit, KuCoin, CoinGecko, refreshed every minute).
Platform fee: **0.5% of every trade** goes into the **$臭企鹅 buy & burn** reserve.

## What works

| Feature | Description |
|---|---|
| Accounts | email and password sign-up and login (PBKDF2), 30-day session in an HttpOnly cookie |
| ZRO deposits | every user gets a personal address (the same one on Ethereum, Base, Arbitrum, BNB Chain and Optimism). Deposits are detected every minute, or on demand with the "Check for deposits" button |
| Withdrawals | instant from the hot wallet to the chosen network. Limits of 5,000 ZRO per withdrawal and 20,000 ZRO per day. A failed send is refunded to the balance immediately |
| Trading | bonding curve (1B supply, 800M on the curve, 200M reserved for the mainnet pool), buy and sell any amount, preset amounts, one-click "⚡ Quick buy" |
| Token creation | image upload, name, ticker, description, network (Zero/GIWA/Stellar), ZRO pair, socials (X, Telegram, website), launch buy cap (% of supply over X minutes), creator taxes: marketing (ZRO to the creator), token burn, ZRO rewards for holders (max 5% each, 10% total), optional dev buy |
| Token page | candles (TradingView Lightweight Charts) 1m/5m/15m/1h in USD, trades, holders, comments, description, curve progress, taxes, claimable rewards |
| Trading view | table of all markets (price, 5m/1h/24h, market cap, volume, holders, progress) and a live trade feed |
| Trader profile | avatar, name, bio, portfolio value, volume, trades, tokens created |
| Docs | full documentation with the curve chart and fee breakdown |
| Proofs | total ZRO owed to users, pLAUNCH reserve, hot wallet address with explorer links, Merkle root of balances |

## Platform wallet (the important part)

- Every deposit address and the hot wallet are derived from **one seed phrase** (path `m/44'/60'/0'/0/i`).
  - `i = 0` is the **hot wallet**: `0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D`
  - `i = 1, 2, 3…` are the per-user deposit addresses.
- Import the phrase into MetaMask and account #1 is the hot wallet, the next accounts are deposit addresses.
- The phrase lives in `.master_mnemonic` on the working server, and the extended key is the `MASTER_XPRV` secret in Cloudflare. **Keep an offline copy of the phrase.** Without it the deposits cannot be recovered.

### For withdrawals to work
Fund the hot wallet with ZRO and with gas on each network you want to pay out on:
- Ethereum, Base, Arbitrum, Optimism: ETH,
- BNB Chain: BNB.

### Sweeping deposits into the hot wallet
Deposits sit on the user addresses. To move them into the hot wallet they have to be swept periodically, and each deposit address needs a little gas for that. Today this is done manually with MetaMask (using the phrase). Automated sweeping is the next step.

## Administration

```bash
K=$(cat .admin_key)
U=https://rookery.stinkypenguin.xyz/api

# manually credit ZRO to a user (for example a deposit made on another network)
curl -s -X POST $U/admin/credit -H 'content-type: application/json' -H 'x-pl: 1' \
  -d "{\"key\":\"$K\",\"user\":\"username_or_email\",\"amount\":\"10000000000000000000\",\"note\":\"manual\"}"

# publish the Merkle root of balances (once a day)
curl -s -X POST "$U/admin/proof?key=$K" -H 'x-pl: 1'

# emergency stop and resume of withdrawals
curl -s -X POST "$U/admin/pause?key=$K&on=1" -H 'x-pl: 1'
curl -s -X POST "$U/admin/pause?key=$K&on=0" -H 'x-pl: 1'
```

Amounts are in wei: 1 ZRO = `1000000000000000000`.

## Zero mainnet migration (1:1)

Every Rookery pre-market token for Zero moves on-chain 1:1 when Zero launches. Nothing to claim, nothing to connect.

**Reserved addresses.** Every token's Zero contract address is fixed today and shown on its token page:
- a dedicated deployer (HD child `2000033002`, used for nothing else) deploys `RookeryCurve2` as its first transaction on Zero, so the curve lands at `CREATE(deployer, 0)`;
- the curve's constructor deploys the token factory at `CREATE(curve, 1)`;
- each token is created with CREATE3: `token = CREATE(CREATE2(factory, keccak256(tokenId), 0x21c35dbe…7c1f), nonce 1)`. The proxy is the standard 16-byte CREATE3 initcode (`0x67363d3d37363d34f03d5260086018f3`), so the address never depends on compiler settings or EVM version, on import order, name, creator or taxes. One token ID can only be deployed once.
- check any address yourself: `curve.predictImported("<token id>")`, or recompute it from [`migration/zero_reserved_addresses.json`](migration/zero_reserved_addresses.json).

| | Address on Zero (chain id 33002) |
|---|---|
| Curve | `0x4ffd205049EFf2AFFa0cB61d81C718cb3928e84a` |
| Token factory | `0x1de02dCaE433DD6B602BC7cC887395d930c127Bd` |
| Deployer | `0x2244bD4c8500a88165A91deAa9B33fa37b582E1D` |

**Launch day, step by step**
1. The watcher (`worker/watch.js`) verifies a Zero RPC twice: chain id 33002, LayerZero EndpointV2 code at its known address, blocks moving (impostor "zero" chains are rejected).
2. Zero trading on Rookery pauses automatically, pending holder rewards are paid in ZRO, and the 1:1 snapshot of every balance and curve is published with its SHA-256 at `/api/migration/zero/snapshot.json` (`worker/zeromig.js`).
3. The curve reserves (~3,000 ZRO) are sent to the deployer on Zero through the official ZRO OFT.
4. One command runs the migration (`worker/zerorun.js`): preflight (chain id, unused deployer, funds), the curve build this EVM accepts (cancun or paris, picked by gas estimation), the curve at its reserved address, then every token imported at its reserved address with exactly its ledger state (`RookeryCurve2.importCurve`), and a per-token check of custody balance, supply, curve state and price to the wei. Resumable and idempotent.
5. The ledger switches each token to on-chain; token pages show **LIVE ON ZERO**: withdraw to your own wallet in one click, and trade the on-chain curve from your wallet.
6. When a curve sells out, the token graduates to a V2-style DEX pool on Zero with LP sent to the dead address. The DEX is chosen on launch day (an existing V2 DEX on Zero, or our own deployment of the official Uniswap V2 artifacts); it is a constructor argument and changes no reserved address.

**Tested before launch** (local chain id 33002, the real production snapshot of 60 tokens):
- `rhcurve/test/ImportCurve.t.sol`: 9/9 (state = ledger, price continuity, exits always covered, owner-only, one ID once, off-chain formula = on-chain address from a fresh deployer); `RookeryCurve2.t.sol`: 13/13.
- `tools/zero_rehearsal.mjs`: 60/60 tokens on cancun and on paris, **same addresses on both**; external-DEX and own-DEX modes; post-migration withdraw + sell + buy; re-run sends 0 transactions.
- `tools/zero_worker_path.mjs`: the worker's own signing/background code, 64 transactions, 60/60.
- `tools/zero_wd_test.mjs`: migrate → finalize → withdrawals on a real SQLite ledger (EOA ok, contract refused, pre-broadcast failure refunded, crash-resume never sends twice, custody covers every balance).
- Contract bytecode used on launch day and its SHA-256: [`migration/zero_artifacts.json`](migration/zero_artifacts.json).

GIWA and LitVM follow the same steps at their mainnets.

## Before serious volume
1. Offline copy of the phrase, moved into a hardware wallet.
2. Automated sweeping of deposits into the hot wallet and a cold wallet.
3. Email verification and password reset (needs a mail provider such as Resend).
4. 2FA for withdrawals.
5. Licensing: custody and trading in the EU mean CASP/MiCA.

## Deploy

```bash
./deploy.sh                                         # rookery.stinkypenguin.xyz
PRELAUNCH_DOMAIN=launch.example.com ./deploy.sh
```

The Cloudflare account id is read from `CLOUDFLARE_ACCOUNT_ID` or from `$WR/.cf_account`, never from the repo.

## Security

- **No secrets in the repository.** `.master_xprv`, `.master_mnemonic`, `.admin_key`, `.staging/` and `.dev.vars` are ignored and blocked by a pre-commit hook and by CI.
- **Every push** runs a secret scan (gitleaks over the whole history), a syntax check of the worker and the frontend, and a dependency audit.
- **Reporting:** see [SECURITY.md](SECURITY.md). Do not report anything that touches funds in public.
- **On-chain addresses are not secrets.** The allowlist in `.gitleaks.toml` lets public EVM addresses (0x + 40 characters) and Stellar public keys (G + 55) through. Private keys and Stellar secret keys (S…) are still detected.

> This code moves real funds. Before every deploy: back up, test on staging, then production.
