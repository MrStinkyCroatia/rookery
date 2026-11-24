// Terms gate: appears on first visit, blocks the page, needs all three boxes, disappears after accepting and stays
// accepted on reload; the full terms page renders; nothing overflows on a phone.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'https://rookery-staging.stablepump-ops.workers.dev';
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9381', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9381/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
const cmd = (m, p = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (f) => writeFileSync(f, Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
await cmd('Page.enable'); await cmd('Runtime.enable');
const out = {};
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/` }); await sleep(6000);
out.firstVisit = await ev(`({ gate: !!document.getElementById('tgate'), disabled: document.getElementById('tgGo')?.disabled, locked: document.documentElement.style.overflow,
  boxes: document.querySelectorAll('.tgate-ck').length, termsLink: !!document.querySelector('.tgate-more'), title: document.querySelector('.tgate-h b')?.innerText })`);
await shot('out/terms_gate.png');
await ev(`document.getElementById('tg1').click(); document.getElementById('tg2').click()`); await sleep(200);
out.twoBoxes = await ev(`document.getElementById('tgGo').disabled`);
await ev(`document.getElementById('tg3').click()`); await sleep(200);
out.threeBoxes = await ev(`document.getElementById('tgGo').disabled`);
await ev(`document.querySelector('.tgate-more summary').click()`); await sleep(300);
out.fullTermsInside = await ev(`document.querySelectorAll('.tgate-full h3').length`);
await shot('out/terms_gate_open.png');
await ev(`document.getElementById('tgGo').click()`); await sleep(500);
out.afterAccept = await ev(`({ gate: !!document.getElementById('tgate'), unlocked: document.documentElement.style.overflow, stored: localStorage.getItem('rk_terms_v') })`);
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/` }); await sleep(4500);
out.reload = await ev(`({ gate: !!document.getElementById('tgate') })`);
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/terms` }); await sleep(4000);
out.termsPage = await ev(`({ title: document.querySelector('.terms-page h1')?.innerText, sections: document.querySelectorAll('.terms-body h3').length, footerLink: !!document.querySelector('.foot a[href="#/terms"]') })`);
await shot('out/terms_page.png');
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/` }); await sleep(3000);
await ev(`localStorage.removeItem('rk_terms_v')`); await cmd('Page.reload', {}); await sleep(4500);
out.mobile = await ev(`(() => { const c = document.querySelector('.tgate-card'); if (!c) return { gate: false }; const r = c.getBoundingClientRect(); return { gate: true, fits: r.left >= -0.5 && r.right <= innerWidth + 0.5, scrollable: c.scrollHeight > c.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
await shot('out/terms_gate_mobile.png');
console.log(JSON.stringify({ ...out, errors: errs }, null, 1)); chrome.kill(); process.exit(0);
