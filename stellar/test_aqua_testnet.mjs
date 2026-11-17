// Testnet: full graduation into an Aquarius pool + LP burn checks.
import { ctx, graduate, invoke, simulateView, Keypair, Address, nativeToScVal, xdr, NETS } from './aqua_grad.mjs';
const c = ctx('testnet');
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n} ${x}`); };
const fund = async (pk) => { for (let i = 0; i < 3; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (r.ok) return; await new Promise(r => setTimeout(r, 2000)); } throw new Error('friendbot'); };
const hot = Keypair.random();
await fund(hot.publicKey());
console.log('hot', hot.publicKey());
const code = 'GRAD' + Math.floor(Math.random() * 1e4);
const t0 = Date.now();
const state = {}; let keeperSecretCopy = null;
const r = await graduate(c, hot, { code, poolXlm: 300, poolTok: 200_000_000, circTok: 790_000_000, state, save: async (S) => { if (S.keeperSecret) keeperSecretCopy = S.keeperSecret; }, log: (m) => console.log('   ·', m) });
console.log('  graduated in', ((Date.now() - t0) / 1000).toFixed(1), 's', JSON.stringify({ pool: r.pool, keeper: r.keeper, asset: r.asset }));
// checks
const iss = await c.hz.loadAccount(r.issuer), kp = await c.hz.loadAccount(r.keeper);
ok('issuer locked', iss.signers.every(s => s.weight === 0));
ok('keeper locked', kp.signers.every(s => s.weight === 0));
const hb = await c.hz.loadAccount(hot.publicKey());
ok('hot wallet holds circulating supply', Number(hb.balances.find(b => b.asset_code === code)?.balance) === 790_000_000);
const res = await simulateView(c, r.pool, 'get_reserves', [], hot.publicKey());
console.log('  reserves', res.map(String));
ok('pool reserves = 300 XLM + 200M tokens', res.map(x => Number(x) / 1e7).sort((a, b) => a - b).join() === [300, 200_000_000].join());
const shares = await simulateView(c, r.pool, 'get_user_shares', [new Address(r.keeper).toScVal()], hot.publicKey()).catch(e => 'err ' + e.message);
ok('keeper owns LP shares', Number(shares) > 0, String(shares));
// try to withdraw LP with the (now useless) keeper key we still know in this test -> must fail at signature level
const leaked = Keypair.fromSecret(keeperSecretCopy);
try {
  await invoke(c, leaked, NETS.testnet.router, 'withdraw', [new Address(r.keeper).toScVal(), xdr.ScVal.scvVec(r.tokens.map(t => new Address(t).toScVal())),
    nativeToScVal(Buffer.from(r.poolHash, 'hex'), { type: 'bytes' }), nativeToScVal(BigInt(shares), { type: 'u128' }), xdr.ScVal.scvVec([nativeToScVal(0n, { type: 'u128' }), nativeToScVal(0n, { type: 'u128' })])]);
  ok('LP withdraw impossible', false);
} catch (e) { ok('LP withdraw impossible', true, e.message.slice(0, 80)); }
// a trade through the new pool works (hot buys a little with XLM via router.swap)
try {
  const xlmC = r.tokens.find(t => t !== r.sac);
  const before = await simulateView(c, r.pool, 'get_reserves', [], hot.publicKey());
  await invoke(c, hot, NETS.testnet.router, 'swap', [new Address(hot.publicKey()).toScVal(), xdr.ScVal.scvVec(r.tokens.map(t => new Address(t).toScVal())),
    new Address(xlmC).toScVal(), new Address(r.sac).toScVal(), nativeToScVal(Buffer.from(r.poolHash, 'hex'), { type: 'bytes' }), nativeToScVal(10n * 10_000_000n, { type: 'u128' }), nativeToScVal(1n, { type: 'u128' })]);
  const after = await simulateView(c, r.pool, 'get_reserves', [], hot.publicKey());
  ok('swap on Aquarius pool works', String(before) !== String(after), `${before.map(String)} -> ${after.map(String)}`);
} catch (e) { ok('swap on Aquarius pool works', false, e.message.slice(0, 160)); }
console.log(`== Aquarius testnet: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
