// UI check for Robinhood Chain wallet launches: open Create, pick Robinhood Chain, read the form state + console errors.
// node tools/rh_ui_check.mjs [baseUrl]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const BASE = process.argv[2] || 'https://rookery.stinkypenguin.xyz';
const MIDS = process.argv.slice(3);
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9334', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9334/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch { /* starting */ } await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push(d.params.args.map(a => a.value || a.description).join(' '));
};
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: BASE + '/?nocache=' + Date.now() + '#/create' });
await sleep(6000);
await ev(`document.querySelector('#netPick [data-n="robinhood"]').click()`);
await sleep(800);
const r = await ev(`(() => ({ rhLive: !!(window.S && S.rh && S.rh.live), appJs: [...document.scripts].map(s => s.src).find(s => /app\\.js/.test(s)),
  btn: document.querySelector('#createGo')?.textContent, fee: document.querySelector('#cFee')?.textContent,
  taxHidden: getComputedStyle(document.querySelector('#fsTax')).display === 'none', protHidden: getComputedStyle(document.querySelector('#fsProt')).display === 'none',
  pair: document.querySelector('#pairBox')?.innerText.replace(/\\n+/g, ' | '), dev: document.querySelector('#devLbl')?.textContent }))()`);
console.log(JSON.stringify(r, null, 1));
// pick a stock pair if the list has one
const pick = await ev(`(() => { const sel = document.querySelector('#rhPair'); if (!sel) return null; const o = [...sel.options].find(o => /TSLA/.test(o.text)); if (!o) return null; sel.value = o.value; sel.dispatchEvent(new Event('change')); return o.text; })()`);
await sleep(500);
console.log('pair picked:', pick, '| dev label:', await ev(`document.querySelector('#devLbl')?.textContent`), '| tax visible:', await ev(`getComputedStyle(document.querySelector('#fsTax')).display !== 'none'`));
const s = await cmd('Page.captureScreenshot', { format: 'png' });
writeFileSync('out/rh_create.png', Buffer.from(s.result.data, 'base64'));
for (const [i, id] of MIDS.entries()) {
  await cmd('Page.navigate', { url: BASE + '/?nocache=' + Date.now() + '#/t/' + id });
  await sleep(6000);
  console.log('token', id, JSON.stringify(await ev(`(() => ({ pane: document.querySelector('#rhPane')?.innerText.slice(0, 300).replace(/\n+/g, ' | '), est: !!document.querySelector('#rhEst') }))()`)));
  await ev(`(() => { const i = document.querySelector('#rhAmt'); if (i) { i.value = '0.5'; i.dispatchEvent(new Event('input')); } })()`);
  await sleep(1500);
  console.log('  estimate:', await ev(`document.querySelector('#rhEst')?.innerText.replace(/\n+/g, ' | ')`));
  const sh = await cmd('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`out/rh_token_${i}.png`, Buffer.from(sh.result.data, 'base64'));
}
console.log('console errors (all pages):', JSON.stringify(errs));
ws.close(); chrome.kill(); process.exit(0);
