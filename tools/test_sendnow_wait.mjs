// Staging: a holder buys on the site while delivery is on, but their wallet is not ready yet.
// The tokens must wait (never get lost), then arrive by themselves once the wallet can take them.
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
const push = () => admin.req('POST', '/admin/stellar/send-now', { run: true, force: true }, true);
const bal = async (pk, code, issuer) => { try { const a = await hz.loadAccount(pk); const b = a.balances.find(b => b.asset_code === code && b.asset_issuer === issuer); return b ? Number(b.balance) : 0; } catch { return null; } };
const hold = async (c, id) => BigInt(((await c.req('GET', '/me')).holdings || []).find(h => h.id === id)?.amount || '0');

const st = await admin.req('GET', '/admin/stellar', null, true);
await admin.req('POST', '/admin/stellar/send-now', { on: true }, true);
const u1 = S.Keypair.random(), u2 = S.Keypair.random(), w = S.Keypair.random();
await Promise.all([fund(u1), fund(w)]);   // U2's wallet stays unactivated until the end of the test
const U1 = new C(), U2 = new C(), W = new C();
// U1: wallet active, no trustline. U2: wallet does not exist on-chain yet.
const login = async (c, kp) => { const n = await c.req('POST', '/auth/stellar/nonce', { address: kp.publicKey() });
  const h = await sha256(new TextEncoder().encode('Stellar Signed Message:\n' + n.message));
  return c.req('POST', '/auth/stellar/verify', { address: kp.publicKey(), nonce: n.nonce, signature: Buffer.from(kp.sign(Buffer.from(h))).toString('base64') }); };
ok('wallet 1 signed in', (await login(U1, u1)).ok);
ok('wallet 2 signed in', (await login(U2, u2)).ok);
// U1 pays in from their own wallet; U2's wallet stays unactivated on purpose, so they get a credit instead
await submit(u1, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '60' })], (await U1.req('GET', '/me')).stellarDeposit.memo);
const u2name = (await U2.req('GET', '/me')).username;
await admin.req('POST', '/admin/credit', { user: u2name, asset: 'xlm', amount: (60n * WEI).toString(), note: 'test funding' }, true);
await W.req('POST', '/auth/signup', { email: 'wx' + Math.random().toString(36).slice(2, 7) + '@t.dev', username: 'wx' + Math.random().toString(36).slice(2, 7), password: 'testpass123' });
await submit(w, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '9900' })], (await W.req('GET', '/me')).stellarDeposit.memo);
for (let i = 0; i < 12; i++) { await run(); if (x((await W.req('GET', '/me')).xlm) >= 9900 && x((await U1.req('GET', '/me')).xlm) >= 60) break; await sleep(3000); }
const mk = await W.req('POST', '/markets', { name: 'Wait Test', symbol: 'WAIT', description: 'x', network: 'stellar' });
const id = mk.id;
let m;
for (let i = 0; i < 20; i++) { m = (await W.req('GET', '/market/' + id)).market; if (m.stellar?.issuer) break; await run(); await sleep(3000); }
const code = m.stellar.code, issuer = m.stellar.issuer;

// U1 buys on the site with no trustline: tokens must wait, not vanish
const b1 = await U1.req('POST', '/trade', { market: id, side: 'buy', amount: (20n * WEI).toString() });
ok('buy accepted without a trustline', BigInt(b1.tokens || 0) > 0n);
const held1 = await hold(U1, id);
for (let i = 0; i < 4; i++) { await run(); await sleep(2500); }
ok('tokens wait in custody', (await hold(U1, id)) === held1 && (await bal(u1.publicKey(), code, issuer)) === 0);
const q1 = (await admin.req('POST', '/admin/stellar/send-now', {}, true)).queue.find(r => r.market === id && r.username && r.pending !== '0');
ok('queue explains the wait', !!q1 && /trustline/i.test(q1.note || ''), q1 ? q1.note : 'no row');

// trustline appears -> delivered by itself
await submit(u1, [S.Operation.changeTrust({ asset: new S.Asset(code, issuer) })]);
let v1 = 0;
for (let i = 0; i < 8; i++) { await push(); v1 = await bal(u1.publicKey(), code, issuer) || 0; if (v1 > 0) break; await sleep(3000); }
ok('delivered once the trustline exists', Math.abs(v1 - x(held1)) < 0.001, `${v1} vs ${x(held1)}`);
ok('custody emptied', (await hold(U1, id)) < 100_000_000_000n);

// U2 has a wallet that does not exist on-chain yet: they cannot even be paid, so tokens must wait
const b2 = await U2.req('POST', '/trade', { market: id, side: 'buy', amount: (10n * WEI).toString() });
ok('buy from a wallet with no on-chain account accepted', BigInt(b2.tokens || 0) > 0n, b2.error || '');
const held2 = await hold(U2, id);
for (let i = 0; i < 4; i++) { await run(); await sleep(2500); }
ok('tokens stay safe while the account does not exist', (await hold(U2, id)) === held2 && (await bal(u2.publicKey(), code, issuer)) === null);
// the holder activates the account and adds the trustline: tokens arrive
await fund(u2);
await submit(u2, [S.Operation.changeTrust({ asset: new S.Asset(code, issuer) })]);
let v2 = 0;
for (let i = 0; i < 8; i++) { await push(); v2 = await bal(u2.publicKey(), code, issuer) || 0; if (v2 > 0) break; await sleep(3000); }
ok('delivered after the account is activated', Math.abs(v2 - x(held2)) < 0.001, `${v2} vs ${x(held2)}`);
await admin.req('POST', '/admin/stellar/send-now', { on: false }, true);
console.log(`== waiting holders: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
