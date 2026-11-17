// Staging (Stellar testnet): tokens go straight to the buyer's own Stellar wallet before graduation.
// Covers: trustline inside the buy signature, delivery with issuer authorization, AUTH_REQUIRED blocks pools,
// wallet-to-wallet transfers, sell from the wallet (XLM back to the wallet), plain returns do not bounce,
// email accounts stay custodial, and graduation still works (flag cleared, LP burned, leftovers dropped).
import * as S from '@stellar/stellar-sdk';
import fs from 'node:fs';
import { StellarIO } from '../worker/stellar.js';
const API = 'https://rookery-staging.stablepump-ops.workers.dev/api';
const KEY = fs.readFileSync(new URL('../.staging/.admin_key', import.meta.url), 'utf8').trim();
const hz = new S.Horizon.Server('https://horizon-testnet.stellar.org');
const WEI = 10n ** 18n;
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class C {
  constructor() { this.cookie = ''; }
  async req(method, path, body, admin = false) {
    if (admin) body = { ...(body || {}), key: KEY };
    const r = await fetch(API + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : ''), {
      method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie, 'user-agent': 'Mozilla/5.0' },
      body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return r.json().catch(() => ({ error: 'http ' + r.status }));
  }
}
const admin = new C();
const fund = async (kp) => { for (let i = 0; i < 5; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`); if (r.ok) break; await sleep(2500); }
  for (let i = 0; i < 20; i++) { try { await hz.loadAccount(kp.publicKey()); return; } catch { await sleep(1000); } } throw new Error('friendbot'); };
const submit = async (kp, ops, memo) => {
  const a = await hz.loadAccount(kp.publicKey());
  const tb = new S.TransactionBuilder(a, { fee: '1000', networkPassphrase: S.Networks.TESTNET });
  for (const op of ops) tb.addOperation(op);
  if (memo) tb.addMemo(S.Memo.id(String(memo)));
  const tx = tb.setTimeout(60).build(); tx.sign(kp); return hz.submitTransaction(tx);
};
const signXdr = (xdrB64, kp) => { const tx = S.TransactionBuilder.fromXDR(xdrB64, S.Networks.TESTNET); tx.sign(kp); return tx.toXDR(); };
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
async function walletLogin(c, kp) {
  const n = await c.req('POST', '/auth/stellar/nonce', { address: kp.publicKey() });
  const hash = await sha256(new TextEncoder().encode('Stellar Signed Message:\n' + n.message));
  return c.req('POST', '/auth/stellar/verify', { address: kp.publicKey(), nonce: n.nonce, signature: Buffer.from(kp.sign(Buffer.from(hash))).toString('base64') });
}
const x = (w) => Number(BigInt(w || 0) * 10000n / WEI) / 10000;
const run = () => admin.req('POST', '/admin/stellar/run', {}, true);
const sendNow = (extra = {}) => admin.req('POST', '/admin/stellar/send-now', { run: true, force: true, ...extra }, true);
const bal = async (pk, code, issuer) => { const a = await hz.loadAccount(pk); const b = a.balances.find(b => b.asset_code === code && b.asset_issuer === issuer); return b ? { v: Number(b.balance), auth: b.is_authorized } : null; };
const xlmOf = async (pk) => Number((await hz.loadAccount(pk)).balances.find(b => b.asset_type === 'native').balance);
const tok = (me, id) => BigInt((me.holdings || []).find(h => h.id === id)?.amount || '0');

const st = await admin.req('GET', '/admin/stellar', null, true);
const ledger0 = await admin.req('GET', '/admin/ledger', null, true);
const sw = await admin.req('POST', '/admin/stellar/send-now', { on: true }, true);
ok('send-now switched on (staging)', sw.on === true);

const kA = S.Keypair.random(), kB = S.Keypair.random(), kW = S.Keypair.random(), kF = S.Keypair.random();
await Promise.all([fund(kA), fund(kB), fund(kW), fund(kF)]);
const A = new C(), B = new C(), Cc = new C(), W = new C();
ok('A signs in with a Stellar wallet', (await walletLogin(A, kA)).ok);
ok('B signs in with a Stellar wallet', (await walletLogin(B, kB)).ok);
const cn = 'sc' + Math.random().toString(36).slice(2, 8), wn = 'sw' + Math.random().toString(36).slice(2, 8);
await Cc.req('POST', '/auth/signup', { email: cn + '@t.dev', username: cn, password: 'testpass123' });
await W.req('POST', '/auth/signup', { email: wn + '@t.dev', username: wn, password: 'testpass123' });
const memo = async (c) => (await c.req('GET', '/me')).stellarDeposit.memo;
await submit(kA, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '40' })], await memo(A));
await submit(kF, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '60' })], await memo(Cc));
await submit(kW, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '9900' })], await memo(W));
for (let i = 0; i < 15; i++) { await run(); if (x((await W.req('GET', '/me')).xlm) >= 9900 && x((await A.req('GET', '/me')).xlm) >= 40) break; await sleep(3000); }

const mk = await W.req('POST', '/markets', { name: 'Wallet Now', symbol: 'WNOW', description: 'send now', network: 'stellar', taxBurn: 1 });
const id = mk.id;
let m;
for (let i = 0; i < 20; i++) { m = (await W.req('GET', '/market/' + id)).market; if (m.stellar?.issuer) break; await run(); await sleep(3000); }
const code = m.stellar.code, issuer = m.stellar.issuer;
ok('token issued on Stellar', !!issuer, `${code}`);

// ── 1. buy from the wallet: trustline + payment in one signature
const prep = await A.req('POST', '/stellar/prep', { market: id, amount: (30n * WEI).toString(), address: kA.publicKey() });
const env = S.TransactionBuilder.fromXDR(prep.xdr, S.Networks.TESTNET);
ok('buy signature carries the trustline and the payment', env.operations.length === 2 && env.operations[0].type === 'changeTrust' && env.operations[1].type === 'payment',
  env.operations.map(o => o.type).join(' + '));
await A.req('POST', '/stellar/submit', { xdr: signXdr(prep.xdr, kA) });
let bA;
for (let i = 0; i < 10; i++) { await run(); await sendNow(); bA = await bal(kA.publicKey(), code, issuer); if (bA?.v > 0) break; await sleep(3000); }
let meA = await A.req('GET', '/me');
ok('tokens land in A\'s own wallet right after the buy', bA?.v > 0 && bA.auth, `${bA?.v} on-chain, authorized=${bA?.auth}`);
ok('nothing left in custody for A', tok(meA, id) < 100_000_000_000n);
const iss = await hz.loadAccount(issuer);
ok('asset requires authorization (no contracts before graduation)', iss.flags.auth_required && !iss.flags.auth_revocable);

// ── 2. a regular buy on the site by a wallet holder also goes to the wallet
const before2 = bA.v;
const t2 = await A.req('POST', '/trade', { market: id, side: 'buy', amount: (8n * WEI).toString() });
for (let i = 0; i < 6; i++) { await sendNow(); bA = await bal(kA.publicKey(), code, issuer); if (bA.v > before2) break; await sleep(2000); }
ok('site buy also delivered to the wallet', bA.v > before2 && Math.abs((bA.v - before2) - x(t2.tokens)) < 0.001, `+${(bA.v - before2).toFixed(4)} vs bought ${x(t2.tokens)}`);

// ── 3. nobody can put the token into a contract (a pool) before graduation
const io = new StellarIO('testnet', Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
let poolErr = null;
try {
  await io.invoke(kA, io.sac(new S.Asset(code, issuer)), 'transfer', [S.Address.fromString(kA.publicKey()).toScVal(), S.Address.fromString(io.sac(S.Asset.native())).toScVal(), S.nativeToScVal(10_000_000n, { type: 'i128' })]);
} catch (e) { poolErr = String(e.message || e).slice(0, 80); }
ok('holder cannot move tokens into a contract (pool) before graduation', !!poolErr, poolErr || 'transfer went through');

// ── 4. wallet to wallet: B opens a trustline on their own, Rookery authorizes it, A pays B
await submit(kB, [S.Operation.changeTrust({ asset: new S.Asset(code, issuer) })]);
await sendNow({ authz: true });
const bB0 = await bal(kB.publicKey(), code, issuer);
ok('trustlines opened by holders get authorized', bB0?.auth === true);
await submit(kA, [S.Operation.payment({ destination: kB.publicKey(), asset: new S.Asset(code, issuer), amount: '1000' })]);
ok('A can pay B wallet-to-wallet', (await bal(kB.publicKey(), code, issuer)).v === 1000);

// ── 5. sell from the wallet: tokens go back with a memo, XLM comes straight back to the wallet
const xlm0 = await xlmOf(kA.publicKey());
const sellAmt = Math.floor(bA.v / 2);
const ps = await A.req('POST', '/stellar/prep-sell', { market: id, amount: (BigInt(sellAmt) * WEI).toString(), address: kA.publicKey() });
ok('sell prepared as a token payment with memo', !!ps.xdr && /^s\d+$/.test(ps.memo), ps.error || ps.memo);
await A.req('POST', '/stellar/submit', { xdr: signXdr(ps.xdr, kA) });
let xlm1 = xlm0;
for (let i = 0; i < 10; i++) { await run(); xlm1 = await xlmOf(kA.publicKey()); if (xlm1 > xlm0) break; await sleep(3000); }
const bA2 = await bal(kA.publicKey(), code, issuer);
meA = await A.req('GET', '/me');
ok('XLM from the sale came back to the wallet', xlm1 > xlm0, `+${(xlm1 - xlm0).toFixed(4)} XLM`);
ok('the sold tokens left the wallet', Math.abs((bA.v - 1000) - bA2.v - sellAmt) < 0.001, `${bA2.v} left`);
ok('the sale is on the curve, nothing stuck in custody', tok(meA, id) < 100_000_000_000n && x(meA.xlm) < 41);

// ── 6. a plain return (no memo) is credited and does NOT bounce back out
await submit(kA, [S.Operation.payment({ destination: st.hot, asset: new S.Asset(code, issuer), amount: '500' })]);
for (let i = 0; i < 6; i++) { await run(); meA = await A.req('GET', '/me'); if (tok(meA, id) > 0n) break; await sleep(3000); }
await sendNow();
meA = await A.req('GET', '/me');
ok('returned tokens credited to A on Rookery', x(tok(meA, id)) === 500, `${x(tok(meA, id))}`);
ok('returned tokens are not sent back out', (await bal(kA.publicKey(), code, issuer)).v === bA2.v - 500);

// ── 7. email accounts stay custodial
const tc = await Cc.req('POST', '/trade', { market: id, side: 'buy', amount: (20n * WEI).toString() });
await sendNow();
ok('email buyer keeps tokens on Rookery', tok(await Cc.req('GET', '/me'), id) === BigInt(tc.tokens || 0) && BigInt(tc.tokens || 0) > 0n);

// ── 8. graduation still works with tokens out in wallets
for (let i = 0; i < 40; i++) {
  m = (await W.req('GET', '/market/' + id)).market; if (m.graduated) break;
  const r = await W.req('POST', '/trade', { market: id, side: 'buy', amount: (400n * WEI).toString() });
  if (r.error) { console.log('   whale:', r.error); break; }
}
for (let i = 0; i < 30; i++) { m = (await W.req('GET', '/market/' + id)).market; if (m.migrated) break; await run(); await sleep(5000); }
const issAfter = await hz.loadAccount(issuer);
ok('graduated into Aquarius', m.migrated, m.stellar?.pool || '');
ok('issuer locked and the flag cleared', issAfter.signers.every(s => s.weight === 0) && !issAfter.flags.auth_required);
for (let i = 0; i < 4; i++) { await run(); await sleep(3000); }
const fin = await bal(kA.publicKey(), code, issuer);
ok('A\'s 500 returned tokens dropped back to A after graduation', Math.abs(fin.v - bA2.v) < 0.001, `${fin.v}`);

const ledger1 = await admin.req('GET', '/admin/ledger', null, true);
ok('ledger XLM still balanced', Math.abs(ledger1.xlm.diffUnits - ledger0.xlm.diffUnits) < 2, `${ledger0.xlm.diffUnits} -> ${ledger1.xlm.diffUnits}`);
await admin.req('POST', '/admin/stellar/send-now', { on: false }, true);
console.log(`== tokens straight to the wallet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
