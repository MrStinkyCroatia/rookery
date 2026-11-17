// Stellar wallet login (SEP-53) + one-signature buy intent, against staging/testnet.
import * as S from '@stellar/stellar-sdk';
import fs from 'node:fs';
const API = 'https://rookery-staging.stablepump-ops.workers.dev/api';
const ADMIN = fs.readFileSync(new URL('../.staging/.admin_key', import.meta.url), 'utf8').trim();
const HOT = 'GCYVXPUKH3WLW6AJCYPHFLU6BEOABA32JFFKGO35HFCDMPONOE3W46MV';
const h = new S.Horizon.Server('https://horizon-testnet.stellar.org');
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

const req = async (m, p, body, cookie) => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', 'x-pl': '1', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { d, cookie: (r.headers.get('set-cookie') || '').split(';')[0] || cookie };
};
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS', n, extra); } else { fail++; console.log('  FAIL', n, extra); } };

// a Stellar account standing in for the user's wallet
const kp = S.Keypair.random();
await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`);
for (let i = 0; i < 20; i++) { try { await h.loadAccount(kp.publicKey()); break; } catch { await new Promise(r => setTimeout(r, 1000)); } }
console.log('wallet', kp.publicKey());

// 1. sign in with the Stellar wallet (SEP-53)
const n = await req('POST', '/auth/stellar/nonce', { address: kp.publicKey() });
ok('nonce issued', !!n.d.message, (n.d.message || n.d.error || '').slice(0, 60));
const hash = await sha256(new TextEncoder().encode('Stellar Signed Message:\n' + n.d.message));
const sig = Buffer.from(kp.sign(Buffer.from(hash))).toString('base64');
const v = await req('POST', '/auth/stellar/verify', { address: kp.publicKey(), nonce: n.d.nonce, signature: sig });
ok('signed in with the Stellar wallet', !!v.d.ok, v.d.username || v.d.error);
const ck = v.cookie;
ok('session cookie set', !!ck);

// replay must fail
const replay = await req('POST', '/auth/stellar/verify', { address: kp.publicKey(), nonce: n.d.nonce, signature: sig });
ok('nonce is single use', !!replay.d.error, replay.d.error);

// wrong signature must fail
const n2 = await req('POST', '/auth/stellar/nonce', { address: kp.publicKey() });
const bad = await req('POST', '/auth/stellar/verify', { address: kp.publicKey(), nonce: n2.d.nonce, signature: Buffer.from('x'.repeat(64)).toString('base64') });
ok('bad signature rejected', !!bad.d.error, bad.d.error);

// 2. create a market owned by this wallet, then buy through an intent
const mk = await req('POST', '/markets', { name: 'Wallet Buy', symbol: 'WBUY', description: 'intent flow', network: 'stellar', taxMarketing: 0, taxBurn: 0, taxRewards: 0 }, ck);
ok('market created', !!mk.d.ok, mk.d.id || mk.d.error);
const market = mk.d.id;
await new Promise(r => setTimeout(r, 12000));   // let the asset be minted on-chain

const intent = await req('POST', '/intent', { market, amount: String(100n * 10n ** 18n) }, ck);
ok('buy intent created', !!intent.d.ok, intent.d.memo + ' → ' + (intent.d.address || intent.d.error));

// 3. the wallet sends XLM with that memo, exactly one signature
const acc = await h.loadAccount(kp.publicKey());
const tx = new S.TransactionBuilder(acc, { fee: '10000', networkPassphrase: S.Networks.TESTNET })
  .addOperation(S.Operation.payment({ destination: HOT, asset: S.Asset.native(), amount: '100' }))
  .addMemo(S.Memo.text(intent.d.memo)).setTimeout(60).build();
tx.sign(kp);
await h.submitTransaction(tx);

const run = await req('POST', '/admin/stellar/run', { key: ADMIN });
console.log('   scan', JSON.stringify(run.d.scan).slice(0, 200));
await new Promise(r => setTimeout(r, 1500));
const m = await req('GET', '/market/' + market);
const holders = m.d.market?.holders || 0, trades = m.d.market?.trades || 0;
ok('XLM credited and token bought in one signature', holders >= 1, `holders ${holders}, trades ${trades}`);
ok('market shows the trade', trades >= 1, 'trades ' + trades);

const me2 = await req('GET', '/me', null, ck);
ok('XLM balance back to ~0 after the buy', Number(me2.d.xlm) / 1e18 < 5, String(Number(me2.d.xlm) / 1e18));

console.log(fail ? `== ${pass} passed, ${fail} failed` : `== ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
