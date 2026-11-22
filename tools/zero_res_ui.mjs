// UI check: the reserved Zero contract panel on a token page (desktop + mobile), screenshots + console errors.
// node tools/zero_res_ui.mjs <tokenId> [baseUrl]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const ID = process.argv[2] || 'bryan-0f9018';
const BASE = process.argv[3] || 'https://rookery.stinkypenguin.xyz';
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9336', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9336/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch { /* starting */ } await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const errs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
};
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
const out = {};
for (const [name, w, h, mobile] of [['desktop', 1400, 1000, false], ['mobile', 390, 844, true]]) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/t/${ID}` });
  await sleep(7000);
  out[name] = await ev(`(() => { const p = document.querySelector('.zero-res'); if (!p) return { panel: false };
    p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect();
    return { panel: true, addr: p.querySelector('.zr-addr')?.getAttribute('data-copy'), text: p.innerText.slice(0, 260), width: Math.round(r.width),
      overflowX: document.documentElement.scrollWidth > window.innerWidth, kvContract: [...document.querySelectorAll('.kv')].find(k => /Contract/.test(k.innerText))?.innerText }; })()`);
  await sleep(600);
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`out/zero_res_${name}.png`, Buffer.from(shot.result.data, 'base64'));
}
console.log(JSON.stringify({ ...out, errors: errs }, null, 1));
chrome.kill();
process.exit(0);
