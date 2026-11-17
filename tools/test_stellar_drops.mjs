// Staging (Stellar testnet): after graduation, holders with a linked Stellar wallet receive their tokens automatically.
//   A: wallet login + trustline before graduation  -> sent right after graduation
//   B: wallet login, no trustline                 -> waits; adds trustline later -> sent
//   C: email account, no Stellar wallet           -> nothing sent, balance stays on Rookery
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
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
async function walletLogin(c, kp) {
  const n = await c.req('POST', '/auth/stellar/nonce', { address: kp.publicKey() });
  const hash = await sha256(new TextEncoder().encode('Stellar Signed Message:\n' + n.message));
  const signature = Buffer.from(kp.sign(Buffer.from(hash))).toString('base64');
  return c.req('POST', '/auth/stellar/verify', { address: kp.publicKey(), nonce: n.nonce, signature });
}
const x = (w) => Number(BigInt(w || 0) * 10000n / WEI) / 10000;
const run = () => admin.req('POST', '/admin/stellar/run', {}, true);
const onchain = async (pk, code, issuer) => {
  const a = await hz.loadAccount(pk);
  const b = a.balances.find(b => b.asset_code === code && b.asset_issuer === issuer);
  return b ? Number(b.balance) : null;
};
const tok = (me, id) => BigInt((me.holdings || []).find(h => h.id === id)?.amount || '0');

const st = await admin.req('GET', '/admin/stellar', null, true);
const ledger0 = await admin.req('GET', '/admin/ledger', null, true);
console.log('hot', st.hot);

// accounts
const kA = S.Keypair.random(), kB = S.Keypair.random(), kW = S.Keypair.random(), kF = S.Keypair.random();
await Promise.all([fund(kA), fund(kB), fund(kW), fund(kF)]);
const A = new C(), B = new C(), Cc = new C(), W = new C();
ok('A signs in with a Stellar wallet', (await walletLogin(A, kA)).ok);
ok('B signs in with a Stellar wallet', (await walletLogin(B, kB)).ok);
const cn = 'dc' + Math.random().toString(36).slice(2, 8), wn = 'dw' + Math.random().toString(36).slice(2, 8);
await Cc.req('POST', '/auth/signup', { email: cn + '@t.dev', username: cn, password: 'testpass123' });
await W.req('POST', '/auth/signup', { email: wn + '@t.dev', username: wn, password: 'testpass123' });
const memo = async (c) => (await c.req('GET', '/me')).stellarDeposit.memo;
await submit(kA, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '60' })], await memo(A));
await submit(kB, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '60' })], await memo(B));
await submit(kF, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '60' })], await memo(Cc));
await submit(kW, [S.Operation.payment({ destination: st.hot, asset: S.Asset.native(), amount: '9900' })], await memo(W));
for (let i = 0; i < 15; i++) { await run(); if (x((await W.req('GET', '/me')).xlm) >= 9900 && x((await Cc.req('GET', '/me')).xlm) >= 60) break; await sleep(3000); }
ok('all deposits credited', x((await A.req('GET', '/me')).xlm) >= 60 && x((await W.req('GET', '/me')).xlm) >= 9900);

// market, issued on Stellar at creation
const mk = await W.req('POST', '/markets', { name: 'Drop Test', symbol: 'DROP', description: 'auto drop', network: 'stellar', taxBurn: 1 });
ok('market created', mk.ok, mk.error || mk.id);
const id = mk.id;
let m;
for (let i = 0; i < 20; i++) { m = (await W.req('GET', '/market/' + id)).market; if (m.stellar?.issuer) break; await run(); await sleep(3000); }
const code = m.stellar.code, issuer = m.stellar.issuer;
ok('asset issued at creation', !!issuer, `${code} · ${issuer}`);

// holders buy on the curve
for (const c of [A, B, Cc]) { const r = await c.req('POST', '/trade', { market: id, side: 'buy', amount: (50n * WEI).toString() }); if (!r.ok) console.log('   buy:', r.error); }
const tA = tok(await A.req('GET', '/me'), id), tB = tok(await B.req('GET', '/me'), id), tC = tok(await Cc.req('GET', '/me'), id);
ok('A, B and C hold tokens', tA > 0n && tB > 0n && tC > 0n, `${x(tA)} / ${x(tB)} / ${x(tC)}`);

// A prepares a trustline before graduation; B does not
await submit(kA, [S.Operation.changeTrust({ asset: new S.Asset(code, issuer) })]);
ok('A added a trustline before graduation', (await onchain(kA.publicKey(), code, issuer)) === 0);

// the whale fills the curve: graduation
for (let i = 0; i < 40; i++) {
  m = (await W.req('GET', '/market/' + id)).market; if (m.graduated) break;
  const r = await W.req('POST', '/trade', { market: id, side: 'buy', amount: (400n * WEI).toString() });
  if (r.error) { console.log('   whale:', r.error); break; }
}
for (let i = 0; i < 30; i++) { m = (await W.req('GET', '/market/' + id)).market; if (m.migrated) break; await run(); await sleep(5000); }
ok('token graduated to Aquarius', m.migrated, m.stellar?.pool || '');

// a couple of cron ticks for the drop
let drops;
for (let i = 0; i < 6; i++) {
  await run();
  drops = (await admin.req('POST', '/admin/stellar/drops', { market: id }, true)).rows || [];
  if (drops.some(d => d.status === 'sent')) break;
  await sleep(4000);
}
const meA = await A.req('GET', '/me'), meB = await B.req('GET', '/me'), meC = await Cc.req('GET', '/me');
const dA = drops.find(d => d.user_id && d.address === kA.publicKey()), dB = drops.find(d => d.address === kB.publicKey());
const balA = await onchain(kA.publicKey(), code, issuer);
ok('A: sent automatically after graduation', dA?.status === 'sent', dA ? `${dA.status} · ${dA.note}` : 'no row');
ok('A: tokens are in A\'s own wallet', Math.abs(balA - x(tA)) < 0.001, `${balA} on-chain vs ${x(tA)} bought`);
ok('A: Rookery balance emptied (only dust)', tok(meA, id) < 100_000_000_000n);
ok('B: waits for a trustline', dB?.status === 'no_trustline' && /trustline/.test(dB.note), dB ? `${dB.status} · ${dB.note}` : 'no row');
ok('B: tokens still safe on Rookery', tok(meB, id) === tB);
ok('B: wallet page tells B what to do', (meB.holdings || []).find(h => h.id === id)?.stellar?.drop?.status === 'no_trustline');
ok('C: no Stellar wallet, no drop', !drops.some(d => d.username === cn) && tok(meC, id) === tC);

// B adds the trustline later
await submit(kB, [S.Operation.changeTrust({ asset: new S.Asset(code, issuer) })]);
const forced = await admin.req('POST', '/admin/stellar/drops', { market: id, run: true, force: true }, true);
const dB2 = (forced.rows || []).find(d => d.address === kB.publicKey());
const balB = await onchain(kB.publicKey(), code, issuer);
ok('B: sent once the trustline exists', dB2?.status === 'sent', dB2 ? `${dB2.status} · ${dB2.note}` : '');
ok('B: tokens are in B\'s own wallet', Math.abs(balB - x(tB)) < 0.001, `${balB} on-chain vs ${x(tB)} bought`);

// nothing is sent twice
const again = await admin.req('POST', '/admin/stellar/drops', { market: id, run: true, force: true }, true);
ok('no double send', (again.run?.sent || 0) === 0 && (await onchain(kA.publicKey(), code, issuer)) === balA && (await onchain(kB.publicKey(), code, issuer)) === balB);

const ledger1 = await admin.req('GET', '/admin/ledger', null, true);
ok('ledger XLM still balanced', Math.abs(ledger1.xlm.diffUnits - ledger0.xlm.diffUnits) < 2, `${ledger0.xlm.diffUnits} -> ${ledger1.xlm.diffUnits}`);
console.log(`== automatic token drop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
