import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const BASE = process.argv[2] || 'https://rookery.stinkypenguin.xyz';
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9338', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9338/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text); };
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
const out = {};
for (const [name, w, h, mobile, hash] of [['desk_all', 1400, 1300, false, '#/terminal'], ['desk_pad', 1400, 900, false, '#/terminal/tzero'], ['mob_all', 390, 844, true, '#/terminal']]) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}${hash}` }); await sleep(7000);
  out[name] = await ev(`({ h1: document.querySelector('.term h1')?.innerText, tabs: document.querySelectorAll('.term-tab').length, pads: document.querySelectorAll('.term-pad').length, rows: document.querySelectorAll('.term-table tbody tr').length,
    imgsBroken: [...document.querySelectorAll('.term img')].filter(i => i.complete && i.naturalWidth === 0).length, overflowX: document.documentElement.scrollWidth > innerWidth,
    mnavOverflow: (() => { const n = document.querySelector('.mnav'); return n && getComputedStyle(n).display !== 'none' ? n.scrollWidth > n.clientWidth + 2 : null; })(), empty: document.querySelector('.term-empty')?.innerText || null })`);
  const shot = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(`out/term_${name}.png`, Buffer.from(shot.result.data, 'base64'));
}
console.log(JSON.stringify({ ...out, errors: errs }, null, 1)); chrome.kill(); process.exit(0);
