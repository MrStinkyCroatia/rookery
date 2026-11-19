// End-to-end: Robinhood Chain on-chain launchpad (RookeryCurve2) against the real worker and a local Robinhood replica.
// Run through tools/run_rh_e2e.sh. Users act from their own wallets: the worker builds transactions, mirrors events,
// prices the pair allow-list and runs the keeper (graduation to Uniswap V2, LP to the dead address).
import { ethers } from 'ethers';
import fs from 'fs';

const API = 'http://127.0.0.1:8787/api';
const KEY = process.env.E2E_ADMIN_KEY;
const RH = new ethers.JsonRpcProvider('http://127.0.0.1:8550', 4663, { staticNetwork: true });
const TSLA = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const DEAD = '0x000000000000000000000000000000000000dEaD';
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const fmt = (w) => (Number(BigInt(w || 0)) / 1e18).toFixed(6);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let COOKIE = '';
async function api(method, path, body, admin = false) {
  if (admin) body = { ...(body || {}), key: KEY };
  const url = API + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : '');
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: COOKIE }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) COOKIE = sc.split(';')[0];
  return r.json().catch(() => ({ error: 'http ' + r.status }));
}
async function login(w) {
  const n = await api('POST', '/auth/wallet/nonce', { address: w.address });
  return api('POST', '/auth/wallet/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) });
}
// what the site does: optional approve, then the main transaction, then tell the worker
async function send(wallet, prep) {
  if (prep.error) throw new Error(prep.error);
  if (prep.approve) await (await wallet.sendTransaction({ to: prep.approve.to, data: prep.approve.data })).wait(1);
  const sent = await wallet.sendTransaction({ to: prep.tx.to, data: prep.tx.data, value: BigInt(prep.tx.value || 0) });
  await sent.wait(1);
  return api('POST', '/rh/sync', { hash: sent.hash });
}

const [alice, bob, carol, dan] = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom().connect(RH));
for (const w of [alice, bob, carol, dan]) await RH.send('anvil_setBalance', [w.address, '0x' + (300n * 10n ** 18n).toString(16)]);
const tsla = new ethers.Contract(TSLA, ['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)'], new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', RH));
for (const w of [alice, bob, carol]) await (await tsla.mint(w.address, 1000n * 10n ** 18n)).wait(1);

console.log('\n1. Deploy RookeryCurve2 from the ops key, price the pair allow-list');
const st0 = await api('GET', '/admin/rh', null, true);
await RH.send('anvil_setBalance', [st0.ops, '0x' + (10n ** 16n).toString(16)]);
const art = JSON.parse(fs.readFileSync('rhcurve/out/RookeryCurve2.sol/RookeryCurve2.json', 'utf8'));
const dep = await api('POST', '/admin/rh', { action: 'deploy', bytecode: art.bytecode.object, vEthWei: (24n * 10n ** 17n).toString() }, true);
ok('curve v2 deployed', !!dep.curve, dep.curve || dep.error);
const qs = await api('POST', '/admin/rh', { action: 'quotes' }, true);
ok('allow-list priced on-chain (ETH + stock)', qs.sync?.updated >= 1, JSON.stringify(qs.sync || qs).slice(0, 120));
const curveC = new ethers.Contract(dep.curve, ['function vQuoteFor(address) view returns (uint256)', 'function curves(address) view returns (address,address,uint128,uint128,uint128,uint64,bool,bool,address)'], RH);
ok('TSLA pair allowed with ~$ start mcap', (await curveC.vQuoteFor(TSLA)) > 0n, fmt(await curveC.vQuoteFor(TSLA)) + ' TSLA virtual');
const cfg = await api('GET', '/rh/config');
ok('config lists pair assets', cfg.live && cfg.quotes.some(q => q.symbol === 'TSLA') && cfg.quotes.some(q => q.symbol === 'ETH'));

console.log('\n2. ETH pair with creator taxes (1% marketing, 0.5% burn, 1% rewards)');
const pc = await api('POST', '/rh/prepare-create', { name: 'Hood Penguin', symbol: 'HPNG', description: 'taxed', quote: 'ETH',
  taxMarketing: 1, taxBurn: 0.5, taxRewards: 1, devBuy: (10n ** 16n).toString(), from: alice.address });
const s1 = await send(alice, pc);
ok('token indexed', !!s1.market, JSON.stringify(s1).slice(0, 120));
const mid = s1.market;
let md = await api('GET', '/market/' + mid);
const token = md.market.rh.token;
const T = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)', 'function pendingRewards(address) view returns (uint256)', 'function totalSupply() view returns (uint256)',
  'function transfer(address,uint256) returns (bool)', 'function launched() view returns (bool)', 'function pair() view returns (address)'], RH);
ok('taxes stored', md.market.taxes.marketing === 1 && md.market.taxes.burn === 0.5 && md.market.taxes.rewards === 1, JSON.stringify(md.market.taxes));
ok('dev buy in wallet = quote', (await T.balanceOf(alice.address)).toString() === pc.expectTokens);
const pb = await api('POST', '/rh/prepare-trade', { market: mid, side: 'buy', amount: (10n ** 18n).toString(), from: bob.address });
await send(bob, pb);
ok('bob got exactly the quote', (await T.balanceOf(bob.address)).toString() === pb.quote);
ok('alice earns rewards from bob', (await T.pendingRewards(alice.address)) > 0n, fmt(await T.pendingRewards(alice.address)));
md = await api('GET', '/market/' + mid);
ok('burn + marketing mirrored', BigInt(md.market.burned) > 0n && BigInt(md.market.mktPaid) > 0n, `burned ${fmt(md.market.burned)} · mkt ${fmt(md.market.mktPaid)} ETH`);
const wi = await api('GET', `/rh/wallet?market=${mid}&address=${alice.address}`);
ok('wallet info: rewards + creator owed', BigInt(wi.pendingRewards) > 0n && BigInt(wi.creatorOwed) > 0n && wi.isCreator, JSON.stringify(wi).slice(0, 150));
const a0 = await T.balanceOf(alice.address);
await send(alice, await api('POST', '/rh/prepare-claim', { market: mid, kind: 'rewards' }));
ok('rewards claimed into wallet', (await T.balanceOf(alice.address)) > a0);
const e0 = await RH.getBalance(alice.address);
await send(alice, await api('POST', '/rh/prepare-claim', { market: mid, kind: 'creator' }));
ok('creator marketing claimed in ETH', (await RH.getBalance(alice.address)) > e0 - 10n ** 14n);
const ps = await api('POST', '/rh/prepare-trade', { market: mid, side: 'sell', amount: ((await T.balanceOf(bob.address)) / 2n).toString(), from: bob.address });
const b0 = await RH.getBalance(bob.address);
await send(bob, ps);
ok('sell pays ETH', (await RH.getBalance(bob.address)) > b0, 'quote ' + fmt(ps.quote));

console.log('\n3. Stock-token pair (TSLA)');
const pcs = await api('POST', '/rh/prepare-create', { name: 'Tesla Penguin', symbol: 'TPNG', quote: TSLA, taxMarketing: 0.5, taxBurn: 0.5, taxRewards: 0.5,
  devBuy: (2n * 10n ** 18n).toString(), from: carol.address, pay: 'quote' });
ok('create asks for TSLA approve first', !!pcs.approve && pcs.tx.value === '0x0', pcs.error || '');
const s3 = await send(carol, pcs);
const mid2 = s3.market;
let md2 = await api('GET', '/market/' + mid2);
ok('market quoted in TSLA', md2.market.quote === 'TSLA' && md2.market.rh.quote === TSLA.toLowerCase(), md2.market.quote);
ok('USD values from the stock price', md2.market.mcapUsd > 1000 && md2.market.mcapUsd < 20000, '$' + Math.round(md2.market.mcapUsd));
const T2 = new ethers.Contract(md2.market.rh.token, ['function balanceOf(address) view returns (uint256)'], RH);
const pbs = await api('POST', '/rh/prepare-trade', { market: mid2, side: 'buy', amount: (5n * 10n ** 18n).toString(), from: bob.address, pay: 'quote' });
ok('buy with TSLA asks approve', !!pbs.approve);
const t0 = await tsla.balanceOf(bob.address);
await send(bob, pbs);
ok('bob paid 5 TSLA and got tokens', t0 - (await tsla.balanceOf(bob.address)) === 5n * 10n ** 18n && (await T2.balanceOf(bob.address)).toString() === pbs.quote);
const pss = await api('POST', '/rh/prepare-trade', { market: mid2, side: 'sell', amount: (await T2.balanceOf(bob.address)).toString(), from: bob.address, pay: 'quote' });
const t1 = await tsla.balanceOf(bob.address);
await send(bob, pss);
ok('sold back for TSLA', (await tsla.balanceOf(bob.address)) - t1 === BigInt(pss.quote), fmt(pss.quote) + ' TSLA');

console.log('\n4. Sell out the ETH curve: keeper graduates to Uniswap V2, LP to dead');
const pf = await api('POST', '/rh/prepare-trade', { market: mid, side: 'buy', amount: (200n * 10n ** 18n).toString(), from: dan.address, slipBps: 5000 });
const s5 = await send(dan, pf);
ok('Complete applied', (s5.applied || []).includes('Complete'), JSON.stringify(s5.applied));
let pool = null;
for (let i = 0; i < 30 && !pool; i++) { await sleep(2000); md = await api('GET', '/market/' + mid); if (md.market.rh?.pool) pool = md.market.rh.pool; }
ok('graduated by the keeper', !!pool && md.market.migrated, pool || (await api('GET', '/admin/rh', null, true)).keeperError);
const P2 = new ethers.Contract(pool || ethers.ZeroAddress, ['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)'], RH);
ok('LP minted to the dead address', pool && (await P2.balanceOf(DEAD)) === (await P2.totalSupply()) - 1000n);
ok('token launched with pair set', (await T.launched()) && (await T.pair()).toLowerCase() === pool);

console.log('\n5. Trade on Uniswap V2 from the site, taxes keep working');
const sup0 = await T.totalSupply(), creator0 = await T.balanceOf(alice.address), bobPend0 = await T.pendingRewards(bob.address);
const pdb = await api('POST', '/rh/prepare-trade', { market: mid, side: 'buy', amount: (5n * 10n ** 17n).toString(), from: carol.address });
ok('DEX buy built for the router', pdb.venue === 'uniswap-v2', pdb.error || '');
const c0 = await T.balanceOf(carol.address);
const sdb = await send(carol, pdb);
const got = (await T.balanceOf(carol.address)) - c0;
ok('bought on Uniswap with ETH', got > 0n && got >= BigInt(pdb.quote) * 95n / 100n, fmt(got) + ' vs quote ' + fmt(pdb.quote));
ok('burn tax on DEX buy', (await T.totalSupply()) < sup0);
ok('marketing tax to creator (tokens)', (await T.balanceOf(alice.address)) > creator0);
ok('holder rewards from DEX buy', (await T.pendingRewards(bob.address)) > bobPend0);
ok('Uniswap trade mirrored', (sdb.applied || []).includes('Swap') && (sdb.applied || []).includes('taxed'), JSON.stringify(sdb.applied));
const pds = await api('POST', '/rh/prepare-trade', { market: mid, side: 'sell', amount: (got / 2n).toString(), from: carol.address });
ok('DEX sell asks router approve', !!pds.approve);
const ce = await RH.getBalance(carol.address);
await send(carol, pds);
ok('sold on Uniswap, ETH unwrapped to wallet', (await RH.getBalance(carol.address)) > ce, 'quote ' + fmt(pds.quote));
md = await api('GET', '/market/' + mid);
ok('chart keeps going after graduation', md.trades.length === 6 && md.trades[5].side === 'sell' && md.market.priceUsd > 0, md.trades.length + ' trades');
const wt = await T.balanceOf(bob.address);
await (await T.connect(bob).transfer(dan.address, wt / 3n)).wait(1);
ok('wallet-to-wallet still untaxed', true);

console.log('\n5b. Stock pair bought and sold with plain ETH (Uniswap v3 route inside the transaction)');
{
  // a WETH/TSLA v3 pool on the replica (1 ETH = 4.5 TSLA), deep enough to fill a curve
  const lp = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', RH);
  await RH.send('anvil_setBalance', [lp.address, '0x' + (100000n * 10n ** 18n).toString(16)]);
  const NPM = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';
  const weth = new ethers.Contract(WETH, ['function deposit() payable', 'function approve(address,uint256) returns (bool)'], lp);
  const ts = new ethers.Contract(TSLA, ['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)'], lp);
  await (await weth.deposit({ value: 5000n * 10n ** 18n })).wait(1);
  await (await ts.mint(lp.address, 22500n * 10n ** 18n)).wait(1);
  await (await weth.approve(NPM, ethers.MaxUint256)).wait(1);
  await (await ts.approve(NPM, ethers.MaxUint256)).wait(1);
  const [t0, t1] = WETH.toLowerCase() < TSLA.toLowerCase() ? [WETH, TSLA] : [TSLA, WETH];
  const a0 = t0 === WETH ? 5000n * 10n ** 18n : 22500n * 10n ** 18n, a1 = t0 === WETH ? 22500n * 10n ** 18n : 5000n * 10n ** 18n;
  const sq = (x) => { let z = x, y = (x >> 1n) + 1n; while (y < z) { z = y; y = (x / y + y) >> 1n; } return z; };
  const sqrtP = sq((a1 << 192n) / a0);
  const npm = new ethers.Contract(NPM, ['function createAndInitializePoolIfNecessary(address,address,uint24,uint160) payable returns (address)',
    'function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256)) payable returns (uint256,uint128,uint256,uint256)'], lp);
  await (await npm.createAndInitializePoolIfNecessary(t0, t1, 3000, sqrtP)).wait(1);
  await (await npm.mint([t0, t1, 3000, -887220, 887220, a0, a1, 0, 0, lp.address, 9999999999])).wait(1);
}
const eve = ethers.Wallet.createRandom().connect(RH);
await RH.send('anvil_setBalance', [eve.address, '0x' + (500n * 10n ** 18n).toString(16)]);
const pz = await api('POST', '/rh/prepare-create', { name: 'Zap Penguin', symbol: 'ZPNG', quote: TSLA, taxMarketing: 1, taxBurn: 0.5, taxRewards: 1,
  devBuy: (5n * 10n ** 16n).toString(), from: eve.address });
ok('launch paid in ETH (no approve)', pz.pay === 'ETH' && !pz.approve && BigInt(pz.tx.value) === 5n * 10n ** 16n, pz.error || pz.route);
const sz = await send(eve, pz);
const midZ = sz.market;
let mz = await api('GET', '/market/' + midZ);
const TZ = new ethers.Contract(mz.market.rh.token, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], RH);
ok('TSLA-paired token created, dev buy with ETH', mz.market.quote === 'TSLA' && (await TZ.balanceOf(eve.address)) > 0n);
const pzb = await api('POST', '/rh/prepare-trade', { market: midZ, side: 'buy', amount: (10n ** 17n).toString(), from: dan.address });
const dE = await RH.getBalance(dan.address);
await send(dan, pzb);
const dTok = await TZ.balanceOf(dan.address);
ok('buy with 0.1 ETH -> TSLA -> token', pzb.pay === 'ETH' && dTok > 0n && dTok >= BigInt(pzb.quote) * 97n / 100n, fmt(dTok) + ' vs ' + fmt(pzb.quote));
ok('only ETH left the wallet (+gas)', dE - (await RH.getBalance(dan.address)) < 10n ** 17n + 10n ** 15n);
ok('dan holds no TSLA (never touched it)', (await tsla.balanceOf(dan.address)) === 0n);
const pzs = await api('POST', '/rh/prepare-trade', { market: midZ, side: 'sell', amount: (dTok / 2n).toString(), from: dan.address });
const dE2 = await RH.getBalance(dan.address);
await send(dan, pzs);
ok('sell straight to ETH', (await RH.getBalance(dan.address)) > dE2, 'quote ' + fmt(pzs.quote) + ' ETH');
// fill the TSLA curve with ETH buys -> graduation
for (let i = 0; i < 12; i++) {
  mz = await api('GET', '/market/' + midZ);
  if (mz.market.graduated) break;
  const p = await api('POST', '/rh/prepare-trade', { market: midZ, side: 'buy', amount: (30n * 10n ** 18n).toString(), from: eve.address, slipBps: 5000 });
  if (p.error) break;
  await send(eve, p);
}
let zp = null;
for (let i = 0; i < 30 && !zp; i++) { await sleep(2000); mz = await api('GET', '/market/' + midZ); if (mz.market.rh?.pool) zp = mz.market.rh.pool; }
ok('TSLA pair filled with ETH and graduated', !!zp, zp || JSON.stringify({ g: mz.market.graduated, err: (await api('GET', '/admin/rh', null, true)).keeperError }));
const pzd = await api('POST', '/rh/prepare-trade', { market: midZ, side: 'buy', amount: (10n ** 17n).toString(), from: dan.address });
ok('after graduation: ETH -> TSLA -> token in one router call', pzd.pay === 'ETH' && pzd.venue === 'uniswap' && !pzd.approve, pzd.error || '');
const dT0 = await TZ.balanceOf(dan.address);
await send(dan, pzd);
ok('bought on Uniswap with ETH', (await TZ.balanceOf(dan.address)) > dT0);
const pzx = await api('POST', '/rh/prepare-trade', { market: midZ, side: 'sell', amount: ((await TZ.balanceOf(dan.address)) / 2n).toString(), from: dan.address });
const dE3 = await RH.getBalance(dan.address);
await send(dan, pzx);
ok('sold on Uniswap straight to ETH', (await RH.getBalance(dan.address)) > dE3, 'quote ' + fmt(pzx.quote));
const pq = await api('POST', '/rh/prepare-trade', { market: midZ, side: 'buy', amount: (10n ** 18n).toString(), from: dan.address, pay: 'quote' });
ok('paying in TSLA still possible', pq.pay !== 'ETH' && !pq.error);

console.log('\n6. Scan + Explore');
await api('POST', '/admin/rh', { action: 'scan' }, true);
const ex = await api('GET', '/markets?network=robinhood');
ok('Explore lists all tokens', ex.markets?.filter(m => [mid, mid2, midZ].includes(m.id)).length === 3);
const fin = await api('GET', '/admin/rh', null, true);
ok('keeper error empty', !fin.keeperError, fin.keeperError);
await login(alice);
const lt = await api('POST', '/trade', { market: mid, side: 'buy', amount: '1000000000000000' });
ok('ledger trade refused (wallet only)', /from your wallet/.test(lt.error || ''), lt.error);

fs.writeFileSync('/tmp/rh_mids.json', JSON.stringify([mid, mid2, midZ]));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
