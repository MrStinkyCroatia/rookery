// Staging: a holder who bought while send-now was off, then links a Stellar wallet, gets the tokens sent
// automatically on the next tick. Tokens sent back with no memo stay in custody and are never bounced out.
import * as S from '@stellar/stellar-sdk';
import fs from 'node:fs';
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
    const url = API + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : '');
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return r.json().catch(() => ({ error: 'http ' + r.status }));
  }
}
const admin = new C();
const fund = async (kp) => { for (let i = 0; i < 5; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`); if (r.ok) break; await sleep(2500); }
  for (let i = 0; i < 20; i++) { try { await hz.loadAccount(kp.publicKey()); return; } catch { await sleep(1000); } } };
const submit = async (kp, ops, memo) => { const a = await hz.loadAccount(kp.publicKey()); const tb = new S.TransactionBuilder(a, { fee: '1000', networkPassphrase: S.Networks.TESTNET });
  for (const op of ops) tb.addOperation(op); if (memo) tb.addMemo(S.Memo.id(String(memo))); const tx = tb.setTimeout(60).build(); tx.sign(kp); return hz.submitTransaction(tx); };
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const x = (w) => Number(BigInt(w || 0) * 10000n / WEI) / 10000;
const run = () => admin.req('POST', '/admin/stellar/run', {}, true);
const setNow = (on) => admin.req('POST', '/admin/stellar/send-now', { on }, true);
const bal = async (pk, code, issuer) => { const a = await hz.loadAccount(pk); const b = a.balances.find(b => b.asset_code === code && b.asset_issuer === issuer); return b ? Number(b.balance) : null; };

const st = await admin.req('GET', '/admin/stellar', null, true);
await setNow(false);
const kU = S.Keypair.random(), kX = S.Keypair.random(), kE = S.Keypair.random(), kF = S.Keypair.random();
await Promise.all([fund(kU), fund(kX), fund(kE), fund(kF)]);
// email account that buys and later links a wallet
const e = 'sd' + Math.random().toString(36).slice(2, 8);
const E = new C(); await E.req('POST', '/auth/signup', { email: e + '@t.dev', username: e, password: 'testpass123' });
await submit(kE, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '40' })], (await E.req('GET', '/me')).stellarDeposit.memo);
const W = new C(); await W.req('POST', '/auth/signup', { email: 'w' + e + '@t.dev', username: 'w' + e, password: 'testpass123' });
await submit(kF, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '9900' })], (await W.req('GET', '/me')).stellarDeposit.memo);
for (let i = 0; i < 12; i++) { await run(); if (x((await E.req('GET', '/me')).xlm) >= 40 && x((await W.req('GET', '/me')).xlm) >= 9900) break; await sleep(3000); }

const mk = await W.req('POST', '/markets', { name: 'Seed Test', symbol: 'SEED', description: 'x', network: 'stellar' });
const id = mk.id;
let m;
for (let i = 0; i < 20; i++) { m = (await W.req('GET', '/market/' + id)).market; if (m.stellar?.issuer) break; await run(); await sleep(3000); }
const code = m.stellar.code, issuer = m.stellar.issuer;

// the email holder buys while delivery is off
const tb = await E.req('POST', '/trade', { market: id, side: 'buy', amount: (20n * WEI).toString() });
ok('email holder bought on the curve', BigInt(tb.tokens || 0) > 0n);
const held = BigInt((await E.req('GET', '/me')).holdings.find(h => h.id === id).amount);
ok('tokens are in custody', held > 0n);

// they link a Stellar wallet, then delivery is switched on
const n = await E.req('POST', '/auth/stellar/nonce', { address: kU.publicKey() });
const hash = await sha256(new TextEncoder().encode('Stellar Signed Message:\n' + n.message));
await E.req('POST', '/auth/stellar/verify', { address: kU.publicKey(), nonce: n.nonce, signature: Buffer.from(kU.sign(Buffer.from(hash))).toString('base64'), link: true });
await submit(kU, [S.Operation.changeTrust({ asset: new S.Asset(code, issuer) })]);
await setNow(true);
let v = null;
for (let i = 0; i < 10; i++) { await run(); v = await bal(kU.publicKey(), code, issuer); if (v > 0) break; await sleep(3000); }
ok('linked holder gets the tokens automatically, no admin action', v !== null && Math.abs(v - x(held)) < 0.001, `${v} on-chain vs ${x(held)} held`);
ok('custody emptied', BigInt((await E.req('GET', '/me')).holdings.find(h => h.id === id).amount) < 100_000_000_000n);

// tokens sent back with no memo stay in custody and are not bounced out
await submit(kU, [S.Operation.payment({ destination: st.hot, asset: new S.Asset(code, issuer), amount: '500' })]);
for (let i = 0; i < 5; i++) { await run(); if (BigInt((await E.req('GET', '/me')).holdings.find(h => h.id === id).amount) > 0n) break; await sleep(3000); }
const before = await bal(kU.publicKey(), code, issuer);
for (let i = 0; i < 3; i++) { await run(); await sleep(2000); }
ok('returned 500 stay on Rookery', x((await E.req('GET', '/me')).holdings.find(h => h.id === id).amount) === 500);
ok('and are not sent back out', (await bal(kU.publicKey(), code, issuer)) === before, `${before} -> ${await bal(kU.publicKey(), code, issuer)}`);

await setNow(false);
console.log(`== holders who link a wallet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
