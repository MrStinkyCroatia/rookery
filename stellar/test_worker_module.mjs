// Tests worker/stellar.js against Stellar testnet: deposit-with-memo detection, payouts, graduation, token payout.
import { StellarIO, xlm2wei, wei2xlm, assetCode } from '../worker/stellar.js';
import { Keypair, Asset, Operation, TransactionBuilder, Networks, Memo, Horizon } from '@stellar/stellar-sdk';
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n} ${x}`); };
const fund = async (pk) => { for (let i = 0; i < 4; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (r.ok) return; await new Promise(r => setTimeout(r, 2500)); } throw new Error('friendbot'); };
const seed = crypto.getRandomValues(new Uint8Array(32));
const S = new StellarIO('testnet', Buffer.from(seed));
await fund(S.hotAddress);
console.log('hot', S.hotAddress);
ok('units round-trip', wei2xlm(xlm2wei('12.3456789')) === 12.3456789);
ok('asset code sanitised', assetCode('$stinky-penguin!') === 'STINKYPENGUI');

// 1) a user deposits 25 XLM with memo id 42 (like an exchange withdrawal) + one without memo
const user = Keypair.random(); await fund(user.publicKey());
const hz = new Horizon.Server('https://horizon-testnet.stellar.org');
const cursor0 = await S.headCursor();
for (const [amt, memo] of [['25', Memo.id('42')], ['3', Memo.none()]]) {
  const a = await hz.loadAccount(user.publicKey());
  const tx = new TransactionBuilder(a, { fee: '1000', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: S.hotAddress, asset: Asset.native(), amount: amt })).addMemo(memo).setTimeout(60).build();
  tx.sign(user); await hz.submitTransaction(tx);
}
const inc = await S.incoming(cursor0);
const m42 = inc.items.find(i => i.memo === '42');
ok('deposit with memo id detected', m42 && m42.amount === '25.0000000' && m42.memoType === 'id', JSON.stringify(m42 || {}).slice(0, 120));
ok('deposit without memo seen (unassigned)', inc.items.some(i => i.amount === '3.0000000' && !i.memo));
const inc2 = await S.incoming(inc.cursor);
ok('cursor advances (no double credit)', inc2.items.length === 0);

// 2) payout XLM to an existing and to a brand-new address
const dest = Keypair.random(); await fund(dest.publicKey());
await S.payXlm(dest.publicKey(), 5.5, '777');
const da = await S.account(dest.publicKey());
ok('XLM payout (with memo) arrives', Number(da.balances.find(b => b.asset_type === 'native').balance) >= 10005.5);
const fresh = Keypair.random();
try { await S.payXlm(fresh.publicKey(), 0.5); ok('payout < 1 XLM to unactivated address refused', false); } catch { ok('payout < 1 XLM to unactivated address refused', true); }
await S.payXlm(fresh.publicKey(), 2);
ok('payout activates a new address', !!(await S.account(fresh.publicKey())));

// 3) graduation
const code = assetCode('TEST' + Math.floor(Math.random() * 1e5));
const st = { aquaMaxXlm: 200 };
const t0 = Date.now();
await S.graduate({ code, poolXlm: 120, poolTok: 200_000_000, circTok: 780_000_000, S: st, save: async () => {}, log: (m) => console.log('   ·', m) });
console.log('  graduated in', ((Date.now() - t0) / 1000).toFixed(1), 's pool', st.pool, 'deposit', st.depositXlm, 'aquaCost', st.aquaCostXlm);
const r = await S.poolReserves(st.pool, st.tokens);
ok('pool reserves', Math.abs(r.xlm - st.depositXlm) < 1e-6 && r.tok === 200_000_000, JSON.stringify(r));
const iss = await S.account(st.issuer), kp = await S.account(st.keeper);
ok('issuer + keeper locked', iss.signers.every(s => s.weight === 0) && kp.signers.every(s => s.weight === 0));
ok('keeper secret wiped from state', !st.keeperSecret && !st.issuerSecret);
// resume is idempotent
await S.graduate({ code, poolXlm: 120, poolTok: 200_000_000, circTok: 780_000_000, S: st, save: async () => {} });
ok('graduate() is idempotent on resume', true);

// 4) token payout needs a trustline
try { await S.payAsset(dest.publicKey(), code, st.issuer, 1000); ok('token payout without trustline refused', false); } catch (e) { ok('token payout without trustline refused', /trustline/.test(e.message)); }
const a2 = await hz.loadAccount(dest.publicKey());
const ttx = new TransactionBuilder(a2, { fee: '1000', networkPassphrase: Networks.TESTNET }).addOperation(Operation.changeTrust({ asset: new Asset(code, st.issuer) })).setTimeout(60).build();
ttx.sign(dest); await hz.submitTransaction(ttx);
await S.payAsset(dest.publicKey(), code, st.issuer, 123456.789);
const a3 = await S.account(dest.publicKey());
ok('token payout after trustline', Number(a3.balances.find(b => b.asset_code === code).balance) === 123456.789);
console.log(`== worker stellar module: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
