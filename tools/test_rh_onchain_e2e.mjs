// End-to-end: Robinhood Chain on-chain launchpad against the real worker and a fork of Robinhood Chain.
// Run through tools/run_rh_e2e.sh. Users act from their own wallets: the worker only builds transactions,
// mirrors the contract's events and runs the keeper (graduation to Uniswap v3, LP burned).
import { ethers } from 'ethers';
import fs from 'fs';

const API = 'http://127.0.0.1:8787/api';
const KEY = process.env.E2E_ADMIN_KEY;
const RH = new ethers.JsonRpcProvider('http://127.0.0.1:8550', 4663, { staticNetwork: true });
const NPM = '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3';
const ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const fmt = (w) => (Number(BigInt(w || 0)) / 1e18).toFixed(6);

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
// what the site does: ask the worker for the transaction, the wallet signs and sends it, then tell the worker
async function send(wallet, tx) {
  const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || 0) });
  await sent.wait(1);
  return api('POST', '/rh/sync', { hash: sent.hash });
}

// fresh keys: the well-known anvil accounts carry EIP-7702 sweeper delegations on this chain
const [alice, bob, carol] = [0, 1, 2].map(() => ethers.Wallet.createRandom().connect(RH));
for (const w of [alice, bob, carol]) await RH.send('anvil_setBalance', [w.address, '0x' + (100n * 10n ** 18n).toString(16)]);

console.log('\n1. Deploy the curve from the worker\'s ops key');
const st0 = await api('GET', '/admin/rh', null, true);
ok('ops wallet derived', /^0x[0-9a-fA-F]{40}$/.test(st0.ops || ''), st0.ops);
await RH.send('anvil_setBalance', [st0.ops, '0x' + (10n ** 16n).toString(16)]);  // 0.01 ETH, like the real top-up
const art = JSON.parse(fs.readFileSync('rhcurve/out/RookeryCurve.sol/RookeryCurve.json', 'utf8'));
const dep = await api('POST', '/admin/rh', { action: 'deploy', bytecode: art.bytecode.object, vEthWei: (24n * 10n ** 17n).toString() }, true);
ok('curve deployed', !!dep.curve, dep.curve || dep.error);
const cfg = await api('GET', '/rh/config');
ok('public config live', cfg.live === true && cfg.feeBps === 50 && cfg.vEth === '2400000000000000000', JSON.stringify(cfg));
const opsAfter = Number(await RH.getBalance(st0.ops)) / 1e18;
ok('deploy paid by the ops wallet', 0.01 - opsAfter > 0 && opsAfter > 0, (0.01 - opsAfter).toFixed(6) + ' ETH at the replica gas price');

console.log('\n2. Launch from a wallet: the contract is on Robinhood Chain right away');
await login(alice);
const ledgerTry = await api('POST', '/markets', { name: 'Ledger RH', symbol: 'LRH', network: 'robinhood' });
ok('old ledger launch on Robinhood is refused', /from your wallet/.test(ledgerTry.error || ''), JSON.stringify(ledgerTry).slice(0, 200));
const pc = await api('POST', '/rh/prepare-create', { name: 'Hood Penguin', symbol: 'HPNG', description: 'on-chain from day one', x: 'x.com/StinkyPenguinL0', devBuy: (10n ** 16n).toString() });
ok('create tx built', pc.tx?.to === dep.curve && pc.tx.value === '0x2386f26fc10000', pc.error || '');
const s1 = await send(alice, pc.tx);
ok('token indexed instantly', !!s1.market, JSON.stringify(s1));
const mid = s1.market;
let md = await api('GET', '/market/' + mid);
const token = md.market?.rh?.token;
ok('market on robinhood, quoted in ETH', md.market?.network === 'robinhood' && md.market?.quote === 'ETH');
ok('draft metadata attached', md.market?.description === 'on-chain from day one' && md.market?.x === 'https://x.com/StinkyPenguinL0');
const erc = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function launched() view returns (bool)'], RH);
const aliceTok = await erc.balanceOf(alice.address);
ok('creator holds her first buy IN HER WALLET', aliceTok > 0n && aliceTok.toString() === pc.expectTokens, fmt(aliceTok) + ' tokens');
ok('creator shown as holder', md.holders?.some(h => h.address === alice.address.toLowerCase()));
ok('first trade on the chart', md.trades?.length === 1 && md.trades[0].tx);

console.log('\n3. Buy and sell from wallets (one signature each)');
const pb = await api('POST', '/rh/prepare-trade', { market: mid, side: 'buy', amount: (5n * 10n ** 17n).toString(), slipBps: 100 });
ok('buy tx built with slippage guard', pb.tx?.value === '0x6f05b59d3b20000', pb.error || '');
await send(bob, pb.tx);
const bobTok = await erc.balanceOf(bob.address);
ok('bob got the quoted tokens', bobTok.toString() === pb.quote, fmt(bobTok));
const ethBefore = await RH.getBalance(bob.address);
const ps = await api('POST', '/rh/prepare-trade', { market: mid, side: 'sell', amount: (bobTok / 2n).toString(), slipBps: 100 });
const s3 = await send(bob, ps.tx);
const got = (await RH.getBalance(bob.address)) - ethBefore;
ok('sell needs no approve and pays ETH', s3.ok && got > 0n, fmt(got) + ' ETH net of gas');
md = await api('GET', '/market/' + mid);
ok('3 trades mirrored', md.trades?.length === 3 && md.market.trades === 3);
const onchain = await new ethers.Contract(dep.curve, ['function curves(address) view returns (address,uint128,uint128,uint128,uint64,bool,bool,address)'], RH).curves(token);
ok('mirror equals the contract (raised ETH, sold tokens)', md.market.reserveZro === onchain[2].toString() && md.market.sold === onchain[3].toString());
ok('price/mcap shown', md.market.mcapUsd > 0 && md.market.priceUsd > 0, '$' + Math.round(md.market.mcapUsd));
const lt = await api('POST', '/trade', { market: mid, side: 'buy', amount: '1000000000000000' });
ok('ledger trade refused (wallet only)', /from your wallet/.test(lt.error || ''), lt.error);

console.log('\n4. Trades made outside our site are picked up by the scan');
const direct = new ethers.Contract(dep.curve, ['function buy(address,uint256) payable returns (uint256)'], carol);
await (await direct.buy(token, 0, { value: 10n ** 17n })).wait(1);
await api('POST', '/admin/rh', { action: 'scan' }, true);
md = await api('GET', '/market/' + mid);
ok('direct contract buy mirrored by the scan', md.trades?.length === 4, String(md.trades?.length));
ok('holders exact from Transfer events', md.market.holders === 3, String(md.market.holders));
// wallet-to-wallet transfer
await (await erc.connect(alice).transfer(carol.address, aliceTok / 2n)).wait(1);
await api('POST', '/admin/rh', { action: 'scan' }, true);
md = await api('GET', '/market/' + mid);
const carolRow = md.holders.find(h => h.address === carol.address.toLowerCase());
ok('wallet-to-wallet transfer reflected', carolRow && BigInt(carolRow.amount) === (await erc.balanceOf(carol.address)));
const bal = await api('GET', `/rh/balance?market=${mid}&address=${carol.address}`);
ok('wallet balance endpoint', bal.balance === (await erc.balanceOf(carol.address)).toString());

console.log('\n5. Sell out the curve: the keeper graduates it to Uniswap v3 and burns the LP');
await RH.send('anvil_setBalance', [bob.address, '0x' + (200n * 10n ** 18n).toString(16)]);
const pf = await api('POST', '/rh/prepare-trade', { market: mid, side: 'buy', amount: (20n * 10n ** 18n).toString(), slipBps: 5000 });
const before = await RH.getBalance(bob.address);
const s5 = await send(bob, pf.tx);
const spent = before - (await RH.getBalance(bob.address));
ok('last buyer refunded the excess', spent < 20n * 10n ** 18n, fmt(spent) + ' ETH spent of 20');
ok('Complete applied', (s5.applied || []).includes('Complete'), JSON.stringify(s5.applied));
let grad = null;
for (let i = 0; i < 30 && !grad; i++) {
  await new Promise(r => setTimeout(r, 2000));
  md = await api('GET', '/market/' + mid);
  if (md.market.rh?.pool) grad = md.market.rh.pool;
}
ok('graduated by the keeper', !!grad && md.market.migrated, grad || JSON.stringify((await api('GET', '/admin/rh', null, true)).keeperError));
ok('token launched (free transfers)', await erc.launched());
const pool = new ethers.Contract(grad || ethers.ZeroAddress, ['function liquidity() view returns (uint128)'], RH);
ok('Uniswap pool has liquidity', grad && (await pool.liquidity()) > 0n);
const npm = new ethers.Contract(NPM, ['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)', 'function ownerOf(uint256) view returns (address)'], RH);
const ev = (await npm.queryFilter(npm.filters.Transfer(null, '0x000000000000000000000000000000000000dEaD'), 0)).pop();
ok('LP NFT sent to the dead address', ev && (await npm.ownerOf(ev.args.tokenId)) === '0x000000000000000000000000000000000000dEaD');
const pt = await api('POST', '/rh/prepare-trade', { market: mid, side: 'buy', amount: (10n ** 16n).toString() });
ok('curve trading closed after graduation', !!pt.error, pt.error);
const router = new ethers.Contract(ROUTER, ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'], carol);
const cBefore = await erc.balanceOf(carol.address);
await (await router.exactInputSingle([WETH, token, 10000, carol.address, 10n ** 16n, 1n, 0n], { value: 10n ** 16n })).wait(1);
ok('anyone trades it on Uniswap from a wallet', (await erc.balanceOf(carol.address)) > cBefore);
const fin = await api('GET', '/admin/rh', null, true);
ok('keeper error empty', !fin.keeperError, fin.keeperError);
ok('fees accrued in the contract (0.5%)', BigInt(fin.feesAccrued || 0) > 0n, fmt(fin.feesAccrued) + ' ETH');

console.log('\n6. Explore');
const ex = await api('GET', '/markets?network=robinhood');
ok('Explore filter lists the token', ex.markets?.some(m => m.id === mid && m.rh?.token === token.toLowerCase()));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
