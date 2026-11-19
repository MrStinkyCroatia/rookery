// Mobile audit: iPhone-sized viewport, overflow / tap-target / tiny-text detection + viewport screenshots.
// node tools/mobile_audit.mjs out/mobile <url> [<url>...]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const [outDir, ...urls] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const W = Number(process.env.MW || 390), H = Number(process.env.MH || 844);
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:9333/json')).json(); const pg = l.find(x => x.type === 'page'); if (pg) { ws = new WebSocket(pg.webSocketDebuggerUrl); break; } } catch {} await sleep(250); }
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {};
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } };
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await cmd('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
const AUDIT = `(() => {
  const vw = document.documentElement.clientWidth, out = { vw, scrollW: document.documentElement.scrollWidth, over: [], tiny: [], taps: [] };
  const label = (e) => (e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')) + ' "' + (e.innerText || e.value || e.placeholder || '').trim().slice(0, 30).replace(/\\s+/g, ' ') + '"';
  const clipped = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if (/(hidden|auto|scroll|clip)/.test(s.overflowX)) { const r = p.getBoundingClientRect(); if (r.right <= vw + 1) return true; } } return false; };
  for (const e of document.querySelectorAll('body *')) {
    const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if ((r.right > vw + 1 || r.left < -1) && !clipped(e) && s.position !== 'fixed') out.over.push(label(e) + ' L' + Math.round(r.left) + ' R' + Math.round(r.right));
    const txt = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 2);
    if (txt && parseFloat(s.fontSize) < 10.5 && r.top < 30000) out.tiny.push(label(e) + ' ' + s.fontSize);
    if (/^(A|BUTTON|INPUT|SELECT)$/.test(e.tagName) && (r.height < 30 || r.width < 30) && r.top >= 0) out.taps.push(label(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (txt && e.scrollWidth > e.clientWidth + 2 && /(hidden|clip)/.test(s.overflowX) && s.textOverflow !== 'ellipsis') out.over.push('CUT ' + label(e));
  }
  out.over = [...new Set(out.over)].slice(0, 25); out.tiny = [...new Set(out.tiny)].slice(0, 15); out.taps = [...new Set(out.taps)].slice(0, 15);
  return out;
})()`;
const report = {};
for (const [n, u] of urls.entries()) {
  await cmd('Page.navigate', { url: u });
  await sleep(Number(process.env.WAIT || 6000));
  const a = await ev(AUDIT);
  const fullH = await ev('document.documentElement.scrollHeight');
  report[u] = { ...a, fullH };
  const shots = Math.min(Number(process.env.SHOTS || 4), Math.ceil(fullH / H));
  for (let i = 0; i < shots; i++) {
    await ev(`window.scrollTo(0, ${i * (H - 80)})`); await sleep(700);
    const s = await cmd('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
    writeFileSync(`${outDir}/p${n}_${i}.jpg`, Buffer.from(s.result.data, 'base64'));
  }
}
writeFileSync(outDir + '/report.json', JSON.stringify(report, null, 1));
for (const [u, r] of Object.entries(report)) {
  console.log(`\n== ${u}  vw=${r.vw} scrollW=${r.scrollW} H=${r.fullH}`);
  if (r.over.length) console.log('  OVERFLOW:\n   ' + r.over.join('\n   '));
  if (r.tiny.length) console.log('  TINY TEXT:\n   ' + r.tiny.join('\n   '));
  if (r.taps.length) console.log('  SMALL TAPS:\n   ' + r.taps.join('\n   '));
}
ws.close(); chrome.kill();
process.exit(0);
