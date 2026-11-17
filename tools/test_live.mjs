// Staging: live push over WebSocket. Two listeners (Explore = 'all', token page = 'm:<id>', other token page),
// one trade over HTTP, measure push latency and check who received what.
import fs from 'node:fs';
const BASE = process.argv[2] || 'https://rookery-staging.stablepump-ops.workers.dev';
const KEY = fs.readFileSync(new URL('../.staging/.admin_key', import.meta.url), 'utf8').trim();
const WEI = 10n ** 18n;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
let cookie = '';
async function api(path, body, admin) {
  const r = await fetch(BASE + '/api' + path, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-pl': '1', cookie },
    body: body ? JSON.stringify(admin ? { ...body, key: KEY } : body) : undefined,
  });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return r.json();
}
function listen(sub) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(BASE.replace('https', 'wss') + '/api/ws');
    const got = [];
    ws.onopen = () => { ws.send(JSON.stringify({ sub })); setTimeout(() => res({ ws, got }), 400); };
    ws.onmessage = (e) => got.push({ at: Date.now(), msg: JSON.parse(e.data) });
    ws.onerror = rej;
  });
}
const n = 'lv_' + Math.random().toString(36).slice(2, 8);
await api('/auth/signup', { email: n + '@t.dev', username: n, password: 'testpass123' });
await api('/admin/credit', { user: n, asset: 'zro', amount: String(50n * WEI) }, true);
const markets = (await api('/markets')).markets.filter(m => m.quote !== 'ETH');
const target = markets[0].id, other = markets[1].id;
const before = markets[0];

const all = await listen(['all']), page = await listen(['m:' + target]), otherPage = await listen(['m:' + other]);
// keep-alive ping is answered by the runtime
const pong = await new Promise(r => { all.ws.addEventListener('message', function f(e) { if (e.data.includes('pong')) { all.ws.removeEventListener('message', f); r(true); } }); all.ws.send('{"ping":1}'); setTimeout(() => r(false), 3000); });
ok(pong, 'ping → pong keep-alive');
all.got.length = 0;

const t0 = Date.now();
const tr = await api('/trade', { market: target, side: 'buy', amount: String(5n * WEI) });
const tHttp = Date.now() - t0;
ok(!tr.error, 'trade accepted ' + (tr.error || ''));
await new Promise(r => setTimeout(r, 2500));
const a = all.got.filter(x => x.msg.market?.id === target), b = page.got.filter(x => x.msg.market?.id === target);
ok(a.length >= 1, `Explore socket got the push (${a.length})`);
ok(b.length >= 1, `token-page socket got the push (${b.length})`);
ok(!otherPage.got.some(x => x.msg.market?.id === target), 'other token page did NOT get it');
if (b[0]) {
  const lat = b[0].at - t0;
  console.log(`     latency: trade sent → push received ${lat} ms (HTTP round trip ${tHttp} ms)`);
  ok(lat < 2000, 'push arrives within 2 s');
  const m = b[0].msg.market;
  ok(m.trades === before.trades + 1, `trades ${before.trades} → ${m.trades}`);
  ok(m.volumeUsd > before.volumeUsd, `volume $${before.volumeUsd.toFixed(2)} → $${m.volumeUsd.toFixed(2)}`);
  ok(m.holders >= before.holders, `holders ${before.holders} → ${m.holders}`);
  ok(b[0].msg.stats && b[0].msg.stats.volumeUsd > 0, 'global stats included');
  const live = (await api('/market/' + target)).market;
  ok(live.trades === m.trades && Math.abs(live.volumeUsd - m.volumeUsd) < 1e-6 && live.holders === m.holders, 'pushed numbers = API numbers');
}
// burst: 5 quick trades are coalesced, last push carries the final state
page.got.length = 0;
for (let i = 0; i < 5; i++) await api('/trade', { market: target, side: 'buy', amount: String(WEI) });
await new Promise(r => setTimeout(r, 2000));
const last = page.got.at(-1)?.msg.market, liveM = (await api('/market/' + target)).market;
ok(page.got.length >= 1 && page.got.length <= 5, `burst of 5 trades → ${page.got.length} pushes`);
ok(last && last.trades === liveM.trades, 'last push = final state');
for (const s of [all, page, otherPage]) s.ws.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
