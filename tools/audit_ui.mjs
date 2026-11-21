// Whole-site audit: opens every route, records JS errors, checks key elements, clicks the main tabs,
// switches networks and tries the bridge form. Read-only: nothing is submitted.
import { spawn } from 'node:child_process';
const BASE = process.env.BASE || 'https://rookery.stinkypenguin.xyz';
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9350', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9350/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch { } await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; let errs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errs.push('EXC ' + (d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text || '').split('\n')[0].slice(0, 140));
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push('CON ' + d.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 140));
};
const cmd = (mm, p = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method: mm, params: p })); });
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');

const go = async (hash) => { errs = []; await cmd('Page.navigate', { url: BASE + '/?nocache=' + Date.now() + hash }); await sleep(5500); };
const probe = async () => ev(`(() => {
  const h1 = document.querySelector('h1')?.textContent || '';
  const over = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  const empty = [...document.querySelectorAll('.empty')].map(e => e.textContent.trim()).filter(Boolean);
  return { h1: h1.slice(0, 60), over, empty, cards: document.querySelectorAll('.card, .net-card, .panel, .row').length };
})()`);

const out = {};
const routes = ['', '#/explore', '#/create', '#/bridge', '#/points', '#/proofs', '#/proofs/burns', '#/docs', '#/wallet', '#/referral', '#/leaderboard'];
for (const r of routes) {
  await go(r);
  out[r || '#/'] = { ...(await probe()), errs: [...new Set(errs)].slice(0, 4) };
}
// token page + its tabs
const mk = await (await fetch(BASE + '/api/markets?network=robinhood&r=' + Date.now(), { headers: { 'x-pl': '1' } })).json();
const tok = (mk.markets || [])[0];
if (tok) {
  await go('#/t/' + tok.id);
  const tabs = {};
  for (const t of ['trades', 'holders', 'comments', 'about']) {
    await ev(`document.querySelector('#tabs [data-t="${t}"]')?.click()`); await sleep(700);
    tabs[t] = await ev(`(document.querySelector('#tabBody')?.innerText || '').slice(0, 60).replace(/\\n/g, ' ')`);
  }
  out['#/t (robinhood)'] = { ...(await probe()), tabs, errs: [...new Set(errs)].slice(0, 4) };
  // buy/sell tabs on the wallet panel
  const rs = {};
  for (const s of ['buy', 'sell', 'buy']) {
    await ev(`document.querySelector('[data-rs="${s}"]')?.click()`); await sleep(500);
    rs[s] = await ev(`({ u: document.querySelector('#rhUnit')?.textContent, cta: document.querySelector('#rhGo')?.textContent })`);
  }
  out['#/t panel'] = rs;
}
// network switching
const nets = {};
for (const n of ['zero', 'giwa', 'litvm', 'robinhood', 'stellar', '']) {
  await ev(`document.querySelector('#netMenu [data-net="${n}"]')?.click()`); await sleep(1600);
  nets[n || 'all'] = await ev(`({ pill: document.querySelector('#pxLbl')?.textContent + ' ' + document.querySelector('#zroPx')?.textContent, list: document.querySelectorAll('.card').length })`);
}
out['network switch'] = nets;
// bridge form: pick pairs and read the quote
await go('#/bridge');
const bridge = {};
const pick = async (host, k) => ev(`(() => { document.querySelector('${host} .br-dd')?.click(); const b = document.querySelector('${host} .br-it[data-k="${k}"]'); if (b) { b.click(); return true; } return false; })()`);
for (const [from, to, amt, addr] of [['base', 'litecoin', '0.005', 'ltc1qd9an6js0wnkslxr4f2r9lxkda3d9zkxtg4jcx8'], ['litecoin', 'base', '0.01', '0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D'], ['base', 'stellar', '0.005', 'GDZWHJSSMSQF2GU5S7V4WOJY7BEZUQI3PFHKNK3AHEEFLVNEKG3QX3NI']]) {
  await pick('#brFN', from); await sleep(600); await pick('#brTN', to); await sleep(600);
  await ev(`(() => { const a=document.querySelector('#brAddr'); if (a) { a.value='${addr}'; a.dispatchEvent(new Event('input')); } const i=document.querySelector('#brAmt'); if (i) { i.value='${amt}'; i.dispatchEvent(new Event('input')); } })()`);
  await sleep(3200);
  bridge[from + '->' + to] = await ev(`({ out: document.querySelector('#brOut')?.innerText.trim(), btn: document.querySelector('#brGo')?.innerText.trim(), err: document.querySelector('#brErr')?.innerText || '' })`);
  await go('#/bridge');
}
out['bridge'] = bridge;
console.log(JSON.stringify(out, null, 1));
ws.close(); chrome.kill(); process.exit(0);
