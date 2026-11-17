/* ═══════════ PnL SHARE CARDS ═══════════ */
// Drawn in the browser on a canvas (1200×675, X/Telegram friendly), then shared, copied or downloaded.
// Four templates; the user picks one in the share dialog (remembered in localStorage).
const withTimeout = (p, ms, v = null) => Promise.race([p, new Promise(r => setTimeout(() => r(v), ms))]);
const IMG_CACHE = new Map();
const loadImg = (src) => {
  if (!src) return Promise.resolve(null);
  if (!IMG_CACHE.has(src)) IMG_CACHE.set(src, withTimeout(new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }), 4000));
  return IMG_CACHE.get(src);
};
const CARD_TEMPLATES = [
  { id: 'classic', label: 'Classic' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'neon', label: 'Neon' },
  { id: 'ranking', label: 'Ranking' },
];
const CW = 1200, CH = 675, MONO = '"JetBrains Mono"';
// numbers shared by every template
function cardData(o) {
  const win = o.pnlUsd >= 0;
  const pctTxt = o.pnlPct === null || o.pnlPct === undefined || !isFinite(o.pnlPct) ? null
    : `${o.pnlPct >= 0 ? '+' : '−'}${Math.abs(o.pnlPct) >= 1000 ? Math.round(Math.abs(o.pnlPct)).toLocaleString('en-US') : Math.abs(o.pnlPct).toFixed(1)}%`;
  const usdTxt = `${win ? '+' : '−'}${fmtUsd(Math.abs(o.pnlUsd || 0))}`;
  const title = o.kind === 'token' ? '$' + o.symbol : 'Portfolio PnL';
  const sub = o.kind === 'token' ? String(o.name || '').slice(0, 34) : `${o.positions} token${o.positions === 1 ? '' : 's'} traded on Rookery`;
  const stats = o.kind === 'token'
    ? [['IN', fmtUsd(o.costUsd || 0)], ['NOW', fmtUsd(o.valueUsd || 0)], ['PnL', usdTxt]]
    : [['BOUGHT', fmtUsd(o.boughtUsd || 0)], ['OPEN', `${(o.openUsd || 0) >= 0 ? '+' : '−'}${fmtUsd(Math.abs(o.openUsd || 0))}`], ['TOKENS', String(o.positions || 0)]];
  return { win, pctTxt, usdTxt, big: pctTxt || usdTxt, title, sub, stats, user: '@' + (o.user || 'anon'), date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase() };
}
// shrink a font until the text fits
function fitFont(g, text, weight, size, maxW, min = 40, fam = 'Inter') {
  let fs = size; g.font = `${weight} ${fs}px ${fam}`;
  while (g.measureText(text).width > maxW && fs > min) { fs -= 4; g.font = `${weight} ${fs}px ${fam}`; }
  return fs;
}
async function tokenBadge(g, o, x, y, r, dark = true) {
  const ti = await loadImg(o.image);
  g.save(); g.beginPath(); g.arc(x + r, y + r, r, 0, Math.PI * 2); g.closePath();
  if (ti) { g.clip(); g.drawImage(ti, x, y, r * 2, r * 2); }
  else { g.fillStyle = dark ? '#1b1b20' : '#e3e3de'; g.fill(); g.fillStyle = dark ? '#fff' : '#111'; g.font = `700 ${Math.round(r * .66)}px Inter`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(o.symbol || '?').slice(0, 2).toUpperCase(), x + r, y + r + 1); }
  g.restore(); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}
async function brand(g, x, y, dark = true) {
  const logo = await loadImg('/assets/logo-64.png');
  if (logo) { g.save(); g.beginPath(); g.roundRect(x, y, 44, 44, 11); g.clip(); g.drawImage(logo, x, y, 44, 44); g.restore(); }
  g.fillStyle = dark ? '#fff' : '#0a0a0a'; g.font = '800 26px Inter'; g.fillText('Rookery', x + 58, y + 30);
  g.fillStyle = dark ? '#7d7d85' : '#8a8a84'; g.font = `500 14px ${MONO}`; g.fillText('BY STINKY PENGUIN', x + 172, y + 29);
}
const newCanvas = () => { const c = document.createElement('canvas'); c.width = CW; c.height = CH; return [c, c.getContext('2d')]; };

/* 1 · Classic: dark card, penguin art on the right (win: cheering, loss: Atlas carrying the market) */
async function drawClassic(o) {
  const [c, g] = newCanvas(), D = cardData(o), col = D.win ? '#3DDC97' : '#FF5C5C';
  g.fillStyle = '#070708'; g.fillRect(0, 0, CW, CH);
  g.strokeStyle = 'rgba(255,255,255,.035)'; g.lineWidth = 1;
  for (let x = -CH; x < CW; x += 18) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + CH, CH); g.stroke(); }
  const art = await loadImg(D.win ? '/assets/penguin/pnl-win.webp' : '/assets/penguin/pnl-loss.webp');
  if (art) {
    const aw = art.width * (CH / art.height), ax = CW - aw + 30;
    g.drawImage(art, ax, 0, aw, CH);
    const fade = g.createLinearGradient(ax, 0, ax + 260, 0); fade.addColorStop(0, '#070708'); fade.addColorStop(1, 'rgba(7,7,8,0)');
    g.fillStyle = fade; g.fillRect(ax - 2, 0, 262, CH);
    const glow = g.createRadialGradient(CW - 260, CH * .55, 20, CW - 260, CH * .55, 420);
    glow.addColorStop(0, D.win ? 'rgba(61,220,151,.13)' : 'rgba(255,92,92,.12)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow; g.fillRect(0, 0, CW, CH);
  }
  await brand(g, 64, 56);
  let y = 186;
  if (o.kind === 'token') { await tokenBadge(g, o, 64, y - 44, 30); g.fillStyle = '#fff'; g.font = '800 46px Inter'; g.fillText(D.title, 142, y); g.fillStyle = '#8b8b93'; g.font = '500 18px Inter'; g.fillText(D.sub, 144, y + 30); }
  else { g.fillStyle = '#fff'; g.font = '800 46px Inter'; g.fillText(D.title, 64, y); g.fillStyle = '#8b8b93'; g.font = '500 18px Inter'; g.fillText(D.sub, 66, y + 30); }
  g.fillStyle = col; g.shadowColor = D.win ? 'rgba(61,220,151,.35)' : 'rgba(255,92,92,.3)'; g.shadowBlur = 40;
  const fs = fitFont(g, D.big, 800, 150, 600, 70);
  g.fillText(D.big, 58, 262 + fs * .82); g.shadowBlur = 0;
  y = 262 + fs * .82 + 62;
  if (D.pctTxt) { g.fillStyle = col; g.font = '700 40px Inter'; g.fillText(D.usdTxt, 64, y); y += 48; }
  g.fillStyle = '#9b9ba3'; g.font = `500 20px ${MONO}`;
  g.fillText(D.stats.slice(0, 2).map(s => `${s[0]} ${s[1]}`).join('  ·  '), 66, y + 6);
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(64, CH - 86, 560, 1);
  g.fillStyle = '#fff'; g.font = '600 20px Inter'; g.fillText(D.user, 64, CH - 48);
  g.fillStyle = '#8b8b93'; g.font = `500 17px ${MONO}`; g.fillText('rookery.stinkypenguin.xyz', 64 + g.measureText(D.user).width + 120, CH - 48);
  return c;
}

/* 2 · Minimal: paper-white, black type, one huge number, hairlines. Colour only on the direction mark. */
async function drawMinimal(o) {
  const [c, g] = newCanvas(), D = cardData(o), col = D.win ? '#12a86a' : '#e0424b';
  const INK = '#0b0b0c', MUTED = '#86867f', LINE = '#d9d9d3';
  g.fillStyle = '#f4f4f1'; g.fillRect(0, 0, CW, CH);
  // faint penguin mark as a watermark (black on white source, multiplied away)
  const mark = await loadImg('/assets/penguin/mark.webp');
  if (mark) { g.save(); g.globalAlpha = .06; g.globalCompositeOperation = 'multiply'; const mh = 560, mw = mark.width * mh / mark.height; g.drawImage(mark, CW - mw - 40, CH - mh + 40, mw, mh); g.restore(); }
  await brand(g, 72, 60, false);
  g.fillStyle = MUTED; g.font = `500 15px ${MONO}`; g.textAlign = 'right'; g.fillText(D.date, CW - 72, 88); g.textAlign = 'left';
  g.fillStyle = LINE; g.fillRect(72, 132, CW - 144, 1);
  // title
  if (o.kind === 'token') { await tokenBadge(g, o, 72, 164, 22, false); g.fillStyle = INK; g.font = '700 34px Inter'; g.fillText(D.title, 128, 198); g.fillStyle = MUTED; g.font = '500 17px Inter'; g.fillText(D.sub, 128 + g.measureText(D.title).width + 0, 198); }
  else { g.fillStyle = INK; g.font = '700 34px Inter'; g.fillText(D.title, 72, 198); }
  if (o.kind === 'token') { g.font = '700 34px Inter'; const tw = g.measureText(D.title).width; g.fillStyle = MUTED; g.font = '500 17px Inter'; g.fillText('  ' + D.sub, 128 + tw, 197); }
  // the number
  g.fillStyle = INK;
  const fs = fitFont(g, D.big, 800, 210, 900, 90);
  const by = 236 + fs * .8;
  g.fillText(D.big, 64, by);
  // direction mark: a small coloured triangle next to the number
  const bw = g.measureText(D.big).width, tx = 64 + bw + 34, ty = by - fs * .62;
  g.fillStyle = col; g.beginPath();
  if (D.win) { g.moveTo(tx, ty + 36); g.lineTo(tx + 21, ty); g.lineTo(tx + 42, ty + 36); } else { g.moveTo(tx, ty); g.lineTo(tx + 42, ty); g.lineTo(tx + 21, ty + 36); }
  g.closePath(); g.fill();
  if (D.pctTxt) { g.fillStyle = col; g.font = '600 30px Inter'; g.fillText(D.usdTxt, tx - 2, ty + 82); }
  // stat strip with hairlines
  const sy = CH - 196, colW = (CW - 144) / 3;
  g.fillStyle = LINE; g.fillRect(72, sy, CW - 144, 1);
  D.stats.forEach((s, i) => {
    const x = 72 + i * colW;
    if (i) { g.fillStyle = LINE; g.fillRect(x, sy + 22, 1, 70); }
    g.fillStyle = MUTED; g.font = `500 14px ${MONO}`; g.fillText(s[0], x + (i ? 28 : 0), sy + 44);
    g.fillStyle = s[0] === 'PnL' ? col : INK; g.font = '700 30px Inter'; g.fillText(s[1], x + (i ? 28 : 0), sy + 84);
  });
  g.fillStyle = LINE; g.fillRect(72, CH - 84, CW - 144, 1);
  g.fillStyle = INK; g.font = '600 18px Inter'; g.fillText(D.user, 72, CH - 44);
  g.fillStyle = MUTED; g.font = `500 15px ${MONO}`; g.textAlign = 'right'; g.fillText('ROOKERY.STINKYPENGUIN.XYZ', CW - 72, CH - 45); g.textAlign = 'left';
  return c;
}

/* 3 · Neon: synthwave grid, glowing numbers, laser frame, colour-tinted penguin */
async function drawNeon(o) {
  const [c, g] = newCanvas(), D = cardData(o);
  const NEON = D.win ? '#39ff88' : '#ff3d6e', ALT = '#2de2ff', MAG = '#c84bff';
  g.fillStyle = '#05030b'; g.fillRect(0, 0, CW, CH);
  // horizon glow + perspective grid
  const hz = 430;
  const sky = g.createLinearGradient(0, 0, 0, hz); sky.addColorStop(0, '#05030b'); sky.addColorStop(1, D.win ? '#0b2a1d' : '#2a0b18');
  g.fillStyle = sky; g.fillRect(0, 0, CW, hz);
  g.save(); g.strokeStyle = D.win ? 'rgba(57,255,136,.35)' : 'rgba(255,61,110,.35)'; g.lineWidth = 1.2; g.shadowColor = NEON; g.shadowBlur = 8;
  for (let i = -16; i <= 16; i++) { g.beginPath(); g.moveTo(CW / 2 + i * 22, hz); g.lineTo(CW / 2 + i * 150, CH); g.stroke(); }
  for (let k = 0; k < 9; k++) { const yy = hz + Math.pow(k / 8, 2) * (CH - hz); g.globalAlpha = .25 + k / 12; g.beginPath(); g.moveTo(0, yy); g.lineTo(CW, yy); g.stroke(); }
  g.restore();
  g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(0, hz, CW, 1);
  // penguin, tinted with the neon colour
  const art = await loadImg(D.win ? '/assets/penguin/pnl-win.webp' : '/assets/penguin/pnl-loss.webp');
  if (art) {
    const ah = CH - 40, aw = art.width * ah / art.height, ax = CW - aw + 10, ay = 20;
    const t = document.createElement('canvas'); t.width = aw; t.height = ah; const tg = t.getContext('2d');
    tg.drawImage(art, 0, 0, aw, ah);
    tg.globalCompositeOperation = 'color'; tg.fillStyle = D.win ? '#1fd877' : '#ff2d6a'; tg.fillRect(0, 0, aw, ah);
    tg.globalCompositeOperation = 'destination-in'; const m = tg.createLinearGradient(0, 0, aw * .55, 0); m.addColorStop(0, 'rgba(0,0,0,0)'); m.addColorStop(1, 'rgba(0,0,0,1)'); tg.fillStyle = m; tg.fillRect(0, 0, aw, ah);
    g.save(); g.globalAlpha = .85; g.globalCompositeOperation = 'screen'; g.drawImage(t, ax, ay); g.restore();
  }
  // scanlines
  g.fillStyle = 'rgba(255,255,255,.025)'; for (let y = 0; y < CH; y += 4) g.fillRect(0, y, CW, 1);
  // header
  await brand(g, 64, 56);
  g.save(); g.fillStyle = ALT; g.shadowColor = ALT; g.shadowBlur = 14; g.font = `600 14px ${MONO}`; g.fillText('● LIVE ON ROOKERY', 64, 136); g.restore();
  // title
  g.save(); g.fillStyle = '#fff'; g.shadowColor = MAG; g.shadowBlur = 18; g.font = '800 44px Inter'; g.fillText(D.title, 64, 196); g.restore();
  g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '500 18px Inter'; g.fillText(D.sub, 66, 226);
  // glowing number: three passes for a tube-light look
  const fs = fitFont(g, D.big, 900, 160, 640, 70);
  const by = 262 + fs * .82;
  g.save(); g.fillStyle = NEON; g.shadowColor = NEON;
  g.shadowBlur = 60; g.fillText(D.big, 58, by); g.shadowBlur = 24; g.fillText(D.big, 58, by); g.restore();
  g.save(); g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2; g.strokeText(D.big, 58, by); g.restore();
  let y = by + 58;
  if (D.pctTxt) { g.save(); g.fillStyle = '#fff'; g.shadowColor = NEON; g.shadowBlur = 20; g.font = '800 38px Inter'; g.fillText(D.usdTxt, 64, y); g.restore(); y += 46; }
  g.fillStyle = ALT; g.font = `600 19px ${MONO}`; g.fillText(D.stats.slice(0, 2).map(s => `${s[0]} ${s[1]}`).join('   //   '), 66, y + 4);
  g.fillStyle = '#fff'; g.font = '700 20px Inter'; g.fillText(D.user, 64, CH - 46);
  g.fillStyle = 'rgba(255,255,255,.55)'; g.font = `500 16px ${MONO}`; g.fillText('rookery.stinkypenguin.xyz', 64 + g.measureText(D.user).width + 30, CH - 46);
  // laser frame
  g.save(); const fr = g.createLinearGradient(0, 0, CW, CH); fr.addColorStop(0, ALT); fr.addColorStop(.5, NEON); fr.addColorStop(1, MAG);
  g.strokeStyle = fr; g.lineWidth = 4; g.shadowColor = NEON; g.shadowBlur = 26;
  g.beginPath(); g.roundRect(14, 14, CW - 28, CH - 28, 26); g.stroke(); g.lineWidth = 1.5; g.shadowBlur = 0; g.strokeStyle = 'rgba(255,255,255,.7)'; g.stroke(); g.restore();
  return c;
}

/* 4 · Ranking: every token in the wallet, best to worst, with PnL bars */
async function drawRanking(o) {
  const [c, g] = newCanvas(), D = cardData(o);
  const UP = '#3DDC97', DN = '#FF5C5C';
  g.fillStyle = '#070708'; g.fillRect(0, 0, CW, CH);
  g.strokeStyle = 'rgba(255,255,255,.03)'; g.lineWidth = 1;
  for (let x = -CH; x < CW; x += 18) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + CH, CH); g.stroke(); }
  await brand(g, 64, 50);
  const rows = (o.rank || []).filter(r => isFinite(r.pnlUsd)).sort((a, b) => b.pnlUsd - a.pnlUsd);
  const total = o.totalUsd ?? rows.reduce((a, r) => a + r.pnlUsd, 0), tw = total >= 0;
  // header: title left, total right
  g.fillStyle = '#fff'; g.font = '800 40px Inter'; g.fillText('My bags, ranked', 64, 156);
  g.fillStyle = '#8b8b93'; g.font = `500 16px ${MONO}`; g.fillText(`${rows.length} TOKEN${rows.length === 1 ? '' : 'S'} · ${D.date}`, 66, 186);
  g.textAlign = 'right'; g.fillStyle = '#8b8b93'; g.font = `500 15px ${MONO}`; g.fillText('TOTAL PnL', CW - 64, 112);
  g.fillStyle = tw ? UP : DN; g.shadowColor = tw ? 'rgba(61,220,151,.35)' : 'rgba(255,92,92,.3)'; g.shadowBlur = 30;
  fitFont(g, `${tw ? '+' : '−'}${fmtUsd(Math.abs(total))}`, 800, 60, 420, 34); g.fillText(`${tw ? '+' : '−'}${fmtUsd(Math.abs(total))}`, CW - 64, 168); g.shadowBlur = 0;
  if (o.totalPct != null && isFinite(o.totalPct)) { g.font = '700 22px Inter'; g.fillText(`${o.totalPct >= 0 ? '+' : '−'}${Math.abs(o.totalPct).toFixed(1)}%`, CW - 64, 198); }
  g.textAlign = 'left';
  // rows
  const top = 228, bottom = CH - 98, max = Math.min(rows.length, 7), rh = max ? Math.min(54, (bottom - top) / max) : 54;
  const maxAbs = Math.max(1e-9, ...rows.slice(0, max).map(r => Math.abs(r.pnlUsd)));
  const barX = 520, barW = 330;
  if (!rows.length) { g.fillStyle = '#8b8b93'; g.font = '500 22px Inter'; g.fillText('No open bags yet.', 64, top + 60); }
  for (let i = 0; i < max; i++) {
    const r = rows[i], y = top + i * rh, mid = y + rh / 2, up = r.pnlUsd >= 0, hi = o.kind === 'token' && r.id === o.id;
    if (hi || i % 2 === 0) { g.fillStyle = hi ? 'rgba(61,220,151,.09)' : 'rgba(255,255,255,.025)'; g.beginPath(); g.roundRect(48, y + 3, CW - 96, rh - 6, 12); g.fill(); }
    if (hi) { g.strokeStyle = 'rgba(61,220,151,.5)'; g.lineWidth = 1.5; g.stroke(); }
    g.fillStyle = i === 0 ? '#fff' : '#6f6f77'; g.font = `700 18px ${MONO}`; g.fillText(String(i + 1).padStart(2, '0'), 66, mid + 7);
    await tokenBadge(g, r, 112, mid - 17, 17);
    g.fillStyle = '#fff'; g.font = '700 22px Inter'; g.fillText('$' + String(r.symbol).slice(0, 12), 160, mid + 8);
    g.fillStyle = '#8b8b93'; g.font = `500 15px ${MONO}`; g.fillText(fmtUsd(r.valueUsd || 0), 360, mid + 7);
    // bar centred on a zero line: gains to the right, losses to the left
    const z = barX + barW * .35, len = (Math.abs(r.pnlUsd) / maxAbs) * (up ? barW * .65 : barW * .35);
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(z, mid - 14, 1, 28);
    g.fillStyle = up ? UP : DN; g.beginPath(); g.roundRect(up ? z + 2 : z - len - 1, mid - 7, Math.max(3, len), 14, 7); g.fill();
    g.textAlign = 'right';
    g.fillStyle = up ? UP : DN; g.font = '800 22px Inter'; g.fillText(`${up ? '+' : '−'}${fmtUsd(Math.abs(r.pnlUsd))}`, CW - 180, mid + 8);
    g.font = '600 17px Inter'; g.fillText(r.pnlPct == null || !isFinite(r.pnlPct) ? '—' : `${r.pnlPct >= 0 ? '+' : '−'}${Math.abs(r.pnlPct).toFixed(1)}%`, CW - 66, mid + 7);
    g.textAlign = 'left';
  }
  if (rows.length > max) { g.fillStyle = '#6f6f77'; g.font = `500 15px ${MONO}`; g.fillText(`+ ${rows.length - max} more`, 66, bottom + 6); }
  g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(64, CH - 78, CW - 128, 1);
  g.fillStyle = '#fff'; g.font = '600 20px Inter'; g.fillText(D.user, 64, CH - 40);
  g.fillStyle = '#8b8b93'; g.font = `500 16px ${MONO}`; g.textAlign = 'right'; g.fillText('rookery.stinkypenguin.xyz', CW - 64, CH - 41); g.textAlign = 'left';
  return c;
}
const CARD_DRAW = { classic: drawClassic, minimal: drawMinimal, neon: drawNeon, ranking: drawRanking };
async function drawCard(tpl, o) {
  await withTimeout(document.fonts?.ready || Promise.resolve(), 1500);
  return (CARD_DRAW[tpl] || drawClassic)(o);
}
const toBlob = (c) => withTimeout(new Promise(r => c.toBlob(r, 'image/png')), 5000);
// the ranking needs the whole wallet: fetch it once if the caller didn't pass it
async function ensureRank(o) {
  if (o.rank) return;
  try {
    const me = await api('/me?pnl=1');
    o.rank = me.holdings.filter(x => x.pnlUsd !== undefined).map(x => ({ id: x.id, symbol: x.symbol, image: x.image, pnlUsd: x.pnlUsd, pnlPct: x.pnlPct, valueUsd: x.valueUsd }));
    if (me.pnl) { o.totalUsd = me.pnl.totalUsd; o.totalPct = me.pnl.pct; }
  } catch { o.rank = []; }
}

async function openShare(o) {
  if (S.sharing) return; S.sharing = true;
  toast('Building your card…');
  try { await openShareInner(o); } catch (e) { console.error(e); toast('Could not build the card: ' + esc(e.message || String(e)), 'bad'); }
  finally { S.sharing = false; }
}
async function openShareInner(o) {
  await ensureRank(o);
  let tpl = CARD_DRAW[localStorage.getItem('pl_card_tpl')] ? localStorage.getItem('pl_card_tpl') : 'classic';
  let blob = null, url = null, file = null;
  const pct = o.pnlPct !== null && o.pnlPct !== undefined && isFinite(o.pnlPct) ? `${o.pnlPct >= 0 ? '+' : '-'}${Math.abs(o.pnlPct).toFixed(1)}%` : `${o.pnlUsd >= 0 ? '+' : '-'}${fmtUsd(Math.abs(o.pnlUsd))}`;
  const textFor = (t) => t === 'ranking'
    ? `My bags on Rookery, ranked 🐧\nPre-mainnet tokens, migrating 1:1 at launch.`
    : o.kind === 'token' ? `${pct} on $${o.symbol} 🐧\nTrading pre-mainnet tokens on Rookery, the Stinky Penguin launchpad.` : `${pct} portfolio PnL on Rookery 🐧\nPre-mainnet tokens, migrating 1:1 at launch.`;
  const link = location.origin + (o.id ? `/#/t/${o.id}` : '/');
  const md = h(`<div class="modal-bg"><div class="modal share-m">
    <div class="share-stage"><img alt="PnL card" class="share-img" id="shImg"><div class="share-busy" id="shBusy">Rendering…</div></div>
    <div class="tpl-h"><span class="mono mu">Card style</span><span class="mu" style="font-size:12px">Pick one, it's remembered for next time</span></div>
    <div class="tpl-pick" id="tplPick">${CARD_TEMPLATES.map(t => `<button class="tpl" data-tpl="${t.id}"><span class="tpl-th"><i class="skel"></i></span><b>${t.label}</b></button>`).join('')}</div>
    <div class="share-a">
      <button class="btn" id="shX">Post on 𝕏</button>
      ${navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'])], 'x.png', { type: 'image/png' })] }) ? '<button class="btn ghost" id="shN">Share…</button>' : ''}
      <button class="btn ghost" id="shC">Copy image</button>
      <a class="btn ghost" id="shD" download="rookery-pnl.png">Download</a>
      <button class="btn ghost" id="shQ" style="margin-left:auto">Close</button>
    </div>
    <p class="mu" style="font-size:12px;margin-top:10px">𝕏 doesn't take images from links: the card is copied to your clipboard, just paste it into the post.</p>
  </div></div>`);
  document.body.append(md);
  const render = async (t) => {
    tpl = t; localStorage.setItem('pl_card_tpl', t);
    $$('#tplPick .tpl').forEach(b => b.classList.toggle('on', b.dataset.tpl === t));
    $('#shBusy').classList.add('on');
    const c = await drawCard(t, o);
    const b = await toBlob(c); if (!b) throw new Error('image export timed out');
    if (url) URL.revokeObjectURL(url);
    blob = b; url = URL.createObjectURL(b);
    file = new File([b], `rookery-${t}-${o.symbol || 'portfolio'}.png`, { type: 'image/png' });
    $('#shImg').src = url; $('#shD').href = url; $('#shD').download = file.name;
    $('#shBusy').classList.remove('on');
  };
  await render(tpl);
  // live previews of every template as thumbnails
  (async () => { for (const t of CARD_TEMPLATES) { try { const c = await drawCard(t.id, o); const th = md.querySelector(`[data-tpl="${t.id}"] .tpl-th`); if (th) th.innerHTML = `<img src="${c.toDataURL('image/jpeg', .7)}" alt="">`; } catch { /* keep the placeholder */ } } })();
  $$('#tplPick .tpl').forEach(b => b.onclick = () => { if (b.dataset.tpl !== tpl) render(b.dataset.tpl).catch(e => toast(esc(e.message), 'bad')); });
  const close = () => { md.remove(); if (url) URL.revokeObjectURL(url); };
  md.onclick = (e) => { if (e.target === md) close(); };
  $('#shQ').onclick = close;
  const copy = async () => { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); return true; } catch { return false; } };
  $('#shC').onclick = async () => toast((await copy()) ? 'Card copied. Paste it anywhere.' : 'Copy is blocked here, use Download.');
  $('#shX').onclick = async () => {
    const ok = await copy();
    if (!ok) $('#shD').click();
    toast(ok ? 'Card copied: paste it into your post (Ctrl/⌘+V)' : 'Card downloaded: attach it to your post');
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(textFor(tpl))}&url=${encodeURIComponent(link)}`, '_blank', 'noopener');
  };
  const sn = $('#shN'); if (sn) sn.onclick = async () => { try { await navigator.share({ files: [file], text: textFor(tpl), url: link }); } catch { /* cancelled */ } };
}
