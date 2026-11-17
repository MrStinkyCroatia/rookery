// A deposit without memo that an admin assigned by hand must teach the scanner that sender address,
// so the next deposit from the same address needs no manual step (staging / Stellar testnet).
import * as S from '@stellar/stellar-sdk';
import fs from 'node:fs';
const API = 'https://rookery-staging.stablepump-ops.workers.dev/api';
const ADMIN = fs.readFileSync(new URL('../.staging/.admin_key', import.meta.url), 'utf8').trim();
const HOT = 'GCYVXPUKH3WLW6AJCYPHFLU6BEOABA32JFFKGO35HFCDMPONOE3W46MV';
const h = new S.Horizon.Server('https://horizon-testnet.stellar.org');
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n} ${x}`); };
const j = async (m, p, body, cookie) => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', 'x-pl': '1', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { d, cookie: (r.headers.get('set-cookie') || '').split(';')[0] || cookie };
};
const fund = async (kp) => { await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`); for (let i = 0; i < 30; i++) { try { await h.loadAccount(kp.publicKey()); return; } catch { await new Promise(r => setTimeout(r, 1000)); } } throw new Error('friendbot timeout'); };
const pay = async (kp, to, amt) => {
  const acc = await h.loadAccount(kp.publicKey());
  const tx = new S.TransactionBuilder(acc, { fee: '10000', networkPassphrase: S.Networks.TESTNET })
    .addOperation(S.Operation.payment({ destination: to, asset: S.Asset.native(), amount: String(amt) })).setTimeout(60).build();
  tx.sign(kp); return (await h.submitTransaction(tx)).hash;
};
const scan = async () => (await j('POST', '/admin/stellar/run', { key: ADMIN })).d;
const bal = async (ck) => Number((await j('GET', '/me', null, ck)).d.xlm) / 1e18;

const A = S.Keypair.random();
await fund(A);
const name = 'rm' + Math.random().toString(36).slice(2, 8);
const su = await j('POST', '/auth/signup', { email: name + '@t.dev', username: name, password: 'testpass123' });
if (!su.d.ok) throw new Error('signup: ' + JSON.stringify(su.d));
const ck = su.cookie;
const uid = (await (await fetch(`${API}/admin/user?key=${ADMIN}&q=${name}`)).json()).user.id;
console.log('user', name, 'id', uid, 'sender', A.publicKey());

// 1) first deposit, no memo: parked
const tx1 = await pay(A, HOT, 6);
await scan();
const first = (await (await fetch(`${API}/admin/stellar?key=${ADMIN}`)).json()).unassigned.find(u => u.to_addr === A.publicKey() && String(u.note).includes(tx1));
ok('first deposit without memo is parked', !!first, first && 'id ' + first.id);
ok('balance untouched', (await bal(ck)) === 0);

// 2) admin assigns it by hand -> the sender address is remembered
const asg = await j('POST', '/admin/stellar/assign', { key: ADMIN, id: first.id, user: name });
ok('admin assigned the deposit', asg.d.ok, JSON.stringify(asg.d));
ok('credited 6 XLM', (await bal(ck)) === 6);

// 3) the same wallet deposits again, still without a memo
const tx2 = await pay(A, HOT, 4);
await scan();
const b = await bal(ck);
ok('second deposit from the same address auto-credited', b === 10, 'balance ' + b);
const me = (await j('GET', '/me', null, ck)).d;
const dep = (await (await fetch(`${API}/admin/user?key=${ADMIN}&q=${name}`)).json()).transfers.filter(t => t.kind === 'deposit');
ok('no new unassigned entry for that tx', !(await (await fetch(`${API}/admin/stellar?key=${ADMIN}`)).json()).unassigned.some(u => String(u.note).includes(tx2)));
ok('deposit noted as remembered sender', dep.some(t => /remembered sender/.test(String(t.note || ''))), dep.map(t => t.note).join(' | ').slice(0, 160));
console.log(`== remembered sender: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
