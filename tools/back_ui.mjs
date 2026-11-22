import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const BASE = 'https://rookery.stinkypenguin.xyz', MOCK = readFileSync('.rehearsal/term_token_mock.json', 'utf8');
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9342', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9342/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description);
  if (d.method === 'Fetch.requestPaused') cmd('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(MOCK).toString('base64') }); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Fetch.enable', { patterns: [{ urlPattern: '*/api/terminal/token*' }] });
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
const out = {};
// 1 · Terminal (Rookery tab, sorted) -> click a Rookery token row -> Rookery token page has Back -> click -> same Terminal view
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/terminal/zero/rookery` }); await sleep(7000);
await ev(`document.querySelector('.term-row').click()`); await sleep(6000);
out.rookeryPage = await ev(`({ hash: location.hash, back: document.querySelector('.term-backbtn')?.innerText, href: document.querySelector('.term-backbtn')?.getAttribute('href') })`);
const shot = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync('out/back_rookery.png', Buffer.from(shot.result.data, 'base64'));
await ev(`document.querySelector('.term-backbtn').click()`); await sleep(5000);
out.afterBack = await ev(`({ hash: location.hash, h1: document.querySelector('.term h1')?.innerText, activeSide: document.querySelector('.term-si.on')?.innerText })`);
// 2 · direct link to a Zero token page (no Terminal history) still offers the way back
await ev(`sessionStorage.clear()`);
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/t/bryan-0f9018` }); await sleep(6500);
out.directZeroToken = await ev(`({ back: document.querySelector('.term-backbtn')?.innerText, href: document.querySelector('.term-backbtn')?.getAttribute('href') })`);
// 3 · Terminal token page of another launchpad
const tok = JSON.parse(MOCK).token.address;
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/terminal/zero/token/${tok}` }); await sleep(6500);
out.terminalTokenPage = await ev(`({ back: document.querySelector('.term-backbtn')?.innerText, href: document.querySelector('.term-backbtn')?.getAttribute('href') })`);
const s2 = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync('out/back_terminal_token.png', Buffer.from(s2.result.data, 'base64'));
// 4 · a non-Zero token (Stellar) has no Terminal button when you did not come from the Terminal
const st = await ev(`fetch('/api/markets?network=stellar').then(r => r.json()).then(d => (d.markets || d).find(m => m.network === 'stellar')?.id)`);
if (st) { await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/t/${st}` }); await sleep(6000); out.stellarToken = await ev(`!!document.querySelector('.term-backbtn')`); }
console.log(JSON.stringify({ ...out, errors: errs }, null, 1)); chrome.kill(); process.exit(0);
