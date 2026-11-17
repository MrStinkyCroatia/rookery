// End-to-end: one-signature buys from an EVM wallet, against the real worker code and forked chains.
// Run through tools/run_wallet_e2e.sh (it starts the forks and the local worker).
import { ethers } from 'ethers';

const API = 'http://127.0.0.1:8787/api';
const KEY = process.env.E2E_ADMIN_KEY;
const BASE = new ethers.JsonRpcProvider('http://127.0.0.1:8547', undefined, { staticNetwork: true });
const ARB = new ethers.JsonRpcProvider('http://127.0.0.1:8548', undefined, { staticNetwork: true });
const ZRO = '0x6985884C4392D348587B19cb9eAAf157F13271cd';
const HOLDER = '0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D'; // holds ZRO on both chains (impersonated on the forks only)
const WEI = 10n ** 18n;
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (w) => (Number(BigInt(w || 0)) / 1e18).toFixed(6);

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, admin = false) {
    if (admin) body = { ...(body || {}), key: KEY };
    const url = API + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : '');
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie },
      body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const j = await r.json().catch(() => ({ error: 'http ' + r.status }));
    return j;
  }
  async login(wallet) {
    const n = await this.req('POST', '/auth/wallet/nonce', { address: wallet.address });
    const signature = await wallet.signMessage(n.message);
    return this.req('POST', '/auth/wallet/verify', { nonce: n.nonce, signature });
  }
}
const admin = new Client();

// fork helpers
const erc20 = (p, signer) => new ethers.Contract(ZRO, ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'], signer || p);
async function fundZro(p, to, amount) {
  await p.send('anvil_impersonateAccount', [HOLDER]);
  await p.send('anvil_setBalance', [HOLDER, '0x56BC75E2D63100000']);
  await (await erc20(p, await p.getSigner(HOLDER)).transfer(to, amount)).wait();
}
const setEth = (p, a, wei) => p.send('anvil_setBalance', [a, '0x' + wei.toString(16)]);
async function payZro(p, wallet, to, amount) { const w = wallet.connect(p); return (await (await erc20(p, w).transfer(to, amount)).wait()).hash; }
async function payEth(p, wallet, to, amount) { const w = wallet.connect(p); return (await (await w.sendTransaction({ to, value: amount })).wait()).hash; }
// confirmations the worker waits for: Base 15, Arbitrum 40
const confirm = async (p, n) => { await p.send('anvil_mine', ['0x' + n.toString(16)]); };
const scan = () => admin.req('POST', '/admin/scan', {}, true);
async function orderStatus(c, id) { const r = await c.req('GET', '/wallet/orders'); return (r.orders || []).find(o => o.id === id); }
async function settle(c, id, tries = 6) {
  for (let i = 0; i < tries; i++) { await scan(); const o = await orderStatus(c, id); if (o && o.status !== 'open') return o; await sleep(1500); }
  return orderStatus(c, id);
}
const holding = (me, id) => BigInt((me.holdings || []).find(h => h.id === id)?.amount || '0');

// ─────────────────────────────────────────────────────────────
console.log('== setup');
await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {});   // one cron tick: loads ZRO/ETH prices
await sleep(4000);
const st0 = await admin.req('GET', '/stats');
ok('prices loaded', st0.zroUsd > 0 && st0.ethUsd > 0, `ZRO $${st0.zroUsd} · ETH $${st0.ethUsd}`);
ok('feature is off by default', st0.walletBuy === false);

const buyer = ethers.Wallet.createRandom();
const A = new Client();
const lg = await A.login(buyer);
ok('sign in with the EVM wallet creates an account', lg.ok && !!lg.username, lg.username || lg.error);

let off = await A.req('POST', '/wallet/order', { market: 'x', amount: WEI.toString() });
ok('orders refused while the switch is off', /not live yet/i.test(off.error || ''), off.error);
const on = await admin.req('POST', '/admin/evm-orders', { on: true }, true);
ok('admin switch turns wallet buys on', on.on === true);
ok('stats tell the site it is live', (await admin.req('GET', '/stats')).walletBuy === true);

// a creator makes one ZRO-paired token (Zero) and one ETH-paired token (GIWA)
const creatorW = ethers.Wallet.createRandom();
const C = new Client(); await C.login(creatorW);
const zMk = await C.req('POST', '/markets', { name: 'Zero Pengu', symbol: 'ZPEN', description: 'e2e', network: 'zero' });
const gMk = await C.req('POST', '/markets', { name: 'Giwa Pengu', symbol: 'GPEN', description: 'e2e', network: 'giwa' });
ok('ZRO-paired token on Zero', zMk.ok, zMk.error || zMk.id);
ok('ETH-paired token on GIWA', gMk.ok, gMk.error || gMk.id);
const zq = (await A.req('GET', '/market/' + zMk.id)).market?.quote, gq = (await A.req('GET', '/market/' + gMk.id)).market?.quote;
ok('pairs are ZRO and ETH', zq === 'ZRO' && gq === 'ETH', `${zq} / ${gq}`);

// the buyer's own wallet holds ZRO and ETH on both chains
for (const p of [BASE, ARB]) { await fundZro(p, buyer.address, 500n * WEI); await setEth(p, buyer.address, 2n * WEI); }
ok('buyer wallet funded on the forks', (await erc20(BASE).balanceOf(buyer.address)) === 500n * WEI && (await erc20(ARB).balanceOf(buyer.address)) === 500n * WEI);

// ── case 1: ZRO on Base -> ZRO-paired token
console.log('== case 1: ZRO on Base, ZRO-paired token');
let r = await A.req('POST', '/wallet/order', { market: zMk.id, amount: (40n * WEI).toString(), pay: 'zro' });
let o = r.order;
ok('order created with a tagged amount', o && BigInt(o.amount) > 40n * WEI && BigInt(o.amount) - 40n * WEI < 1000n, o ? `${o.amount} wei, tag ${o.tag}` : r.error);
ok('order lists every ZRO network', o && ['ethereum', 'base', 'arbitrum', 'bsc', 'optimism'].every(k => o.chains.some(c => c.key === k)));
ok('order sends ZRO to the buyer\'s own deposit address', o && ethers.isAddress(o.to) && o.token === ZRO);
await payZro(BASE, buyer, o.to, BigInt(o.amount));
await confirm(BASE, 20);
let s1 = await settle(A, o.id);
let me = await A.req('GET', '/me');
ok('order filled after one signature', s1?.status === 'filled', s1 ? `${s1.status} · ${s1.note}` : 'no status');
ok('tokens are in the buyer\'s Rookery wallet', holding(me, zMk.id) > 0n, `${fmt(holding(me, zMk.id))} ZPEN`);
ok('only the tag stays as ZRO balance', BigInt(me.zro) < 1000n, `${me.zro} wei`);
const t1 = holding(me, zMk.id);

// ── case 2: ETH on Arbitrum -> ZRO-paired token (converted at the live rate)
console.log('== case 2: ETH on Arbitrum, ZRO-paired token');
r = await A.req('POST', '/wallet/order', { market: zMk.id, amount: (WEI / 100n).toString(), pay: 'eth' });
o = r.order;
ok('ETH order on a ZRO pair', o && o.asset === 'eth' && o.token === null, r.error || '');
ok('ETH order lists the ETH networks', o && ['ethereum', 'base', 'arbitrum'].every(k => o.chains.some(c => c.key === k)) && !o.chains.some(c => c.key === 'bsc'));
await payEth(ARB, buyer, o.to, BigInt(o.amount));
await confirm(ARB, 60);
let s2 = await settle(A, o.id);
me = await A.req('GET', '/me');
ok('ETH paid for a ZRO token, filled', s2?.status === 'filled', s2 ? `${s2.status} · ${s2.note}` : 'no status');
ok('more tokens after the ETH buy', holding(me, zMk.id) > t1, `${fmt(t1)} -> ${fmt(holding(me, zMk.id))}`);

// ── case 3: ZRO on Arbitrum -> ETH-paired token (GIWA)
console.log('== case 3: ZRO on Arbitrum, ETH-paired token');
r = await A.req('POST', '/wallet/order', { market: gMk.id, amount: (30n * WEI).toString(), pay: 'zro' });
o = r.order;
await payZro(ARB, buyer, o.to, BigInt(o.amount));
await confirm(ARB, 60);
let s3 = await settle(A, o.id);
me = await A.req('GET', '/me');
ok('ZRO paid for an ETH token, filled', s3?.status === 'filled', s3 ? `${s3.status} · ${s3.note}` : r.error);
ok('GIWA tokens in the wallet', holding(me, gMk.id) > 0n, `${fmt(holding(me, gMk.id))} GPEN`);
const g1 = holding(me, gMk.id);

// ── case 4: ETH on Base -> ETH-paired token
console.log('== case 4: ETH on Base, ETH-paired token');
r = await A.req('POST', '/wallet/order', { market: gMk.id, amount: (WEI / 200n).toString(), pay: 'eth' });
o = r.order;
await payEth(BASE, buyer, o.to, BigInt(o.amount));
await confirm(BASE, 20);
let s4 = await settle(A, o.id);
me = await A.req('GET', '/me');
ok('ETH on Base for a GIWA token, filled', s4?.status === 'filled', s4 ? `${s4.status} · ${s4.note}` : r.error);
ok('GIWA balance grew', holding(me, gMk.id) > g1);

// ── regression: an abandoned order must never catch the payment meant for another token
console.log('== regression: abandoned order + payment for another token');
const abandoned = (await A.req('POST', '/wallet/order', { market: zMk.id, amount: (WEI / 200n).toString(), pay: 'eth' })).order;
const wanted = (await A.req('POST', '/wallet/order', { market: gMk.id, amount: (WEI / 200n).toString(), pay: 'eth' })).order;
const zHold = holding(await A.req('GET', '/me'), zMk.id), gHold = holding(await A.req('GET', '/me'), gMk.id);
await payEth(BASE, buyer, wanted.to, BigInt(wanted.amount));
await confirm(BASE, 20);
const sw = await settle(A, wanted.id);
const sa = await orderStatus(A, abandoned.id);
me = await A.req('GET', '/me');
ok('payment fills the order it was sent for', sw?.status === 'filled' && sw.note === 'exact tag match', sw ? `${sw.status} · ${sw.note}` : '');
ok('the older abandoned order stays untouched', sa?.status === 'open');
ok('tokens land in the right token', holding(me, gMk.id) > gHold && holding(me, zMk.id) === zHold);

// two orders open and a payment without a tag: nothing is bought, the money waits on the balance
const second = (await A.req('POST', '/wallet/order', { market: zMk.id, amount: (WEI / 200n).toString(), pay: 'eth' })).order;
const ethB = BigInt(me.eth);
await payEth(BASE, buyer, second.to, WEI / 200n + 50_000n);   // no tag, both orders same size
await confirm(BASE, 20);
await scan();
me = await A.req('GET', '/me');
ok('ambiguous payment does not guess', (await orderStatus(A, abandoned.id))?.status === 'open' && (await orderStatus(A, second.id))?.status === 'open');
ok('ambiguous payment is kept as balance', BigInt(me.eth) - ethB === WEI / 200n + 50_000n);

// the wallet refused: the site cancels the order right away
const c1 = (await A.req('POST', '/wallet/order', { market: zMk.id, amount: (WEI / 100n).toString(), pay: 'eth' })).order;
await A.req('POST', '/wallet/order/cancel', { id: c1.id });
ok('order cancelled when the wallet refuses', (await orderStatus(A, c1.id))?.status === 'cancelled');
const other2 = new Client(); await other2.login(ethers.Wallet.createRandom());
await other2.req('POST', '/wallet/order/cancel', { id: abandoned.id });
ok('nobody else can cancel your order', (await orderStatus(A, abandoned.id))?.status === 'open');
await A.req('POST', '/wallet/order/cancel', { id: abandoned.id });
await A.req('POST', '/wallet/order/cancel', { id: second.id });

// ── edge cases
console.log('== edge cases');
// underpaid by far more than 2%: order cancelled, money kept as balance
r = await A.req('POST', '/wallet/order', { market: zMk.id, amount: (20n * WEI).toString(), pay: 'zro' });
o = r.order;
const zBefore = BigInt((await A.req('GET', '/me')).zro);
await payZro(BASE, buyer, o.to, 5n * WEI);
await confirm(BASE, 20);
let s5 = await settle(A, o.id);
me = await A.req('GET', '/me');
ok('underpayment cancels the order', s5?.status === 'cancelled', s5 ? `${s5.status} · ${s5.note}` : '');
ok('underpaid ZRO stays on the balance', BigInt(me.zro) - zBefore === 5n * WEI, `+${fmt(BigInt(me.zro) - zBefore)} ZRO`);

// a plain deposit with no order is just a deposit
const tBefore = holding(me, zMk.id), zB2 = BigInt(me.zro);
await payZro(BASE, buyer, o.to, 7n * WEI);
await confirm(BASE, 20);
await scan();
me = await A.req('GET', '/me');
ok('deposit without an order only credits the balance', BigInt(me.zro) - zB2 === 7n * WEI && holding(me, zMk.id) === tBefore);

// a much larger payment than the order does not fill it, the money lands on the balance
r = await A.req('POST', '/wallet/order', { market: zMk.id, amount: (10n * WEI).toString(), pay: 'zro' });
o = r.order;
const zB3 = BigInt(me.zro);
await payZro(BASE, buyer, o.to, 100n * WEI);
await confirm(BASE, 20);
await scan();
let s7 = await orderStatus(A, o.id);
me = await A.req('GET', '/me');
ok('oversized payment does not fill the small order', s7?.status === 'open');
ok('oversized payment is credited in full', BigInt(me.zro) - zB3 === 100n * WEI);

// below the minimum buy
r = await A.req('POST', '/wallet/order', { market: zMk.id, amount: (WEI / 100n).toString(), pay: 'zro' });
ok('minimum buy enforced', /Minimum buy/i.test(r.error || ''), r.error);

// logged out
const anon = new Client();
r = await anon.req('POST', '/wallet/order', { market: zMk.id, amount: WEI.toString(), pay: 'zro' });
ok('logged-out order refused', /log in/i.test(r.error || ''), r.error);

// someone else's session cannot see this buyer's orders
const other = new Client(); await other.login(ethers.Wallet.createRandom());
const otherOrders = (await other.req('GET', '/wallet/orders')).orders || [];
ok('orders are private to their owner', otherOrders.length === 0);

// cron entry point is not public
const cronHit = await fetch(API + '/_cron', { method: 'POST' });
ok('public /api/_cron is blocked', cronHit.status === 404, 'HTTP ' + cronHit.status);

// ── signing in again with the same wallet shows the same tokens
console.log('== wallet sign-in shows the balance');
const A2 = new Client();
const lg2 = await A2.login(buyer);
const me2 = await A2.req('GET', '/me');
ok('same wallet, same account', lg2.username === lg.username, lg2.username);
ok('ZRO-paired token visible after login', holding(me2, zMk.id) === holding(me, zMk.id) && holding(me2, zMk.id) > 0n, `${fmt(holding(me2, zMk.id))} ZPEN`);
ok('ETH-paired token visible after login', holding(me2, gMk.id) > 0n, `${fmt(holding(me2, gMk.id))} GPEN`);
ok('balances match the first session', me2.zro === me.zro && me2.eth === me.eth);

// switch off again: nothing new can be opened
await admin.req('POST', '/admin/evm-orders', { on: false }, true);
r = await A.req('POST', '/wallet/order', { market: zMk.id, amount: WEI.toString(), pay: 'zro' });
ok('switch off closes the door again', /not live yet/i.test(r.error || ''));

const counts = (await admin.req('POST', '/admin/evm-orders', {}, true)).counts;
console.log('   orders by status:', JSON.stringify(counts));
console.log(`== wallet buys E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
