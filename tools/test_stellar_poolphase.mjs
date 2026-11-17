// Staging (testnet) simulation of the real mainnet case: the curve sells out BELOW the graduation target,
// the token keeps trading on the Rookery pool, and graduates into Aquarius only when it reaches the target.
// Also checks: burn tax tokens burned on-chain, no token withdrawals before graduation, price continuity, ledger.
import fs from 'node:fs';
import { Keypair, Asset, Operation, TransactionBuilder, Networks, Memo, Horizon } from '@stellar/stellar-sdk';
const BASE = 'https://rookery-staging.stablepump-ops.workers.dev/api';
const KEY = fs.readFileSync(new URL('../.staging/.admin_key', import.meta.url), 'utf8').trim();
const hz = new Horizon.Server('https://horizon-testnet.stellar.org');
const WEI = 10n ** 18n;
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n} ${x}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class C {
  constructor() { this.cookie = ''; }
  async req(method, path, body, admin = false) {
    if (admin) body = { ...(body || {}), key: KEY };
    const r = await fetch(BASE + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : ''), {
      method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie, 'user-agent': 'Mozilla/5.0' }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return r.json().catch(() => ({ error: 'http ' + r.status }));
  }
}
const admin = new C();
const fund = async (pk) => { for (let i = 0; i < 4; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (r.ok) return; await sleep(2500); } throw new Error('friendbot'); };
const pay = async (kp, to, amount, memo) => {
  const a = await hz.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(a, { fee: '1000', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: to, asset: Asset.native(), amount: String(amount) })).addMemo(Memo.id(String(memo))).setTimeout(60).build();
  tx.sign(kp); return hz.submitTransaction(tx);
};
const x = (w) => Number(BigInt(w || 0) * 10000n / WEI) / 10000;
const ledger0 = await admin.req('GET', '/admin/ledger', null, true);
const st = await admin.req('GET', '/admin/stellar', null, true);
const A = new C();
const n = 'pp' + Math.random().toString(36).slice(2, 8);
await A.req('POST', '/auth/signup', { email: n + '@t.dev', username: n, password: 'testpass123' });
const me = await A.req('GET', '/me');
// two friendbot wallets = ~20k test XLM
for (let i = 0; i < 2; i++) { const kp = Keypair.random(); await fund(kp.publicKey()); await pay(kp, st.hot, 9990, me.stellarDeposit.memo); }
let bal = 0;
for (let i = 0; i < 20 && bal < 19900; i++) { await admin.req('POST', '/admin/stellar/run', {}, true); bal = x((await A.req('GET', '/me')).xlm); if (bal < 19900) await sleep(4000); }
ok('19,980 XLM deposited with memo and credited', bal >= 19900, bal);

const cr = await A.req('POST', '/markets', { name: 'Pool Phase', symbol: 'PPH', description: 'pool-phase sim', network: 'stellar', taxBurn: 2, devBuy: (20n * WEI).toString() });
ok('create Stellar market (2% burn tax)', cr.ok, JSON.stringify(cr).slice(0, 120));
const id = cr.id;
let m;
for (let i = 0; i < 15; i++) { m = (await A.req('GET', '/market/' + id)).market; if (m.stellar?.issuer) break; await admin.req('POST', '/admin/stellar/run', {}, true); await sleep(3000); }
ok('asset issued on Stellar at creation', !!m.stellar?.issuer, m.stellar?.issuer);
const curveTarget = m.stellar.gradUsd;
// raise THIS market's target by 60%: its curve now sells out well below the target, exactly like BORING on mainnet
const target = Math.round(curveTarget * 1.6);
const sg = await admin.req('POST', '/admin/stellar/grad', { market: id, usd: target }, true);
ok('market target raised above the curve end', sg.ok && sg.gradUsd === target, `${curveTarget} -> ${target}`);

const wEarly = await A.req('POST', '/wallet/withdraw', { asset: 't:' + id, chain: 'stellar', to: Keypair.random().publicKey(), amount: WEI.toString() });
ok('token withdrawal blocked before graduation', /after it graduates/i.test(wEarly.error || ''), wEarly.error);
ok('wallet does not offer the token yet', !(await A.req('GET', '/me')).holdings.find(h => h.id === id)?.stellar?.withdrawable);

// fill the curve
for (let i = 0; i < 40; i++) {
  m = (await A.req('GET', '/market/' + id)).market; if (m.graduated) break;
  const r = await A.req('POST', '/trade', { market: id, side: 'buy', amount: (300n * WEI).toString() });
  if (r.error) { console.log('   buy:', r.error); break; }
}
m = (await A.req('GET', '/market/' + id)).market;
ok('curve sold out -> bonded (Rookery pool phase)', m.graduated && !m.migrated);
ok('bonded below target: no graduation yet', m.mcapUsd < target * 0.995, `mcap $${m.mcapUsd.toFixed(0)} < $${target}`);
ok('progress shows distance to target, not 100%', m.progress < 99 && Math.abs(m.progress - (m.mcapUsd / target) * 100) < 0.2, m.progress);
await admin.req('POST', '/admin/stellar/run', {}, true);
const j0 = await admin.req('GET', '/admin/stellar', null, true);
ok('no graduation job while below target', !(j0.jobs || []).some(j => j.market === id), JSON.stringify(j0.jobs || []).slice(0, 100));

// pool phase: a sell and buys until the target
const tk = BigInt((await A.req('GET', '/me')).holdings.find(h => h.id === id).amount);
const s1 = await A.req('POST', '/trade', { market: id, side: 'sell', amount: (tk / 50n).toString() });
ok('selling works in the pool phase', s1.ok, s1.error);
let lastPrice = 0, migrated = false;
for (let i = 0; i < 40; i++) {
  m = (await A.req('GET', '/market/' + id)).market;
  if (m.mcapUsd >= target * 0.995) break;
  const r = await A.req('POST', '/trade', { market: id, side: 'buy', amount: (250n * WEI).toString() });
  if (r.error) { console.log('   buy:', r.error); break; }
}
m = (await A.req('GET', '/market/' + id)).market;
lastPrice = m.priceZro;
ok('pool phase reached the target', m.mcapUsd >= target * 0.995, `$${m.mcapUsd.toFixed(0)}`);
const blocked = await A.req('POST', '/trade', { market: id, side: 'buy', amount: (5n * WEI).toString() });
ok('trading frozen while graduating', /Graduating/i.test(blocked.error || ''), blocked.error);
const poolXlm = x(m.poolZro), poolTok = x(m.poolTok), burned = x(m.burned);
for (let i = 0; i < 30 && !migrated; i++) { await admin.req('POST', '/admin/stellar/run', {}, true); await sleep(5000); m = (await A.req('GET', '/market/' + id)).market; migrated = m.migrated; }
const job = ((await admin.req('GET', '/admin/stellar', null, true)).jobs || []).find(j => j.market === id);
ok('graduated into Aquarius', migrated, JSON.stringify(job || {}).slice(0, 200));
if (migrated) {
  const iss = await hz.loadAccount(m.stellar.issuer);
  ok('issuer locked (no more minting)', iss.thresholds.high_threshold >= 1 && iss.signers.every(s => s.weight === 0));
  const kp = await hz.loadAccount(m.stellar.keeper);
  ok('LP keeper locked (LP burned)', kp.signers.every(s => s.weight === 0));
  const asset = await (await fetch(`https://horizon-testnet.stellar.org/assets?asset_code=${m.stellar.code}&asset_issuer=${m.stellar.issuer}`)).json();
  const onchain = Number(asset._embedded.records[0]?.balances?.authorized || 0) + Number(asset._embedded.records[0]?.contracts_amount || 0) + Number(asset._embedded.records[0]?.liquidity_pools_amount || 0);
  ok('burn-tax tokens burned on-chain', Math.abs(onchain - (1e9 - burned)) < 2, `on-chain ${onchain.toFixed(0)} = 1B - ${burned.toFixed(0)} burned`);
  const S = job;
  const aquaPrice = S.depositXlm / poolTok;
  ok('Aquarius opens within 2% of the last Rookery price', Math.abs(aquaPrice / lastPrice - 1) < 0.02, `rookery ${lastPrice.toExponential(4)} vs aquarius ${aquaPrice.toExponential(4)} (${((aquaPrice / lastPrice - 1) * 100).toFixed(2)}%)`);
  console.log(`   pool ${poolXlm.toFixed(0)} XLM -> deposited ${S.depositXlm} XLM + ${poolTok.toFixed(0)} tokens, AQUA cost ${S.aquaCostXlm || 0} XLM`);
  const after = await A.req('GET', '/me');
  ok('token now withdrawable', !!after.holdings.find(h => h.id === id)?.stellar?.withdrawable);
}
const ledger1 = await admin.req('GET', '/admin/ledger', null, true);
ok('ledger XLM still balanced', Math.abs(ledger1.xlm.diffUnits - ledger0.xlm.diffUnits) < 2, `${ledger0.xlm.diffUnits} -> ${ledger1.xlm.diffUnits}`);
console.log(`== pool-phase graduation sim: ${pass} passed, ${fail} failed`);
