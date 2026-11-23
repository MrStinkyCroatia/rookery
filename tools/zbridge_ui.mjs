// UI test of the hidden bridge page (#/zbridge) on production with a recording mock wallet: real API, real mainnet
// contracts and balances; the wallet records what it would sign instead of signing.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'https://rookery.stinkypenguin.xyz';
const ACCT = process.env.ACCT || '0x2fc334db3b68995ca29ba752d47b4d88c025990d';
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9361', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9361/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
const cmd = (m, p = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description); };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__w = []; window.ethereum = { request: async ({ method, params }) => { window.__w.push({ method, params });
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${ACCT}'];
  if (method === 'eth_chainId') return '0x1';
  if (method === 'eth_getCode') return '0x';
  if (method === 'eth_sendTransaction') return '0x' + (window.__w.length).toString(16).padStart(64, '0');
  if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
  return null; } };` });
const shot = async (f) => writeFileSync(f, Buffer.from((await cmd('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
const out = {};
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/zbridge` }); await sleep(11000);
out.page = await ev(`({ stats: [...document.querySelectorAll('.zbx-kpis div')].map(d => d.innerText.replace(/\\n/g, ' ')), route: [...document.querySelectorAll('#zbRoute .zbx-rt')].map(b => b.innerText.replace(/\\n/g, ' ')),
  onZero: document.querySelector('#zbOnZero')?.innerText, bal: document.querySelector('#zbBal')?.innerText, btn: document.querySelector('#zbGo')?.innerText, inNav: !![...document.querySelectorAll('nav a, header a')].find(a => (a.getAttribute('href') || '').includes('zbridge')) })`);
await shot('out/zb_desktop.png');
// chain picker
await ev(`document.querySelector('#zbFrom').click()`); await sleep(400);
out.modal = await ev(`[...document.querySelectorAll('#zbChainList .zbx-mi')].map(b => b.innerText.replace(/\\n/g, ' '))`);
await shot('out/zb_modal.png');
await ev(`document.querySelector('#zbChainList .zbx-mi[data-c=arb]').click()`); await sleep(300);
out.picked = await ev(`document.querySelector('#zbFromName').innerText + ' / ' + document.querySelector('#zbBal').innerText`);
await ev(`document.querySelector('#zbRoute .zbx-rt[data-c=eth]').click()`); await sleep(300);
await ev(`(() => { const a = document.querySelector('#zbAmt'); a.value = '25'; a.oninput(); })()`); await sleep(300);
out.form = await ev(`({ recv: document.querySelector('#zbRecv').innerText, usd: document.querySelector('#zbUsd').innerText, lines: [...document.querySelectorAll('#zbLines div')].map(k => k.innerText.replace(/\\n/g, ': ')), btn: document.querySelector('#zbGo').innerText, route: document.querySelector('#zbRouteLine').innerText.replace(/\\n/g, ' ') })`);
await ev(`window.__w = []; document.querySelector('#zbGo').click()`); await sleep(1200);
out.needTick = await ev(`document.querySelector('.zbx-ck').classList.contains('need')`);
await ev(`document.querySelector('#zbOk').checked = true; document.querySelector('#zbGo').click()`); await sleep(9000);
out.signupWallet = await ev(`window.__w.filter(x => x.method === 'eth_sendTransaction').map(x => ({ to: x.params[0].to.slice(0, 10), data: x.params[0].data.slice(0, 10), value: x.params[0].value }))`);
await shot('out/zb_filled.png');
await ev(`document.querySelector('.zbx-seg button[data-m=now]').click()`); await sleep(300);
out.instantClosed = await ev(`({ btn: document.querySelector('#zbGo').innerText, disabled: document.querySelector('#zbGo').disabled })`);
await ev(`document.querySelector('.zbx-tabs button[data-t=mine]').click()`); await sleep(500);
out.mine = await ev(`[...document.querySelectorAll('#zbHist .zbx-li')].map(r => r.innerText.replace(/\\n/g, ' | '))`);
await ev(`document.querySelector('.zbx-tabs button[data-t=track]').click()`); await sleep(300);
await ev(`document.querySelector('#zbCkTx').value = '0x066b8cac6eaf7ef4b8fe4b21f7c259f8ed45b15590c95c6b241fdd29bac9510d'; document.querySelector('#zbCkGo').click()`); await sleep(4000);
out.track = await ev(`document.querySelector('#zbCkOut')?.innerText.replace(/\\n/g, ' | ')`);
await ev(`document.querySelector('.zbx-hist').scrollIntoView()`); await sleep(400);
await shot('out/zb_track.png');
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/zbridge` }); await sleep(9000);
out.mobileOverflow = await ev(`document.documentElement.scrollWidth > innerWidth`);
out.mobileFit = await ev(`[...document.querySelectorAll('.zbx-card, .zbx-panel, .zbx-kpis')].map(e => { const r = e.getBoundingClientRect(); return Math.round(r.left) + '..' + Math.round(r.right) + (r.left < 0 || r.right > innerWidth + 0.5 ? ' OUT' : ' ok'); })`);
await ev(`document.querySelector('.zbx-card').scrollIntoView()`); await sleep(400);
await shot('out/zb_mobile.png');
console.log(JSON.stringify({ ...out, errors: errs }, null, 1)); chrome.kill(); process.exit(0);
