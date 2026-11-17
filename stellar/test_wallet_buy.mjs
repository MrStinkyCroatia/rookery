// The exact path the "Buy from wallet" button uses: prep → wallet signs → submit → scan → buy.
import * as S from '@stellar/stellar-sdk';
import fs from 'node:fs';
const API = 'https://rookery-staging.stablepump-ops.workers.dev/api';
const ADMIN = fs.readFileSync(new URL('../.staging/.admin_key', import.meta.url), 'utf8').trim();
const h = new S.Horizon.Server('https://horizon-testnet.stellar.org');
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const req = async (m, p, body, cookie) => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', 'x-pl': '1', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { d, cookie: (r.headers.get('set-cookie') || '').split(';')[0] || cookie };
};
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log(c ? '  PASS' : '  FAIL', n, extra); };

const kp = S.Keypair.random();
await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
for (let i = 0; i < 20; i++) { try { await h.loadAccount(kp.publicKey()); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }

// sign in with the wallet (same as the button)
const n = await req('POST', '/auth/stellar/nonce', { address: kp.publicKey() });
const sig = Buffer.from(kp.sign(Buffer.from(await sha256(new TextEncoder().encode('Stellar Signed Message:\n' + n.d.message))))).toString('base64');
const v = await req('POST', '/auth/stellar/verify', { address: kp.publicKey(), nonce: n.d.nonce, signature: sig });
ok('wallet login', !!v.d.ok, v.d.username || v.d.error);
const ck = v.cookie;

// a fresh market to buy
const mk = await req('POST', '/markets', { name: 'Wallet Direct', symbol: 'WDIR', description: 'prep/submit path', network: 'stellar', taxMarketing: 0, taxBurn: 0, taxRewards: 0 }, ck);
ok('market created', !!mk.d.ok, mk.d.id || mk.d.error);
const market = mk.d.id;
await new Promise(r => setTimeout(r, 12000));

// 1. server builds the payment the wallet will sign
const prep = await req('POST', '/stellar/prep', { market, amount: String(50n * 10n ** 18n), address: kp.publicKey() }, ck);
ok('server built the payment (prep)', !!prep.d.xdr, prep.d.memo + ' ' + (prep.d.error || ''));
const tx = S.TransactionBuilder.fromXDR(prep.d.xdr, S.Networks.TESTNET);
ok('memo carries the intent', Buffer.from(tx.memo.value).toString() === prep.d.memo, Buffer.from(tx.memo.value).toString());
ok('payment goes to the Rookery hot wallet', tx.operations[0].destination === prep.d.address, tx.operations[0].destination?.slice(0, 8));
ok('amount is what the user asked for', tx.operations[0].amount === '50.0000000', tx.operations[0].amount);

// 2. the wallet signs it (this is what Freighter/Lobstr does)
tx.sign(kp);
const signedXdr = tx.toXDR();
ok('wallet signature attached', tx.signatures.length === 1, 'sigs ' + tx.signatures.length);

// 3. server submits
const sub = await req('POST', '/stellar/submit', { xdr: signedXdr }, ck);
ok('server submitted the signed payment', !!sub.d.txid, sub.d.txid?.slice(0, 12) || sub.d.error);

// 4. the scanner credits it and buys the token
const run = await req('POST', '/admin/stellar/run', { key: ADMIN });
console.log('   scan', JSON.stringify(run.d.scan).slice(0, 180));
await new Promise(r => setTimeout(r, 1500));
const m = await req('GET', '/market/' + market);
ok('tokens bought automatically', (m.d.market?.holders || 0) >= 1, `holders ${m.d.market?.holders}, trades ${m.d.market?.trades}`);

console.log(fail ? `== ${pass} passed, ${fail} failed` : `== ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
