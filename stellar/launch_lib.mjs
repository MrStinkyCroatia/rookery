// Rookery on Stellar — launch + trade built only from native Stellar primitives (no custom contracts):
//  - classic asset, 1B supply, issuer locked forever (master weight 0, no signers)  -> no mint, no freeze, no clawback
//  - native constant-product AMM pool XLM/TOKEN seeded with the whole supply by a one-shot "pool keeper"
//    account that is locked in the same transaction -> liquidity can never be withdrawn
//  - trades = path payments through that pool; Rookery fee (0.5% -> $臭企鹅 burn reserve) + optional creator tax
//    are extra payment ops in the same transaction (like Lumen: applies only to trades routed through the site)
import * as SDK from '@stellar/stellar-sdk';
const { Keypair, Asset, LiquidityPoolAsset, getLiquidityPoolId, Operation, TransactionBuilder, Horizon, BASE_FEE, Memo } = SDK;

export const SUPPLY = '1000000000';
export const POOL_FEE_BP = 30; // native AMM fee 0.3%
export const ROOKERY_FEE = 0.005;

export function net(name) {
  return name === 'mainnet'
    ? { horizon: 'https://horizon.stellar.org', passphrase: SDK.Networks.PUBLIC }
    : { horizon: 'https://horizon-testnet.stellar.org', passphrase: SDK.Networks.TESTNET };
}
export const poolOf = (asset) => {
  const lpa = new LiquidityPoolAsset(Asset.native(), asset, SDK.LiquidityPoolFeeV18);
  return { lpa, id: getLiquidityPoolId('constant_product', lpa.getLiquidityPoolParameters()).toString('hex') };
};
const fmt = (n) => (Math.floor(n * 1e7) / 1e7).toFixed(7);

/** Build the single launch transaction. Issuer + keeper keys are fresh and thrown away after signing.
 *  meta: { name, img, desc, web, x, tg } -> stored ON-CHAIN as data entries of the (then locked) issuer account */
export async function buildLaunch({ server, passphrase, creator, code, seedXlm, burnReserve, launchFeeXlm = 0, firstBuyXlm = 0, homeDomain, meta = {}, creatorTaxBp = 0 }) {
  const issuer = Keypair.random(), keeper = Keypair.random();
  const asset = new Asset(code, issuer.publicKey());
  const { lpa, id } = poolOf(asset);
  const data = [];
  const put = (k, v) => { v = String(v || '').trim(); if (v) data.push([k, Buffer.from(v, 'utf8').subarray(0, 64)]); };
  put('name', meta.name); put('img', meta.img); put('web', meta.web); put('x', meta.x); put('tg', meta.tg);
  const d = Buffer.from(String(meta.desc || '').trim(), 'utf8').subarray(0, 192);
  for (let i = 0; i < d.length; i += 64) data.push([`d${i / 64}`, d.subarray(i, i + 64)]);
  if (creatorTaxBp > 0) data.push(['tax', Buffer.from(`${creatorTaxBp}:${creator}`, 'utf8')]);
  const acct = await server.loadAccount(creator);
  const tb = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 4), networkPassphrase: passphrase })
    .addOperation(Operation.createAccount({ destination: issuer.publicKey(), startingBalance: fmt(2 + data.length * 0.5) }))
    .addOperation(Operation.createAccount({ destination: keeper.publicKey(), startingBalance: fmt(Number(seedXlm) + 3) }))
    .addOperation(Operation.changeTrust({ asset, source: keeper.publicKey() }))
    .addOperation(Operation.changeTrust({ asset: lpa, source: keeper.publicKey() }))
    .addOperation(Operation.payment({ destination: keeper.publicKey(), asset, amount: SUPPLY, source: issuer.publicKey() }));
  if (homeDomain) tb.addOperation(Operation.setOptions({ homeDomain, source: issuer.publicKey() }));
  for (const [k, v] of data) tb.addOperation(Operation.manageData({ name: k, value: v, source: issuer.publicKey() }));
  tb.addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1, source: issuer.publicKey() }))
    .addOperation(Operation.liquidityPoolDeposit({
      liquidityPoolId: id, maxAmountA: fmt(seedXlm), maxAmountB: SUPPLY,
      // first deposit into an empty pool: the ratio we send IS the price, bounds only need to be wide (int32 fractions)
      minPrice: { n: 1, d: 2147483647 }, maxPrice: { n: 2147483647, d: 1 }, source: keeper.publicKey(),
    }))
    .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1, source: keeper.publicKey() }));
  if (launchFeeXlm > 0) tb.addOperation(Operation.payment({ destination: burnReserve, asset: Asset.native(), amount: fmt(launchFeeXlm) }));
  if (firstBuyXlm > 0) {
    // creator's first buy lands in the same ledger as the pool opening: nobody can buy before it
    const out = quoteBuy({ x: Number(seedXlm), y: Number(SUPPLY) }, firstBuyXlm * (1 - ROOKERY_FEE));
    tb.addOperation(Operation.changeTrust({ asset }))
      .addOperation(Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: fmt(firstBuyXlm * (1 - ROOKERY_FEE)), destination: creator, destAsset: asset, destMin: fmt(out * 0.99), path: [] }))
      .addOperation(Operation.payment({ destination: burnReserve, asset: Asset.native(), amount: fmt(firstBuyXlm * ROOKERY_FEE) }));
  }
  const tx = tb.addMemo(Memo.text(`rookery:${code}`.slice(0, 28))).setTimeout(180).build();
  tx.sign(issuer, keeper);
  return { tx, asset, poolId: id, issuer: issuer.publicKey(), keeper: keeper.publicKey() };
}

/** constant product with the native 0.3% fee taken from the input */
export function quoteBuy({ x, y }, xlmIn) { const dx = xlmIn * (1 - POOL_FEE_BP / 1e4); return (y * dx) / (x + dx); }
export function quoteSell({ x, y }, tokIn) { const dy = tokIn * (1 - POOL_FEE_BP / 1e4); return (x * dy) / (y + dy); }

export async function poolState(server, poolId) {
  const p = await server.liquidityPools().liquidityPoolId(poolId).call();
  const x = Number(p.reserves.find(r => r.asset === 'native').amount);
  const y = Number(p.reserves.find(r => r.asset !== 'native').amount);
  return { x, y, shares: p.total_shares, trustlines: p.total_trustlines };
}

export async function buildBuy({ server, passphrase, trader, asset, poolId, xlm, burnReserve, creator, creatorTax = 0, slippage = 0.02 }) {
  const st = await poolState(server, poolId);
  const fee = xlm * ROOKERY_FEE, tax = xlm * creatorTax, net = xlm - fee - tax;
  const out = quoteBuy(st, net);
  const acct = await server.loadAccount(trader);
  const hasTl = acct.balances.some(b => b.asset_code === asset.code && b.asset_issuer === asset.issuer);
  const tb = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 4), networkPassphrase: passphrase });
  if (!hasTl) tb.addOperation(Operation.changeTrust({ asset }));
  tb.addOperation(Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: fmt(net), destination: trader, destAsset: asset, destMin: fmt(out * (1 - slippage)), path: [] }))
    .addOperation(Operation.payment({ destination: burnReserve, asset: Asset.native(), amount: fmt(fee) }));
  if (tax > 0) tb.addOperation(Operation.payment({ destination: creator, asset: Asset.native(), amount: fmt(tax) }));
  return { tx: tb.setTimeout(120).build(), expectedOut: out, fee, tax };
}

export async function buildSell({ server, passphrase, trader, asset, poolId, tokens, burnReserve, creator, creatorTax = 0, slippage = 0.02 }) {
  const st = await poolState(server, poolId);
  const gross = quoteSell(st, tokens);
  const fee = gross * ROOKERY_FEE, tax = gross * creatorTax;
  const acct = await server.loadAccount(trader);
  const tb = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 4), networkPassphrase: passphrase })
    .addOperation(Operation.pathPaymentStrictSend({ sendAsset: asset, sendAmount: fmt(tokens), destination: trader, destAsset: Asset.native(), destMin: fmt(gross * (1 - slippage)), path: [] }))
    .addOperation(Operation.payment({ destination: burnReserve, asset: Asset.native(), amount: fmt(fee) }));
  if (tax > 0) tb.addOperation(Operation.payment({ destination: creator, asset: Asset.native(), amount: fmt(tax) }));
  return { tx: tb.setTimeout(120).build(), expectedOut: gross - fee - tax, fee, tax };
}

export { SDK, Keypair, Asset, Horizon };
