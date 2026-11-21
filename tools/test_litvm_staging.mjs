// LitVM pre-market check on staging: create a zkLTC-paired token, buy it with ETH from the ledger,
// sell it back to ETH. Run: node tools/test_litvm_staging.mjs
import { ethers } from 'ethers';

const API = (process.env.API || 'https://rookery-staging.stablepump-ops.workers.dev') + '/api';
const KEY = process.env.ADMIN_KEY;
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
let COOKIE = '';
async function api(method, path, body, admin = false) {
  if (admin) body = { ...(body || {}), key: KEY };
  const url = API + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : '');
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: COOKIE }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) COOKIE = sc.split(';')[0];
  return r.json().catch(() => ({ error: 'http ' + r.status }));
}

const w = ethers.Wallet.createRandom();
const n = await api('POST', '/auth/wallet/nonce', { address: w.address });
const login = await api('POST', '/auth/wallet/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) });
ok('wallet login', !!login.username, login.username || login.error);
const user = login.username;

let cfg = null;
for (let i = 0; i < 12; i++) {
  cfg = await api('GET', '/stats?r=' + Math.random());
  if (cfg.prices && cfg.prices.ltc > 0) break;
  await new Promise(r => setTimeout(r, 5000));
}
ok('LTC price feed live', cfg?.prices?.ltc > 0, '$' + (cfg?.prices?.ltc || 0));

await api('POST', '/admin/credit', { user, asset: 'eth', amount: (10n ** 18n).toString() }, true);
const mk = await api('POST', '/markets', { name: 'Lite Penguin', symbol: 'LTPNG', network: 'litvm', description: 'pre-market zkLTC pair',
  devBuy: (5n * 10n ** 16n).toString(), devPay: 'eth' });
ok('token created on LitVM', !!mk.id, mk.error || mk.id);
const id = mk.id;
let d = await api('GET', '/market/' + id);
ok('pair is zkLTC', d.market?.quote === 'ZKLTC' && d.market?.network === 'litvm', d.market?.quote);
ok('price and mcap in USD', d.market?.priceUsd > 0 && d.market?.mcapUsd > 100, '$' + Math.round(d.market?.mcapUsd || 0));
ok('dev buy paid in ETH converted to zkLTC', BigInt(d.market?.reserveZro || 0) > 0n && d.me?.eth !== undefined, 'raised ' + (Number(BigInt(d.market.reserveZro)) / 1e18).toFixed(3) + ' zkLTC');

const before = BigInt(d.me?.tokens || 0);
const buy = await api('POST', '/trade', { market: id, side: 'buy', amount: (25n * 10n ** 15n).toString(), pay: 'eth' });
ok('buy with ETH from ledger', buy.ok !== false && BigInt(buy.tokens || 0) > 0n, buy.error || '');
d = await api('GET', '/market/' + id);
const held = BigInt(d.me?.tokens || 0);
ok('tokens credited', held > before, (Number(held) / 1e18).toFixed(2));
const sell = await api('POST', '/trade', { market: id, side: 'sell', amount: (held / 2n).toString(), pay: 'eth' });
ok('sell back to ETH', sell.ok !== false && !!sell.received, sell.error || JSON.stringify(sell.received || {}));
d = await api('GET', '/market/' + id);
ok('ETH returned to balance', Number(d.me?.eth) > 0, (Number(d.me?.eth) / 1e18).toFixed(4) + ' ETH');
const ex = await api('GET', '/markets?network=litvm&r=' + Math.random());
ok('Explore lists LitVM', ex.markets?.some(m => m.id === id));
const tr = await api('GET', '/market/' + id);
ok('trades on the chart', tr.trades?.length >= 3, String(tr.trades?.length));

console.log(`\n${pass} passed, ${fail} failed\nmarket: ${id}`);
process.exit(fail ? 1 : 0);
