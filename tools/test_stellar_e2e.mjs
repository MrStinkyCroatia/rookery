// Staging E2E for Stellar markets (testnet): XLM deposits with memo -> create -> trade -> graduation into Aquarius
// -> LP burn checks -> token + XLM withdrawals -> ledger conservation. Usage: node tools/test_stellar_e2e.mjs
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
  const tb = new TransactionBuilder(a, { fee: '1000', networkPassphrase: Networks.TESTNET }).addOperation(Operation.payment({ destination: to, asset: Asset.native(), amount: String(amount) }));
  if (memo) tb.addMemo(Memo.id(String(memo)));
  const tx = tb.setTimeout(60).build(); tx.sign(kp); return hz.submitTransaction(tx);
};
const signup = async (c, tag) => { const n = tag + Math.random().toString(36).slice(2, 8); const r = await c.req('POST', '/auth/signup', { email: n + '@t.dev', username: n, password: 'testpass123' }); if (r.error) throw new Error(r.error); return n; };
const x = (w) => Number(BigInt(w || 0) * 10000n / WEI) / 10000;

const st = await admin.req('GET', '/admin/stellar', null, true);
console.log('hot', st.hot, 'net', st.net);
const A = new C(), Bc = new C();
const an = await signup(A, 'sta'), bn = await signup(Bc, 'stb');
const meA = await A.req('GET', '/me'), meB = await Bc.req('GET', '/me');
ok('deposit info: hot address + memo', meA.stellarDeposit?.address === st.hot && /^\d+$/.test(meA.stellarDeposit.memo), JSON.stringify(meA.stellarDeposit));

// deposits
const payer = Keypair.random(), payer2 = Keypair.random(); await fund(payer.publicKey()); await fund(payer2.publicKey());
await pay(payer, st.hot, 4000, meA.stellarDeposit.memo);
await pay(payer2, st.hot, 1500, meB.stellarDeposit.memo);
await pay(payer2, st.hot, 7, null);   // no memo -> unassigned
let a1, b1;
for (let i = 0; i < 6; i++) {
  await admin.req('POST', '/admin/stellar/run', {}, true);
  a1 = await A.req('GET', '/me'); b1 = await Bc.req('GET', '/me');
  if (x(a1.xlm) >= 4000 && x(b1.xlm) >= 1500) break; await sleep(4000);
}
ok('XLM deposit credited to A (memo)', x(a1.xlm) === 4000, x(a1.xlm));
ok('XLM deposit credited to B (memo)', x(b1.xlm) === 1500, x(b1.xlm));
await admin.req('POST', '/admin/stellar/run', {}, true);
ok('no double credit on re-scan', x((await A.req('GET', '/me')).xlm) === 4000);
const st2 = await admin.req('GET', '/admin/stellar', null, true);
const un = st2.unassigned.find(u => x(u.amount) === 7);
ok('deposit without memo parked as unassigned', !!un);

// create a Stellar market with a dev buy
const cr = await A.req('POST', '/markets', { name: 'Stellar Waddle', symbol: 'SWAD', description: 'e2e', network: 'stellar', devBuy: (50n * WEI).toString() });
ok('create Stellar market', cr.ok && cr.id, JSON.stringify(cr).slice(0, 160));
const id = cr.id;
let m = (await A.req('GET', '/market/' + id)).market;
ok('quote XLM, network stellar', m.quote === 'XLM' && m.network === 'stellar');
ok('graduation target ~ $1,500 (staging setting)', Math.abs(m.stellar.gradUsd - 1500) < 60, m.stellar.gradUsd);
ok('dev buy filled', BigInt(m.sold) > 0n);
// trading rules
const bad = await Bc.req('POST', '/trade', { market: id, side: 'buy', amount: (5n * WEI).toString(), pay: 'zro' });
ok('cannot pay a Stellar token with ZRO', /XLM/.test(bad.error || ''), bad.error);
const small = await Bc.req('POST', '/trade', { market: id, side: 'buy', amount: (WEI / 2n).toString() });
ok('minimum buy 1 XLM', /1 XLM/.test(small.error || ''), small.error);
const bb = await Bc.req('POST', '/trade', { market: id, side: 'buy', amount: (100n * WEI).toString() });
ok('B buys 100 XLM', bb.ok, bb.error);
const sell = await Bc.req('POST', '/trade', { market: id, side: 'sell', amount: (BigInt(bb.tokens) / 2n).toString() });
ok('B sells half', sell.ok, sell.error);
// fill the curve
let bonded = false;
for (let i = 0; i < 20 && !bonded; i++) {
  const r = await A.req('POST', '/trade', { market: id, side: 'buy', amount: (400n * WEI).toString() });
  if (r.error) { console.log('   buy err', r.error); break; }
  bonded = !!r.bonded;
}
ok('curve bonded', bonded);
const blocked = await Bc.req('POST', '/trade', { market: id, side: 'buy', amount: (5n * WEI).toString() });
ok('trading blocked while graduating / after', /Aquarius/.test(blocked.error || ''), blocked.error);
// graduation job
for (let i = 0; i < 20; i++) {
  m = (await A.req('GET', '/market/' + id)).market;
  if (m.migrated) break;
  await admin.req('POST', '/admin/stellar/run', {}, true); await sleep(5000);
}
ok('graduated on-chain (migrated)', m.migrated && m.stellar.issuer && m.stellar.pool, JSON.stringify(m.stellar).slice(0, 200));
if (m.migrated) {
  const iss = await hz.loadAccount(m.stellar.issuer), kp = await hz.loadAccount(m.stellar.keeper);
  ok('issuer locked', iss.signers.every(s => s.weight === 0));
  ok('LP keeper locked (LP burned)', kp.signers.every(s => s.weight === 0));
  const job = (await admin.req('GET', '/admin/stellar', null, true)).jobs.find(j => j.market === id);
  ok('job done', job?.status === 'done', JSON.stringify(job));
  // token withdrawal
  const W = Keypair.random(); await fund(W.publicKey());
  const bTok = (await Bc.req('GET', '/me')).holdings.find(h => h.id === id);
  ok('B holding shows Stellar asset', !!bTok?.stellar, JSON.stringify(bTok?.stellar));
  const noTl = await Bc.req('POST', '/wallet/withdraw', { chain: 'stellar', asset: 't:' + id, to: W.publicKey(), amount: bTok.amount });
  ok('token withdrawal without trustline refused + refunded', /trustline/i.test(noTl.error || '') && (await Bc.req('GET', '/me')).holdings.find(h => h.id === id)?.amount === bTok.amount, noTl.error);
  const a2 = await hz.loadAccount(W.publicKey());
  const tl = new TransactionBuilder(a2, { fee: '1000', networkPassphrase: Networks.TESTNET }).addOperation(Operation.changeTrust({ asset: new Asset(m.stellar.code, m.stellar.issuer) })).setTimeout(60).build();
  tl.sign(W); await hz.submitTransaction(tl);
  const wt = await Bc.req('POST', '/wallet/withdraw', { chain: 'stellar', asset: 't:' + id, to: W.publicKey(), amount: bTok.amount });
  ok('token withdrawal to Stellar wallet', wt.ok, wt.error);
  const a3 = await hz.loadAccount(W.publicKey());
  const got = Number(a3.balances.find(b => b.asset_code === m.stellar.code)?.balance || 0);
  ok('tokens arrived on-chain', Math.abs(got - x(bTok.amount)) < 0.01, `${got} vs ${x(bTok.amount)}`);
  // XLM withdrawal with memo
  const xw = await A.req('POST', '/wallet/withdraw', { chain: 'stellar', asset: 'xlm', to: W.publicKey(), amount: (100n * WEI).toString(), memo: '12345' });
  ok('XLM withdrawal', xw.ok && Number(xw.sent) === 99.95, JSON.stringify(xw).slice(0, 160));
  const bad2 = await A.req('POST', '/wallet/withdraw', { chain: 'stellar', asset: 'xlm', to: 'GBADADDRESS', amount: (5n * WEI).toString() });
  ok('invalid address rejected', /Stellar address/.test(bad2.error || ''));
}
// admin assign unassigned deposit
if (un) {
  const as = await admin.req('POST', '/admin/stellar/assign', { id: un.id, user: bn }, true);
  ok('admin assigns unassigned deposit', as.ok, as.error);
}
const led = await admin.req('GET', '/admin/ledger', null, true);
ok('ledger XLM conserved', Math.abs(led.xlm?.diffUnits ?? 99) < 1e-6, JSON.stringify(led.xlm).slice(0, 300));
ok('ledger ZRO unchanged sanity', led.zro && typeof led.zro.diffUnits === 'number', led.zro?.diffUnits);
console.log(`== Stellar staging E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
