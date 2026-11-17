// Validates: a deposit with NO memo from an address the user has already withdrawn to
// is auto-credited to that user (staging / Stellar testnet).
import * as S from '@stellar/stellar-sdk';
const API = 'https://rookery-staging.stablepump-ops.workers.dev/api';
const ADMIN = (await import('node:fs')).readFileSync(new URL('../.staging/.admin_key', import.meta.url), 'utf8').trim();
const HOT = 'GCYVXPUKH3WLW6AJCYPHFLU6BEOABA32JFFKGO35HFCDMPONOE3W46MV';
const h = new S.Horizon.Server('https://horizon-testnet.stellar.org');

const j = async (m, p, body, cookie) => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', 'x-pl': '1', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { d, cookie: (r.headers.get('set-cookie') || '').split(';')[0] || cookie };
};
const fund = async (kp) => { await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`); for (let i = 0; i < 30; i++) { try { await h.loadAccount(kp.publicKey()); return; } catch { await new Promise(r => setTimeout(r, 1000)); } } throw new Error('friendbot timeout'); };
const pay = async (kp, to, amt, memo) => {
  const acc = await h.loadAccount(kp.publicKey());
  const b = new S.TransactionBuilder(acc, { fee: '10000', networkPassphrase: S.Networks.TESTNET })
    .addOperation(S.Operation.payment({ destination: to, asset: S.Asset.native(), amount: String(amt) }));
  if (memo) b.addMemo(S.Memo.id(String(memo)));
  const tx = b.setTimeout(60).build(); tx.sign(kp);
  return (await h.submitTransaction(tx)).hash;
};
const scan = async () => (await j('POST', '/admin/stellar/run', { key: ADMIN })).d;
const bal = async (cookie) => { const { d } = await j('GET', '/me', null, cookie); return Number(d.xlm) / 1e18; };

const A = S.Keypair.random(), B = S.Keypair.random();
await fund(A); await fund(B);
const name = 'am' + Math.random().toString(36).slice(2, 8);
const su = await j('POST', '/auth/signup', { email: name + '@t.dev', username: name, password: 'testpass123' });
if (!su.d.ok) throw new Error('signup: ' + JSON.stringify(su.d));
const ck = su.cookie;
const au = await (await fetch(`${API}/admin/user?key=${ADMIN}&q=${name}`)).json();
const uid = au.user.id;
console.log('user', name, 'id', uid);

// 1) deposit WITH memo -> credited
await pay(A, HOT, '3', uid);
await scan();
const b1 = await bal(ck);
console.log('after memo deposit   ', b1, b1 >= 3 ? 'OK' : 'FAIL');

// 2) withdraw to B (B becomes a known payout address for this user)
const w = await j('POST', '/wallet/withdraw', { chain: 'stellar', to: B.publicKey(), amount: String(10n ** 18n), asset: 'xlm' }, ck);
console.log('withdraw             ', JSON.stringify(w.d).slice(0, 120));

// 3) B sends back with NO memo -> must auto-match to this user
await pay(B, HOT, '1.5', null);
const r = await scan();
console.log('scan                 ', JSON.stringify(r.scan).slice(0, 160));
const b2 = await bal(ck);
const ok = Math.abs(b2 - (b1 - 1 + 1.5)) < 1e-6;
console.log('after no-memo deposit', b2, ok ? 'OK auto-matched' : 'FAIL not credited');
process.exit(ok ? 0 : 1);
