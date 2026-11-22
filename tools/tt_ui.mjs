import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
const BASE = 'https://rookery.stinkypenguin.xyz';
const MOCK = readFileSync('.rehearsal/term_token_mock.json', 'utf8');
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9340', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9340/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
  if (d.method === 'Fetch.requestPaused') cmd('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(MOCK).toString('base64') }); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Fetch.enable', { patterns: [{ urlPattern: '*/api/terminal/token*', requestStage: 'Request' }] });
const tok = JSON.parse(MOCK).token.address; const out = {};
for (const [name, w, h, mobile, hash] of [['list', 1400, 1000, false, '#/terminal/zero'], ['tok_desk', 1400, 1300, false, `#/terminal/zero/token/${tok}`], ['tok_mob', 390, 844, true, `#/terminal/zero/token/${tok}`]]) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}${hash}` }); await sleep(7500);
  out[name] = await ev(`({ h1: document.querySelector('.tt h1, .term h1')?.innerText, stats: [...document.querySelectorAll('.tt-stat')].map(s => s.innerText.replace(/\\n/g, ': ')), rows: document.querySelectorAll('.term-table tbody tr').length,
    head: [...document.querySelectorAll('.term-table thead th')].map(x => x.innerText).join('|'), chart: !!document.querySelector('#ttChart canvas'), overflowX: document.documentElement.scrollWidth > innerWidth })`);
  if (name === 'tok_desk') { await ev(`document.querySelector('[data-tt=holders]')?.click()`); await sleep(500); out.holdersTab = await ev(`[...document.querySelectorAll('#ttBody tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').slice(0, 60))`); await ev(`document.querySelector('[data-tt=txs]')?.click()`); await sleep(300); }
  const shot = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(`out/tt_${name}.png`, Buffer.from(shot.result.data, 'base64'));
}
console.log(JSON.stringify({ ...out, errors: errs }, null, 1)); chrome.kill(); process.exit(0);
