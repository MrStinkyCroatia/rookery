// Seed the Stellar TESTNET preview: fixed burn-reserve (= on-chain launch registry) + a few real launches with trades.
import fs from 'node:fs';
import { net, buildLaunch, buildBuy, buildSell, SDK, Keypair } from './launch_lib.mjs';
const N = net('testnet'), server = new SDK.Horizon.Server(N.horizon);
const fund = async (pk) => { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (!r.ok && r.status !== 400) throw new Error('friendbot ' + r.status); };
const send = async (tx, ...k) => { k.forEach(x => tx.sign(x)); return server.submitTransaction(tx); };
const F = new URL('./.testnet_burn', import.meta.url);
let burn;
if (fs.existsSync(F)) burn = Keypair.fromSecret(fs.readFileSync(F, 'utf8').trim());
else { burn = Keypair.random(); fs.writeFileSync(F, burn.secret(), { mode: 0o600 }); await fund(burn.publicKey()); }
console.log('BURN_RESERVE', burn.publicKey());

const TOKENS = [
  { code: 'WADDLE', name: 'Waddle', desc: 'Slow walk, long hold. The first penguin on Stellar.', seed: 100, tax: 100, first: 4, buys: [60, 40, 25, 80, 30] },
  { code: 'LUMPEN', name: 'Lumpen Penguin', desc: 'Cold feet, warm bags.', seed: 100, tax: 0, first: 2, buys: [15, 30, 10] },
  { code: 'ICEFLOE', name: 'Ice Floe', desc: 'Drifting from LayerZero to Stellar at 2 knots.', seed: 250, tax: 200, first: 0, buys: [50, 120, 60, 40] },
  { code: 'KRILL', name: 'Krill', desc: 'Small individually, enormous together.', seed: 50, tax: 0, first: 1, buys: [5, 8] },
  { code: 'STNK', name: 'Stinky Lumen', desc: 'Parody. Not affiliated with anyone. Smells like XLM.', seed: 100, tax: 50, first: 3, buys: [20, 70, 15, 90, 35, 25] },
];
const traders = [Keypair.random(), Keypair.random(), Keypair.random()];
for (const t of traders) await fund(t.publicKey());
const out = [];
for (const T of TOKENS) {
  const creator = Keypair.random(); await fund(creator.publicKey());
  const L = await buildLaunch({ server, passphrase: N.passphrase, creator: creator.publicKey(), code: T.code, seedXlm: T.seed, burnReserve: burn.publicKey(),
    launchFeeXlm: 5, firstBuyXlm: T.first, homeDomain: 'rookery.stinkypenguin.xyz', creatorTaxBp: T.tax, meta: { name: T.name, desc: T.desc, x: 'https://x.com/StinkyPenguinL0' } });
  await send(L.tx, creator);
  let i = 0;
  for (const b of T.buys) {
    const tr = traders[i++ % traders.length];
    const B = await buildBuy({ server, passphrase: N.passphrase, trader: tr.publicKey(), asset: L.asset, poolId: L.poolId, xlm: b, burnReserve: burn.publicKey(), creator: creator.publicKey(), creatorTax: T.tax / 1e4, slippage: 0.05 });
    await send(B.tx, tr);
    if (i % 3 === 0) {
      const a = await server.loadAccount(tr.publicKey());
      const bal = Number(a.balances.find(x => x.asset_code === T.code)?.balance || 0);
      if (bal > 0) { const S = await buildSell({ server, passphrase: N.passphrase, trader: tr.publicKey(), asset: L.asset, poolId: L.poolId, tokens: Math.floor(bal * 0.3), burnReserve: burn.publicKey(), creator: creator.publicKey(), creatorTax: T.tax / 1e4, slippage: 0.05 }); await send(S.tx, tr); }
    }
  }
  console.log('launched', T.code, L.issuer, L.poolId);
  out.push({ code: T.code, issuer: L.issuer, pool: L.poolId });
}
console.log(JSON.stringify(out));
