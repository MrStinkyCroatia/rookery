// Header fit at many widths: every nav item visible (not scrolled away), no horizontal overflow, mobile bar fits.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const BASE = process.env.BASE || 'https://rookery-staging.stablepump-ops.workers.dev';
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9371', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9371/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {};
const cmd = (m, p = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } };
const ev = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
const out = {};
for (const [w, h, mob] of [[1440, 900, false], [1280, 800, false], [1100, 800, false], [1000, 800, false], [820, 1000, false], [430, 900, true], [390, 844, true], [360, 740, true]]) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mob ? 2 : 1, mobile: mob });
  await cmd('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}#/zbridge` }); await sleep(6500);
  out[w] = await ev(`(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return cs.display !== 'none' && r.width > 0 && r.left >= -0.5 && r.right <= innerWidth + 0.5; };
    const nav = document.querySelector('.nav'); const mnav = document.querySelector('.mnav');
    const top = [...document.querySelectorAll('.nav a')], bot = [...document.querySelectorAll('.mnav a')];
    const navShown = nav && getComputedStyle(nav).display !== 'none';
    const hidden = navShown ? top.filter(a => { const r = a.getBoundingClientRect(), n = nav.getBoundingClientRect(); return r.right > n.right + 0.5 || r.left < n.left - 0.5; }).map(a => a.innerText.trim()) : [];
    const mShown = mnav && getComputedStyle(mnav).display !== 'none';
    const tight = mShown ? bot.filter(a => a.scrollWidth > a.clientWidth + 1).map(a => a.innerText.trim()) : [];
    const topR = document.querySelector('.top-in').getBoundingClientRect();
    return { nav: navShown ? 'top' : 'bottom', hiddenTop: hidden, bottomItems: mShown ? bot.map(a => a.innerText.trim().replace(/\\s+/g, ' ')) : null, bottomCut: tight,
      headerOverflow: document.querySelector('.top-in').scrollWidth > document.querySelector('.top-in').clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > innerWidth,
      zbOn: !!document.querySelector((navShown ? '.nav' : '.mnav') + ' a.on[data-nav=zbridge]'), docs: mShown ? vis(document.querySelector('.docs-m')) : null };
  })()`);
  if ([1440, 1100, 390].includes(w)) writeFileSync(`out/nav_${w}.png`, Buffer.from((await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: mob ? h : 140, scale: 1 } })).result.data, 'base64'));
}
console.log(JSON.stringify(out, null, 1)); chrome.kill(); process.exit(0);
