// UI test of "buy any launchpad's coin through the Rookery Router": the network is not live yet, so the token, the
// route and the build answers are mocked at the network layer, and window.ethereum is a recording mock wallet.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'https://rookery-staging.stablepump-ops.workers.dev', MOCK = readFileSync('.rehearsal/term_token_mock.json', 'utf8');
const TOKEN = JSON.parse(MOCK).token.address, ROUTER = '0x676439F52D1809E822751859CadE8222Ef30f08D';
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9347', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9347/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = []; const builds = []; let approved = false;
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const reply = (rid, obj) => cmd('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(obj)).toString('base64') });
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description);
  if (d.method !== 'Fetch.requestPaused') return;
  const u = d.params.request.url, rid = d.params.requestId;
  if (u.includes('/terminal/route/build')) {
    const b = JSON.parse(d.params.request.postData || '{}'); builds.push(b);
    if (b.side === 'sell' && !approved) return reply(rid, { ok: true, side: 'sell', needsApproval: true, approve: { to: TOKEN, data: '0x095ea7b3' + ROUTER.slice(2).toLowerCase().padStart(64, '0') + 'f'.repeat(64) } });
    if (b.side === 'sell') return reply(rid, { ok: true, side: 'sell', expectedOut: '2985000000000000000', minOut: '2895450000000000000', fee: '15000000000000000', tx: { to: ROUTER, value: '0x0', data: '0x5e1e1004' }, via: 'tzero', chainId: 33002, router: ROUTER });
    return reply(rid, { ok: true, side: 'buy', expectedOut: '284300000000000000000000', minOut: '275771000000000000000000', fee: '50000000000000000', tx: { to: ROUTER, value: '0x8ac7230489e80000', data: '0x1a2b3c4d' }, via: 'tzero', chainId: 33002, router: ROUTER });
  }
  if (u.includes('/terminal/route')) return reply(rid, { network: 'zero', router: ROUTER, feeBps: 50, feeTo: '$臭企鹅 buy & burn', chainId: 33002, available: true, via: 'tzero' });
  if (u.includes('/intel')) return reply(rid, { priceUsd: 3.5e-6, athUsd: 3.6e-6, fromAthPct: -1.2, holders: 4, inProfit: 1, inProfitPct: 25, supplyInProfitPct: 0.03, valueInProfitUsd: 1.2, traders1h: 3, buyers1h: 3, sellers1h: 1, netBuyers1h: 2 });
  return cmd('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(MOCK).toString('base64') });
};
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
// recording mock wallet
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__w = []; window.ethereum = { request: async ({ method, params }) => { window.__w.push({ method, params });
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x000000000000000000000000000000000000cafe'];
  if (method === 'eth_chainId') return '0x80ea';
  if (method === 'eth_sendTransaction') return '0x' + (window.__w.length).toString(16).padStart(64, '0');
  if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
  if (method === 'eth_call') return '0x' + (4000n * 10n ** 18n).toString(16).padStart(64, '0');
  return null; } };` });
await cmd('Fetch.enable', { patterns: [{ urlPattern: '*/api/terminal/token*' }, { urlPattern: '*/api/terminal/intel*' }, { urlPattern: '*/api/terminal/route*' }] });
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/terminal/zero/token/${TOKEN}` }); await sleep(10000);
const out = {};
out.panel = await ev(`({ buy: document.querySelector('.tx-route .tx-bs .on')?.innerText, fee: document.querySelector('.tx-route .tx-fee')?.innerText, btn: document.querySelector('#rtGo')?.innerText, note: document.querySelector('.tx-route .tx-note')?.innerText })`);
await ev(`(() => { const a = document.querySelector('#rtAmt'); a.value = '10'; a.oninput(); })()`); await sleep(1500);
out.quoteBuy = await ev(`document.querySelector('#rtEst')?.innerText`);
writeFileSync('out/route_buy.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
await ev(`document.querySelector('#rtGo').click()`); await sleep(4000);
out.walletAfterBuy = await ev(`window.__w.map(x => x.method + (x.method === 'eth_sendTransaction' ? ':' + x.params[0].to + ':' + x.params[0].value : '')).filter(m => !m.startsWith('eth_getTransactionReceipt'))`);
out.toastBuy = await ev(`[...document.querySelectorAll('.toast, #toast, .toasts div')].map(t => t.innerText).join(' | ')`);
await sleep(3000);   // let the post-trade refresh land first
await ev(`document.querySelector('[data-rs=sell]').click()`); await sleep(500);
await ev(`document.querySelector('[data-rp="50%"]').click()`); await sleep(1800);
out.sellAmount = await ev(`document.querySelector('#rtAmt').value`);
out.quoteSellBeforeApproval = await ev(`document.querySelector('#rtEst')?.innerText`);
await ev(`window.__w = []`);
approved = false;
const goSell = ev(`document.querySelector('#rtGo').click()`);
await sleep(1200); approved = true; await goSell; await sleep(4000);
out.walletSell = await ev(`window.__w.filter(x => x.method === 'eth_sendTransaction').map(x => x.params[0].to.slice(0, 10) + ':' + x.params[0].data.slice(0, 10))`);
out.walletAll = await ev(`window.__w.map(x => x.method)`); out.toastSell = await ev(`[...document.querySelectorAll('.toast, #toast, .toasts div')].map(t => t.innerText).join(' | ')`); out.btnNow = await ev(`document.querySelector('#rtGo')?.innerText + ' / side ' + document.querySelector('.tx-route .tx-bs .on')?.innerText`);
out.sellBuilds = builds.filter(b => b.side === 'sell').map(b => b.amount).slice(-2);
await ev(`document.querySelector('[data-sl="100"]').click()`); await sleep(400);
out.slippageOn = await ev(`document.querySelector('.tx-slip .on')?.innerText`);
writeFileSync('out/route_sell.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
console.log(JSON.stringify({ ...out, errors: errs }, null, 1)); chrome.kill(); process.exit(0);
