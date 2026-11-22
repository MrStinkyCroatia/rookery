import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const BASE = 'https://rookery.stinkypenguin.xyz', MOCK = readFileSync('.rehearsal/term_token_mock.json', 'utf8');
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9344', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9344/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description);
  if (d.method === 'Fetch.requestPaused') cmd('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(d.params.request.url.includes('/intel') ? JSON.stringify({ priceUsd: 3.5e-6, athUsd: 3.6e-6, fromAthPct: -1.2, holders: 4, inProfit: 1, inProfitPct: 25, supplyInProfitPct: 0.03, valueInProfitUsd: 1.2, inProfitEntryUsd: 3.4e-6, top100EntryUsd: 3.5e-6, traders1h: 3, buyers1h: 3, sellers1h: 1, netBuyers1h: 2, note: 'mock' }) : MOCK).toString('base64') }); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
const snap = `({ net: document.querySelector('.tx-nets .on')?.innerText.trim(), rows: document.querySelectorAll('.tx-row').length, sel: document.querySelector('.tx-row.on .tx-rn b')?.innerText, title: document.querySelector('.tx-tn h2')?.innerText,
  mc: document.querySelector('.tx-mc b')?.innerText, chart: !!document.querySelector('#txChart canvas'), side: document.querySelector('.tx-bs .on')?.innerText.trim() || document.querySelector('.tx-ext a')?.innerText, intel: document.querySelector('.tx-intel span')?.innerText,
  empty: document.querySelector('.tx-list .tx-empty')?.innerText || null, overflowX: document.documentElement.scrollWidth > innerWidth, status: document.querySelector('#txStatus')?.innerText })`;
const out = {};
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/terminal/zero` }); await sleep(9000);
out.zero = await ev(snap); writeFileSync('out/tx_zero.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }); await sleep(3500);
out.afterArrow = await ev(`document.querySelector('.tx-row.on .tx-rn b')?.innerText`);
await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', text: 's' }); await sleep(800);
out.afterS = await ev(`document.querySelector('.tx-bs .on')?.innerText.trim()`);
await ev(`document.querySelector('[data-rt=intel]')?.click()`); await sleep(600);
out.intelTab = await ev(`[...document.querySelectorAll('.tx-intel-full .kv')].slice(0,4).map(k => k.innerText.replace(/\\n/g, ': '))`);
await ev(`document.querySelector('#txDir').click()`); await sleep(500);
out.directory = await ev(`document.querySelectorAll('.tx-dp').length`); await ev(`document.querySelector('#txDirX').click()`);
await ev(`document.querySelector('[data-net=giwa]').click()`); await sleep(5000); out.giwa = await ev(snap); writeFileSync('out/tx_giwa.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
await ev(`document.querySelector('[data-net=litvm]').click()`); await sleep(5000); out.litvm = await ev(snap);
await cmd('Fetch.enable', { patterns: [{ urlPattern: '*/api/terminal/token*' }, { urlPattern: '*/api/terminal/intel*' }] });
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/terminal/zero/token/${JSON.parse(MOCK).token.address}` }); await sleep(8000);
out.otherPadToken = await ev(snap); writeFileSync('out/tx_other.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
await cmd('Fetch.disable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/terminal/zero` }); await sleep(9000);
out.mobile = await ev(snap); writeFileSync('out/tx_mobile.png', Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
console.log(JSON.stringify({ ...out, errors: errs }, null, 1)); chrome.kill(); process.exit(0);
