// End-to-end test on Stellar TESTNET (free friendbot XLM): launch -> first buy -> buy -> sell -> lock checks.
import { net, buildLaunch, buildBuy, buildSell, poolState, quoteBuy, SDK, Keypair } from './launch_lib.mjs';
const N = net('testnet'), server = new SDK.Horizon.Server(N.horizon);
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${n} ${x}`); };
const fund = async (kp) => { const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`); if (!r.ok) throw new Error('friendbot ' + r.status); };
const send = async (tx, ...kps) => { kps.forEach(k => tx.sign(k)); try { return await server.submitTransaction(tx); } catch (e) { console.log(JSON.stringify(e.response?.data?.extras?.result_codes || e.message)); throw e; } };
const bal = async (pk, code) => { const a = await server.loadAccount(pk); const b = a.balances.find(x => code ? x.asset_code === code : x.asset_type === 'native'); return b ? Number(b.balance) : 0; };

const creator = Keypair.random(), buyer = Keypair.random(), burn = Keypair.random();
await Promise.all([fund(creator), fund(buyer), fund(burn)]);
console.log('funded creator/buyer/burn');

const SEED = 100, CODE = 'STNKT';
const L = await buildLaunch({ server, passphrase: N.passphrase, creator: creator.publicKey(), code: CODE, seedXlm: SEED, burnReserve: burn.publicKey(), launchFeeXlm: 2, firstBuyXlm: 5, homeDomain: 'rookery.stinkypenguin.xyz' });
const burn0 = await bal(burn.publicKey());
const r = await send(L.tx, creator);
ok('launch tx in one ledger', r.successful, `ledger ${r.ledger} ops ${L.tx.operations.length}`);
console.log('  asset', `${CODE}:${L.issuer}`, 'pool', L.poolId);

const st = await poolState(server, L.poolId);
ok('pool holds ~all supply', st.y > 990_000_000 && st.y < 1_000_000_000, `${st.y.toFixed(0)} tok / ${st.x.toFixed(4)} XLM`);
const cb = await bal(creator.publicKey(), CODE);
ok('creator first buy in launch tx', cb > 0, `${cb.toFixed(0)} tok (${(cb / 1e7).toFixed(2)}%)`);
ok('launch fee + first-buy fee to burn reserve', Math.abs((await bal(burn.publicKey())) - burn0 - 2 - 5 * 0.005) < 1e-6);

// lock checks
const iss = await server.loadAccount(L.issuer), kp = await server.loadAccount(L.keeper);
const locked = (a) => a.signers.every(s => s.weight === 0) && a.thresholds.low_threshold >= 1;
ok('issuer locked (no signer can mint)', locked(iss), JSON.stringify(iss.signers.map(s => s.weight)));
ok('issuer has no freeze/clawback flags', !iss.flags.auth_required && !iss.flags.auth_revocable && !iss.flags.auth_clawback_enabled);
ok('pool keeper locked (LP cannot be withdrawn)', locked(kp));
ok('keeper holds all pool shares', kp.balances.some(b => b.asset_type === 'liquidity_pool_shares' && Number(b.balance) === Number(st.shares)));
ok('issuer home_domain set', iss.home_domain === 'rookery.stinkypenguin.xyz');
// try to mint more with the old issuer key: impossible (we no longer have it) -> try with keeper key as signer on issuer: must fail
try {
  const a = await server.loadAccount(L.issuer);
  const tx = new SDK.TransactionBuilder(a, { fee: '400', networkPassphrase: N.passphrase }).addOperation(SDK.Operation.payment({ destination: creator.publicKey(), asset: L.asset, amount: '1' })).setTimeout(60).build();
  tx.sign(creator); await server.submitTransaction(tx); ok('mint attempt rejected', false);
} catch { ok('mint attempt rejected', true); }

// buy with creator tax 1%
const s0 = await poolState(server, L.poolId);
const B = await buildBuy({ server, passphrase: N.passphrase, trader: buyer.publicKey(), asset: L.asset, poolId: L.poolId, xlm: 50, burnReserve: burn.publicKey(), creator: creator.publicKey(), creatorTax: 0.01 });
const cx0 = await bal(creator.publicKey()), bz0 = await bal(burn.publicKey());
await send(B.tx, buyer);
const got = await bal(buyer.publicKey(), CODE);
ok('buy fills ~quote', Math.abs(got / B.expectedOut - 1) < 0.001, `${got.toFixed(0)} vs ${B.expectedOut.toFixed(0)}`);
ok('0.5% to burn reserve', Math.abs((await bal(burn.publicKey())) - bz0 - 0.25) < 1e-6);
ok('1% creator tax paid', Math.abs((await bal(creator.publicKey())) - cx0 - 0.5) < 1e-6);
const s1 = await poolState(server, L.poolId);
ok('price went up', s1.x / s1.y > s0.x / s0.y, `${(s0.x / s0.y).toExponential(3)} -> ${(s1.x / s1.y).toExponential(3)} XLM`);

// sell half
const x0 = await bal(buyer.publicKey());
const S = await buildSell({ server, passphrase: N.passphrase, trader: buyer.publicKey(), asset: L.asset, poolId: L.poolId, tokens: Math.floor(got / 2), burnReserve: burn.publicKey(), creator: creator.publicKey(), creatorTax: 0.01 });
await send(S.tx, buyer);
const x1 = await bal(buyer.publicKey());
ok('sell pays out XLM', x1 > x0, `+${(x1 - x0).toFixed(4)} XLM (expected ~${S.expectedOut.toFixed(4)} minus tx fee)`);

// slippage guard: absurd destMin must fail
try {
  const T = await buildBuy({ server, passphrase: N.passphrase, trader: buyer.publicKey(), asset: L.asset, poolId: L.poolId, xlm: 5, burnReserve: burn.publicKey(), slippage: -0.5 });
  await send(T.tx, buyer); ok('slippage guard', false);
} catch { ok('slippage guard', true); }

// trades are visible via Horizon (what the site will index)
const tr = await server.trades().forLiquidityPool(L.poolId).limit(20).call();
ok('pool trades indexed by Horizon', tr.records.length >= 3, `${tr.records.length} trades`);
console.log(`== Stellar testnet: ${pass} passed, ${fail} failed`);
console.log(JSON.stringify({ code: CODE, issuer: L.issuer, pool: L.poolId, creator: creator.publicKey() }));
process.exit(fail ? 1 : 0);
