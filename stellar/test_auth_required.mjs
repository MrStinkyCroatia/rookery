// Testnet experiment: with AUTH_REQUIRED on the issuer (and NOT revocable), can a holder still
//  (1) receive tokens in a normal wallet once the issuer authorizes the trustline,
//  (2) move them wallet-to-wallet,
//  (3) NOT push them into a contract (e.g. an Aquarius pool) until the issuer authorizes that contract,
//  (4) after AUTH_REQUIRED is cleared and the issuer is locked, use contracts freely?
import { StellarIO } from '../worker/stellar.js';
import * as S from '@stellar/stellar-sdk';
const { Keypair, Asset, Operation, TransactionBuilder, Networks, Address, nativeToScVal, AuthRequiredFlag } = S;
const hz = new S.Horizon.Server('https://horizon-testnet.stellar.org');
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fund = async (kp) => { for (let i = 0; i < 5; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`); if (r.ok) break; await sleep(2500); }
  for (let i = 0; i < 20; i++) { try { await hz.loadAccount(kp.publicKey()); return; } catch { await sleep(1000); } } };
const submit = async (src, ops, signers = [src]) => {
  const a = await hz.loadAccount(src.publicKey());
  const tb = new TransactionBuilder(a, { fee: '10000', networkPassphrase: Networks.TESTNET });
  for (const op of ops) tb.addOperation(op);
  const tx = tb.setTimeout(60).build(); for (const s of signers) tx.sign(s);
  return hz.submitTransaction(tx);
};

const io = new StellarIO('testnet', Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
const iss = Keypair.random(), h1 = Keypair.random(), h2 = Keypair.random();
await Promise.all([fund(io.hot), fund(iss), fund(h1), fund(h2)]);
const asset = new Asset('AUTHT', iss.publicKey());

// issuer: AUTH_REQUIRED only (not revocable: wallets show no "can freeze" warning)
await submit(iss, [Operation.setOptions({ setFlags: AuthRequiredFlag })]);
const ia = await hz.loadAccount(iss.publicKey());
ok('issuer has AUTH_REQUIRED, not revocable', ia.flags.auth_required && !ia.flags.auth_revocable);

// holders add trustlines; issuer authorizes them and pays tokens
await submit(h1, [Operation.changeTrust({ asset })]);
await submit(h2, [Operation.changeTrust({ asset })]);
await submit(iss, [
  Operation.setTrustLineFlags({ trustor: h1.publicKey(), asset, flags: { authorized: true } }),
  Operation.payment({ destination: h1.publicKey(), asset, amount: '1000' }),
]);
const b1 = (await hz.loadAccount(h1.publicKey())).balances.find(b => b.asset_code === 'AUTHT');
ok('holder receives tokens after authorization', Number(b1?.balance) === 1000 && b1.is_authorized);

// wallet to wallet: only works to an authorized trustline
let e1 = null;
try { await submit(h1, [Operation.payment({ destination: h2.publicKey(), asset, amount: '10' })]); } catch (e) { e1 = e?.response?.data?.extras?.result_codes || e.message; }
ok('transfer to an unauthorized wallet is refused', !!e1, JSON.stringify(e1));
await submit(iss, [Operation.setTrustLineFlags({ trustor: h2.publicKey(), asset, flags: { authorized: true } })]);
await submit(h1, [Operation.payment({ destination: h2.publicKey(), asset, amount: '10' })]);
ok('transfer between authorized wallets works', Number((await hz.loadAccount(h2.publicKey())).balances.find(b => b.asset_code === 'AUTHT')?.balance) === 10);

// SAC + contract recipient: the holder tries to move tokens into a contract (stand-in for a pool)
await io.invoke(io.hot, Operation.createStellarAssetContract({ asset }), 'create_sac').catch(e => { if (!/exist/i.test(e.message)) throw e; });
const sac = io.sac(asset);
const contract = io.sac(Asset.native());            // any contract address works as the receiver
let e2 = null;
try {
  await io.invoke(h1, sac, 'transfer', [Address.fromString(h1.publicKey()).toScVal(), Address.fromString(contract).toScVal(), nativeToScVal(5n * 10_000_000n, { type: 'i128' })]);
} catch (e) { e2 = String(e.message || e).slice(0, 160); }
ok('holder cannot push tokens into a contract (pool) while AUTH_REQUIRED', !!e2, e2 || 'transfer went through');

// graduation: clear AUTH_REQUIRED, then the same transfer is allowed
await submit(iss, [Operation.setOptions({ clearFlags: AuthRequiredFlag })]);
let e3 = null;
try {
  await io.invoke(h1, sac, 'transfer', [Address.fromString(h1.publicKey()).toScVal(), Address.fromString(contract).toScVal(), nativeToScVal(5n * 10_000_000n, { type: 'i128' })]);
} catch (e) { e3 = String(e.message || e).slice(0, 160); }
ok('after clearing the flag, contracts accept the token', !e3, e3 || '');
// new trustlines after clearing work without the issuer
const h3 = Keypair.random(); await fund(h3);
await submit(h3, [Operation.changeTrust({ asset })]);
await submit(h1, [Operation.payment({ destination: h3.publicKey(), asset, amount: '1' })]);
ok('after clearing, new holders need no authorization', Number((await hz.loadAccount(h3.publicKey())).balances.find(b => b.asset_code === 'AUTHT')?.balance) === 1);
console.log(`== AUTH_REQUIRED experiment: ${pass} passed, ${fail} failed`);
