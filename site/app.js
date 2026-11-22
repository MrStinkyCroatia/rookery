/* Rookery — frontend (vanilla, hash routed) */
'use strict';

const S = {
  me: null, stats: null, timer: null, chart: null,
  net: localStorage.getItem('pl_net') || '',
  quick: localStorage.getItem('pl_quick') || '10',
};
const app = document.getElementById('app');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const B = (v) => BigInt(v || 0);
const WEI = 10n ** 18n;

/* ───────── formatting ───────── */
const SUB = '₀₁₂₃₄₅₆₇₈₉';
function fmtUsd(v) {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v), s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}K`;
  if (a >= 1) return `${s}$${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (a === 0) return '$0';
  if (a >= 0.01) return `${s}$${a.toFixed(4)}`;
  const z = Math.floor(-Math.log10(a)) - 1;
  const digits = Math.round(a * 10 ** (z + 4)).toString().slice(0, 4);
  return `${s}$0.0${[...String(z)].map(d => SUB[d]).join('')}${digits}`;
}
const axisUsd = (v) => (v >= 1 ? v.toFixed(2) : v === 0 ? '0' : v.toPrecision(3));
const fmtPct = (v) => `<span class="${v >= 0 ? 'up' : 'dn'}">${v >= 0 ? '+' : ''}${(v || 0).toFixed(1)}%</span>`;
const zNum = (v) => (typeof v === 'number' ? v : Number(B(v)) / 1e18); // accepts wei (string/BigInt) or an already-human number
function fmtZ(wei, dp = 2) {
  const n = zNum(wei);
  if (n === 0) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n < 0.01) return n.toPrecision(2);
  return n.toLocaleString('en-US', { maximumFractionDigits: dp });
}
function fmtT(wei) {
  const n = zNum(wei);
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(n < 1 ? 4 : 2);
}
function toWei(str) {
  str = String(str || '').trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(str) || str === '' || str === '.') return 0n;
  const [i, f = ''] = str.split('.');
  return B(i || '0') * WEI + B((f + '0'.repeat(18)).slice(0, 18));
}
// exact, always rounds DOWN (MAX must never exceed the real balance)
const weiToStr = (wei, dp = 6) => {
  const v = B(wei); if (v <= 0n) return '0';
  const t = v / 10n ** BigInt(18 - dp), base = 10n ** BigInt(dp);
  const f = (t % base).toString().padStart(dp, '0').replace(/0+$/, '');
  return f ? `${t / base}.${f}` : `${t / base}`;
};
function ago(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd';
}
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const initials = (s) => esc(String(s || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?');
const timg = (m, cls = '') => `<div class="timg ${cls}">${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy">` : initials(m.symbol)}</div>`;
const avatar = (u, url) => `<div class="av">${url ? `<img src="${esc(url)}" alt="">` : initials(u)}</div>`;
const netTag = (n) => `<span class="tag ${n}">${n === 'giwa' ? '<img src="/assets/giwa.png" alt="">GIWA' : n === 'stellar' ? '<img src="/assets/chains/stellar.svg" alt="">STELLAR' : n === 'robinhood' ? '<img src="/assets/chains/robinhood.png" alt="">ROBINHOOD' : n === 'litvm' ? '<img src="/assets/chains/litecoin.svg" alt="">LITVM' : 'ZERO'}</span>`;
const netName = (n) => (n === 'giwa' ? 'GIWA' : n === 'stellar' ? 'Stellar' : n === 'robinhood' ? 'Robinhood Chain' : n === 'litvm' ? 'LitVM' : 'Zero');
const netCur = (n) => (n === 'giwa' || n === 'robinhood' ? 'eth' : n === 'stellar' ? 'xlm' : n === 'litvm' ? 'zltc' : 'zro');
const netLong = (n) => (n === 'zero' ? 'Zero · LayerZero' : n === 'giwa' ? 'GIWA · Upbit' : n === 'stellar' ? 'Stellar · on-chain' : n === 'robinhood' ? 'Robinhood Chain · L2' : n === 'litvm' ? 'LitVM · Litecoin' : 'All networks');

/* ───────── api ───────── */
async function api(path, body, method) {
  const opt = { method: method || (body ? 'POST' : 'GET'), credentials: 'same-origin', headers: { 'x-pl': '1' } };
  if (body) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch('/api' + path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error(j.error || 'Request failed'); e.status = r.status; throw e; }
  return j;
}
function toast(msg, kind = 'ok') {
  const t = h(`<div class="toast ${kind}">${msg}</div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 5200);
}

/* ───────── curve math (mirror of the server) ───────── */
function reserves(m) {
  if (m.graduated) return { z: B(m.poolZro), t: B(m.poolTok) };
  const c = S.stats.curve;
  return { z: (m.vQuote ? B(m.vQuote) : B(c.vZro) * WEI) + B(m.reserveZro), t: B(c.vTok) * WEI - B(m.sold) };
}
const bpsOf = (pct) => BigInt(Math.round((pct || 0) * 100));
const ASSET = { zro: { label: 'ZRO', ico: 'Z', quick: ['1', '5', '10', '50'], dp: 4 }, eth: { label: 'ETH', ico: 'Ξ', quick: ['0.001', '0.005', '0.01', '0.05'], dp: 6 }, xlm: { label: 'XLM', ico: 'X', quick: ['10', '50', '100', '500'], dp: 4 },
  zltc: { label: 'zkLTC', ico: 'Ł', quick: ['1', '5', '10', '50'], dp: 4 }, ltc: { label: 'LTC', ico: 'Ł', quick: ['0.05', '0.1', '0.5', '1'], dp: 5 } };
const assetUsd = (a) => (a === 'eth' ? S.stats?.ethUsd : a === 'xlm' ? S.stats?.xlmUsd : S.stats?.zroUsd) || 0;
const qaOf = (q) => (q === 'ETH' ? 'eth' : q === 'XLM' ? 'xlm' : q === 'ZKLTC' ? 'zltc' : q === 'LTC' ? 'ltc' : 'zro');
// mirror of the server's instant conversion (0.5% fee) for estimates only
const convert = (wei, from, to) => (from === to ? wei : (wei * BigInt(Math.round(assetUsd(from) * 1e8)) / BigInt(Math.max(1, Math.round(assetUsd(to) * 1e8))) * 9950n) / 10000n);
const fmtA = (wei, a, dp) => `${fmtZ(wei, dp ?? ASSET[a].dp)} ${ASSET[a].label}`;
function estBuy(m, zroIn) {
  const tx = m.taxes, fee = (v, p) => (v * bpsOf(p)) / 10000n;
  const net = zroIn - fee(zroIn, tx.platform) - fee(zroIn, tx.marketing) - fee(zroIn, tx.rewards);
  if (net <= 0n) return { tokens: 0n };
  const { z, t } = reserves(m);
  let out = t - (z * t) / (z + net);
  const left = B(m.curveTokens) * WEI - B(m.sold);
  if (!m.graduated && out > left) out = left;
  const burn = fee(out, tx.burn);
  const avg = out > 0n ? Number(zroIn) / Number(out - burn) : 0;
  const after = m.graduated ? { ...m, poolZro: (B(m.poolZro) + net).toString(), poolTok: (B(m.poolTok) - out).toString() }
    : { ...m, reserveZro: (B(m.reserveZro) + net).toString(), sold: (B(m.sold) + out).toString() };
  const r2 = reserves(after);
  const impact = m.priceZro ? (Number((r2.z * WEI) / r2.t) / 1e18 / m.priceZro - 1) * 100 : 0;
  return { tokens: out - burn, burn, avg, impact };
}
function estSell(m, tokIn) {
  const tx = m.taxes, fee = (v, p) => (v * bpsOf(p)) / 10000n;
  const burn = fee(tokIn, tx.burn);
  const sellTok = tokIn - burn;
  const { z, t } = reserves(m);
  let gross = z - (z * t) / (t + sellTok);
  const cap = m.graduated ? B(m.poolZro) : B(m.reserveZro);
  if (gross > cap) gross = cap;
  const net = gross - fee(gross, tx.platform) - fee(gross, tx.marketing) - fee(gross, tx.rewards);
  return { zro: net > 0n ? net : 0n, burn };
}

/* ───────── Stellar wallets (SEP-43 providers + Freighter / xBull / Albedo / Rabet / Lobstr via WalletConnect) ───────── */
const WC_PID = '7e1a3a63f6cfcac97c152d5fa0a0e4ef';
const WC = {
  client: null, session: null,
  chain() { return 'stellar:' + (S.stats?.stellar?.net === 'mainnet' ? 'pubnet' : 'testnet'); },
  async init() {
    if (WC.client) return WC.client;
    const { SignClient } = await import('https://esm.sh/@walletconnect/sign-client@2.17.0?bundle');
    WC.client = await SignClient.init({
      projectId: WC_PID,
      metadata: { name: 'Rookery', description: 'The Stinky Penguin launchpad', url: location.origin, icons: [location.origin + '/assets/penguin/sticky.webp'] },
    });
    const last = localStorage.getItem('wc_topic');
    if (last) { const sess = WC.client.session.getAll().find(x => x.topic === last); if (sess && sess.expiry * 1000 > Date.now()) WC.session = sess; }
    return WC.client;
  },
  address() {
    const acc = WC.session?.namespaces?.stellar?.accounts?.[0] || '';
    const a = acc.split(':')[2] || '';
    return /^G[A-Z2-7]{55}$/.test(a) ? a : '';
  },
  async connect() {
    const c = await WC.init();
    if (WC.session && WC.address()) return WC.address();
    const { uri, approval } = await c.connect({
      requiredNamespaces: { stellar: { methods: ['stellar_signMessage', 'stellar_signXDR'], chains: [WC.chain()], events: ['accountsChanged'] } },
    });
    await WC.showQr(uri);
    const session = await approval();
    WC.session = session;
    localStorage.setItem('wc_topic', session.topic);
    WC.hideQr();
    return WC.address();
  },
  async signMessage(message) {
    const c = await WC.init();
    const r = await c.request({ topic: WC.session.topic, chainId: WC.chain(), request: { method: 'stellar_signMessage', params: { message } } });
    const sig = r?.signedMessage || r?.signature || r?.signed_message;
    if (!sig) throw new Error('Lobstr did not return a signature');
    return sig;
  },
  async signTx(xdr) {
    const c = await WC.init();
    const r = await c.request({ topic: WC.session.topic, chainId: WC.chain(), request: { method: 'stellar_signXDR', params: { xdr } } });
    const out = r?.signedXDR || r?.signed_xdr || r?.xdr;
    if (!out) throw new Error('Lobstr did not sign the payment');
    return out;
  },
  async showQr(uri) {
    WC.hideQr();
    const { default: QR } = await import('https://esm.sh/qrcode@1.5.4?bundle');
    const dataUrl = await QR.toDataURL(uri, { margin: 1, width: 300, color: { dark: '#000', light: '#fff' } });
    const el = document.createElement('div');
    el.id = 'wcBox';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.86);display:grid;place-items:center;padding:20px';
    el.innerHTML = `<div style="background:#0f0f11;border:1px solid #26262c;border-radius:16px;padding:22px;max-width:360px;text-align:center">
      <div class="mono mu" style="margin-bottom:10px">Scan with Lobstr</div>
      <img alt="WalletConnect" src="${dataUrl}" style="width:300px;height:300px;border-radius:12px;background:#fff">
      <p class="mu" style="font-size:12px;line-height:1.5;margin:10px 0 0">Open Lobstr on your phone, tap WalletConnect and scan this code. On the phone, <a href="${esc(uri)}" style="text-decoration:underline;color:var(--tx)">tap here instead</a>.</p>
      <button class="btn sm ghost" id="wcClose" style="margin-top:12px">Cancel</button></div>`;
    document.body.appendChild(el);
    el.querySelector('#wcClose').onclick = () => WC.hideQr();
  },
  hideQr() { document.getElementById('wcBox')?.remove(); },
};

/* ───────── Stellar wallets (SEP-43 providers + Freighter / xBull / Albedo / Rabet) ───────── */
const STW = {
  async detect() {
    if (window.freighterApi?.signMessage || window.freighter?.signMessage) return 'freighter';
    if (window.albedo?.publicKey) return 'albedo';
    if (window.xBullSDK?.connect) return 'xbull';
    if (window.rabet?.connect) return 'rabet';
    if (window.stellar?.getPublicKey) return 'sep43';
    return null;
  },
  async connect(kind) {
    if (kind === 'freighter') {
      const api = window.freighterApi || window.freighter;
      let r = await api.requestAccess?.() ?? await api.getPublicKey();
      const addr = typeof r === 'string' ? r : r?.publicKey || r?.address;
      if (!/^G[A-Z2-7]{55}$/.test(addr || '')) throw new Error('Freighter returned no address');
      return addr;
    }
    if (kind === 'albedo') { const r = await window.albedo.publicKey({}); return r.pubkey || r.publicKey; }
    if (kind === 'xbull') { const r = await window.xBullSDK.connect({ canRequestPublicKey: true, canRequestSign: true }); return r.publicKey || r; }
    if (kind === 'rabet') { const r = await window.rabet.connect(); return r.publicKey || r; }
    if (kind === 'sep43') { const r = await window.stellar.getPublicKey(); return r.address || r.publicKey || r; }
    throw new Error('No Stellar wallet found. Install Freighter, xBull, Albedo or Rabet.');
  },
  async signMessage(kind, address, message) {
    if (kind === 'freighter') {
      const api = window.freighterApi || window.freighter;
      const r = await api.signMessage(message, { address });
      const sig = r?.signedMessage || r?.signature;
      if (!sig) throw new Error(r?.error || 'Wallet did not return a signature');
      return sig;
    }
    if (kind === 'albedo') { const r = await window.albedo.signMessage({ message, pubkey: address }); return r.signature; }
    if (kind === 'xbull') { const r = await window.xBullSDK.signMessage({ message, publicKey: address }); return r.signature || r; }
    if (kind === 'rabet') { const r = await window.rabet.signMessage?.(message, address); return r?.signature || r; }
    if (kind === 'sep43') { const r = await window.stellar.signMessage(message, { address }); return r.signedMessage || r.signature; }
    throw new Error('This wallet cannot sign a message');
  },
  async signTx(kind, address, xdr, net) {
    const MAIN = net ? net === 'mainnet' : S.stats?.stellar?.net === 'mainnet';
    if (kind === 'freighter') {
      const api = window.freighterApi || window.freighter;
      const r = await api.signTransaction(xdr, { address, network: MAIN ? 'PUBLIC' : 'TESTNET' });
      const out = r?.signedTxXdr || r?.signedXDR;
      if (!out) throw new Error(r?.error || 'Wallet did not sign the payment');
      return out;
    }
    if (kind === 'albedo') { const r = await window.albedo.tx({ xdr, pubkey: address, network: MAIN ? 'public' : 'testnet' }); return r.signed_envelope_xdr; }
    if (kind === 'xbull') { const r = await window.xBullSDK.signXDR(xdr, { publicKey: address }); return r.signedXDR || r; }
    if (kind === 'rabet') { const r = await window.rabet.sign(xdr, address); return r.xdr || r; }
    if (kind === 'sep43') { const r = await window.stellar.signTransaction(xdr, { address, networkPassphrase: MAIN ? 'Public Global Stellar Network ; September 2015' : 'Test SDF Network ; September 2015' }); return r.signedTxXdr || r; }
    throw new Error('This wallet cannot sign a transaction');
  },
  async loginWc() {
    const address = await WC.connect();
    const n = await api('/auth/stellar/nonce', { address });
    const sig = await WC.signMessage(n.message);
    await api('/auth/stellar/verify', { address, nonce: n.nonce, signature: sig });
    S.me = null; await loadMe(); paintAcct();
    toast('Signed in with Lobstr');
    return address;
  },
  async buyWc(marketId, xlm) {
    const address = await WC.connect();
    if (!S.me) { const n = await api('/auth/stellar/nonce', { address }); const sig = await WC.signMessage(n.message); await api('/auth/stellar/verify', { address, nonce: n.nonce, signature: sig }); S.me = await api('/me'); }
    const p = await api('/stellar/prep', { market: marketId, amount: BigInt(Math.round(xlm * 1e6)) * 10n ** 12n + '', address });
    const signed = await WC.signTx(p.xdr);
    const r = await api('/stellar/submit', { xdr: signed });
    toast('Payment sent. Your tokens arrive in about a minute.');
    return r;
  },
  // full sign-in: one message signature, no transaction
  async login() {
    const kind = await STW.detect();
    if (!kind) throw new Error('No Stellar wallet found. Install Freighter, xBull, Albedo or Rabet.');
    const address = await STW.connect(kind);
    const n = await api('/auth/stellar/nonce', { address });
    const sig = await STW.signMessage(kind, address, n.message);
    await api('/auth/stellar/verify', { address, nonce: n.nonce, signature: sig });
    S.me = null; await loadMe(); paintAcct();
    toast('Signed in with ' + short(address));
    return address;
  },
  async trust(marketId) {
    const kind = await STW.detect();
    if (!kind) throw new Error('No Stellar wallet found. Install Freighter, xBull, Albedo or Rabet.');
    const address = await STW.connect(kind);
    const p = await api('/stellar/prep-trust', { market: marketId, address });
    const signed = await STW.signTx(kind, address, p.xdr);
    await api('/stellar/submit', { xdr: signed });
    toast('Trustline added. Tokens you buy now arrive in this wallet.');
  },
  // sell tokens that are in the wallet: they go back to Rookery with a memo, the XLM comes straight back
  async sell(marketId, tokensWei) {
    const kind = await STW.detect();
    if (!kind) throw new Error('No Stellar wallet found. Install Freighter, xBull, Albedo or Rabet.');
    const address = await STW.connect(kind);
    const p = await api('/stellar/prep-sell', { market: marketId, amount: String(tokensWei), address });
    const signed = await STW.signTx(kind, address, p.xdr);
    const r = await api('/stellar/submit', { xdr: signed });
    toast('Tokens sent. The sale runs on the curve and the XLM comes back to your wallet in about a minute.');
    return r;
  },
  // buy straight from the wallet: server builds the payment, the wallet signs it, we submit
  async buy(marketId, xlm) {
    const kind = await STW.detect();
    if (!kind) throw new Error('No Stellar wallet found. Install Freighter, xBull, Albedo or Rabet.');
    const address = await STW.connect(kind);
    const p = await api('/stellar/prep', { market: marketId, amount: BigInt(Math.round(xlm * 1e6)) * 10n ** 12n + '', address });
    const signed = await STW.signTx(kind, address, p.xdr);
    const r = await api('/stellar/submit', { xdr: signed });
    toast('Payment sent. Your tokens arrive in about a minute.');
    return r;
  },
};

/* ───────── header: price, burn, network, account ───────── */
// the header price pill follows the network picked in the menu: ZRO / ETH / XLM
function paintPx() {
  const st = S.stats; if (!st) return;
  const a = netCur(S.net);
  const ltc = a === 'ltc' || a === 'zltc';
  const px = a === 'eth' ? st.ethUsd : a === 'xlm' ? st.xlmUsd : ltc ? (st.ltcUsd || st.zltcUsd || 0) : st.zroUsd;
  const ico = $('#pxIco'), lbl = $('#pxLbl'), p = $('#zroPx'), ch = $('#zroCh');
  if (!ico || !lbl || !p) return;
  ico.textContent = ASSET[a].ico; ico.className = 'zro-ico' + (a === 'eth' ? ' eth' : a === 'xlm' ? ' xlm' : ltc ? ' ltc' : '');
  lbl.textContent = ASSET[a].label;
  const dp = a === 'eth' ? 0 : ltc ? 2 : 3;
  p.textContent = '$' + (Number(px) || 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  ch.innerHTML = a === 'zro' ? fmtPct(st.zroChange24h) : '';
}
async function loadStats() {
  try {
    S.stats = await api('/stats');
    if (!S.rh) api('/rh/config').then(c => { S.rh = c; }).catch(() => {});
    paintPx();
    liveNum($('#burnPx'), S.stats.burnReserveUsd ?? S.stats.plaunchBurnUsd, fmtUsd);
    fitHeader();
  } catch { /* ignore */ }
}
async function loadMe() {
  try { S.me = await api('/me'); } catch { S.me = null; }
  paintAcct();
  try { if (typeof ltcPaintAddr === 'function' && $('#ltcAddrBox')) ltcPaintAddr(); } catch { /* wallet view not open */ }
}
function paintAcct() {
  const el = $('#acct');
  if (!S.me) {
    el.innerHTML = `<div style="display:flex;gap:8px"><a class="btn ghost" href="#/login">Log in</a><a class="btn hide-xs" href="#/signup">Sign up</a></div>`;
    fitHeader();
    return;
  }
  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center">
      <a class="pill num" href="#/wallet" title="Your balances"><span class="zro-ico">Z</span><b>${fmtZ(S.me.zro)}</b>${B(S.me.eth || '0') > 0n ? `<span class="zro-ico" style="margin-left:4px">Ξ</span><b>${fmtZ(S.me.eth, 4)}</b>` : ''}<span class="mu hide-xs">${fmtUsd((S.me.zroUsd || 0) + (S.me.ethUsd || 0))}</span></a>
      ${S.myHatches && S.myHatches.length ? `<a class="pill bell" href="#/" title="Hatches you follow">🔔<b>${S.myHatches.length}</b></a>` : ''}
      <div class="sw">
        <button class="icon-btn" id="meBtn" style="padding:0;border-radius:50%;width:36px;overflow:hidden">${avatar(S.me.username, S.me.avatar).replace('class="av"', 'class="av" style="width:34px;height:34px;border:0"')}</button>
        <div class="menu" id="meMenu" style="min-width:210px">
          <div class="menu-h">${esc(S.me.username)} ${badgeHTML(S.me.badges)}</div>
          <a class="mi" href="#/u/${encodeURIComponent(S.me.username)}">Profile</a>
          <a class="mi" href="#/wallet">Wallet</a>
          <a class="mi" href="#/create">Create token</a>
          <button class="mi" id="logout">Log out</button>
        </div>
      </div>
    </div>`;
  $('#meBtn').onclick = (e) => { e.stopPropagation(); $('#meMenu').classList.toggle('open'); };
  $('#logout').onclick = async () => { await api('/auth/logout', {}); S.me = null; paintAcct(); location.hash = '#/'; };
  fitHeader();
}
const gradK = (v) => { const g = Number(v) || S.stats?.stellar?.gradUsd || 46000; return '$' + (g >= 10000 ? Math.round(g / 1000) : (g / 1000).toFixed(1).replace(/\.0$/, '')) + 'K'; };
// header must never clip the nav: drop low-priority items, one at a time, until everything fits
function fitHeader() {
  const nav = document.querySelector('.top .nav');
  if (!nav) return;
  const order = ['.app-pill .app-l', '.brand .by', '#appPill', '#zroPill', '#burnPill'];
  order.forEach(sel => document.querySelectorAll(sel).forEach(el => el.classList.remove('fit-hide')));
  const over = () => nav.offsetParent !== null && nav.scrollWidth > nav.clientWidth + 1;
  for (const sel of order) { if (!over()) break; document.querySelectorAll(sel).forEach(el => el.classList.add('fit-hide')); }
}
window.addEventListener('resize', () => { clearTimeout(fitHeader._t); fitHeader._t = setTimeout(fitHeader, 80); });
document.fonts?.ready?.then(() => fitHeader());
// Android app: not out yet
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('#appPill, #appFoot');
  if (!a) return;
  e.preventDefault();
  toast('The Rookery Android app is coming soon. Follow <a href="https://x.com/StinkyPenguinL0" target="_blank" rel="noopener" style="text-decoration:underline">@StinkyPenguinL0</a> for the launch.');
});
// any [data-copy] button copies its value (asset code / issuer on graduated tokens)
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-copy]');
  if (!b) return;
  const v = b.getAttribute('data-copy') || '';
  navigator.clipboard.writeText(v).then(() => toast('Copied')).catch(() => {});
});
function initNet() {
  const set = (n) => {
    S.net = n; localStorage.setItem('pl_net', n);
    $('#netLabel').textContent = netLong(n);
    $$('#netMenu .mi[data-net]').forEach(b => b.classList.toggle('on', b.dataset.net === n));
    paintPx();
  };
  set(S.net);
  window.plSetNet = set;
  $('#netBtn').onclick = (e) => { e.stopPropagation(); $('#netMenu').classList.toggle('open'); };
  $$('#netMenu .mi[data-net]').forEach(b => b.onclick = () => { set(b.dataset.net); $('#netMenu').classList.remove('open'); if (location.hash.startsWith('#/chain')) location.hash = '#/'; else route(); });
  document.addEventListener('click', () => $$('.menu.open').forEach(m => m.classList.remove('open')));
}
function countdown(iso) {
  if (!iso) return 'TBA';
  const d = new Date(iso).getTime() - Date.now();
  if (d <= 0) return 'LIVE';
  const dd = Math.floor(d / 864e5), hh = Math.floor(d % 864e5 / 36e5), mm = Math.floor(d % 36e5 / 6e4);
  return `${dd}d ${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m`;
}

/* ───────── shared bits ───────── */
function cardHTML(m) {
  return `
  <a class="card" href="#/t/${m.id}" data-id="${m.id}">
    ${timg(m)}
    <div class="card-b">
      <div class="card-t"><h3>${esc(m.name)}</h3><span class="sym">$${esc(m.symbol)}</span>${netTag(m.network)}${m.graduated ? (m.network === 'stellar' && m.migrated ? '<span class="tag grad">ON AQUARIUS</span>' : '<span class="tag grad">BONDED</span>') : ''}</div>
      <div class="mu" style="font-size:11.5px">by <b class="tx2">${esc(m.creator)}</b> · ${ago(m.created)} ago</div>
      <div class="desc">${esc(m.description || 'No description yet.')}</div>
      <div class="card-m num"><span class="mu">MC <b class="tx2 c-mc" style="color:var(--tx)">${fmtUsd(m.mcapUsd)}</b></span><span class="c-ch">${fmtPct(m.change24h)}</span></div>
      <div class="prog"><i class="c-bar" style="width:${Math.max(1.5, m.progress)}%"></i></div>
      <div class="card-m mu" style="font-size:11px"><span><span class="c-bond">${m.progress.toFixed(1)}</span>% ${m.network === 'stellar' ? 'to ' + gradK(m.stellar?.gradUsd || 46000) : 'bonded'}</span><span><span class="c-hold">${m.holders}</span> holders · <span class="c-tr">${m.trades}</span> trades</span></div>
    </div>
  </a>`;
}
// update one Explore card in place (numbers tween, nothing re-rendered)
function updateCard(el, m) {
  const q = (c) => el.querySelector(c);
  liveNum(q('.c-mc'), m.mcapUsd, fmtUsd);
  liveText(q('.c-ch'), fmtPct(m.change24h));
  liveNum(q('.c-bond'), m.progress, (v) => v.toFixed(1), false);
  liveNum(q('.c-hold'), m.holders, fmtInt); liveNum(q('.c-tr'), m.trades, fmtInt, false);
  const bar = q('.c-bar'); if (bar) bar.style.width = Math.max(1.5, m.progress) + '%';
  if (m.graduated && !q('.tag.grad')) q('.card-t')?.insertAdjacentHTML('beforeend', '<span class="tag grad">BONDED</span>');
}
// keyed grid: reuse cards, update them in place, and slide moved cards to their new spot (FLIP)
function paintGrid(grid, list, emptyHTML) {
  if (!list.length) { grid.innerHTML = emptyHTML; return; }
  if (grid.querySelector('.skel, .empty')) grid.innerHTML = '';
  const before = new Map();
  for (const el of grid.children) before.set(el.dataset.id, el.getBoundingClientRect());
  const keep = new Set(list.map(m => m.id));
  for (const el of [...grid.children]) if (!keep.has(el.dataset.id)) el.remove();
  const byId = new Map([...grid.children].map(el => [el.dataset.id, el]));
  list.forEach((m, i) => {
    let el = byId.get(m.id);
    if (!el) { el = h(cardHTML(m)); if (before.size) el.classList.add('card-in'); updateCard(el, m); } else updateCard(el, m);
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
  });
  for (const el of grid.children) {
    const r0 = before.get(el.dataset.id); if (!r0) continue;
    const r1 = el.getBoundingClientRect(), dx = r0.left - r1.left, dy = r0.top - r1.top;
    if (!dx && !dy) continue;
    el.style.transition = 'none'; el.style.transform = `translate(${dx}px,${dy}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1)'; el.style.transform = ''; }));
  }
}
/* sortable holdings tables: click a header to sort, click again to flip */
const HOLD_KEYS = { token: x => String(x.symbol || '').toLowerCase(), amount: x => zNum(x.amount || '0'), price: x => Number(x.priceUsd) || 0,
  value: x => Number(x.valueUsd) || 0, rewards: x => zNum(x.pendingRewards || '0'), pnl: x => Number(x.pnlUsd) || 0 };
// signed USD amount coloured by direction, e.g. +$12.40 / −$3.10
const sUsd = (v) => `<span class="${v >= 0 ? 'up' : 'dn'}">${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v || 0))}</span>`;
S.holdSort = S.holdSort || { key: 'value', dir: -1 };
function sortHoldings(rows) {
  const st = S.holdSort, f = HOLD_KEYS[st.key] || HOLD_KEYS.value;
  return [...rows].sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * st.dir; });
}
function thSort(label, key, right = true) {
  const st = S.holdSort, on = st.key === key;
  return `<th class="${right ? 'r ' : ''}sortable${on ? ' on' : ''}" data-sort="${key}">${label}<span class="sort-ar">${on ? (st.dir < 0 ? '↓' : '↑') : '↕'}</span></th>`;
}
function bindSort(root, repaint) {
  root.querySelectorAll('th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.sort, st = S.holdSort;
    if (st.key === k) st.dir = -st.dir; else { st.key = k; st.dir = k === 'token' ? 1 : -1; }
    repaint();
  });
}
// Polling timer. With live=true it becomes a slow safety net (every 15 s) while the live socket is up.
function setTimer(fn, ms, live = false) {
  clearInterval(S.timer); S.lastPoll = Date.now();
  S.timer = setInterval(() => { if (live && Live.up && Date.now() - S.lastPoll < 15000) return; S.lastPoll = Date.now(); fn(); }, ms);
  S.tick = fn;
}

/* ═══════════ LIVE (server push over WebSocket) ═══════════ */
// One socket per tab. Each view says what it wants ('all' or 'm:<id>') and how to react; reconnects with backoff.
const Live = { ws: null, up: false, subs: ['all'], fn: null, retry: 0 };
function liveConnect() {
  if (Live.ws || !('WebSocket' in window)) return;
  let ws;
  try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/ws'); } catch { return; }
  Live.ws = ws;
  ws.onopen = () => { Live.up = true; Live.retry = 0; ws.send(JSON.stringify({ sub: Live.subs })); document.body.classList.add('is-live'); };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === 'trades') return tickerAdd(msg.trades);
    if (msg.t !== 'market') return;
    if (msg.stats) liveStats(msg.stats);
    try { Live.fn?.(msg); } catch (err) { console.warn('live', err); }
  };
  ws.onclose = () => {
    Live.up = false; Live.ws = null; document.body.classList.remove('is-live');
    setTimeout(liveConnect, Math.min(15000, 800 * 2 ** Live.retry++));
  };
  ws.onerror = () => { try { ws.close(); } catch { /* gone */ } };
}
function liveSub(subs, fn) {
  Live.subs = subs; Live.fn = fn || null;
  if (Live.ws?.readyState === 1) Live.ws.send(JSON.stringify({ sub: subs }));
}
setInterval(() => { if (Live.ws?.readyState === 1) Live.ws.send('{"ping":1}'); }, 25000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !Live.ws) liveConnect(); });
/* ═══════════ BADGES ═══════════ */
// Earned on Rookery, never sold. The server decides (per user id); the labels live here.
const BADGES = {
  early:   { i: '🐣', l: 'Early hatcher', t: 'One of the first 500 accounts on Rookery' },
  creator: { i: '🥚', l: 'Hatcher', t: 'Launched at least one token' },
  bonded:  { i: '💎', l: 'Bonded a token', t: 'One of their tokens reached 100% of the curve and opened a pool' },
  diamond: { i: '⚡', l: 'Diamond flipper', t: '25 or more trades' },
};
const badgeHTML = (ids, labels = false) => (ids || []).filter(id => BADGES[id])
  .map(id => `<span class="bdg ${id}" title="${esc(BADGES[id].t)}">${BADGES[id].i}${labels ? ' ' + esc(BADGES[id].l) : ''}</span>`).join('');

/* ═══════════ HATCHING SOON ═══════════ */
// A creator announces a token with a countdown; people tap "Notify me" and get a bell + toast when it goes live.
S.hatches = S.hatches || []; S.myHatches = S.myHatches || [];
const cdText = (ms) => {
  if (ms <= 0) return 'Hatching now';
  const t = Math.floor(ms / 1000), d = Math.floor(t / 86400), hh = Math.floor((t % 86400) / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return d ? `${d}d ${p(hh)}h ${p(mm)}m` : `${p(hh)}:${p(mm)}:${p(ss)}`;
};
setInterval(() => document.querySelectorAll('[data-cd]').forEach(el => {
  if (!el.offsetParent) return;
  const t = +el.dataset.cd; el.textContent = t ? cdText(t - Date.now()) : 'Hatching now';
  el.classList.toggle('soon', !!t && t - Date.now() < 15 * 60e3);
}), 1000);
async function loadHatches() {
  try { S.hatches = (await api('/hatches')).hatches || []; } catch { S.hatches = []; }
  S.myHatches = S.hatches.filter(h => h.subscribed || h.isMine);
  hatchNotify();
  paintHatches(); paintAcct();
}
// one toast per hatch when something you follow goes live
function hatchNotify() {
  let seen = {}; try { seen = JSON.parse(localStorage.getItem('pl_hatch_seen') || '{}'); } catch { seen = {}; }
  let changed = false;
  for (const h of S.hatches) {
    if (!h.subscribed || h.status !== 'live' || seen[h.id]) continue;
    seen[h.id] = Date.now(); changed = true;
    toast(`🔔 <b>$${esc(h.symbol)}</b> is hatching now${h.isMine ? ' — go launch it' : ' — be early'}!`);
  }
  if (changed) localStorage.setItem('pl_hatch_seen', JSON.stringify(seen));
}
const hatchCard = (h) => {
  const live = h.status === 'live';
  const img = h.image ? `<img src="${esc(h.image)}" alt="">` : esc((h.symbol || '?').slice(0, 2).toUpperCase());
  return `<div class="hc ${live ? 'live' : ''}">
    <div class="hc-h"><span class="hc-ico">${img}</span><div class="hc-n"><b>$${esc(h.symbol)}</b><span class="mu">${esc(h.name)}</span></div><span class="tag ${h.network}">${netName(h.network).toUpperCase()}</span></div>
    <div class="hc-cd" data-cd="${live ? 0 : h.launchAt}">${live ? 'Hatching now' : cdText(h.launchAt - Date.now())}</div>
    <div class="hc-f"><span class="mu hc-w">👥 <b>${h.waiting}</b> waiting</span>
      ${live ? (h.marketId ? `<a class="btn sm up" href="#/t/${esc(h.marketId)}">Trade now ↗</a>` : '<span class="hc-live">● LIVE</span>')
        : `<button class="btn sm ${h.subscribed ? 'ghost on' : ''}" data-sub="${esc(h.id)}">${h.subscribed ? '✓ Notified' : '🔔 Notify me'}</button>`}</div>
    ${h.isMine ? `<div class="hc-mine">${live ? `<a class="btn sm up" href="#/create/${esc(h.id)}">Hatch it now ↗</a>` : '<span class="mu" style="font-size:11.5px">Your hatch</span>'}<button class="btn sm ghost" data-hcancel="${esc(h.id)}">Cancel</button></div>` : ''}
  </div>`;
};
function paintHatches() {
  const el = $('#hatchStrip'); if (!el) return;
  const list = S.hatches || [];
  el.innerHTML = `<div class="hatch-head"><div><span class="mono mu">Hatching soon</span>
      <p class="mu">Announce a token with a countdown and collect a crowd before it goes live.</p></div>
    <button class="btn ghost" id="announceBtn">＋ Announce a hatch</button></div>
    ${list.length ? `<div class="hatch-row">${list.map(hatchCard).join('')}</div>`
      : '<div class="hatch-empty mu">Nothing on the nest yet — be the first to announce one.</div>'}`;
  $('#announceBtn').onclick = openAnnounce;
  $$('[data-sub]').forEach(b => b.onclick = async () => {
    if (!S.me) return needLogin();
    try {
      const r = await api('/hatch/sub', { id: b.dataset.sub });
      toast(r.subscribed ? '🔔 You are on the list. We will ping you when it hatches.' : 'Notifications off for this hatch.');
      await loadHatches();
    } catch (e) { toast(esc(e.message), 'bad'); }
  });
  $$('[data-hcancel]').forEach(b => b.onclick = async () => {
    try { await api('/hatch/cancel', { id: b.dataset.hcancel }); toast('Hatch cancelled'); await loadHatches(); }
    catch (e) { toast(esc(e.message), 'bad'); }
  });
}
function openAnnounce() {
  if (!S.me) return needLogin();
  const at = (mins) => { const d = new Date(Date.now() + mins * 60e3); d.setSeconds(0, 0); const off = d.getTime() - d.getTimezoneOffset() * 60e3; return new Date(off).toISOString().slice(0, 16); };
  const md = h(`<div class="modal-bg"><div class="modal" style="max-width:540px">
    <h3 style="font-size:22px;letter-spacing:-.03em;margin-bottom:6px">Announce a hatch 🥚</h3>
    <p class="mu" style="font-size:13px;margin-bottom:16px">People see the countdown, tap “Notify me”, and get pinged the moment it goes live. Launching later fills this in for you.</p>
    <div class="f2"><div class="f"><label>Name</label><input class="inp" id="hName" maxlength="32" placeholder="Stinky Penguin"></div>
      <div class="f"><label>Ticker</label><input class="inp" id="hSym" maxlength="12" placeholder="PENGU"></div></div>
    <div class="f"><label>Network</label><select class="inp" id="hNet"><option value="zero">Zero · by LayerZero</option><option value="giwa">GIWA · by Upbit</option><option value="robinhood">Robinhood Chain · live</option></select></div>
    <div class="f"><label>Description (optional)</label><textarea class="inp" id="hDesc" maxlength="300" placeholder="One line about why this one matters"></textarea></div>
    <div class="f"><label>Hatches in</label>
      <div class="choice" id="hQuick">${[['1 hour', 60], ['6 hours', 360], ['24 hours', 1440], ['3 days', 4320]].map(([l, m]) => `<button class="opt hq" data-m="${m}"><div><b>${l}</b></div></button>`).join('')}</div></div>
    <div class="f"><label>Exact time</label><input class="inp" type="datetime-local" id="hAt" value="${at(1440)}"></div>
    <div class="err" id="hErr"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" id="hX">Cancel</button><button class="btn" id="hGo">Announce it</button></div>
  </div></div>`);
  document.body.append(md);
  const close = () => md.remove();
  md.onclick = (e) => { if (e.target === md) close(); };
  $('#hX').onclick = close;
  $$('#hQuick .hq').forEach(b => b.onclick = () => { $('#hAt').value = at(+b.dataset.m); $$('#hQuick .hq').forEach(x => x.classList.toggle('on', x === b)); });
  $('#hGo').onclick = async () => {
    $('#hErr').textContent = '';
    const launchAt = new Date($('#hAt').value).getTime();
    try {
      $('#hGo').disabled = true;
      await api('/hatch', { name: $('#hName').value.trim(), symbol: $('#hSym').value.trim(), network: $('#hNet').value,
        description: $('#hDesc').value.trim(), launchAt });
      close(); toast('🥚 Announced. Share the link and the countdown does the work.'); await loadHatches();
    } catch (e) { $('#hErr').textContent = e.message; }
    finally { $('#hGo').disabled = false; }
  };
}

/* ═══════════ LIVE TICKER ═══════════ */
// Continuous right-to-left strip of trades. Items that scroll out on the left are recycled to the end;
// a new live trade is slotted in just past the right edge, so it slides into view without any jump.
const Ticker = { track: null, view: null, x: 0, last: 0, paused: false, speed: 46, gap: 30, n: 0 };
function tickItem(t) {
  const up = t.side !== 'sell';
  return h(`<a class="tk-i" href="#/t/${esc(t.id)}"><i class="tk-d ${up ? 'up' : 'dn'}"></i><b>${esc(t.user || 'anon')}</b><span class="mu">${up ? 'bought' : 'sold'}</span><b class="${up ? 'up' : 'dn'}">${fmtUsd(t.usd)}</b><span class="mu">of</span><b>$${esc(t.symbol)}</b></a>`);
}
async function tickerInit() {
  Ticker.track = $('#tkTrack'); Ticker.view = document.querySelector('#ticker .tk-view');
  if (!Ticker.track) return;
  try {
    const { trades } = await api('/feed');
    trades.slice(0, 30).forEach(t => Ticker.track.append(tickItem({ side: t.side, usd: zNum(t.zro) * t.usd, user: t.username, symbol: t.symbol, id: t.market })));
  } catch { /* the strip fills from live trades */ }
  tickerFill();
  const tk = $('#ticker');
  tk.onmouseenter = () => { Ticker.paused = true; }; tk.onmouseleave = () => { Ticker.paused = false; };
  requestAnimationFrame(tickerFrame);
}
// make sure the strip is longer than the screen so the loop never shows a hole
function tickerFill() {
  const tr = Ticker.track, base = [...tr.children];
  if (!base.length) return;
  let guard = 0;
  while (tr.scrollWidth < Ticker.view.clientWidth * 2 + 400 && guard++ < 40) base.forEach(el => tr.append(el.cloneNode(true)));
}
function tickerFrame(ts) {
  const dt = Ticker.last ? Math.min(64, ts - Ticker.last) : 0; Ticker.last = ts;
  const tr = Ticker.track;
  if (tr.firstElementChild && !Ticker.paused && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Ticker.x -= (Ticker.speed * dt) / 1000;
    const f = tr.firstElementChild, w = f.offsetWidth + Ticker.gap;
    if (-Ticker.x >= w) { Ticker.x += w; tr.append(f); }
    tr.style.transform = `translate3d(${Ticker.x.toFixed(2)}px,0,0)`;
  }
  requestAnimationFrame(tickerFrame);
}
function tickerAdd(trades) {
  const tr = Ticker.track; if (!tr || !trades?.length) return;
  const edge = Ticker.view.clientWidth - Ticker.x;          // track coordinate of the right edge of the screen
  let ref = [...tr.children].find(el => el.offsetLeft > edge) || null;
  for (const t of trades) {
    const el = tickItem(t); el.classList.add('tk-new');
    tr.insertBefore(el, ref);
  }
  // keep the strip bounded: drop off-screen items from the far end
  while (tr.children.length > 70) { const l = tr.lastElementChild; if (l.offsetLeft > edge + 200) l.remove(); else break; }
  if (tr.children.length === trades.length) tickerFill();
}

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
const usd2 = (v) => Math.abs(v) >= 1000 ? fmtUsd(v) : '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// footer: handle on the left, site right after it (measured in the handle's own font)
function footer(g, D, x, y, userCol, urlCol, gap = 28) {
  g.fillStyle = userCol; g.font = '600 20px Inter'; g.fillText(D.user, x, y);
  const w = g.measureText(D.user).width;
  g.fillStyle = urlCol; g.font = `500 16px ${MONO}`; g.fillText('rookery.stinkypenguin.xyz', x + w + gap, y - 1);
}
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
  footer(g, D, 64, CH - 48, '#fff', '#8b8b93', 36);
  return c;
}

/* 2 · Minimal: paper-white, black type, one huge number, hairlines. Colour only on the direction mark. */
async function drawMinimal(o) {
  const [c, g] = newCanvas(), D = cardData(o), col = D.win ? '#12a86a' : '#e0424b';
  const INK = '#0b0b0c', MUTED = '#86867f', LINE = '#d9d9d3';
  g.fillStyle = '#f4f4f1'; g.fillRect(0, 0, CW, CH);
  // faint penguin mark as a watermark (black on white source, multiplied away)
  const mark = await loadImg('/assets/penguin/mark.webp');
  if (mark) { g.save(); g.globalAlpha = .07; g.globalCompositeOperation = 'multiply'; const mh = 300, mw = mark.width * mh / mark.height; g.drawImage(mark, CW - mw - 72, 160, mw, mh); g.restore(); }
  await brand(g, 72, 60, false);
  g.fillStyle = MUTED; g.font = `500 15px ${MONO}`; g.textAlign = 'right'; g.fillText(D.date, CW - 72, 88); g.textAlign = 'left';
  g.fillStyle = LINE; g.fillRect(72, 132, CW - 144, 1);
  // title
  if (o.kind === 'token') { await tokenBadge(g, o, 72, 164, 22, false); g.fillStyle = INK; g.font = '700 34px Inter'; g.fillText(D.title, 128, 198); }
  else { g.fillStyle = INK; g.font = '700 34px Inter'; g.fillText(D.title, 72, 198); }
  if (o.kind === 'token') { g.font = '700 34px Inter'; const tw = g.measureText(D.title).width; g.fillStyle = MUTED; g.font = '500 17px Inter'; g.fillText('  ' + D.sub, 128 + tw, 197); }
  // the number
  g.fillStyle = INK;
  const fs = fitFont(g, D.big, 800, 196, 820, 90);
  const by = 224 + fs * .8;
  g.fillText(D.big, 62, by);
  // direction row under the number: coloured triangle + the dollar change
  const ty = by + 30;
  g.fillStyle = col; g.beginPath();
  if (D.win) { g.moveTo(72, ty + 22); g.lineTo(85, ty); g.lineTo(98, ty + 22); } else { g.moveTo(72, ty); g.lineTo(98, ty); g.lineTo(85, ty + 22); }
  g.closePath(); g.fill();
  g.font = '700 28px Inter'; g.fillText(D.pctTxt ? D.usdTxt : (D.win ? 'in profit' : 'down bad'), 112, ty + 22);
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
  g.fillStyle = MUTED; g.font = `500 15px ${MONO}`; g.textAlign = 'right'; g.fillText('rookery.stinkypenguin.xyz', CW - 72, CH - 45); g.textAlign = 'left';
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
    g.drawImage(t, ax, ay);
  }
  // keep the text column readable over the grid
  const back = g.createLinearGradient(0, 0, 760, 0); back.addColorStop(0, 'rgba(5,3,11,.92)'); back.addColorStop(.75, 'rgba(5,3,11,.6)'); back.addColorStop(1, 'rgba(5,3,11,0)');
  g.fillStyle = back; g.fillRect(0, 0, 760, CH);
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
  footer(g, D, 64, CH - 46, '#fff', 'rgba(255,255,255,.6)', 32);
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
  const tt = `${tw ? '+' : '−'}${usd2(Math.abs(total))}`; fitFont(g, tt, 800, 60, 420, 34); g.fillText(tt, CW - 64, 168); g.shadowBlur = 0;
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
    g.fillStyle = '#8b8b93'; g.font = `500 15px ${MONO}`; g.fillText(usd2(r.valueUsd || 0), 360, mid + 7);
    // bar centred on a zero line: gains to the right, losses to the left
    const z = barX + barW * .35, len = (Math.abs(r.pnlUsd) / maxAbs) * (up ? barW * .65 : barW * .35);
    g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(z, mid - 14, 1, 28);
    g.fillStyle = up ? UP : DN; g.beginPath(); g.roundRect(up ? z + 2 : z - len - 1, mid - 7, Math.max(3, len), 14, 7); g.fill();
    g.textAlign = 'right';
    g.fillStyle = up ? UP : DN; g.font = '800 22px Inter'; g.fillText(`${up ? '+' : '−'}${usd2(Math.abs(r.pnlUsd))}`, CW - 180, mid + 8);
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
// big call-to-action with an animated laser frame
const laserBtn = (attrs, label = 'Share your PnL') => `<button class="laser-btn" ${attrs} onclick="event.stopPropagation()"><span>${label} <b>↗</b></span></button>`;
const shareBtn = (attrs) => `<button class="share-b" ${attrs} title="Share this PnL" onclick="event.stopPropagation()">Share ↗</button>`;

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
// header + home numbers that come with every push
function liveStats(st) {
  if (!S.stats) return;
  Object.assign(S.stats, st);
  liveNum($('#burnPx'), st.burnReserveUsd, fmtUsd);
  liveNum($('#sVol'), st.volumeUsd, fmtUsd); liveNum($('#sTok'), st.markets, fmtInt); liveNum($('#sTr'), st.traders, fmtInt);
  liveNum($('#sBurn'), st.burnReserveUsd, fmtUsd); liveNum($('#sBurn2'), st.burnReserveUsd, fmtUsd);
}
const fmtInt = (v) => Math.round(v).toLocaleString('en-US');
// Smooth number change: tween from the old value to the new one and flash the cell up/down.
function liveNum(el, value, fmt, flash = true) {
  if (!el || value === undefined || value === null || !isFinite(value)) return;
  const old = el._v; el._v = value;
  if (old === undefined || old === value || !isFinite(old)) { el.textContent = fmt(value); return; }
  cancelAnimationFrame(el._raf);
  const t0 = performance.now(), D = 520;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(k < 1 ? old + (value - old) * e : value);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
  if (flash) { el.classList.remove('flash-up', 'flash-dn'); void el.offsetWidth; el.classList.add(value > old ? 'flash-up' : 'flash-dn'); }
}
// set text/html only when it changed (no needless repaint), optional flash
function liveText(el, html, flash = false) {
  if (!el || el._h === html) return;
  const first = el._h === undefined; el._h = html; el.innerHTML = html;
  if (flash && !first) { el.classList.remove('flash-up', 'flash-dn'); void el.offsetWidth; el.classList.add('flash-up'); }
}
// browsers throttle timers to ~1/minute in hidden tabs; refresh the moment the tab is visible again
const refreshNow = () => { try { S.tick?.(); } catch (e) { /* view already gone */ } };
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNow(); });
window.addEventListener('focus', refreshNow);
const needLogin = () => { toast('Log in or create an account first', 'bad'); location.hash = '#/login'; };

/* ═══════════ EXPLORE ═══════════ */
async function viewExplore() {
  document.title = 'Rookery — the Stinky Penguin launchpad';
  const st = S.stats || {};
  const nets = st.networks || {};
  const nt = st.netTokens || {};
  app.innerHTML = `
  <section class="wrap hero">
    <div class="hero-grid">
      <div>
        <span class="kicker"><img src="/assets/penguin/mark.webp" alt="" style="width:12px;height:17px;filter:invert(1)">The Stinky Penguin launchpad · trade with ZRO, ETH or XLM</span>
        <h1>Hatch before<br><span>the chain does.</span></h1>
        <p class="lead">Create and trade tokens on a bonding curve. Zero and GIWA tokens migrate 1:1 the day mainnet opens, Robinhood Chain tokens trade live in ETH; Stellar tokens graduate on-chain into Aquarius at ${gradK()} with the LP burned.</p>
        <div class="hero-cta"><a class="btn lg" href="#/create">Create a token</a><a class="btn lg ghost" href="#/docs">How it works</a></div>
      </div>
      <div class="nets">
        <div class="net-card"><span class="net-ico">Ø</span><div><h4>Zero</h4><span class="mu" style="font-size:12.5px">by LayerZero · mainnet 30.11</span><span class="net-meta"><i class="dotp"></i>Pre-market live · <b>${nt.zero || 0}</b> tokens</span></div>
          <div class="cd"><b>LIVE</b><span class="mono mu">Pre-market · mainnet in <i id="cdZero">${countdown(nets.zero?.launchAt)}</i></span></div></div>
        <div class="net-card"><span class="net-ico giwa"><img src="/assets/giwa.png" alt="GIWA"></span><div><h4>GIWA</h4><span class="mu" style="font-size:12.5px">by Upbit · Ethereum L2</span><span class="net-meta"><i class="dotp"></i>Pre-market live · <b>${nt.giwa || 0}</b> tokens</span></div>
          <div class="cd"><b>LIVE</b><span class="mono mu">Pre-market · testnet</span></div></div>
        <a class="net-card" href="#/" onclick="event.preventDefault();document.querySelector('#netMenu .mi[data-net=litvm]')?.click()"><span class="net-ico ltc"><img src="/assets/chains/litecoin.svg" alt="LitVM"></span><div><h4>LitVM</h4><span class="mu" style="font-size:12.5px">by Litecoin · zkLTC pairs · 1:1 at mainnet</span><span class="net-meta"><i class="dotp live"></i>Pre-market live · <b>${nt.litvm || 0}</b> tokens</span></div>
          <div class="cd"><b>LIVE</b><span class="mono mu">Premarket · zkLTC</span></div></a>
        <a class="net-card" href="#/" onclick="event.preventDefault();document.querySelector('#netMenu .mi[data-net=robinhood]')?.click()"><span class="net-ico rh"><img src="/assets/chains/robinhood.png" alt="Robinhood Chain"></span><div><h4>Robinhood Chain</h4><span class="mu" style="font-size:12.5px">by Robinhood · ETH &amp; stock pairs · Uniswap V2</span><span class="net-meta"><i class="dotp live"></i>Pre-market live · on-chain · <b>${nt.robinhood || 0}</b> tokens</span></div>
          <div class="cd"><b>LIVE</b><span class="mono mu">Premarket · on-chain</span></div></a>
        <a class="net-card" href="#/" onclick="event.preventDefault();document.querySelector('#netMenu .mi[data-net=stellar]')?.click()"><span class="net-ico st"><img src="/assets/chains/stellar.svg" alt="Stellar"></span><div><h4>Stellar</h4><span class="mu" style="font-size:12.5px">by SDF · graduates to Aquarius at ${gradK()}</span><span class="net-meta"><i class="dotp live"></i>Live on-chain · <b>${nt.stellar || 0}</b> tokens</span></div>
          <div class="cd"><b>LIVE</b><span class="mono mu">XLM · on-chain</span></div></a>
      </div>
    </div>
    <div class="stats">
      <div><span class="mono mu">Volume</span><b id="sVol">${fmtUsd(st.volumeUsd)}</b></div>
      <div><span class="mono mu">Tokens</span><b id="sTok">${st.markets ?? '—'}</b></div>
      <div><span class="mono mu">Traders</span><b id="sTr">${st.traders ?? '—'}</b></div>
      <div><span class="mono mu">ZRO price</span><b>$${(st.zroUsd || 0).toFixed(3)}</b></div>
      <div class="burn"><span class="mono mu">$臭企鹅 burn reserve</span><b><img src="/assets/penguin/mark.webp" alt="" style="width:14px;height:20px;filter:invert(1)"><span id="sBurn">${fmtUsd(st.burnReserveUsd ?? st.plaunchBurnUsd)}</span></b></div>
    </div>
  </section>
  <section class="wrap">
    <div class="peng">
      <img src="/assets/penguin/allin.webp" alt="Stinky Penguin going all-in">
      <div class="peng-b">
        <span class="mono mu">Powered by the penguin</span>
        <h2>Every trade feeds<br><span>the penguin.</span></h2>
        <p>Rookery is the launchpad of Stinky Penguin. <b style="color:var(--tx)">0.5% of every buy and sell</b> on any token here goes to buying and burning <b style="color:var(--tx)">$臭企鹅</b>. More launches, more volume, fewer penguins.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="https://stinkypenguin.xyz" target="_blank" rel="noopener">Meet the penguin</a><a class="btn ghost" href="#/docs">Burn mechanics</a></div>
        <span class="mono mu">Burn reserve now · <b style="color:var(--tx)" id="sBurn2">${fmtUsd(st.burnReserveUsd ?? st.plaunchBurnUsd)}</b></span>
      </div>
    </div>
  </section>
  <section class="wrap" style="padding-bottom:40px">
    <div id="hatchStrip"></div>
    <div class="seg netseg" id="netseg" style="margin-bottom:12px">
      <button data-n="" class="${S.net ? '' : 'on'}">All networks</button>
      <button data-n="zero" class="${S.net === 'zero' ? 'on' : ''}">Zero</button>
      <button data-n="giwa" class="${S.net === 'giwa' ? 'on' : ''}">GIWA</button>
      <button data-n="stellar" class="${S.net === 'stellar' ? 'on' : ''}">Stellar</button>
      <button data-n="robinhood" class="${S.net === 'robinhood' ? 'on' : ''}">Robinhood</button>
      <button data-n="litvm" class="${S.net === 'litvm' ? 'on' : ''}">LitVM</button>
    </div>
    <div class="bar-row">
      <div class="seg" id="sort">
        <button data-s="trending" class="on">Trending</button><button data-s="new">New</button>
        <button data-s="mcap">Market cap</button><button data-s="bond">About to bond</button>
      </div>
      <label class="search"><span class="mu">⌕</span><input id="q" placeholder="Search name or ticker"></label>
    </div>
    <div id="koth"></div>
    <div class="grid" id="grid"><div class="skel" style="height:116px"></div><div class="skel" style="height:116px"></div><div class="skel" style="height:116px"></div></div>
  </section>`;

  let sort = 'trending', q = '', markets = [];
  const paint = () => {
    let list = markets.filter(m => !q || (m.name + ' ' + m.symbol).toLowerCase().includes(q));
    const by = { trending: (a, b) => (b.lastTrade || b.created) - (a.lastTrade || a.created), new: (a, b) => b.created - a.created, mcap: (a, b) => b.mcapUsd - a.mcapUsd, bond: (a, b) => b.progress - a.progress };
    list.sort(by[sort]);
    const king = [...markets].filter(m => !m.graduated).sort((a, b) => b.progress - a.progress)[0];
    const kKey = king ? `${king.id}|${king.progress.toFixed(1)}|${king.holders}|${Math.round(king.mcapUsd)}|${king.change24h.toFixed(1)}` : '';
    if ($('#koth')._k !== kKey) { $('#koth')._k = kKey;
    $('#koth').innerHTML = king && king.progress > 0 ? `
      <a class="koth" href="#/t/${king.id}">
        ${timg(king)}
        <div><span class="mono mu">King of the hill · ${netName(king.network)}</span>
          <h3>${esc(king.name)} <span class="mu" style="font-size:16px">$${esc(king.symbol)}</span></h3>
          <div class="prog big" style="margin:12px 0 8px;max-width:520px"><i style="width:${king.progress}%"></i></div>
          <span class="mu" style="font-size:12.5px">${king.progress.toFixed(1)}% ${king.network === 'stellar' ? 'to ' + gradK(king.stellar?.gradUsd || 46000) : 'bonded'} · ${king.holders} holders</span></div>
        <div style="text-align:right"><span class="mono mu">Market cap</span><div class="price-xl">${fmtUsd(king.mcapUsd)}</div>${fmtPct(king.change24h)}</div>
      </a>` : ''; }
    paintGrid($('#grid'), list,
      `<div class="empty" style="grid-column:1/-1"><img src="/assets/penguin/stay.webp" alt="">The rookery is quiet${S.net ? ' on this network' : ''}. <a href="#/create" style="text-decoration:underline;color:var(--tx)">Hatch the first token</a>.</div>`);
  };
  $$('#sort button').forEach(b => b.onclick = () => { sort = b.dataset.s; $$('#sort button').forEach(x => x.classList.toggle('on', x === b)); paint(); });
  $$('#netseg button').forEach(b => b.onclick = () => { window.plSetNet(b.dataset.n); route(); });
  $('#q').oninput = (e) => { q = e.target.value.toLowerCase().trim(); paint(); };
  const load = async () => { markets = (await api('/markets' + (S.net ? `?network=${S.net}` : ''))).markets; paint(); };
  await load();
  paintHatches();
  liveSub(['all'], (msg) => {
    const nm = msg.market; if (S.net && nm.network !== S.net) return;
    const i = markets.findIndex(x => x.id === nm.id);
    if (i >= 0) markets[i] = nm; else markets.unshift(nm);
    paint();
  });
  setTimer(() => { load(); loadHatches(); const cd = $('#cdZero'); if (cd) cd.textContent = countdown(S.stats?.networks?.zero?.launchAt); }, 4000, true);
}

/* ═══════════ TRADING TERMINAL ═══════════ */
async function viewTrading() {
  document.title = 'Trading — Rookery';
  app.innerHTML = `
  <section class="wrap trade-layout">
    <div class="panel">
      <div class="panel-h"><h3>Markets</h3><div class="seg" id="tsort">
        <button data-s="vol" class="on">Volume</button><button data-s="ch">24h</button><button data-s="mcap">MC</button><button data-s="new">New</button></div></div>
      <p class="mu" style="font-size:12.5px;line-height:1.6;margin:0 0 10px">LitVM and the other pre-market networks hold no on-chain funds yet: their tokens trade on the Rookery ledger, so the table below covers ZRO, ETH and XLM. LTC has no custody wallet yet either: it lives in the bridge, not in the ledger.</p>
      <div style="overflow:auto"><table class="tbl" id="mt"><thead><tr>
        <th>Token</th><th>Network</th><th class="r">Price</th><th class="r">5m</th><th class="r">1h</th><th class="r">24h</th>
        <th class="r">Market cap</th><th class="r">Volume</th><th class="r">Holders</th><th class="r">Bonded</th></tr></thead><tbody></tbody></table></div>
    </div>
    <div class="panel"><div class="panel-h"><h3>Live trades</h3><span class="dot live"></span></div><div class="feed" id="feed"></div></div>
  </section>`;
  let sort = 'vol', seen = new Set(), first = true;
  const by = { vol: (a, b) => b.volumeUsd - a.volumeUsd, ch: (a, b) => b.change24h - a.change24h, mcap: (a, b) => b.mcapUsd - a.mcapUsd, new: (a, b) => b.created - a.created };
  $$('#tsort button').forEach(b => b.onclick = () => { sort = b.dataset.s; $$('#tsort button').forEach(x => x.classList.toggle('on', x === b)); load(); });
  const load = async () => {
    const [{ markets }, { trades }] = await Promise.all([api('/markets' + (S.net ? `?network=${S.net}` : '')), api('/feed')]);
    markets.sort(by[sort]);
    $('#mt tbody').innerHTML = markets.length ? markets.map(m => `
      <tr class="click" data-id="${m.id}">
        <td><div class="tok-cell">${timg(m)}<div><b>${esc(m.symbol)}</b><div class="mu" style="font-size:11.5px">${esc(m.name)}</div></div></div></td>
        <td>${netTag(m.network)}</td><td class="r">${fmtUsd(m.priceUsd)}</td>
        <td class="r">${fmtPct(m.change5m)}</td><td class="r">${fmtPct(m.change1h)}</td><td class="r">${fmtPct(m.change24h)}</td>
        <td class="r">${fmtUsd(m.mcapUsd)}</td><td class="r">${fmtUsd(m.volumeUsd)}</td><td class="r">${m.holders}</td>
        <td class="r"><div style="display:flex;align-items:center;gap:8px;justify-content:flex-end"><div class="prog" style="width:60px"><i style="width:${m.progress}%"></i></div>${m.progress.toFixed(0)}%</div></td>
      </tr>`).join('') : `<tr><td colspan="10"><div class="empty" style="border:0">No markets yet.</div></td></tr>`;
    $$('#mt tr.click').forEach(r => r.onclick = () => (location.hash = `#/t/${r.dataset.id}`));
    $('#feed').innerHTML = trades.length ? trades.map(t => {
      const key = `${t.ts}${t.market}${t.zro}`; const isNew = !first && !seen.has(key); seen.add(key);
      return `<a class="fi ${isNew ? 'new' : ''}" href="#/t/${t.market}"><span class="side ${t.side === 'buy' ? 'up' : 'dn'}">${t.side.toUpperCase()}</span>
        <span><b>${fmtUsd(zNum(t.zro) * t.usd)}</b> <span class="mu">${esc(t.symbol)}</span></span><span class="mu">${esc(t.username || '')}</span><span class="tm">${ago(t.ts)}</span></a>`;
    }).join('') : '<div class="empty" style="border:0;margin:14px">No trades yet.</div>';
    first = false;
  };
  await load();
  liveSub(['all'], debounce(load, 250));
  setTimer(load, 4000, true);
}

/* ═══════════ TOKEN PAGE ═══════════ */
async function viewToken(id) {
  let d;
  try { d = await api('/market/' + id); } catch (e) { app.innerHTML = `<div class="wrap page"><div class="empty">${esc(e.message)}</div></div>`; return; }
  let m = d.market;
  document.title = `${m.symbol} ${fmtUsd(m.priceUsd)} — Rookery`;
  let side = 'buy', ival = 60, tab = 'trades';
  const Q = m.quote || 'ZRO', QA = qaOf(Q);                                 // the market's own currency
  let pay = localStorage.getItem('pl_pay_' + QA) || QA;                  // what the user pays / receives in
  if (!ASSET[pay] || QA === 'xlm' || pay === 'xlm') pay = QA;
  if (QA === 'zltc' && !['eth', 'ltc', 'zltc'].includes(pay)) pay = 'eth';          // Stellar tokens trade only in XLM
  S.quickEth = S.quickEth || localStorage.getItem('pl_quick_eth') || '0.005';

  app.innerHTML = `
  <section class="wrap token">
    <div class="tmain">
      ${(() => { const back = sessionStorage.getItem('termBack') || (m.network === 'zero' || m.network === 'giwa' ? '#/terminal/' + m.network : ''); return back ? `<a class="term-backbtn" href="${esc(back)}">← Back to Terminal</a>` : ''; })()}
      <div class="th">
        ${timg(m)}
        <div>
          <h1>${esc(m.name)} <span class="mu" style="font-size:18px;font-weight:600">$${esc(m.symbol)}</span></h1>
          <div class="th-sub">${netTag(m.network)}${m.network === 'stellar' ? (m.migrated
            ? '<span class="tag onchain">ON-CHAIN · AQUARIUS</span>'
            : m.stellar?.job ? '<span class="tag pm">GRADUATING TO AQUARIUS…</span>'
            : m.stellar?.issuer ? `<span class="tag onchain">ON STELLAR · LP AT ${fmtUsd(m.stellar?.gradUsd || 46000)}</span>`
            : `<span class="tag pm">ISSUING ON STELLAR…</span>`) : ''}<span>Pair: <b>${esc(m.symbol)}/${m.quote || 'ZRO'}</b></span><span class="mu">·</span>
            <span>by <a href="#/u/${encodeURIComponent(m.creator)}" style="text-decoration:underline">${esc(m.creator)}</a></span><span class="mu">· ${ago(m.created)} ago</span></div>
        </div>
        <div class="socials">
          ${m.x ? `<a href="${esc(m.x)}" target="_blank" rel="noopener">𝕏</a>` : ''}
          ${m.tg ? `<a href="${esc(m.tg)}" target="_blank" rel="noopener">Telegram</a>` : ''}
          ${m.web ? `<a href="${esc(m.web)}" target="_blank" rel="noopener">Website</a>` : ''}
        </div>
      </div>
      <div class="kpis" id="kpis"></div>
      <div class="panel tchart">
        <div class="chart-top">
          <div><span class="mono mu">Price · USD</span><div style="display:flex;align-items:baseline;gap:10px"><span class="price-xl" id="px"></span><span id="pxch"></span></div></div>
          <div class="ivals" id="ivals"><button data-i="60" class="on">1m</button><button data-i="300">5m</button><button data-i="900">15m</button><button data-i="3600">1h</button></div>
        </div>
        <div class="chart-wrap"><div id="chart"></div></div>
      </div>
      <div class="panel ttabs" style="margin-top:14px">
        <div class="tabs-h" id="tabs">
          <button data-t="trades" class="on">Trades<span class="cnt" id="cTrades"></span></button>
          <button data-t="holders">Holders<span class="cnt" id="cHolders"></span></button>
          <button data-t="comments">Comments<span class="cnt" id="cCom"></span></button>
          <button data-t="about">About</button>
        </div>
        <div id="tabBody"></div>
      </div>
    </div>

    <aside class="tb">
      ${m.network === 'stellar' && !m.migrated && !m.stellar?.job && m.stellar?.issuer ? `<div class="panel pb">
        <span class="mono mu">On Stellar since launch</span>
        <div class="st-asset" style="margin-top:10px">
          <div class="kv"><span>Asset code</span><b>${esc(m.stellar.code)}</b><button class="mini" data-copy="${esc(m.stellar.code)}">Copy</button></div>
          <div class="kv"><span>Issuer</span><b class="mono" style="font-size:11px;letter-spacing:0">${esc(m.stellar.issuer)}</b><button class="mini" data-copy="${esc(m.stellar.issuer)}">Copy</button></div>
        </div>
        <p class="mu" style="font-size:11.5px;line-height:1.55;margin:0">${S.stats?.stellarSendNow
          ? `Buy with a Stellar wallet and the tokens land in that wallet right after your buy. No pool can open before ${fmtUsd(m.stellar?.gradUsd || 46000)}: until graduation the token can sit in wallets but not in contracts, so there is one price, the curve.`
          : `The token exists on Stellar from launch and the issuer stays open until graduation. Add the trustline now — 0.5 XLM reserve — so you can withdraw the moment the Aquarius pool opens at ${fmtUsd(m.stellar?.gradUsd || 46000)}.`}</p>
        <div id="stWal"></div>
      </div>` : ''}
      ${m.network === 'stellar' && (m.migrated || m.stellar?.job) ? `<div class="panel pb st-grad">
        <span class="net-ico st" style="width:40px;height:40px"><img src="/assets/chains/stellar.svg" alt=""></span>
        <h3 style="font-size:16px;margin:12px 0 6px">${m.migrated ? 'Trading on Aquarius' : 'Graduating to Aquarius…'}</h3>
        <p class="mu" style="font-size:13px;line-height:1.55;margin-bottom:14px">${m.migrated
          ? `$${esc(m.symbol)} reached ${fmtUsd(m.stellar?.gradUsd || 46000)}. Its liquidity sits in an Aquarius pool on Stellar and the LP is burned forever. Holders with a linked Stellar wallet get their tokens sent there automatically as soon as it has a trustline for <b>${esc(m.stellar?.code || '')}</b>; anyone else can withdraw them to any Stellar wallet.`
          : 'The curve is full. Rookery is issuing the token on Stellar, opening the Aquarius pool and burning the LP. This takes about a minute.'}</p>
        ${m.migrated ? `<div class="st-asset">
          <div class="kv"><span>Asset code</span><b>${esc(m.stellar?.code || '')}</b><button class="mini" data-copy="${esc(m.stellar?.code || '')}">Copy</button></div>
          <div class="kv"><span>Issuer</span><b class="mono" style="font-size:11px;letter-spacing:0">${esc(m.stellar?.issuer || '')}</b><button class="mini" data-copy="${esc(m.stellar?.issuer || '')}">Copy</button></div>
          <p class="mu" style="font-size:11.5px;line-height:1.55;margin:8px 0 12px">Add this asset in your Stellar wallet (Freighter: Assets → Add asset; Lobstr: Add asset) before withdrawing. A trustline locks 0.5 XLM as a reserve — you get it back if you remove it.</p>
        </div>
        ${(() => {
          const h = (S.me?.holdings || []).find(x => x.id === m.id);
          if (!h) return '';
          const dr = h.stellar?.drop, w = h.stellar?.wallet;
          const msg = dr?.status === 'sent' ? `<span style="color:#3ddc97">✓</span> Your tokens were sent to your Stellar wallet <span class="mono">${esc(short(w || ''))}</span>.`
            : w ? `Your <b>${esc(weiToStr(B(h.amount), 2))} $${esc(m.symbol)}</b> are sent automatically to <span class="mono">${esc(short(w))}</span> as soon as it has a trustline for <b>${esc(m.stellar?.code || '')}</b>. Nothing else to do.`
            : `Sign in with a Stellar wallet (or link one in your wallet page) and your <b>${esc(weiToStr(B(h.amount), 2))} $${esc(m.symbol)}</b> are sent there automatically. You can also withdraw them by hand.`;
          return `<div style="border:1px solid #26262c;border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.5;margin-bottom:12px">${msg}</div>`;
        })()}
        <a class="btn lg wide" target="_blank" rel="noopener" href="https://aqua.network/pools/${esc(m.stellar?.pool || '')}/">Trade on Aquarius ↗</a>
        <a class="btn lg wide ghost" style="margin-top:8px" href="#/wallet">Withdraw to my Stellar wallet</a>` : '<div class="prog big"><i style="width:70%"></i></div>'}
      </div>` : ''}
      ${m.rh ? `<div class="panel pb rh-pane" id="rhPane"></div>` : ''}
      ${(m.network === 'zero' || m.network === 'giwa') && m.migrated ? `<div class="panel pb zero-live" id="zeroLive"></div>` : ''}
      ${m.chainContract && !m.migrated ? `<div class="panel pb zero-res">
        <div class="zr-h"><span class="tag net-zero">RESERVED</span><b>${m.network === 'giwa' ? 'GIWA' : 'Zero'} contract</b></div>
        <button class="zr-addr mono" data-copy="${esc(m.chainContract)}" title="Copy address">${esc(m.chainContract)}<span class="zr-cp">⧉</span></button>
        <p class="mu zr-n">This is the address $${esc(m.symbol)} gets on ${m.network === 'giwa' ? 'GIWA' : 'Zero'} mainnet. Every balance moves here 1:1, nothing to claim. Anything else claiming to be $${esc(m.symbol)} on ${m.network === 'giwa' ? 'GIWA' : 'Zero'} is fake.</p>
      </div>` : ''}
      <div class="panel pb" ${(m.network === 'stellar' && (m.migrated || m.stellar?.job)) || m.rh || ((m.network === 'zero' || m.network === 'giwa') && m.migrated) ? 'style="display:none"' : ''}>
        <div class="tb-tabs"><button class="buy on" data-side="buy">Buy</button><button class="sell" data-side="sell">Sell</button></div>
        <div class="pay-sel" id="paySel" ${QA === 'xlm' ? 'style="display:none"' : ''}><span class="mu" id="payLbl">Pay with</span>${(QA === 'zltc' ? [['eth', 'ETH'], ['ltc', 'LTC'], ['zltc', 'zkLTC']] : [['zro', 'ZRO'], ['eth', 'ETH']]).map(([k, l]) => `<button data-a="${k}">${l}</button>`).join('')}</div>
        <div class="amt"><input id="amt" inputmode="decimal" placeholder="0.0" autocomplete="off"><span class="unit" id="unit"></span></div>
        <div class="quick" id="quick"></div>
        <div class="est" id="est"></div>
        <button class="btn lg wide up" id="go">${S.me ? 'Buy' : 'Log in to trade'}</button>
        ${m.network !== 'stellar' && !m.migrated && S.stats?.walletBuy ? `<button class="btn lg wide ghost" id="evmBuy" style="margin-top:8px;gap:8px"><span style="font-size:15px">⬡</span>Buy from wallet · ETH or ZRO</button>` : ''}
        ${m.network === 'stellar' && !m.migrated ? `<button class="btn lg wide ghost" id="stBuy" style="margin-top:8px;gap:8px"><span style="font-size:15px">✶</span>Buy from wallet</button>
        <button class="btn lg wide ghost" id="wcBuy" style="margin-top:6px;gap:8px"><span style="font-size:14px">▲</span>Buy with Lobstr</button>` : ''}
        <div class="qb" id="qbRow"><span class="mono mu">Quick buy</span><input id="qbAmt" value=""><span class="mu" style="font-size:12px" id="qbUnit">ZRO</span>
          <button class="btn sm up" id="qbGo" style="margin-left:auto">⚡ Buy</button></div>
        <div class="kv" style="margin-top:12px"><span id="myPayLbl">Your ZRO</span><b id="myZro">—</b></div>
        <div class="kv"><span>Your ${esc(m.symbol)}</span><b id="myTok">—</b></div>
        <div class="kv"><span>Your PnL</span><b id="myPnl">—</b></div>
        <div id="pnlShareBox"></div>
      </div>

      <div class="panel pb side-card">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="mono mu" id="bondLbl">Bonding curve</span><b id="bondPct"></b></div>
        <div class="prog big" style="margin:10px 0"><i id="bondBar"></i></div>
        <p class="mu" style="font-size:12.5px;line-height:1.55" id="bondTxt"></p>
      </div>

      <div class="panel pb side-card">
        <span class="mono mu">${m.network === 'stellar' ? (m.migrated ? 'Taxes on the curve · ended at graduation' : 'Taxes on every curve trade') : 'Taxes on every trade'}</span>
        <div style="margin-top:8px">
          <div class="tax-row"><span class="tax-dot" style="background:#fff"></span>$臭企鹅 buy &amp; burn (Stinky Penguin)<b>${m.rh && m.migrated ? 'curve only' : '0.5%'}</b></div>
          <div class="tax-row"><span class="tax-dot" style="background:#9b9ba3"></span>Marketing (creator)<b>${m.taxes.marketing}%</b></div>
          <div class="tax-row"><span class="tax-dot" style="background:#5c5c64"></span>Burn ${esc(m.symbol)}<b>${m.taxes.burn}%</b></div>
          <div class="tax-row"><span class="tax-dot" style="background:var(--up)"></span>${m.rh ? '$' + esc(m.symbol) : (m.quote || 'ZRO')} rewards to holders<b>${m.taxes.rewards}%</b></div>
        </div>
        ${Number(m.taxes.marketing) > 0 ? `<p class="mu" style="font-size:11.5px;line-height:1.6;margin-top:10px">Marketing fees are paid to the creator automatically on every trade. Nothing to claim.</p>` : ''}
        ${m.network === 'stellar' ? `<p class="mu" style="font-size:11.5px;line-height:1.6;margin-top:8px;border-left:2px solid var(--line2);padding-left:9px">${m.migrated
          ? 'This token now trades on Aquarius. A Stellar asset cannot charge a fee on transfers, so trades there carry no marketing, rewards or burn tax. Rewards earned before graduation stay claimable.'
          : 'These taxes apply to every trade on the curve. After graduation the token trades on Aquarius, where a Stellar asset cannot charge a transfer fee, so trading there is tax-free.'}</p>` : ''}
        <div id="rewBox"></div>
      </div>

      <div class="panel pb side-card">
        <span class="mono mu">Telegram buybot</span>
        <p style="font-size:13px;line-height:1.6;color:var(--tx2);margin:8px 0 10px">Post every buy of $${esc(m.symbol)} in your Telegram group.</p>
        ${S.stats.tgBot ? `
        <div class="kv"><span>1. Add to your group</span><b><a href="https://t.me/${esc(S.stats.tgBot)}?startgroup=track" target="_blank" rel="noopener" style="text-decoration:underline">@${esc(S.stats.tgBot)}</a></b></div>
        <div class="kv"><span>2. Send in the group</span><b class="mono" style="letter-spacing:0;font-size:11.5px;text-transform:none">/track ${esc(m.id)}</b></div>
        <button class="btn sm ghost wide" id="copyTrack" style="margin-top:8px">Copy command</button>
        <p class="mu" style="font-size:11.5px;line-height:1.6;margin-top:10px">Customize in the group: reply to a GIF with <b class="mono" style="letter-spacing:0;text-transform:none">/setmedia</b>, add buttons with <b class="mono" style="letter-spacing:0;text-transform:none">/socials x=… tg=… web=…</b>, set <b class="mono" style="letter-spacing:0;text-transform:none">/emoji 🐧</b>, check with <b class="mono" style="letter-spacing:0;text-transform:none">/preview</b>.</p>`
        : '<p class="mu" style="font-size:12.5px">Buybot is being set up. Coming online shortly.</p>'}
      </div>
    </aside>
  </section>`;
  if (m.rh) RHW.pane(m);
  if ((m.network === 'zero' || m.network === 'giwa') && m.migrated) ZW.pane(m);

  /* chart */
  const LW = window.LightweightCharts;
  const chartEl = $('#chart');
  let series = null;
  if (LW) {
    S.chart = LW.createChart(chartEl, {
      autoSize: true, layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#76767E', fontFamily: 'JetBrains Mono', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,.035)' }, horzLines: { color: 'rgba(255,255,255,.035)' } },
      rightPriceScale: { borderColor: '#1E1E23', scaleMargins: { top: 0.15, bottom: 0.1 } }, timeScale: { borderColor: '#1E1E23', timeVisible: true, secondsVisible: false, barSpacing: 9, minBarSpacing: 3, rightOffset: 6 },
      crosshair: { mode: 0 },
    });
    series = S.chart.addCandlestickSeries({
      upColor: '#3DDC97', downColor: '#FF5C5C', borderVisible: false, wickUpColor: '#3DDC97', wickDownColor: '#FF5C5C',
      priceFormat: { type: 'custom', formatter: axisUsd, minMove: 1e-12 },
    });
  }
  const startUsd = () => (Number((m.vQuote ? B(m.vQuote) : B(S.stats.curve.vZro) * WEI) * WEI / (B(S.stats.curve.vTok) * WEI)) / 1e18) * (m.quoteUsd || d.zroUsd);
  function candles() {
    const map = new Map();
    let prev = startUsd();
    for (const t of d.trades) {
      const p = (Number(B(t.price)) / 1e18) * (t.usd || d.zroUsd);
      const b = Math.floor(t.ts / 1000 / ival) * ival;
      const c = map.get(b);
      if (!c) map.set(b, { time: b, open: prev, high: Math.max(prev, p), low: Math.min(prev, p), close: p });
      else { c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; }
      prev = p;
    }
    // continuous timeline: flat candles where nothing traded (pump-style)
    const nowB = Math.floor(Date.now() / 1000 / ival) * ival;
    let t0 = Math.floor(m.created / 1000 / ival) * ival;
    t0 = Math.max(t0, nowB - 400 * ival);
    const out = []; let last = startUsd();
    for (const t of d.trades) { if (Math.floor(t.ts / 1000 / ival) * ival < t0) last = (Number(B(t.price)) / 1e18) * (t.usd || d.zroUsd); }
    for (let b = t0; b <= nowB; b += ival) {
      const c = map.get(b);
      if (c) { out.push(c); last = c.close; } else out.push({ time: b, open: last, high: last, low: last, close: last });
    }
    return out;
  }
  const paintChart = () => { if (series) { series.setData(candles()); } };
  $$('#ivals button').forEach(b => b.onclick = () => { ival = +b.dataset.i; $$('#ivals button').forEach(x => x.classList.toggle('on', x === b)); paintChart(); S.chart?.timeScale().scrollToRealTime(); });

  /* static-ish parts */
  function paintTop() {
    liveNum($('#px'), m.priceUsd, fmtUsd);
    liveText($('#pxch'), fmtPct(m.change24h));
    if (!$('#kMc')) $('#kpis').innerHTML = `
      <div><span class="mono mu">Market cap</span><b id="kMc"></b></div>
      ${Number(m.taxes.marketing) > 0 ? `<div><span class="mono mu">Creator fees earned</span><b style="color:var(--up)" id="kFee"></b><span class="mu" style="font-size:11.5px" id="kFeeU"></span></div>` : ''}
      <div><span class="mono mu">Liquidity</span><b id="kLiq"></b></div>
      <div><span class="mono mu">Volume</span><b id="kVol"></b></div>
      <div><span class="mono mu">Holders</span><b id="kHold"></b></div>
      <div><span class="mono mu">Burned</span><b id="kBurn"></b></div>`;
    liveNum($('#kMc'), m.mcapUsd, fmtUsd); liveNum($('#kLiq'), m.liquidityUsd, fmtUsd);
    liveNum($('#kVol'), m.volumeUsd, fmtUsd); liveNum($('#kHold'), m.holders, fmtInt);
    liveText($('#kBurn'), fmtT(m.burned), true);
    liveText($('#kFee'), `${fmtZ(m.mktPaid, m.quote === 'ETH' ? 5 : 2)} ${m.quote || 'ZRO'}`, true);
    liveText($('#kFeeU'), `${fmtUsd(m.mktPaidUsd)} · ${m.taxes.marketing}% tax`);
    liveNum($('#bondPct'), m.progress, (v) => v.toFixed(2) + '%', false);
    if ($('#bondLbl')) $('#bondLbl').textContent = m.network === 'stellar' ? `Progress to ${gradK(m.stellar?.gradUsd || 46000)} · Aquarius` : 'Bonding curve';
    $('#bondBar').style.width = Math.max(2.5, m.progress) + '%';
    const left = zNum(B(m.curveTokens) * WEI - B(m.sold));
    $('#bondTxt').innerHTML = m.rh
      ? (m.migrated ? `<b style="color:var(--tx)">Graduated to Uniswap V2.</b> The pool lives on Robinhood Chain and its LP tokens were minted to the dead address, so the liquidity is locked forever. Creator taxes keep applying on Uniswap.`
        : m.graduated ? `<b style="color:var(--tx)">Sold out.</b> Graduating into a Uniswap V2 pool on Robinhood Chain right now, LP burned forever.`
        : `${(left / 1e6).toFixed(1)}M ${esc(m.symbol)} left on the curve. When it sells out, the contract moves the raise into a Uniswap V2 pool on Robinhood Chain and burns the LP.`)
      : m.graduated
      ? (m.network === 'stellar'
        ? (m.migrated
          ? `<b style="color:var(--tx)">Graduated to Aquarius.</b> The pool lives on Stellar with its LP burned forever. Trade it on <a href="https://aqua.network/pools/${esc(m.stellar?.pool || '')}/" target="_blank" rel="noopener" style="text-decoration:underline">Aquarius</a> or withdraw your tokens to a Stellar wallet.`
          : `<b style="color:var(--tx)">Bonded.</b> Trading continues on the Rookery pool. At ${fmtUsd(m.stellar?.gradUsd || 46000)} market cap it graduates on-chain into an Aquarius pool and the LP is burned forever.`)
        : `<b style="color:var(--tx)">Bonded.</b> Trading continues on the Rookery pool with no market-cap limit (${fmtUsd(m.liquidityUsd)} liquidity). On ${netName(m.network)} mainnet this pool moves 1:1 to a DEX at the same price.`)
      : `${m.network === 'stellar' ? `<b style="color:var(--tx)">${fmtUsd(m.mcapUsd)}</b> of ${fmtUsd(m.stellar?.gradUsd || 46000)} market cap. ` : ''}${(left / 1e6).toFixed(1)}M ${esc(m.symbol)} left on the curve. ${m.network === 'stellar' ? `At ${fmtUsd(m.stellar?.gradUsd || 46000)} market cap the liquidity moves on-chain into an Aquarius pool on Stellar and the LP is burned.` : `the reserve (${fmtUsd(m.liquidityUsd)} now) becomes the first ${netName(m.network)} pool.`}`;
    liveNum($('#cTrades'), m.trades, fmtInt, false); liveNum($('#cHolders'), m.holders, fmtInt, false); liveNum($('#cCom'), d.comments.length, fmtInt, false);
    if (d.me) {
      $('#myZro').textContent = fmtA(d.me[pay] || '0', pay);
      $('#myTok').textContent = fmtT(d.me.tokens);
      const pn = d.me.pnl;
      try {
      if (pn && pn.trades > 0) {
        const v = pn.pnlZro, pct = pn.pnlPct;
        const col = v > 0 ? 'var(--up)' : v < 0 ? 'var(--dn)' : 'var(--tx)';
        const sign = v > 0 ? '+' : v < 0 ? '-' : '';
        $('#myPnl').innerHTML = `<span style="color:${col}">${sign}${fmtZ(Math.abs(v), QA === 'eth' ? 6 : 4)} ${Q}</span>` +
          (pct === null ? '' : ` <span style="color:${col};font-weight:600">${sign}${Math.abs(pct).toFixed(1)}%</span>`) +
          `<span class="mu" style="font-weight:500;font-size:11.5px"> · in ${fmtZ(pn.costZro, QA === 'eth' ? 5 : 2)} ${Q}</span>`;
        if (!$('#pnlShare')) $('#pnlShareBox').innerHTML = laserBtn('id="pnlShare" style="width:100%;margin-top:10px"', `Share your $${esc(m.symbol)} PnL`);
        const qu = m.quoteUsd || d.zroUsd;
        $('#pnlShare').onclick = (e) => { e.stopPropagation(); openShare({ kind: 'token', id: m.id, symbol: m.symbol, name: m.name, image: m.image, user: S.me?.username,
          pnlUsd: v * qu, pnlPct: pct, costUsd: pn.costZro * qu, valueUsd: pn.valueZro * qu }); };
      } else { $('#myPnl').innerHTML = '<span class="mu">—</span>'; $('#pnlShareBox').innerHTML = ''; }
      } catch (e) { $('#myPnl').innerHTML = '<span class="mu">—</span>'; console.warn('pnl', e); }
      const pend = B(d.me.pendingRewards);
      $('#rewBox').innerHTML = m.taxes.rewards > 0 ? `<hr class="sep"><div class="kv"><span>Your pending ${Q} rewards</span><b>${fmtA(pend, QA)}</b></div>
        <button class="btn sm ghost wide" id="claim" ${pend > 0n ? '' : 'disabled'} style="margin-top:6px">Claim to balance</button>` : '';
      const cl = $('#claim'); if (cl) cl.onclick = async () => { try { const r = await api('/rewards/claim', { market: id }); toast(`Claimed ${fmtA(r.claimed, QA)}`); refresh(); } catch (e) { toast(esc(e.message), 'bad'); } };
    }
    const maxw = m.maxBuyBps > 0 && Date.now() < m.maxBuyUntil;
    if (maxw && !$('#maxw')) $('#est').insertAdjacentHTML('beforebegin', `<div id="maxw" class="warn" style="margin:12px 0 0">Launch protection: max ${(m.maxBuyBps / 100).toFixed(2)}% of supply per wallet for ${Math.ceil((m.maxBuyUntil - Date.now()) / 60000)} more min.</div>`);
  }

  /* trade straight from a Stellar wallet, no account: the wallet signature is the login */
  if ($('#stWal') && !S.me?.stellarWallet && m.network === 'stellar' && !m.migrated && m.stellar?.issuer) {
    const box = $('#stWal');
    let kind = null, addr = '';
    const panel = (h) => {
      const bal = Number(h.wallet || 0);
      box.innerHTML = `<div class="st-guest">
        <div class="kv"><span>Wallet <span class="mono">${esc(short(addr))}</span></span><b>${h.trust ? esc(bal.toLocaleString('en-US', { maximumFractionDigits: 2 })) + ' $' + esc(m.symbol) : 'no trustline'}</b></div>
        ${h.xlm !== null ? `<div class="kv"><span>XLM in wallet</span><b>${esc(Number(h.xlm).toLocaleString('en-US', { maximumFractionDigits: 2 }))}</b></div>` : ''}
        ${!h.trust ? `<button class="btn sm wide" id="stGTrust" style="margin-top:8px">Add trustline for ${esc(m.stellar.code)}</button>`
          : bal > 0 ? `<div style="display:flex;gap:6px;margin-top:8px">
            <input id="stGAmt" class="inp" inputmode="decimal" placeholder="Amount" style="flex:1;min-width:0">
            <button class="btn sm ghost" id="stGMax">Max</button><button class="btn sm" id="stGSell">Sell from wallet</button></div>
            <div class="mu" style="font-size:11px;margin-top:4px">One signature, no login. The XLM comes back to this wallet.</div>`
          : `<div class="mu" style="font-size:11.5px;margin-top:6px">No ${esc(m.symbol)} in this wallet yet. Buy here with the wallet and the tokens land in it.</div>`}
        <div class="mu" style="font-size:11px;margin-top:8px">Trading works without an account: your wallet signs, Rookery never holds the tokens.</div>
      </div>`;
      const g = (id) => document.getElementById(id);
      if (g('stGTrust')) g('stGTrust').onclick = async () => {
        try {
          const p = await api('/stellar/prep-trust', { market: m.id, address: addr });
          const signed = await STW.signTx(kind, addr, p.xdr);
          await api('/stellar/submit', { xdr: signed });
          toast('Trustline added'); setTimeout(() => repaint(), 4000);
        } catch (e) { toast(esc(e.message || e), 'bad'); }
      };
      if (g('stGMax')) g('stGMax').onclick = () => { g('stGAmt').value = String(bal); };
      if (g('stGSell')) g('stGSell').onclick = async () => {
        const v = Number(g('stGAmt').value || 0);
        if (!(v > 0) || v > bal) return toast('Enter an amount you hold in the wallet', 'bad');
        const b = g('stGSell'); b.disabled = true; b.textContent = 'Waiting for your wallet…';
        try {
          const p = await api('/stellar/prep-sell', { market: m.id, amount: toWei(String(v)), address: addr });
          const signed = await STW.signTx(kind, addr, p.xdr);
          await api('/stellar/submit', { xdr: signed });
          toast('Tokens sent. The sale runs on the curve and the XLM comes back to your wallet in about a minute.');
          setTimeout(() => repaint(), 9000);
        } catch (e) { toast(esc(e.message || e), 'bad'); }
        finally { if (g('stGSell')) { g('stGSell').disabled = false; g('stGSell').textContent = 'Sell from wallet'; } }
      };
    };
    const repaint = async () => {
      if (!addr) return;
      try { panel(await api(`/stellar/wallet?market=${encodeURIComponent(m.id)}&address=${encodeURIComponent(addr)}`)); }
      catch (e) { box.innerHTML = `<div class="mu" style="font-size:11.5px">${esc(e.message)}</div>`; }
    };
    box.innerHTML = `<div class="st-guest">
      <div style="font-size:12.5px;line-height:1.55">Trade this token from your own Stellar wallet. <b>No account needed.</b></div>
      <button class="btn sm wide" id="stGConnect" style="margin-top:8px">Connect wallet</button>
      <div class="mu" style="font-size:11px;margin-top:6px">Freighter, xBull, Albedo or Rabet.</div></div>`;
    $('#stGConnect').onclick = async () => {
      try {
        kind = await STW.detect();
        if (!kind) throw new Error('No Stellar wallet found. Install Freighter, xBull, Albedo or Rabet.');
        addr = await STW.connect(kind);
        await repaint();
      } catch (e) { toast(esc(e.message || e), 'bad'); }
    };
  }

  /* the holder's own Stellar wallet: balance there, tokens on their way, trustline and sell-from-wallet */
  if ($('#stWal') && S.me?.stellarWallet && S.stats?.stellarSendNow) {
    const paintWal = async () => {
      const box = $('#stWal'); if (!box) return;
      let h;
      try { h = await api(`/stellar/holding?market=${encodeURIComponent(m.id)}&address=${encodeURIComponent(S.me.stellarWallet)}`); } catch { return; }
      const q = B(h.queued || '0');
      box.innerHTML = `<div style="border:1px solid #26262c;border-radius:10px;padding:10px 12px;margin-top:10px;font-size:12.5px;line-height:1.55">
        <div class="kv"><span>Your wallet ${esc(short(S.me.stellarWallet))}</span><b>${h.trust ? esc(Number(h.wallet || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })) + ' $' + esc(m.symbol) : 'no trustline yet'}</b></div>
        ${q > 0n ? `<div class="mu" style="font-size:11.5px">On its way: ${esc(weiToStr(q, 2))} $${esc(m.symbol)}${h.note ? ' · ' + esc(h.note) : ''}</div>` : ''}
        ${!h.trust ? `<button class="btn sm wide" id="stTrust" style="margin-top:8px">Add trustline for ${esc(m.stellar.code)} (0.5 XLM reserve)</button>` : ''}
        ${h.trust && Number(h.wallet) > 0 ? `<div style="display:flex;gap:6px;margin-top:8px"><input id="stSellAmt" class="inp" inputmode="decimal" placeholder="Amount" style="flex:1;min-width:0">
          <button class="btn sm ghost" id="stSellMax">Max</button><button class="btn sm" id="stSell">Sell from wallet</button></div>
          <div class="mu" style="font-size:11px;margin-top:4px">One signature. The XLM comes back to this wallet.</div>` : ''}
      </div>`;
      if ($('#stTrust')) $('#stTrust').onclick = async () => { try { await STW.trust(m.id); setTimeout(paintWal, 4000); } catch (e) { toast(esc(e.message || e), 'bad'); } };
      if ($('#stSellMax')) $('#stSellMax').onclick = () => { $('#stSellAmt').value = String(h.wallet); };
      if ($('#stSell')) $('#stSell').onclick = async () => {
        const v = Number($('#stSellAmt').value || 0);
        if (!(v > 0) || v > Number(h.wallet)) return toast('Enter an amount you hold in the wallet', 'bad');
        const b = $('#stSell'); b.disabled = true; b.textContent = 'Waiting for your wallet…';
        try { await STW.sell(m.id, toWei(String(v))); setTimeout(paintWal, 8000); }
        catch (e) { toast(esc(e.message || e), 'bad'); }
        finally { b.disabled = false; b.textContent = 'Sell from wallet'; }
      };
    };
    paintWal();
    const iv = setInterval(() => { if (!$('#stWal')) return clearInterval(iv); paintWal(); }, 15000);
  }

  /* trade box */
  const amt = $('#amt'), go = $('#go');
  if ($('#wcBuy')) $('#wcBuy').onclick = async () => {
    const b = $('#wcBuy'), was = b.innerHTML;
    const xlm = Number(amt.value || 0) || 10;
    if (!(xlm >= 1)) return toast('Minimum is 1 XLM', 'bad');
    b.disabled = true; b.innerHTML = 'Waiting for Lobstr…';
    try { await STW.buyWc(m.id, xlm); }
    catch (e) { toast(esc(e.message || e), 'bad'); WC.hideQr(); }
    finally { b.disabled = false; b.innerHTML = was; }
  };
  if ($('#evmBuy')) $('#evmBuy').onclick = async () => {
    const b = $('#evmBuy'), old = b.innerHTML;
    // whatever is typed in the trade box, in the selected pay asset, becomes a USD size
    const v = Number(amt.value || 0) || (pay === 'eth' ? Number(S.quickEth || 0.005) : Number(S.quick || 10));
    const usd = v * (pay === 'eth' ? (S.stats?.ethUsd || 0) : (S.stats?.zroUsd || 0));
    b.disabled = true; b.innerHTML = 'Waiting for your wallet…';
    try { await EVMW.buy(m, usd); }
    catch (e) { toast(esc(e.message || e), 'bad'); }
    finally { b.disabled = false; b.innerHTML = old; }
  };
  if ($('#stBuy')) $('#stBuy').onclick = async () => {
    const b = $('#stBuy'), old = b.innerHTML;
    const xlm = Number(amt.value || 0) || 10;
    if (!(xlm >= 1)) return toast('Minimum is 1 XLM', 'bad');
    b.disabled = true; b.innerHTML = 'Waiting for your wallet…';
    try { await STW.buy(m.id, xlm); }
    catch (e) { toast(esc(e.message || e), 'bad'); }
    finally { b.disabled = false; b.innerHTML = old; }
  };
  function paintPay() {
    $$('#paySel button').forEach(b => b.classList.toggle('on', b.dataset.a === pay));
    $('#payLbl').textContent = side === 'buy' ? 'Pay with' : 'Receive in';
    $('#unit').innerHTML = side === 'buy' ? `<span class="zro-ico">${ASSET[pay].ico}</span>${ASSET[pay].label}` : esc(m.symbol);
    $('#qbUnit').textContent = ASSET[pay].label;
    $('#qbAmt').value = pay === 'eth' ? (S.quickEth || '0.005') : S.quick;
    $('#myPayLbl').textContent = 'Your ' + ASSET[pay].label;
    if (d.me) $('#myZro').textContent = fmtA(d.me[pay] || '0', pay);
  }
  $$('#paySel button').forEach(b => b.onclick = () => { pay = b.dataset.a; localStorage.setItem('pl_pay_' + QA, pay); amt.value = ''; paintPay(); paintQuick(); paintEst(); });
  function paintQuick() {
    $('#quick').innerHTML = side === 'buy'
      ? ASSET[pay].quick.map(v => `<button data-v="${v}">${v} ${ASSET[pay].label}</button>`).join('')
      : ['25', '50', '75', '100'].map(v => `<button data-p="${v}">${v}%</button>`).join('');
    $$('#quick button').forEach(b => b.onclick = () => {
      if (b.dataset.v) amt.value = b.dataset.v;
      else if (d.me) amt.value = weiToStr((B(d.me.tokens) * BigInt(b.dataset.p)) / 100n, 4);
      paintEst();
    });
  }
  function paintEst() {
    const v = toWei(amt.value);
    if (side === 'buy') {
      const qIn = v > 0n ? convert(v, pay, QA) : 0n;
      const e = qIn > 0n ? estBuy(m, qIn) : null;
      $('#est').innerHTML = `
        <div class="kv"><span>You pay</span><b>${v > 0n ? `${fmtA(v, pay)} · ${fmtUsd(zNum(v) * assetUsd(pay))}` : '—'}</b></div>
        ${pay !== QA && v > 0n ? `<div class="kv"><span>Converted to</span><b>≈ ${fmtA(qIn, QA)} <span class="mu" style="font-weight:500">· 0.5% conversion</span></b></div>` : ''}
        <div class="kv"><span>You receive</span><b>${e ? `${fmtT(e.tokens)} ${esc(m.symbol)}` : '—'}</b></div>
        <div class="kv"><span>Price impact</span><b>${e ? `${e.impact.toFixed(2)}%` : '—'}</b></div>
        <div class="kv"><span>Fees</span><b>${(0.5 + m.taxes.marketing + m.taxes.rewards).toFixed(1)}% + ${m.taxes.burn}% burn</b></div>`;
      go.textContent = S.me ? 'Buy' : 'Log in to trade';
    } else {
      const e = v > 0n ? estSell(m, v) : null;
      const outW = e ? convert(e.zro, QA, pay) : 0n;
      $('#est').innerHTML = `
        <div class="kv"><span>You sell</span><b>${v > 0n ? `${fmtT(v)} ${esc(m.symbol)}` : '—'}</b></div>
        <div class="kv"><span>You receive</span><b>${e ? `${pay !== QA ? '≈ ' : ''}${fmtA(outW, pay)} · ${fmtUsd(zNum(outW) * assetUsd(pay))}` : '—'}</b></div>
        ${pay !== QA && e ? `<div class="kv"><span>Conversion</span><b class="mu" style="font-weight:500">${Q} → ${ASSET[pay].label} · 0.5%</b></div>` : ''}
        <div class="kv"><span>Fees</span><b>${(0.5 + m.taxes.marketing + m.taxes.rewards).toFixed(1)}% + ${m.taxes.burn}% burn</b></div>`;
      go.textContent = S.me ? 'Sell' : 'Log in to trade';
    }
  }
  // the wallet panel on Robinhood Chain tokens has its own tabs (data-rs); never bind over them
  const tabBtns = $$('.tb-tabs button').filter(b => !(b.closest && b.closest('#rhPane')));
  tabBtns.forEach(b => b.onclick = () => {
    side = b.dataset.side;
    tabBtns.forEach(x => x.classList.toggle('on', x === b));
    paintPay();
    go.className = `btn lg wide ${side === 'buy' ? 'up' : 'dn'}`;
    $('#qbRow').style.display = side === 'buy' ? '' : 'none';
    amt.value = ''; paintQuick(); paintEst();
  });
  amt.oninput = paintEst;
  async function doTrade(sideX, wei) {
    if (!S.me) return needLogin();
    if (wei <= 0n) return toast('Enter an amount', 'bad');
    go.disabled = true;
    try {
      const r = await api('/trade', { market: id, side: sideX, amount: wei.toString(), ...(pay !== QA ? { pay } : {}) });
      const gotQ = r.received ? fmtA(r.received.amount, r.received.asset) : fmtA(r.zro, QA);
      toast(sideX === 'buy' ? `Bought <b>${fmtT(r.tokens)} ${esc(m.symbol)}</b> for ${r.paid ? fmtA(r.paid.amount, r.paid.asset) : fmtA(r.zro, QA)}` : `Sold for <b>${gotQ}</b>`);
      amt.value = ''; await refresh(); loadMe();
    } catch (e) { toast(esc(e.message), 'bad'); }
    finally { go.disabled = false; }
  }
  go.onclick = () => doTrade(side, toWei(amt.value));
  $('#qbAmt').onchange = (e) => { if (pay === 'eth') { S.quickEth = e.target.value; localStorage.setItem('pl_quick_eth', S.quickEth); } else { S.quick = e.target.value; localStorage.setItem('pl_quick', S.quick); } };
  $('#qbGo').onclick = () => doTrade('buy', toWei($('#qbAmt').value));

  /* tabs */
  function paintTab() {
    const body = $('#tabBody');
    if (tab === 'trades') {
      body.innerHTML = `<div class="row trade mono mu" style="font-size:9.5px"><span>Side</span><span>Trader</span><span class="r">USD</span><span class="r hide-s">${esc(m.symbol)}</span><span class="r">Age</span></div>
        <div class="list">${d.trades.length ? [...d.trades].reverse().slice(0, 100).map(t => `
          <div class="row trade"><b class="${t.side === 'buy' ? 'up' : 'dn'}">${t.side.toUpperCase()}</b>
            <span class="who"><a href="#/u/${encodeURIComponent(t.username || '')}">${esc(t.username || 'anon')}</a>${badgeHTML(t.badges)}</span>
            <span style="text-align:right">${fmtUsd(zNum(t.zro) * (t.usd || d.zroUsd))}</span><span style="text-align:right" class="hide-s">${fmtT(t.tokens)}</span>
            <span style="text-align:right" class="mu">${ago(t.ts)}</span></div>`).join('') : '<div class="empty" style="border:0;margin:10px">No trades yet. Be first.</div>'}</div>`;
    } else if (tab === 'holders') {
      const burnedPct = Number((B(m.burned) * 1000000n) / (B(m.supply) * WEI)) / 10000;
      const curveLeft = B(m.curveTokens) * WEI - B(m.sold);
      const curvePct = Number((curveLeft * 1000000n) / (B(m.supply) * WEI)) / 10000;
      body.innerHTML = `<div class="list">
        ${m.graduated
          ? `<div class="row holder"><span class="mu">—</span><span class="who"><b>Rookery pool</b><span class="tag">MOVES 1:1 AT MAINNET</span></span><span style="text-align:right">${fmtT(m.poolTok)}</span><span style="text-align:right">${(Number((B(m.poolTok) * 1000000n) / (B(m.supply) * WEI)) / 10000).toFixed(2)}%</span></div>`
          : `<div class="row holder"><span class="mu">—</span><span class="who"><b>Bonding curve</b></span><span style="text-align:right">${fmtT(curveLeft)}</span><span style="text-align:right">${curvePct.toFixed(2)}%</span></div>
        <div class="row holder"><span class="mu">—</span><span class="who"><b>Pool reserve (after bonding)</b></span><span style="text-align:right">200M</span><span style="text-align:right">20.00%</span></div>`}
        ${burnedPct > 0 ? `<div class="row holder"><span class="mu">—</span><span class="who"><b>Burned</b></span><span style="text-align:right">${fmtT(m.burned)}</span><span style="text-align:right">${burnedPct.toFixed(2)}%</span></div>` : ''}
        ${d.holders.map((x, i) => `<div class="row holder"><span class="mu">${i + 1}</span>
          <span class="who"><a href="#/u/${encodeURIComponent(x.username)}">${esc(x.username)}</a>${badgeHTML(x.badges)}${x.creator ? '<span class="tag">DEV</span>' : ''}</span>
          <span style="text-align:right">${fmtT(x.amount)}</span><span style="text-align:right">${Number(x.pct || 0).toFixed(2)}%<div class="pct-bar"><i style="width:${Math.min(100, Number(x.pct || 0) * 5)}%"></i></div></span></div>`).join('')}
      </div>`;
    } else if (tab === 'comments') {
      body.innerHTML = `${S.me ? `<div class="cmt-form"><textarea id="cBody" placeholder="Say something about ${esc(m.symbol)}…" maxlength="500"></textarea><button class="btn" id="cGo">Post</button></div>`
        : `<div class="cmt-form mu" style="font-size:13px"><a href="#/login" style="text-decoration:underline;color:var(--tx)">Log in</a>&nbsp;to comment.</div>`}
        <div class="list">${d.comments.length ? d.comments.map(c => `<div class="cmt">${avatar(c.username, c.avatar)}<div>
          <a href="#/u/${encodeURIComponent(c.username)}"><b>${esc(c.username)}</b></a>${badgeHTML(c.badges)} <span class="mu" style="font-size:11.5px">${ago(c.ts)} ago</span>
          <p>${esc(c.body)}</p></div></div>`).join('') : '<div class="empty" style="border:0;margin:10px">No comments yet.</div>'}</div>`;
      const cg = $('#cGo');
      if (cg) cg.onclick = async () => {
        try { await api('/comment', { market: id, body: $('#cBody').value }); toast('Comment posted'); await refresh(); }
        catch (e) { toast(esc(e.message), 'bad'); }
      };
    } else {
      body.innerHTML = `<div class="pb">
        <p style="font-size:14px;line-height:1.7;color:var(--tx2);white-space:pre-wrap">${esc(m.description || 'No description.')}</p>
        <hr class="sep">
        <div class="kv"><span>Network</span><b>${m.network === 'giwa' ? 'GIWA (Upbit) · pre-mainnet' : m.network === 'robinhood' ? 'Robinhood Chain · live' : m.network === 'stellar' ? `Stellar · ${m.migrated ? 'on Aquarius' : 'graduates at ' + fmtUsd(m.stellar?.gradUsd || 46000)}` : 'Zero (LayerZero) · pre-mainnet'}</b></div>
        ${m.stellar?.issuer ? `<div class="kv"><span>Stellar asset</span><b><a class="mono" style="letter-spacing:0" target="_blank" rel="noopener" href="${m.stellar.explorer}/asset/${esc(m.stellar.code)}-${esc(m.stellar.issuer)}">${esc(m.stellar.code)} · ${short(m.stellar.issuer)} ↗</a></b></div>
        <div class="kv"><span>Aquarius pool</span><b><a class="mono" style="letter-spacing:0" target="_blank" rel="noopener" href="${m.stellar.explorer}/contract/${esc(m.stellar.pool)}">${short(m.stellar.pool)} ↗</a> · LP burned</b></div>` : ''}
        <div class="kv"><span>Pair</span><b>${esc(m.symbol)} / ${esc(Q)}</b></div>
        <div class="kv"><span>Total supply</span><b>1,000,000,000</b></div>
        <div class="kv"><span>On the bonding curve</span><b>800,000,000 (80%)</b></div>
        <div class="kv"><span>Reserved for mainnet pool</span><b>200,000,000 (20%)</b></div>
        <div class="kv"><span>${esc(Q)} rewards paid to holders</span><b>${fmtUsd(m.rewardsPaidUsd)}</b></div>
        <div class="kv"><span>Contract</span><b>${m.chainContract ? `<button class="mono zr-mini" data-copy="${esc(m.chainContract)}">${esc(m.chainContract.slice(0, 8))}…${esc(m.chainContract.slice(-6))} ⧉</button> <span class="mu" style="font-weight:400">${m.migrated ? 'live' : 'reserved'} on ${m.network === 'giwa' ? 'GIWA' : 'Zero'}</span>` : 'Minted at mainnet'}</b></div>
      </div>`;
    }
  }
  const ct = $('#copyTrack'); if (ct) ct.onclick = () => { navigator.clipboard.writeText(`/track ${id}`); toast('Command copied. Paste it in your Telegram group.'); };
  $$('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; $$('#tabs button').forEach(x => x.classList.toggle('on', x === b)); paintTab(); });

  async function refresh() {
    try { d = await api('/market/' + id); m = d.market; } catch { return; }
    paintTop(); paintChart();
    if (!(tab === 'comments' && document.activeElement?.id === 'cBody')) paintTab();
    paintEst();
  }

  paintPay(); paintQuick(); paintTop(); paintChart(); S.chart?.timeScale().scrollToRealTime(); paintTab(); paintEst();
  // live: the pushed market view updates price/KPIs instantly; trades, holders and your position follow a moment later
  const soon = debounce(refresh, 180);
  liveSub(['m:' + id], (msg) => {
    if (msg.market.id !== id) return;
    m = { ...m, ...msg.market }; d.market = m;
    paintTop(); paintEst(); soon();
  });
  setTimer(refresh, 4000, true);
}

/* ═══════════ CREATE ═══════════ */
function readImage(file, size = 256, maxBytes = 190_000) {
  return new Promise((res, rej) => {
    if (!file.type.startsWith('image/')) return rej(new Error('Pick an image file'));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const ctx = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      let q = 0.9, url = c.toDataURL('image/webp', q);
      while (url.length > maxBytes && q > 0.4) { q -= 0.1; url = c.toDataURL('image/webp', q); }
      if (!url.startsWith('data:image/webp')) url = c.toDataURL('image/jpeg', 0.85);
      url.length > maxBytes ? rej(new Error('Image too large')) : res(url);
    };
    img.onerror = () => rej(new Error('Could not read the image'));
    img.src = URL.createObjectURL(file);
  });
}
async function viewCreate(hatchId) {
  document.title = 'Create a token — Rookery';
  let hatch = null;
  if (hatchId) { try { hatch = (await api('/hatch/' + hatchId)).hatch; } catch { /* already launched */ } }
  const F = { name: hatch?.name || '', symbol: hatch?.symbol || '', description: hatch?.description || '', image: '',
    network: hatch?.network || S.net || 'zero', x: '', tg: '', web: '',
    maxBuyPct: 1, maxBuyMinutes: 30, taxMarketing: 1, taxBurn: 0.5, taxRewards: 1, devBuy: '', hatchId: hatch?.id || '' };
  app.innerHTML = `
  <section class="wrap page">
    <div id="hatchNote"></div>
    <div class="page-h"><div><h1>Create a token</h1><p>Hatch a token for a network before its mainnet. Free to create. Zero tokens trade in ZRO and migrate 1:1 at mainnet, GIWA and Robinhood Chain tokens in ETH, Stellar tokens in XLM and graduate on-chain into Aquarius. 0.5% of every trade burns $臭企鹅.</p></div></div>
    <div class="create">
      <div>
        <div class="fs"><h3>Token</h3><p class="hint">Name, ticker, picture and story. You can't change these later.</p>
          <label class="upl" id="upl">${timg({ symbol: '?' }).replace('class="timg ', 'id="imgPrev" class="timg ')}
            <div><b>Upload image</b><div class="mu" style="font-size:12.5px;margin-top:4px">PNG, JPG or WEBP from your computer. Square works best.</div></div>
            <input type="file" id="file" accept="image/*" hidden></label>
          <div class="f2" style="margin-top:14px">
            <div class="f"><label>Name</label><input class="inp" data-k="name" maxlength="32" placeholder="Stinky Penguin"></div>
            <div class="f"><label>Ticker</label><input class="inp" data-k="symbol" maxlength="12" placeholder="PENGU"></div>
          </div>
          <div class="f"><label>Description</label><textarea class="inp" data-k="description" maxlength="600" placeholder="What is it, why now, why this chain…"></textarea></div>
        </div>

        <div class="fs"><h3>Network & pair</h3><p class="hint">Where the token lands at mainnet, and what it trades against.</p>
          <div class="choice" id="netPick">
            <button class="opt" data-n="zero"><span class="net-ico">Ø</span><div><b>Zero</b><small>LayerZero · mainnet 30.11</small></div></button>
            <button class="opt" data-n="giwa"><span class="net-ico giwa"><img src="/assets/giwa.png" alt="GIWA"></span><div><b>GIWA</b><small>Upbit L2 · mainnet TBA</small></div></button>
            <button class="opt" data-n="stellar"><span class="net-ico st"><img src="/assets/chains/stellar.svg" alt="Stellar"></span><div><b>Stellar</b><small>Live · graduates to Aquarius</small></div></button>
            <button class="opt" data-n="litvm"><span class="net-ico ltc"><img src="/assets/chains/litecoin.svg" alt="LitVM"></span><div><b>LitVM</b><small>Litecoin EVM · pre-market · zkLTC pairs</small></div></button>
            <button class="opt" data-n="robinhood"><span class="net-ico rh"><img src="/assets/chains/robinhood.png" alt="Robinhood Chain"></span><div><b>Robinhood Chain</b><small>Live · Ethereum L2 · ETH pair</small></div></button>
          </div>
          <div class="choice" style="margin-top:10px" id="pairBox"></div>
        </div>

        <div class="fs"><h3>Socials</h3><p class="hint">Optional, shown on the token page.</p>
          <div class="f3">
            <div class="f"><label>X / Twitter</label><input class="inp" data-k="x" placeholder="x.com/yourtoken"></div>
            <div class="f"><label>Telegram</label><input class="inp" data-k="tg" placeholder="t.me/yourtoken"></div>
            <div class="f"><label>Website</label><input class="inp" data-k="web" placeholder="yourtoken.xyz"></div>
          </div>
        </div>

        <div class="fs" id="fsProt"><h3>Launch protection</h3><p class="hint">Limit how much one wallet can hold right after launch, so snipers can't take the supply.</p>
          <div class="slider"><span class="l">Max per wallet<small>% of supply</small></span><input type="range" min="0" max="5" step="0.25" data-k="maxBuyPct" value="1"><span class="v" id="v_maxBuyPct"></span></div>
          <div class="slider"><span class="l">For the first<small>minutes</small></span><input type="range" min="0" max="240" step="5" data-k="maxBuyMinutes" value="30"><span class="v" id="v_maxBuyMinutes"></span></div>
        </div>

        <div class="fs" id="fsTax"><h3>Taxes</h3><p class="hint">Applied to every buy and sell on top of Rookery's 0.5% $臭企鹅 burn. Max 5% each, 10% total.</p>
          <p class="hint" id="taxNote" style="display:none;border-left:2px solid var(--line2);padding-left:9px">Stellar tokens: these taxes apply on the Rookery curve. After graduation the token trades on Aquarius, where a Stellar asset cannot charge a transfer fee, so trading there is tax-free.</p>
          <div class="slider"><span class="l">Marketing<small><span class="qcur">ZRO</span> to you</small></span><input type="range" min="0" max="5" step="0.25" data-k="taxMarketing" value="1"><span class="v" id="v_taxMarketing"></span></div>
          <div class="slider"><span class="l">Burn<small>of the token</small></span><input type="range" min="0" max="5" step="0.25" data-k="taxBurn" value="0.5"><span class="v" id="v_taxBurn"></span></div>
          <div class="slider"><span class="l">Rewards<small><span class="qcur">ZRO</span> to holders</small></span><input type="range" min="0" max="5" step="0.25" data-k="taxRewards" value="1"><span class="v" id="v_taxRewards"></span></div>
          <div class="split" id="split"></div><div class="mu" style="font-size:12px" id="splitTxt"></div>
        </div>

        <div class="fs"><h3>Dev buy</h3><p class="hint" id="devHint">Optional first buy from your balance in the token's pair currency, in the same transaction as the launch.</p>
          <div class="f" style="max-width:280px"><label id="devLbl">Amount · ZRO</label><input class="inp" data-k="devBuy" inputmode="decimal" placeholder="0"></div>
          <div class="mu" style="font-size:12.5px" id="devTxt"></div>
        </div>
      </div>

      <aside class="preview">
        <div class="mono mu" style="margin-bottom:10px">Preview</div>
        <div id="prev"></div>
        <div class="panel pb" style="margin-top:14px">
          <div class="kv"><span>Creation fee</span><b id="cFee">Free</b></div>
          <div class="kv"><span>Supply</span><b>1,000,000,000</b></div>
          <div class="kv"><span>Starting market cap</span><b id="startMc"></b></div>
          <div class="kv"><span>Bonds at</span><b id="bondMc"></b></div>
          <div class="err" id="cErr"></div>
          <button class="btn lg wide" id="createGo">${S.me ? 'Create token' : 'Log in to create'}</button>
        </div>
      </aside>
    </div>
  </section>`;

  const paint = () => {
    $$('#netPick .opt').forEach(b => b.classList.toggle('on', b.dataset.n === F.network));
    ['maxBuyPct', 'taxMarketing', 'taxBurn', 'taxRewards'].forEach(k => $('#v_' + k).textContent = (+F[k]).toFixed(2) + '%');
    $('#v_maxBuyMinutes').textContent = (+F.maxBuyPct ? F.maxBuyMinutes : 0) + 'm';
    const t = +F.taxMarketing + +F.taxBurn + +F.taxRewards;
    $('#split').innerHTML = `<i style="width:${0.5 * 8}%;background:#fff"></i><i style="width:${F.taxMarketing * 8}%;background:#9b9ba3"></i><i style="width:${F.taxBurn * 8}%;background:#5c5c64"></i><i style="width:${F.taxRewards * 8}%;background:var(--up)"></i>`;
    $('#splitTxt').innerHTML = `Total per trade <b class="${t > 10 ? 'dn' : ''}" style="color:${t > 10 ? '' : 'var(--tx)'}">${(t + 0.5).toFixed(2)}%</b> · 0.5% $臭企鹅 burn · ${F.taxMarketing}% to you · ${F.taxBurn}% burned · ${F.taxRewards}% shared with holders`;
    const zu = S.stats?.zroUsd || 1.5, c = S.stats?.curve;
    const endMult = c ? (Number(c.vTok) * 1e9) / ((Number(c.vTok) - 8e8) ** 2) : 14.4;           // final mcap / virtual reserve
    const startMc = F.network === 'stellar' ? (S.stats?.stellar?.gradUsd || 46000) / endMult * (c ? 1e9 / Number(c.vTok) : 0.93)
      : c ? (Number(c.vZro) / Number(c.vTok)) * 1e9 * zu : 0;
    $('#startMc').textContent = fmtUsd(startMc);
    $('#bondMc').textContent = F.network === 'stellar' ? fmtUsd(S.stats?.stellar?.gradUsd || 46000) : c ? fmtUsd(Number(c.vZro) * endMult * zu) : '—';
    const pq = netCur(F.network);
    $$('.qcur').forEach(e => (e.textContent = ASSET[pq].label));
    const tn = $('#taxNote'); if (tn) tn.style.display = F.network === 'stellar' ? 'block' : 'none';
    $('#pairBox').innerHTML = pq === 'xlm'
      ? `<button class="opt on" disabled style="opacity:1;cursor:default"><span class="zro-ico" style="width:26px;height:26px;font-size:12px">X</span><div><b>Pair: XLM</b><small>Stellar tokens trade in XLM</small></div></button>
      <button class="opt" disabled><span class="net-ico st"><img src="/assets/chains/stellar.svg" alt=""></span><div><b>Graduates to Aquarius</b><small>At ${fmtUsd(S.stats?.stellar?.gradUsd || 46000)} market cap · LP burned</small></div></button>`
      : `<button class="opt on" disabled style="opacity:1;cursor:default"><span class="zro-ico" style="width:26px;height:26px;font-size:12px">${ASSET[pq].ico}</span><div><b>Pair: ${ASSET[pq].label}</b><small>${pq === 'eth' ? 'GIWA tokens trade in ETH' : pq === 'zltc' ? 'LitVM tokens trade in zkLTC · buy now with ETH' : 'Zero tokens trade in ZRO'}</small></div></button>
      <button class="opt" disabled><span class="net-ico all">⇄</span><div><b>Buy with ${pq === 'eth' ? 'ZRO' : 'ETH'} too</b><small>One button, instant conversion</small></div></button>`;
    $('#devLbl').textContent = 'Amount · ' + ASSET[pq].label;
    $('#devTxt').textContent = F.devBuy && S.me ? `Balance: ${fmtA(S.me[pq] || '0', pq)}` : '';
    $('#prev').innerHTML = cardHTML({
      id: '', name: F.name || 'Your token', symbol: F.symbol || 'TICKER', description: F.description, image: F.image,
      network: F.network, creator: S.me?.username || 'you', created: Date.now(), mcapUsd: startMc, change24h: 0, progress: 0,
      holders: 0, trades: 0, graduated: false,
    }).replace('<a class="card" href="#/t/">', '<div class="card" style="cursor:default">').replace(/<\/a>\s*$/, '</div>');
    // Robinhood Chain: the token contract is deployed from the creator's wallet in the launch transaction
    const onc = F.network === 'robinhood' && S.rh?.live;
    $('#fsProt').style.display = onc ? 'none' : '';
    $('#cFee').textContent = onc ? 'Gas only (~$0.01)' : 'Free';
    if (onc) {
      const qs = S.rh.quotes || [{ symbol: 'ETH', name: 'Ether', address: '0x0000000000000000000000000000000000000000' }];
      const cur = qs.find(q => q.address === F.rhQuote) || qs[0];
      F.rhQuote = cur.address;
      const opt = (q) => `<option value="${esc(q.address)}" ${q.address === cur.address ? 'selected' : ''}>${esc(q.symbol)} · ${esc(q.name)}${q.usd ? ' · $' + (q.usd >= 100 ? q.usd.toFixed(0) : q.usd.toFixed(2)) : ''}</option>`;
      const stocks = qs.filter(q => !['ETH', 'USDG'].includes(q.symbol)).sort((a, b) => a.symbol.localeCompare(b.symbol));
      $('#pairBox').innerHTML = `<div class="rh-pair" style="grid-column:1/-1">
        <label class="mono mu" style="font-size:11px;letter-spacing:.06em">PAIR WITH</label>
        <select class="inp" id="rhPair" style="margin-top:6px">
          <optgroup label="Crypto">${qs.filter(q => ['ETH', 'USDG'].includes(q.symbol)).map(opt).join('')}</optgroup>
          <optgroup label="Robinhood Stock Tokens (${stocks.length})">${stocks.map(opt).join('')}</optgroup>
        </select>
        <small class="mu" style="display:block;margin-top:6px;font-size:11.5px;line-height:1.5">${cur.symbol === 'ETH' ? 'Buyers pay in ETH.' : `Buyers pay in <b>ETH</b>: Uniswap swaps it to ${esc(cur.symbol)} inside the same transaction.${S.rh?.zap ? '' : ` They can also pay in ${esc(cur.symbol)} itself.`}`} The token is a real ERC-20 from block one and graduates to a Uniswap V2 pool with the LP burned.</small></div>`;
      $('#rhPair').onchange = (e) => { F.rhQuote = e.target.value; paint(); };
      const devCur = (cur.symbol === 'ETH' || !S.rh?.zap) ? cur.symbol : 'ETH';
      $('#devTxt').textContent = '';
      $('#devLbl').textContent = 'Amount · ' + devCur;
      $('#devHint').textContent = cur.symbol === 'ETH'
        ? 'Optional first buy in ETH from your wallet, in the same transaction that deploys the token. Bought tokens land in your wallet.'
        : `Optional first buy in ETH: it is swapped to ${cur.symbol} on Uniswap inside the same transaction that deploys the token. You never touch ${cur.symbol} yourself.`;
      const ql = $$('.qcur'); if (ql[0]) ql[0].textContent = cur.symbol; if (ql[1]) ql[1].textContent = '$' + (F.symbol || 'TOKEN');
      const tn = $('#taxNote'); tn.style.display = 'block';
      tn.textContent = 'Robinhood Chain: these taxes apply on the bonding curve AND keep applying on Uniswap after graduation. On the curve marketing is paid in the pair asset; on Uniswap it is paid in your token. Rewards go to holders in your token: they land in wallets on the next transfer or with one claim. Wallet-to-wallet transfers are never taxed.';
    } else {
      $('#devHint').textContent = "Optional first buy from your balance in the token's pair currency, in the same transaction as the launch.";
    }
    $('#createGo').textContent = onc ? 'Create from wallet' : (S.me ? 'Create token' : 'Log in to create');
  };
  $$('[data-k]').forEach(el => el.oninput = () => { F[el.dataset.k] = el.value; paint(); });
  $$('#netPick .opt').forEach(b => b.onclick = () => { F.network = b.dataset.n; paint(); });
  $('#upl').onclick = (e) => { if (e.target.id !== 'file') $('#file').click(); };
  $('#file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { F.image = await readImage(f); $('#imgPrev').innerHTML = `<img src="${F.image}" alt="">`; paint(); }
    catch (err) { toast(esc(err.message), 'bad'); }
  };
  $('#createGo').onclick = async () => {
    if (F.network === 'robinhood' && S.rh?.live) return RHW.create(F);
    if (!S.me) return needLogin();
    $('#cErr').textContent = '';
    try {
      $('#createGo').disabled = true;
      const r = await api('/markets', { ...F, devBuy: toWei(F.devBuy).toString() });
      toast(`<b>$${esc(F.symbol)}</b> is live on Rookery`);
      loadMe(); location.hash = `#/t/${r.id}`;
    } catch (e) { $('#cErr').textContent = e.message; }
    finally { $('#createGo').disabled = false; }
  };
  if (hatch) {
    $$('[data-k]').forEach(el => { if (F[el.dataset.k]) el.value = F[el.dataset.k]; });
    $('#hatchNote').innerHTML = `<div class="note-hatch"><b>🥚 You announced $${esc(hatch.symbol)}</b>
      <span>${hatch.waiting} penguin${hatch.waiting === 1 ? '' : 's'} waiting · ${hatch.status === 'live' ? 'it is live, launch it now' : 'hatches in ' + cdText(hatch.launchAt - Date.now())}. Launching here replaces the countdown with the real token.</span></div>`;
  }
  paint();
}

/* ═══════════ POINTS & REFERRALS ═══════════ */
async function viewPoints() {
  document.title = 'Points — Rookery';
  let d = { top: [], tiers: [], me: null };
  try { d = await api('/points'); } catch (e) { /* still show the page */ }
  const tiers = d.tiers && d.tiers.length ? d.tiers : [];
  const me = d.me;
  const nextOf = (t) => tiers.find(x => x.min > t) || null;
  const pct = (t) => { const n = nextOf(t); if (!n) return 100; const cur = [...tiers].reverse().find(x => t >= x.min) || tiers[0]; return Math.max(4, Math.min(100, ((t - cur.min) / (nextOf(t).min - cur.min)) * 100)); };
  const refLink = me ? `${location.origin}/?ref=${encodeURIComponent(me.ref.code)}#/signup` : '';
  app.innerHTML = `
  <section class="wrap page">
    <div class="page-h"><div><h1>Points</h1>
      <p>A counter for people who actually use the launchpad. Trade, hatch, bond, hold, bring friends. Nothing here is money — points buy priority at mainnet, nothing else.</p></div>
      ${me ? `<div style="text-align:right"><span class="mono mu">Your points</span><div class="bal-xl">${me.total.toLocaleString('en-US')}</div>
        <span class="mono mu">rank #${me.rank}</span></div>` : ''}
    </div>

    ${me ? `<div class="pts-grid">
      <div class="panel pb pts-me">
        <div class="pts-top"><div><span class="mono mu">Tier</span><b class="pts-tier">${esc(me.tier.label)}</b></div>
          <div><span class="mono mu">Next tier</span><b>${nextOf(me.total) ? `${esc(nextOf(me.total).label)} · ${(nextOf(me.total).min - me.total).toLocaleString('en-US')} to go` : 'top tier'}</b></div></div>
        <div class="prog big" style="margin:12px 0"><i style="width:${pct(me.total)}%"></i></div>
        <p class="mu" style="font-size:12.5px">${esc(me.tier.perk)}${nextOf(me.total) ? ` · next: ${esc(nextOf(me.total).perk)}` : ''}</p>
        <div class="pts-break">
          <div><span class="mono mu">Trading</span><b>${me.trade.toLocaleString('en-US')}</b></div>
          <div><span class="mono mu">Hatches</span><b>${me.hatch.toLocaleString('en-US')}</b></div>
          <div><span class="mono mu">Bonding</span><b>${me.bond.toLocaleString('en-US')}</b></div>
          <div><span class="mono mu">Holding</span><b>${me.hold.toLocaleString('en-US')}</b></div>
          <div><span class="mono mu">Referrals</span><b>${me.referral.toLocaleString('en-US')}</b></div>
        </div>
      </div>
      <div class="panel pb">
        <span class="mono mu">Referrals</span>
        <p style="font-size:13px;color:var(--tx2);margin:8px 0 12px">Share your link: they get a welcome bonus, and you keep <b style="color:var(--tx)">20% of the platform fee</b> from everything they trade. Paid to your balance, in the token's pair currency.</p>
        <div class="addr"><span style="flex:1;overflow:hidden;text-overflow:ellipsis">${esc(refLink)}</span><button class="btn sm ghost" id="copyRef">Copy</button></div>
        <div class="pts-break" style="margin-top:12px">
          <div><span class="mono mu">Invited</span><b>${me.ref.invited}</b></div>
          <div><span class="mono mu">Earned</span><b>${fmtUsd(me.ref.earnedUsd)}</b></div>
        </div>
      </div>
    </div>` : `<div class="panel pb" style="margin-bottom:18px"><b>Log in</b> to see your points and your referral link. <a href="#/login" style="text-decoration:underline;color:var(--tx)">Log in</a></div>`}

    <div class="panel" style="margin-top:18px">
      <div class="panel-h"><h3>How points are earned</h3></div>
      <div class="pb"><table class="tbl"><tbody>
        <tr><td>Every trade</td><td class="r mu">10 points per $1 of volume</td></tr>
        <tr><td>Announcing a hatch</td><td class="r mu">250 points</td></tr>
        <tr><td>Turning a hatch into a token</td><td class="r mu">500 points</td></tr>
        <tr><td>Your token reaching 100%</td><td class="r mu">5,000 points</td></tr>
        <tr><td>Holding bags, per day</td><td class="r mu">0.1 point per $1 held, max 500</td></tr>
        <tr><td>Someone joining with your link</td><td class="r mu">500 points, and 10% of their trade points</td></tr>
      </tbody></table></div>
    </div>

    <div class="panel" style="margin-top:18px">
      <div class="panel-h"><h3>Tiers at mainnet</h3></div>
      <div class="pb"><div class="tier-row">${tiers.map(t => `<div class="tier ${me && me.tier.id === t.id ? 'on' : ''}">
        <span class="mono mu">${t.min === 0 ? 'from 0' : t.min.toLocaleString('en-US') + '+'}</span>
        <b>${esc(t.label)}</b><span class="mu">${esc(t.perk)}</span></div>`).join('')}</div></div>
    </div>

    <div class="panel" style="margin-top:18px">
      <div class="panel-h"><h3>Leaderboard</h3><span class="mu" style="font-size:12px">top 25</span></div>
      ${d.top.length ? `<div style="overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>Trader</th><th class="r">Points</th><th class="r hide-s">Trading</th><th class="r hide-s">Hatches</th><th class="r hide-s">Holding</th></tr></thead><tbody>
        ${d.top.map((t, i) => `<tr class="click" onclick="location.hash='#/u/${encodeURIComponent(t.username)}'">
          <td class="mu">${i + 1}</td><td><b>${esc(t.username)}</b>${badgeHTML(t.badges)}</td>
          <td class="r"><b>${t.total.toLocaleString('en-US')}</b></td>
          <td class="r hide-s mu">${t.trade.toLocaleString('en-US')}</td>
          <td class="r hide-s mu">${t.hatch.toLocaleString('en-US')}</td>
          <td class="r hide-s mu">${t.hold.toLocaleString('en-US')}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty" style="border:0;margin:14px">No points yet. Trade something and you are on the board.</div>'}
    </div>

    <p class="mu" style="font-size:12px;line-height:1.7;margin:18px 0 40px;max-width:820px">
      Points are a loyalty counter, not a token, not a security and not a promise of money or profit. They are not transferable and carry no guaranteed value.
      What they give you is standing inside Rookery: a place in the migration snapshot and priority in the day-one pools we seed. Referral rewards are paid out of the 0.5% platform fee, so on trades from referred users the buy &amp; burn reserve receives the remaining 0.4%.
    </p>
  </section>`;
  const cp = $('#copyRef');
  if (cp) cp.onclick = () => { navigator.clipboard.writeText(refLink); toast('Referral link copied'); };
}

/* ═══════════ WALLET ═══════════ */
async function viewWallet() {
  document.title = 'Wallet — Rookery';
  if (!S.me) return needLogin();
  let me = S.me, asset = ['eth', 'xlm'].includes(localStorage.getItem('pl_wallet_asset')) ? localStorage.getItem('pl_wallet_asset') : 'zro';
  const stExp = S.stats.stellar?.explorer || 'https://stellar.expert/explorer/public';
  const allChains = { ...S.stats.chains, stellar: { label: 'Stellar', explorer: stExp } }, ethChains = S.stats.ethChains || ['ethereum', 'base', 'arbitrum'];
  const chainsOf = (a) => Object.fromEntries(Object.entries(allChains).filter(([k]) => (a === 'xlm' ? k === 'stellar' : k !== 'stellar' && (a === 'zro' || ethChains.includes(k)))));
  const stToks = () => (me.holdings || []).filter(x => x.stellar?.withdrawable);
  let wAsset = 'xlm';
  let chain = 'base';
  app.innerHTML = `
  <section class="wrap page">
    <div class="page-h"><div><h1>Wallet</h1><p>Deposit ZRO, ETH or XLM, trade any token, withdraw instantly.</p></div>
      <div style="text-align:right"><span class="mono mu">Balances</span><div class="bal-xl" id="bal"></div></div></div>
    <div id="pnlHero"></div>
    <div class="pay-sel" id="assetSel" style="margin:0 0 14px"><span class="mu">Currency</span><button data-a="zro">ZRO</button><button data-a="eth">ETH</button><button data-a="xlm">XLM</button></div>
    <div class="panel pb" id="ltcDep" style="margin:0 0 14px">
      <div style="display:flex;align-items:center;gap:10px"><span class="net-ico ltc" style="width:34px;height:34px"><img src="/assets/chains/litecoin.svg" alt="LTC"></span>
        <div><h3 style="font-size:16px;margin:0">Deposit LTC</h3><p class="mu" style="font-size:12.5px;margin:2px 0 0">Send Litecoin, get a balance you can trade with. Credited at the value that actually arrives, about 1–2% goes to the bridge.</p></div></div>
      <div id="ltcAddrBox" style="margin-top:12px"></div>
      <div id="ltcList" class="mu" style="font-size:12px;margin-top:8px"></div>
      <hr class="sep">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px"><b style="font-size:14px">Withdraw LTC</b><span class="mu" style="font-size:12px">paid out through the same bridge, min 0.01 LTC</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="inp" id="ltcWAmt" inputmode="decimal" placeholder="0.01" style="max-width:150px">
        <input class="inp" id="ltcWTo" placeholder="Your Litecoin address (ltc1… or L…)" style="flex:1;min-width:240px">
        <button class="btn ghost" id="ltcWGo">Withdraw</button></div>
      <div id="ltcWOut" style="margin-top:8px"></div>
    </div>
    <div class="wallet">
      <div class="panel pb">
        <h3 style="font-size:16px;margin-bottom:4px" id="dTitle"></h3><p class="mu" style="font-size:13px;margin-bottom:16px" id="dSub"></p>
        <div class="chains" id="dChains"></div>
        <div style="display:flex;gap:16px;align-items:flex-start">
          <div class="qr" id="qr"></div>
          <div style="flex:1;min-width:0">
            <div class="addr"><span style="flex:1" id="dAddr"></span><button class="btn sm ghost" id="copy">Copy</button></div>
            <div class="addr st-memo" id="dMemoBox" style="display:none;margin-top:8px"><span class="mono mu" style="letter-spacing:.1em">MEMO</span><b id="dMemo" style="flex:1;font-size:18px"></b><button class="btn sm ghost" id="copyMemo">Copy</button></div>
            <div class="warn"><span>⚠</span><span id="dWarn"></span></div>
            <button class="btn ghost wide" id="chk" style="margin-top:12px">Check for deposits</button>
          </div>
        </div>
      </div>
      <div class="panel pb">
        <h3 style="font-size:16px;margin-bottom:4px" id="wTitle"></h3><p class="mu" style="font-size:13px;margin-bottom:16px" id="wSub"></p>
        <div class="f"><label>Network</label><select class="inp" id="wChain"></select></div>
        <div class="f" id="wAssetF" style="display:none"><label>What to withdraw</label><select class="inp" id="wAsset"></select></div>
        <div class="f"><label>Destination address</label><input class="inp" id="wTo" placeholder="0x…" autocomplete="off"></div>
        <div class="f" id="wMemoF" style="display:none"><label>Memo <em class="mu" style="font-style:normal;text-transform:none;letter-spacing:0">needed when withdrawing to an exchange</em></label><input class="inp" id="wMemo" maxlength="28" placeholder="optional" autocomplete="off"></div>
        <div class="f"><label id="wAmtLbl">Amount</label><div class="amt" style="height:50px"><input id="wAmt" inputmode="decimal" placeholder="0.0"><button class="btn sm ghost" id="wMax">MAX</button></div>
          <span class="mu" style="font-size:12px" id="wUsd"></span></div>
        <div class="est" id="wEst" style="margin:4px 0 12px"></div>
        <div class="err" id="wErr"></div>
        <button class="btn lg wide" id="wGo">Withdraw</button>
        <p class="mu" style="font-size:11.5px;margin-top:10px">The network fee covers on-chain gas and is deducted from the amount.</p>
      </div>
    </div>
    <div class="panel pb" style="margin-top:18px;display:flex;align-items:center;gap:16px;flex-wrap:wrap" id="linkBox"></div>
    <div class="panel pb snb-card" style="margin-top:18px">
      <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:240px">
        <div class="snb-ico">⌁</div>
        <div><b style="font-size:15px">RookerySniperBot</b> <span class="mono mu" style="font-size:10.5px;letter-spacing:.1em;margin-left:6px">TELEGRAM</span>
          <p class="mu" style="font-size:13px;margin:3px 0 0">Trade and snipe every Rookery token from Telegram with this same balance. Live PnL terminal after every buy.</p></div>
      </div>
      <button class="btn" id="snbGo">Connect Telegram</button>
    </div>
    <div class="panel" style="margin-top:18px">
      <div class="panel-h"><h3>Holdings</h3><div class="pnl-sum" id="pnlSum"></div></div><div id="hold"></div>
    </div>
    <div class="panel" style="margin-top:18px">
      <div class="panel-h"><h3>History</h3></div><div style="overflow:auto"><table class="tbl" id="hist"><thead><tr><th>Type</th><th>Network</th><th class="r">Amount</th><th>Status</th><th>Tx</th><th class="r">When</th></tr></thead><tbody></tbody></table></div>
    </div>
  </section>`;
  const addrOf = () => (asset === 'eth' ? me.ethDepositAddress : asset === 'xlm' ? me.stellarDeposit?.address : me.depositAddress) || '';
  const paintQR = () => {
    if (!window.qrcode || !addrOf()) return;
    const q = window.qrcode(0, 'M'); q.addData(addrOf()); q.make();
    $('#qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0 });
  };
  let fees = {}, ethFees = {};
  const feeOf = (c) => (asset === 'eth' ? ethFees[c] : asset === 'xlm' ? { ok: true, xlm: wAsset === 'xlm' ? 0.05 : 0, usd: (wAsset === 'xlm' ? 0.05 : 0) * assetUsd('xlm') } : fees[c]);
  const paintAsset = () => {
    const A = ASSET[asset].label, ch = chainsOf(asset);
    if (!ch[chain]) chain = Object.keys(ch)[0];
    $$('#assetSel button').forEach(b => b.classList.toggle('on', b.dataset.a === asset));
    $('#dTitle').textContent = 'Deposit ' + A;
    $('#dSub').textContent = asset === 'eth' ? 'Your personal ETH address. Same address on Ethereum, Base and Arbitrum.' : asset === 'xlm' ? 'Send XLM to the Rookery Stellar address with your personal memo.' : 'Your personal deposit address. Same address on every network below.';
    $('#dMemoBox').style.display = asset === 'xlm' ? '' : 'none';
    $('#dMemo').textContent = me.stellarDeposit?.memo || '—';
    $('#wMemoF').style.display = asset === 'xlm' ? '' : 'none';
    $('#wAssetF').style.display = asset === 'xlm' && stToks().length ? '' : 'none';
    $('#wAsset').innerHTML = `<option value="xlm">XLM</option>` + stToks().map(x => `<option value="t:${x.id}">$${esc(x.symbol)} · ${fmtT(x.amount)} (Stellar ${esc(x.stellar.code)})</option>`).join('');
    $('#wAsset').value = wAsset;
    $('#wTo').placeholder = asset === 'xlm' ? 'G…' : '0x…';
    $('#dChains').innerHTML = Object.entries(ch).map(([k, v]) => `<button data-c="${k}" class="${k === chain ? 'on' : ''}">${esc(v.label)}</button>`).join('');
    $$('#dChains button').forEach(b => b.onclick = () => { chain = b.dataset.c; $$('#dChains button').forEach(x => x.classList.toggle('on', x === b)); $('#cName').textContent = allChains[chain].label; });
    $('#dAddr').textContent = addrOf();
    $('#dWarn').innerHTML = asset === 'xlm'
      ? `${me.stellarDeposit?.net === 'testnet' ? '<span style="display:block;margin-bottom:8px;padding:8px 10px;border:1px solid var(--dn);color:var(--dn);border-radius:6px;font-weight:600">TESTNET ONLY — this is a test site. Do NOT send real XLM here, it will not be credited. Use rookery.stinkypenguin.xyz.</span>' : ''}Always add memo <b>${esc(me.stellarDeposit?.memo || '')}</b> (memo type ID). Without it the deposit cannot be credited automatically. Send only native <b>XLM</b> on Stellar${me.stellarDeposit?.net === 'testnet' ? ' <b>testnet</b>' : ''}. Credited within about a minute.`
      : asset === 'eth'
      ? `Send only native <b>ETH</b> on <b id="cName">${esc(allChains[chain].label)}</b>. Do not send ZRO or other tokens to this address. Deposits appear after the transfer confirms.`
      : `Send only <b>ZRO</b> (<span class="mono" style="font-size:10px;letter-spacing:0">${short(S.stats.zroToken)}</span>) on <b id="cName">${esc(allChains[chain].label)}</b>. Other tokens sent here are lost. Deposits appear after the transfer confirms.`;
    $('#wTitle').textContent = 'Withdraw ' + A;
    $('#wSub').textContent = `Sent instantly on the network you pick. A small network fee in ${A} covers gas.`;
    $('#wAmtLbl').textContent = 'Amount · ' + A;
    $('#wChain').innerHTML = Object.entries(ch).map(([k, v]) => { const f = feeOf(k); return `<option value="${k}">${esc(v.label)}${f && f.ok === false ? ' (unavailable)' : ''}</option>`; }).join('');
    const cur = feeOf($('#wChain').value);
    if (cur && cur.ok === false) { const good = [...$('#wChain').options].find(o => feeOf(o.value)?.ok); if (good) $('#wChain').value = good.value; }
    $('#wAmt').value = ''; paintQR(); paintFee();
  };
  const paint = () => {
    $('#bal').innerHTML = [['zro', fmtZ(me.zro, 4), me.zroUsd], ['eth', fmtZ(me.eth || '0', 6), me.ethUsd || 0], ['xlm', fmtZ(me.xlm || '0', 4), me.xlmUsd || 0]]
      .map(([a, v, u]) => `<div class="brow"><b>${v}</b><small>${ASSET[a].label} · ${fmtUsd(u)}</small></div>`).join('');
    $('#linkBox').innerHTML = me.wallet
      ? `<span style="font-size:20px">◈</span><div><b>Linked wallet</b><div class="mono" style="letter-spacing:0;font-size:12px;color:var(--tx2);margin-top:3px">${esc(me.wallet)}</div></div>
         <span class="mu" style="font-size:12.5px">You can log in with this wallet${me.email ? ' or with ' + esc(me.email) : ''}.</span>
         <button class="btn sm ghost" id="wToMine" style="margin-left:auto">Withdraw to this wallet</button>`
      : `<span style="font-size:20px">◈</span><div><b>Link a wallet</b><div class="mu" style="font-size:12.5px;margin-top:3px">Log in with MetaMask or Rabby next time, and withdraw to it in one click.</div></div>
         <button class="btn sm" id="linkW" style="margin-left:auto">Link wallet</button>`;
    const lw = $('#linkW'); if (lw) lw.onclick = async () => { if (await walletSignIn(true)) { me = S.me; paint(); } };
    const wm = $('#wToMine'); if (wm) wm.onclick = () => { $('#wTo').value = me.wallet; $('#wAmt').focus(); };
    const paintHold = () => {
    $('#hold').innerHTML = me.holdings.length ? `<table class="tbl"><thead><tr>${thSort('Token', 'token', false)}${thSort('Amount', 'amount')}${thSort('Price', 'price')}${thSort('Value', 'value')}${me.pnl ? thSort('PnL', 'pnl') : ''}${thSort('Rewards', 'rewards')}</tr></thead><tbody>
      ${sortHoldings(me.holdings).map(x => `<tr class="click" onclick="location.hash='#/t/${x.id}'"><td><div class="tok-cell">${timg(x)}<b>${esc(x.symbol)}</b></div></td>
        <td class="r">${fmtT(x.amount)}</td><td class="r">${fmtUsd(x.priceUsd)}</td><td class="r">${fmtUsd(x.valueUsd)}</td>${me.pnl ? `<td class="r">${x.pnlUsd === undefined ? '<span class="mu">—</span>' : sUsd(x.pnlUsd) + `<div style="font-size:11px;display:flex;gap:8px;justify-content:flex-end;align-items:center">${x.pnlPct != null ? fmtPct(x.pnlPct) : ''}${shareBtn(`data-share="${x.id}"`)}</div>`}</td>` : ''}<td class="r">${fmtZ(x.pendingRewards, x.quote === 'ETH' ? 6 : 4)} ${esc(x.quote || 'ZRO')}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty" style="border:0;margin:14px">No tokens yet.</div>';
    bindSort($('#hold'), paintHold);
    const P = me.pnl;
    $('#pnlSum').innerHTML = P && P.positions ? `<div><span class="mono mu">Total PnL</span><b>${sUsd(P.totalUsd)}${P.pct != null ? ' ' + fmtPct(P.pct) : ''}</b></div>
      <div><span class="mono mu">Open</span><b>${sUsd(P.openUsd)}</b></div><div><span class="mono mu">Closed</span><b>${sUsd(P.closedUsd)}</b></div>
      <div class="hide-xs"><span class="mono mu">Bought</span><b>${fmtUsd(P.boughtUsd)}</b></div>` : '';
    const best = P && me.holdings.filter(x => x.pnlUsd !== undefined).sort((a, b) => b.pnlUsd - a.pnlUsd)[0];
    $('#pnlHero').innerHTML = P && P.positions ? `<div class="pnl-hero ${P.totalUsd >= 0 ? 'win' : 'loss'}">
      <div class="ph-k"><span class="mono mu">Your PnL</span><b>${sUsd(P.totalUsd)}</b>${P.pct != null ? `<span class="ph-p">${fmtPct(P.pct)}</span>` : ''}</div>
      ${best ? `<div class="ph-k hide-xs"><span class="mono mu">Best bag</span><b>$${esc(best.symbol)} ${sUsd(best.pnlUsd)}</b></div>` : ''}
      <div class="ph-a">${laserBtn('data-share="__all"')}${best ? laserBtn(`data-share="${best.id}"`, `Share $${esc(best.symbol)}`) : ''}</div>
    </div>` : '';
    $$('[data-share]').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      const id = b.dataset.share;
      const rank = me.holdings.filter(y => y.pnlUsd !== undefined).map(y => ({ id: y.id, symbol: y.symbol, image: y.image, pnlUsd: y.pnlUsd, pnlPct: y.pnlPct, valueUsd: y.valueUsd }));
      const common = { user: me.username, rank, totalUsd: P.totalUsd, totalPct: P.pct };
      if (id === '__all') return openShare({ kind: 'total', ...common, pnlUsd: P.totalUsd, pnlPct: P.pct, boughtUsd: P.boughtUsd, openUsd: P.openUsd, positions: P.positions });
      const x = me.holdings.find(y => y.id === id); if (!x) return;
      openShare({ kind: 'token', ...common, id: x.id, symbol: x.symbol, name: x.name, image: x.image, pnlUsd: x.pnlUsd, pnlPct: x.pnlPct, costUsd: x.costUsd, valueUsd: x.valueUsd });
    });
    };
    paintHold();
    $('#hist tbody').innerHTML = me.transfers.length ? me.transfers.map(t => { const a = ['eth', 'xlm'].includes(t.asset) ? t.asset : 'zro'; const isTok = String(t.asset || '').startsWith('t:'); return `<tr>
      <td>${t.kind === 'deposit' ? 'Deposit' : 'Withdrawal'}</td><td>${esc(allChains[t.chain]?.label || t.chain)}</td>
      <td class="r">${t.kind === 'deposit' ? '+' : '−'}${isTok ? fmtT(t.amount) + ' tokens' : fmtA(t.amount, a)}</td><td><span class="st-tag ${esc(t.status)}">${esc(t.status)}</span></td>
      <td>${t.txid ? `<a href="${allChains[t.chain]?.explorer}/${t.chain === 'stellar' && t.kind === 'deposit' ? 'op' : 'tx'}/${esc(t.txid)}" target="_blank" rel="noopener" class="mono" style="letter-spacing:0">${short(t.txid)} ↗</a>` : `<span class="mu" style="font-size:12px">${esc(t.note || '')}</span>`}</td>
      <td class="r mu">${ago(t.ts)}</td></tr>`; }).join('') : `<tr><td colspan="6"><div class="empty" style="border:0">No transfers yet.</div></td></tr>`;
  };
  $$('#assetSel button').forEach(b => b.onclick = () => { asset = b.dataset.a; localStorage.setItem('pl_wallet_asset', asset); paintAsset(); });
  $('#snbGo').onclick = async () => {
    const w = window.open('', '_blank');
    try { const r = await api('/snb/link', {}); if (w) w.location = r.url; else location.href = r.url; }
    catch (e) { if (w) w.close(); toast(esc(e.message), 'bad'); }
  };
  $('#copy').onclick = () => { navigator.clipboard.writeText(addrOf()); toast('Address copied'); };
  $('#copyMemo').onclick = () => { navigator.clipboard.writeText(me.stellarDeposit?.memo || ''); toast('Memo copied'); };
  $('#wAsset').onchange = () => { wAsset = $('#wAsset').value; $('#wAmt').value = ''; paintFee(); };
  const check = async (manual) => {
    try {
      const r = await api('/wallet/check', {});
      if (r.found?.length) { r.found.forEach(f => toast(`Deposit received: <b>${fmtA(f.amount, f.asset === 'eth' ? 'eth' : 'zro')}</b> on ${esc(allChains[f.chain]?.label || f.chain)}`)); }
      else if (manual) toast('No new deposits yet. Deposits are detected automatically within about a minute.');
      me = S.me = await api('/me?pnl=1'); paint(); paintAcct();
    } catch (e) { if (manual) toast(esc(e.message), 'bad'); }
  };
  $('#chk').onclick = () => check(true);
  function paintFee() {
    const A = ASSET[asset].label, f = feeOf($('#wChain').value), v = toWei($('#wAmt').value);
    const feeAmt = f ? (asset === 'eth' ? f.eth : asset === 'xlm' ? f.xlm : f.zro) : 0, feeW = f ? toWei(String(feeAmt)) : 0n;
    $('#wUsd').textContent = v > 0n ? '≈ ' + fmtUsd(zNum(v) * assetUsd(asset)) : '';
    const lim = f && f.maxOut !== undefined ? f.maxOut + Number(feeAmt) : null;
    // the network with the most room right now, suggested when the picked one can't pay
    const best = (() => { let b = null; for (const k of Object.keys(chainsOf(asset))) { const g = feeOf(k); if (g && g.ok !== false && g.maxOut !== undefined && (!b || g.maxOut > b.m)) b = { k, m: g.maxOut }; } return b; })();
    const alt = best && best.k !== $('#wChain').value && v > 0n && zNum(v) <= best.m ? ` <a href="#" id="wAlt" style="text-decoration:underline;color:var(--tx)">Use ${esc(allChains[best.k].label)}</a>` : '';
    const warn = f && f.ok === false ? `<div class="kv" style="color:var(--dn)"><span>${esc(allChains[$('#wChain').value].label)} payouts are temporarily unavailable.${alt}</span></div>`
      : (lim !== null && v > 0n && zNum(v) > lim ? `<div class="kv" style="color:var(--dn)"><span>Max on ${esc(allChains[$('#wChain').value].label)} right now: ${lim.toLocaleString('en-US', { maximumFractionDigits: asset === 'eth' ? 5 : 2 })} ${A}.${alt || ' Split it or use another network.'}</span></div>` : '');
    $('#wGo').disabled = asset !== 'xlm' && !!warn;
    $('#wEst').innerHTML = f ? `<div class="kv"><span>Network fee</span><b>${Number(feeAmt).toLocaleString('en-US', { maximumFractionDigits: asset === 'eth' ? 6 : 2 })} ${A} · ${fmtUsd(f.usd)}</b></div>
      <div class="kv"><span>You receive</span><b>${v > feeW ? fmtA((v - feeW).toString(), asset) : '—'}</b></div>${warn}` : '<div class="kv"><span>Network fee</span><b>…</b></div>';
    const wa = $('#wAlt'); if (wa) wa.onclick = (e) => { e.preventDefault(); $('#wChain').value = best.k; paintFee(); };
  }
  api('/wallet/fees').then(r => { fees = r.fees || {}; ethFees = r.eth || {}; paintAsset(); }).catch(() => {});
  $('#wChain').onchange = paintFee;
  $('#wAmt').oninput = paintFee;
  $('#wMax').onclick = () => {
    const tok = asset === 'xlm' && wAsset !== 'xlm' ? stToks().find(x => 't:' + x.id === wAsset) : null;
    $('#wAmt').value = weiToStr(tok ? tok.amount : (me[asset] || '0'), 6); $('#wAmt').oninput();
  };
  $('#wGo').onclick = async () => {
    $('#wErr').textContent = '';
    try {
      $('#wGo').disabled = true; $('#wGo').textContent = 'Sending…';
      const st = asset === 'xlm';
      const r = await api('/wallet/withdraw', { asset: st ? wAsset : asset, chain: $('#wChain').value, to: $('#wTo').value.trim(), amount: toWei($('#wAmt').value).toString(), memo: st ? $('#wMemo').value.trim() : undefined });
      toast(r.pending ? 'Sent, waiting for confirmation' : st ? `Sent <b>${esc(r.sent)} ${wAsset === 'xlm' ? 'XLM' : 'tokens'}</b> · <a href="${r.explorer}" target="_blank" rel="noopener" style="text-decoration:underline">view tx</a>`
        : `Sent <b>${fmtA(r.sent, asset)}</b> (fee ${fmtZ(r.fee, asset === 'eth' ? 6 : 2)}) · <a href="${r.explorer}" target="_blank" rel="noopener" style="text-decoration:underline">view tx</a>`);
      $('#wAmt').value = ''; me = S.me = await api('/me?pnl=1'); paint(); paintAcct();
    } catch (e) { $('#wErr').textContent = e.message; }
    finally { $('#wGo').disabled = false; $('#wGo').textContent = 'Withdraw'; }
  };
  paintAsset(); paint(); if (me.wallet && !$('#wTo').value) $('#wTo').value = me.wallet; check(false);
  const reMe = debounce(async () => { try { me = S.me = await api('/me?pnl=1'); paint(); paintAcct(); } catch { /* next tick */ } }, 600);
  liveSub(['all'], (msg) => { if (me.holdings.some(x => x.id === msg.market.id)) reMe(); });
  setTimer(() => check(false), 20000);
}

/* ═══════════ PROFILE ═══════════ */
async function viewProfile(name) {
  let p;
  try { p = await api('/u/' + encodeURIComponent(name)); } catch (e) { app.innerHTML = `<div class="wrap page"><div class="empty">${esc(e.message)}</div></div>`; return; }
  document.title = `${p.username} — Rookery`;
  let tab = 'holdings';
  app.innerHTML = `
  <section class="wrap page">
    <div class="prof">
      ${avatar(p.username, p.avatar)}
      <div><h1>${esc(p.username)} ${badgeHTML(p.badges, true)}</h1><p class="tx2" style="margin-top:6px;max-width:520px;font-size:14px;line-height:1.6">${esc(p.bio || 'No bio yet.')}</p>
        <span class="mono mu" style="display:block;margin-top:10px">Joined ${new Date(p.joined).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>
        ${p.isMe ? '<button class="btn sm ghost" id="edit" style="margin-top:12px">Edit profile</button>' : ''}</div>
      <div class="prof-stats">
        <div><span class="mono mu">Portfolio</span><b id="pPort">${fmtUsd(p.portfolioUsd)}</b></div>
        <div><span class="mono mu">Volume</span><b id="pVol">${fmtUsd(p.volumeUsd)}</b></div>
        <div><span class="mono mu">Trades</span><b id="pTr">${p.trades}</b></div>
        <div><span class="mono mu">Created</span><b>${p.created.length}</b></div>
        ${p.created.some(m => m.taxes.marketing > 0) ? `<div><span class="mono mu">Creator fees</span><b id="pFee">${fmtUsd(p.creatorEarned?.usd || 0)}</b></div>` : ''}
      </div>
    </div>
    ${p.isMe && p.ref ? `<div class="panel pb ref-card">
      <div class="rc-main"><span class="mono mu">Your referral link</span>
        <div class="addr"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="rcLink">${esc(location.origin)}/?ref=${encodeURIComponent(p.username)}</span><button class="btn sm ghost" id="rcCopy">Copy</button></div>
        <p class="mu" style="font-size:12px;margin-top:8px">They get a welcome bonus, you keep <b style="color:var(--tx)">20% of the platform fee</b> from everything they trade.</p></div>
      <div class="rc-stats"><div><span class="mono mu">Invited</span><b>${p.ref.invited}</b></div>
        <div><span class="mono mu">Earned</span><b>${fmtUsd(p.ref.earnedUsd)}</b></div></div>
    </div>` : ''}
    <div class="panel"><div class="tabs-h" id="ptabs"><button data-t="holdings" class="on">Holdings</button><button data-t="created">Created</button><button data-t="trades">Trades</button></div><div id="pbody"></div></div>
  </section>`;
  const paint = () => {
    const b = $('#pbody');
    if (tab === 'holdings') {
      const hasPrice = p.holdings.some(x => x.priceUsd !== undefined);
      b.innerHTML = p.holdings.length ? `<table class="tbl"><thead><tr>${thSort('Token', 'token', false)}${thSort('Amount', 'amount')}${hasPrice ? thSort('Price', 'price') : ''}${thSort('Value', 'value')}</tr></thead><tbody>${sortHoldings(p.holdings).map(x => `<tr class="click" onclick="location.hash='#/t/${x.id}'">
      <td><div class="tok-cell">${timg(x)}<div><b>${esc(x.symbol)}</b><div class="mu" style="font-size:11.5px">${esc(x.name)}</div></div></div></td><td class="r">${fmtT(x.amount)}</td>${hasPrice ? `<td class="r">${fmtUsd(x.priceUsd)}</td>` : ''}<td class="r"><b>${fmtUsd(x.valueUsd)}</b></td></tr>`).join('')}</tbody></table>`
      : '<div class="empty" style="border:0;margin:14px">No holdings.</div>';
      bindSort(b, paint);
    }
    else if (tab === 'created') {
      const E = p.creatorEarned || { usd: 0, zro: 0, eth: 0 };
      const earnTxt = [E.zro ? fmtZ(E.zro, 2) + ' ZRO' : '', E.eth ? fmtZ(E.eth, 5) + ' ETH' : ''].filter(Boolean).join(' + ');
      const hasMkt = p.created.some(m => m.taxes.marketing > 0);
      const holdersUsd = p.created.reduce((a, m) => a + (m.rewardsPaidUsd || 0), 0);
      const hasRew = p.created.some(m => m.taxes.rewards > 0);
      const rows = [...p.created].sort((a, c) => (c.mktPaidUsd || 0) - (a.mktPaidUsd || 0) || (c.rewardsPaidUsd || 0) - (a.rewardsPaidUsd || 0));
      b.innerHTML = p.created.length ? `<div class="pb" style="padding-bottom:0">
        <div class="earn-h">
          <div class="earn-k">${hasMkt
            ? `<div><span class="mono mu">Earned from creator taxes</span><b>${fmtUsd(E.usd)}</b>${earnTxt ? `<span class="mu" style="font-size:12.5px">${earnTxt}</span>` : ''}</div>`
            : `<div><span class="mono mu">Creator taxes</span><b class="tx2" style="font-size:17px">No marketing tax on ${p.isMe ? 'your' : 'these'} tokens</b><span class="mu" style="font-size:12.5px">${p.isMe ? 'Set one at launch to earn on every buy and sell.' : 'This creator earns nothing from trading fees.'}</span></div>`}
            ${hasRew ? `<div><span class="mono mu">Paid to holders</span><b>${fmtUsd(holdersUsd)}</b><span class="mu" style="font-size:12.5px">from rewards taxes</span></div>` : ''}
          </div>
          <p class="mu" style="font-size:12.5px;max-width:420px">The marketing tax a creator sets at launch is paid to them on every buy and sell, in the token's pair currency. A rewards tax is shared by all holders instead.</p></div>
        <div style="overflow:auto"><table class="tbl"><thead><tr><th>Token</th><th class="r">Taxes</th><th class="r hide-s">Volume</th>${hasRew ? '<th class="r hide-s">Paid to holders</th>' : ''}<th class="r">Creator earned</th></tr></thead><tbody>
        ${rows.map(m => `<tr class="click" onclick="location.hash='#/t/${m.id}'"><td><div class="tok-cell">${timg(m)}<div><b>${esc(m.symbol)}</b><div class="mu" style="font-size:11.5px">${esc(m.name)}</div></div></div></td>
          <td class="r"><span title="marketing / burn / rewards">${m.taxes.marketing}% <span class="mu">mkt</span>${m.taxes.burn ? ` · ${m.taxes.burn}% <span class="mu">burn</span>` : ''}${m.taxes.rewards ? ` · ${m.taxes.rewards}% <span class="mu">rew</span>` : ''}</span></td>
          <td class="r hide-s">${fmtUsd(m.volumeUsd)}</td>${hasRew ? `<td class="r hide-s">${m.taxes.rewards ? fmtUsd(m.rewardsPaidUsd || 0) : '<span class="mu">—</span>'}</td>` : ''}
          <td class="r">${m.taxes.marketing > 0 ? `<b>${fmtUsd(m.mktPaidUsd || 0)}</b><div class="mu" style="font-size:11px">${fmtZ(zNum(m.mktPaid || '0'), m.quote === 'ETH' ? 6 : 2)} ${esc(m.quote)}</div>` : '<span class="mu">no tax</span>'}</td></tr>`).join('')}
        </tbody></table></div></div>
        <div class="grid pb">${p.created.map(cardHTML).join('')}</div>` : '<div class="empty" style="border:0;margin:14px">No tokens created.</div>';
    }
    else b.innerHTML = p.recent.length ? `<table class="tbl"><tbody>${p.recent.map(t => `<tr class="click" onclick="location.hash='#/t/${t.market}'">
      <td><b class="${t.side === 'buy' ? 'up' : 'dn'}">${t.side.toUpperCase()}</b></td><td>${esc(t.symbol)}</td><td class="r">${fmtT(t.tokens)}</td><td class="r">${fmtUsd(zNum(t.zro) * t.usd)}</td><td class="r mu">${ago(t.ts)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty" style="border:0;margin:14px">No trades yet.</div>';
  };
  $$('#ptabs button').forEach(x => x.onclick = () => { tab = x.dataset.t; $$('#ptabs button').forEach(y => y.classList.toggle('on', y === x)); paint(); });
  paint();
  const rc = $('#rcCopy');
  if (rc) rc.onclick = () => { navigator.clipboard.writeText(`${location.origin}/?ref=${encodeURIComponent(p.username)}`); toast('Referral link copied'); };
  // live: when one of this trader's tokens trades, refresh the numbers in place
  const mine = () => new Set([...p.holdings.map(x => x.id), ...p.created.map(x => x.id)]);
  const reP = debounce(async () => {
    try { p = await api('/u/' + encodeURIComponent(name)); } catch { return; }
    liveNum($('#pPort'), p.portfolioUsd, fmtUsd); liveNum($('#pVol'), p.volumeUsd, fmtUsd); liveNum($('#pTr'), p.trades, fmtInt);
    liveNum($('#pFee'), p.creatorEarned?.usd || 0, fmtUsd);
    if (tab !== 'created') paint(); else if (!document.querySelector('#pbody .card:hover')) paint();
  }, 700);
  liveSub(['all'], (msg) => { if (mine().has(msg.market.id)) reP(); });
  setTimer(reP, 30000, true);
  const ed = $('#edit');
  if (ed) ed.onclick = () => {
    let av = null;
    const md = h(`<div class="modal-bg"><div class="modal">
      <h3 style="font-size:20px;letter-spacing:-.03em;margin-bottom:16px">Edit profile</h3>
      <label class="upl" id="aUp">${avatar(p.username, p.avatar).replace('class="av"', 'id="aPrev" class="av" style="width:64px;height:64px"')}<div><b>Change avatar</b><div class="mu" style="font-size:12px">From your computer</div></div><input type="file" id="aFile" accept="image/*" hidden></label>
      <div class="f" style="margin-top:14px"><label>Username</label><input class="inp" id="eU" value="${esc(p.username)}"></div>
      <div class="f"><label>Bio</label><textarea class="inp" id="eB" maxlength="280">${esc(p.bio)}</textarea></div>
      <div class="err" id="eErr"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" id="eX">Cancel</button><button class="btn" id="eS">Save</button></div></div></div>`);
    document.body.appendChild(md);
    $('#aUp', md).onclick = (e) => { if (e.target.id !== 'aFile') $('#aFile', md).click(); };
    $('#aFile', md).onchange = async (e) => { try { av = await readImage(e.target.files[0], 192, 140_000); $('#aPrev', md).innerHTML = `<img src="${av}">`; } catch (er) { toast(esc(er.message), 'bad'); } };
    $('#eX', md).onclick = () => md.remove();
    md.onclick = (e) => { if (e.target === md) md.remove(); };
    $('#eS', md).onclick = async () => {
      try {
        const body = { username: $('#eU', md).value.trim(), bio: $('#eB', md).value };
        if (av) body.avatar = av;
        await api('/me', body); md.remove(); await loadMe(); toast('Profile saved');
        location.hash = `#/u/${encodeURIComponent(body.username)}`; route();
      } catch (er) { $('#eErr', md).textContent = er.message; }
    };
  };
}


/* ───────── live status of wallet buys, bottom-right; survives closing the dialog and reloading the page ───────── */
const TXW = {
  key: 'pl_txw',
  load() { try { return JSON.parse(localStorage.getItem(TXW.key) || '[]'); } catch { return []; } },
  save(list) { try { localStorage.setItem(TXW.key, JSON.stringify(list.slice(-4))); } catch { /* private mode */ } },
  get(id) { return TXW.load().find(x => x.id === id); },
  set(id, patch) {
    const list = TXW.load(), i = list.findIndex(x => x.id === id);
    if (i >= 0) list[i] = { ...list[i], ...patch }; else list.push({ id, ...patch });
    TXW.save(list); TXW.render();
  },
  drop(id) { TXW.save(TXW.load().filter(x => x.id !== id)); TXW.render(); },
  mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; },
  dock() {
    let d = document.getElementById('txDock');
    if (!d) {
      d = document.createElement('div');
      d.id = 'txDock';
      d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9998;display:flex;flex-direction:column;gap:8px;width:min(340px,calc(100vw - 32px))';
      document.body.appendChild(d);
    }
    return d;
  },
  // stage: switch -> sign -> sent -> filled | failed | cancelled | expired
  render() {
    const list = TXW.load(), d = TXW.dock();
    const order = ['switch', 'sign', 'sent', 'filled'];
    d.innerHTML = list.map(t => {
      const end = ['filled', 'failed', 'cancelled', 'expired'].includes(t.stage);
      const at = order.indexOf(t.stage);
      const step = (i, label) => {
        const done = t.stage === 'filled' || (at > i && at >= 0);
        const live = at === i && !end;
        const bad = end && t.stage !== 'filled' && i === Math.max(at, 0);
        const ico = done ? '<span style="color:#3ddc97">✓</span>' : live ? '<span class="txw-spin">◌</span>' : bad ? '<span style="color:#ff5c5c">✕</span>' : '<span class="mu">·</span>';
        return `<div style="display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.45;${!done && !live && !bad ? 'opacity:.55' : ''}"><span style="width:14px;text-align:center">${ico}</span><span>${label}</span></div>`;
      };
      const txLink = t.tx ? ` · <a href="${esc(t.txp ? t.txp + t.tx : t.explorer + '/tx/' + t.tx)}" target="_blank" rel="noopener" style="text-decoration:underline">view tx ↗</a>` : '';
      const head = t.kind === 'bridge' ? (t.stage === 'filled' ? 'Bridged' : end ? 'Not completed' : 'Bridging') : (t.stage === 'filled' ? 'Bought' : end ? 'Not completed' : 'Buying');
      return `<div style="background:#0f0f11;border:1px solid ${t.stage === 'filled' ? '#1f6b4b' : end ? '#6b2a2a' : '#26262c'};border-radius:14px;padding:12px 14px;box-shadow:0 12px 32px rgba(0,0,0,.5)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <b style="font-size:13.5px">${head} ${t.kind === 'bridge' ? esc(t.symbol) : '$' + esc(t.symbol)}</b>
          <span class="mono mu txw-time" data-start="${t.started}" data-end="${t.ended || ''}" style="margin-left:auto;font-size:11.5px">${TXW.mmss((t.ended || Date.now()) - t.started)}</span>
          <button data-x="${t.id}" title="Hide" style="background:none;border:0;color:inherit;opacity:.6;cursor:pointer;font-size:15px;padding:0 0 0 4px">×</button>
        </div>
        ${step(0, t.labels?.[0] || `Switch wallet to ${esc(t.chain)}`)}
        ${step(1, t.labels?.[1] || `Approve ${esc(t.amount)} ${esc(t.unit)} in your wallet`)}
        ${step(2, (t.labels?.[2] || `Payment confirming on ${esc(t.chain)}`) + `${txLink}<br><span class="mu" style="font-size:11.5px">${t.kind === 'bridge' ? 'usually 1–3 minutes' : 'usually about a minute'}</span>`)}
        ${step(3, t.stage === 'filled' ? (t.done || `Received <b>${esc(t.tokens || '')} $${esc(t.symbol)}</b>`) : (t.labels?.[3] || `Tokens land in your Rookery wallet`))}
        ${t.stage === 'filled' ? `<div style="margin-top:8px;font-size:12px;color:#3ddc97">All good. ${t.kind === 'bridge' ? (t.outLink ? `<a href="${esc(t.outLink)}" target="_blank" rel="noopener" style="text-decoration:underline;color:inherit">View delivery ↗</a>` : '') : `<a href="#/wallet" style="text-decoration:underline;color:inherit">Open wallet</a>`}</div>` : ''}
        ${end && t.stage !== 'filled' ? `<div class="mu" style="margin-top:8px;font-size:11.5px;line-height:1.5">${esc(t.note || 'Nothing was charged.')}</div>` : ''}
      </div>`;
    }).join('');
    d.querySelectorAll('[data-x]').forEach(b => b.onclick = () => TXW.drop(/^-?\d+$/.test(b.dataset.x) ? Number(b.dataset.x) : b.dataset.x));
    if (!document.getElementById('txwStyle')) {
      const st = document.createElement('style');
      st.id = 'txwStyle';
      st.textContent = '@keyframes txwspin{to{transform:rotate(360deg)}}.txw-spin{display:inline-block;animation:txwspin 1s linear infinite}';
      document.head.appendChild(st);
    }
  },
  tick() {
    document.querySelectorAll('#txDock .txw-time').forEach(el => {
      const end = Number(el.dataset.end) || Date.now();
      el.textContent = TXW.mmss(end - Number(el.dataset.start));
    });
  },
  // poll the order until it settles (a tagged payment can still land up to an hour after the order expired)
  async watch(id) {
    if (TXW._w?.[id]) return;
    (TXW._w = TXW._w || {})[id] = true;
    const t0 = TXW.get(id)?.started || Date.now();
    while (Date.now() - t0 < 70 * 60e3) {
      await new Promise(r => setTimeout(r, 5000));
      const t = TXW.get(id);
      if (!t || t.stage !== 'sent') break;
      try {
        const r = await api('/wallet/orders');
        const o = (r.orders || []).find(x => x.id === id);
        if (!o) continue;
        if (o.status === 'filled') {
          TXW.set(id, { stage: 'filled', ended: Date.now(), tokens: weiToStr(B(o.tokens || '0'), 2) });
          toast(`Bought <b>${esc(weiToStr(B(o.tokens || '0'), 2))} $${esc(t.symbol)}</b> straight from your wallet`);
          loadMe().catch(() => {});
          setTimeout(() => { const x = TXW.get(id); if (x && x.stage === 'filled') TXW.drop(id); }, 60e3);
          break;
        }
        if (o.status === 'failed' || o.status === 'cancelled') {
          TXW.set(id, { stage: o.status, ended: Date.now(), note: (o.note || 'Order ' + o.status) + '. Anything that arrived stays on your Rookery balance.' });
          loadMe().catch(() => {});
          break;
        }
      } catch { /* keep watching */ }
    }
    delete TXW._w[id];
  },
  resume() {
    TXW.render();
    for (const t of TXW.load()) if (t.stage === 'sent') (t.kind === 'bridge' ? BRG.watch(t.id) : TXW.watch(t.id));
    // finished cards from an earlier visit only need to be seen once
    for (const t of TXW.load()) if (['filled', 'cancelled'].includes(t.stage) && Date.now() - (t.ended || 0) > 10 * 60e3) TXW.drop(t.id);
    if (!TXW._timer) TXW._timer = setInterval(TXW.tick, 1000);
  },
};

/* ───────── EVM wallets: one-signature buys with ETH or ZRO from any EVM chain Rookery scans ───────── */
const EVM_ADD = {
  1: { chainName: 'Ethereum', rpcUrls: ['https://ethereum-rpc.publicnode.com'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://etherscan.io'] },
  8453: { chainName: 'Base', rpcUrls: ['https://mainnet.base.org'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://basescan.org'] },
  42161: { chainName: 'Arbitrum One', rpcUrls: ['https://arb1.arbitrum.io/rpc'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://arbiscan.io'] },
  56: { chainName: 'BNB Chain', rpcUrls: ['https://bsc-dataseed.bnbchain.org'], nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, blockExplorerUrls: ['https://bscscan.com'] },
  10: { chainName: 'Optimism', rpcUrls: ['https://mainnet.optimism.io'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://optimistic.etherscan.io'] },
  137: { chainName: 'Polygon', rpcUrls: ['https://polygon-rpc.com'], nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, blockExplorerUrls: ['https://polygonscan.com'] },
  43114: { chainName: 'Avalanche C-Chain', rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'], nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 }, blockExplorerUrls: ['https://snowtrace.io'] },
  4663: { chainName: 'Robinhood Chain', rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] },
};
const EVMW = {
  hex: (n) => '0x' + BigInt(n).toString(16),
  eth() {
    if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or Rabby, or open Rookery in your wallet app browser.');
    return window.ethereum;
  },
  async account() { const [a] = await EVMW.eth().request({ method: 'eth_requestAccounts' }); return a; },
  async ensureChain(chainId) {
    const eth = EVMW.eth(), want = EVMW.hex(chainId);
    const cur = String(await eth.request({ method: 'eth_chainId' }) || '').toLowerCase();
    if (cur === want) return;
    try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); }
    catch (e) {
      if (e?.code !== 4902 || !EVM_ADD[chainId]) throw e;
      await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, ...EVM_ADD[chainId] }] });
    }
  },
  box(html) {
    let el = document.getElementById('evmBox');
    if (!el) {
      el = document.createElement('div');
      el.id = 'evmBox';
      el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.86);display:grid;place-items:center;padding:20px';
      document.body.appendChild(el);
    }
    el.innerHTML = `<div style="background:#0f0f11;border:1px solid #26262c;border-radius:16px;padding:22px;width:100%;max-width:380px">${html}</div>`;
    return el;
  },
  close() { document.getElementById('evmBox')?.remove(); },
  status(html) { EVMW.box(`<div class="mono mu" style="margin-bottom:10px">Buy from wallet</div><p style="font-size:13.5px;line-height:1.55;margin:0">${html}</p>`); },
  // choose what to pay with, how much, and from which network; resolves { pay, amount, chain } or null when cancelled
  pick(m, init) {
    const q = (m.quote || 'ZRO').toLowerCase();
    const MIN = { eth: 0.00005, zro: 0.1 };
    const QUICK = { eth: ['0.005', '0.01', '0.05', '0.1'], zro: ['10', '25', '50', '100'] };
    return new Promise((done) => {
      let pay = q === 'eth' ? 'eth' : 'zro';
      let val = { ...init };
      let chainKey = null;
      const preselect = () => {
        const list = chainsFor(pay);
        if (chainKey && list.some(c => c.key === chainKey)) return;
        const hit = list.find(c => c.chainId === EVMW.walletChain);
        chainKey = hit ? hit.key : null;
      };
      const chainsFor = (a) => (a === 'eth' ? (S.stats?.ethChains || ['ethereum', 'base', 'arbitrum']) : Object.keys(S.stats?.chains || {}))
        .map(k => ({ key: k, ...(S.stats?.chains?.[k] || {}) })).filter(c => c.chainId);
      const est = () => {
        const v = Number(val[pay]);
        if (!(v > 0)) return 'Enter an amount';
        let line = `≈ ${fmtUsd(v * assetUsd(pay))}`;
        try {
          const w = toWei(String(val[pay]));
          const r = estBuy(m, convert(w, pay, q));
          if (r.tokens > 0n) line += ` · ≈ ${fmtT(String(r.tokens))} $${esc(m.symbol)}`;
        } catch { /* estimate only */ }
        if (v < MIN[pay]) line = `Minimum is ${MIN[pay]} ${pay.toUpperCase()}`;
        return line;
      };
      const draw = () => {
        const el = EVMW.box(`<div class="mono mu" style="margin-bottom:10px">Buy $${esc(m.symbol)} from your wallet</div>
          <p style="font-size:13px;line-height:1.55;margin:0 0 12px">One signature, no deposit step. Pay with ETH or ZRO from the network you already use: Rookery converts and buys at the curve price when the payment confirms.</p>
          <div class="mono mu" style="font-size:11px;margin-bottom:6px">Pay with</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px">
            <button class="btn sm ${pay === 'eth' ? '' : 'ghost'}" data-p="eth">ETH</button>
            <button class="btn sm ${pay === 'zro' ? '' : 'ghost'}" data-p="zro">ZRO</button>
          </div>
          <div class="mono mu" style="font-size:11px;margin-bottom:6px">Amount</div>
          <div style="display:flex;align-items:center;gap:8px;border:1px solid #26262c;border-radius:10px;padding:8px 12px;margin-bottom:6px">
            <input id="evmAmt" class="inp" inputmode="decimal" autocomplete="off" value="${esc(val[pay])}"
              style="flex:1;border:0;background:transparent;padding:0;font-size:20px;font-weight:700;min-width:0">
            <span class="mono" style="font-size:13px">${pay.toUpperCase()}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px">${QUICK[pay].map(v =>
            `<button class="btn sm ghost" data-v="${v}">${v}</button>`).join('')}</div>
          <div id="evmEst" class="mono mu" style="font-size:12px;margin-bottom:12px">${est()}</div>
          <div class="mono mu" style="font-size:11px;margin-bottom:6px">From network</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">${chainsFor(pay).map(c =>
            `<button class="btn sm ${c.key === chainKey ? '' : 'ghost'}" data-c="${esc(c.key)}">${c.key === chainKey ? '✓ ' : ''}${esc(c.label)}</button>`).join('')}</div>
          <button class="btn lg wide" id="evmGo" style="margin-top:14px;width:100%"></button>
          ${pay === 'eth' && q === 'zro' ? `<p class="mu" style="font-size:11.5px;line-height:1.5;margin:12px 0 0">This token trades against ZRO: your ETH is converted at the live ETH/ZRO rate when it lands.</p>` : ''}
          ${pay === 'zro' && q === 'eth' ? `<p class="mu" style="font-size:11.5px;line-height:1.5;margin:12px 0 0">This token trades against ETH: your ZRO is converted at the live ZRO/ETH rate when it lands.</p>` : ''}
          <p class="mu" style="font-size:11.5px;line-height:1.5;margin:10px 0 0">Valid for 10 minutes. Send the exact amount your wallet shows: the last digits mark this order.</p>
          <button class="btn sm ghost" id="evmCancel" style="margin-top:12px;width:100%">Cancel</button>`);
        const inp = el.querySelector('#evmAmt'), go = el.querySelector('#evmGo');
        const paintGo = () => {
          const v = Number(val[pay]);
          const c = chainsFor(pay).find(x => x.key === chainKey);
          go.disabled = !(v >= MIN[pay]) || !c;
          go.innerHTML = !c ? 'Choose a network' : !(v >= MIN[pay]) ? `Minimum ${MIN[pay]} ${pay.toUpperCase()}`
            : `Buy $${esc(m.symbol)} · ${esc(String(val[pay]))} ${pay.toUpperCase()} on ${esc(c.label)}`;
        };
        inp.oninput = () => { val[pay] = inp.value.replace(',', '.').replace(/[^0-9.]/g, ''); el.querySelector('#evmEst').innerHTML = est(); paintGo(); };
        el.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { val[pay] = b.dataset.v; inp.value = b.dataset.v; el.querySelector('#evmEst').innerHTML = est(); paintGo(); });
        el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
          const to = b.dataset.p;
          if (to === pay) return;
          // keep the same size in USD when switching what to pay with
          const usd = Number(val[pay] || 0) * assetUsd(pay);
          if (usd > 0 && assetUsd(to) > 0) val[to] = (usd / assetUsd(to)).toFixed(to === 'eth' ? 6 : 3);
          pay = to; preselect(); draw();
        });
        el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { chainKey = b.dataset.c; draw(); });
        go.onclick = () => {
          const v = Number(val[pay]);
          const c = chainsFor(pay).find(x => x.key === chainKey);
          if (!(v >= MIN[pay]) || !c) return paintGo();
          done({ pay, amount: String(val[pay]), chain: c });
        };
        paintGo();
        el.querySelector('#evmCancel').onclick = () => { EVMW.close(); done(null); };
        setTimeout(() => { inp.focus(); inp.select(); }, 30);
      };
      preselect();
      draw();
    });
  },
  walletChain: null,
  async readChain() {
    try { if (window.ethereum) EVMW.walletChain = Number(BigInt(await window.ethereum.request({ method: 'eth_chainId' }))); } catch { /* no wallet yet */ }
  },
  async send(order, from) {
    const eth = EVMW.eth();
    if (order.asset === 'eth') return eth.request({ method: 'eth_sendTransaction', params: [{ from, to: order.to, value: EVMW.hex(order.amount) }] });
    const data = '0xa9059cbb' + order.to.slice(2).toLowerCase().padStart(64, '0') + BigInt(order.amount).toString(16).padStart(64, '0');
    return eth.request({ method: 'eth_sendTransaction', params: [{ from, to: order.token, data }] });
  },
  async waitFill(id, maxMs = 15 * 60e3) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await new Promise(r => setTimeout(r, 6000));
      try {
        const r = await api('/wallet/orders');
        const o = (r.orders || []).find(x => x.id === id);
        if (o && o.status !== 'open') return o;
      } catch { /* keep waiting */ }
    }
    return null;
  },
  // usd: the amount the user typed, expressed in USD so both pay options show the same size
  async buy(m, usd) {
    if (!S.stats?.walletBuy) return toast('Buying from a wallet is not live yet', 'bad');
    const ethUsd = S.stats?.ethUsd || 0, zroUsd = S.stats?.zroUsd || 0;
    if (!ethUsd || !zroUsd) return toast('Prices are loading, try again in a second', 'bad');
    const init = { eth: (usd / ethUsd).toFixed(6), zro: (usd / zroUsd).toFixed(3) };
    await EVMW.readChain();
    const sel = await EVMW.pick(m, init);
    if (!sel || !sel.chain) return;
    // the order belongs to an account: sign in with the paying wallet if nobody is logged in yet
    if (!S.me) { EVMW.status('Sign the free login message in your wallet…'); const r = await walletSignIn(); if (!r) { EVMW.close(); return; } }
    let order = null, sent = false;
    try {
      ({ order } = await api('/wallet/order', { market: m.id, amount: toWei(sel.amount).toString(), pay: sel.pay }));
      EVMW.close();
      const id = order.id;
      TXW.set(id, { symbol: m.symbol, market: m.id, chain: sel.chain.label, explorer: sel.chain.explorer,
        amount: weiToStr(B(order.amount), sel.pay === 'eth' ? 6 : 4), unit: sel.pay.toUpperCase(), stage: 'switch', started: Date.now() });
      if (!TXW._timer) TXW._timer = setInterval(TXW.tick, 1000);
      const from = await EVMW.account();
      await EVMW.ensureChain(sel.chain.chainId);
      TXW.set(id, { stage: 'sign' });
      const tx = await EVMW.send(order, from);
      sent = true;
      TXW.set(id, { stage: 'sent', tx });
      TXW.watch(id);
    } catch (e) {
      EVMW.close();
      // nothing left the wallet: close the order so it can never catch another payment
      if (order && !sent) {
        api('/wallet/order/cancel', { id: order.id }).catch(() => {});
        TXW.set(order.id, { stage: 'cancelled', ended: Date.now(), note: e?.code === 4001 ? 'Cancelled in the wallet. Nothing was sent.' : (e.message || 'Wallet payment failed') + '. Nothing was sent.' });
        setTimeout(() => TXW.drop(order.id), 20e3);
      } else if (e?.code === 4001) toast('Payment cancelled in the wallet. Nothing was sent.', 'bad');
      else toast(esc(e.message || 'Wallet payment failed'), 'bad');
    }
  },
};

/* ───────── wallet sign-in (SIWE) ───────── */
async function walletSignIn(link = false) {
  const eth = window.ethereum;
  if (!eth) { toast('No wallet found. Install MetaMask or Rabby, or open Rookery in your wallet app browser.', 'bad'); return false; }
  try {
    const [address] = await eth.request({ method: 'eth_requestAccounts' });
    const { message, nonce } = await api('/auth/wallet/nonce', { address });
    const signature = await eth.request({ method: 'personal_sign', params: [message, address] });
    const r = await api('/auth/wallet/verify', { nonce, signature, link });
    await loadMe();
    if (link) toast(`Wallet <b>${short(r.linked)}</b> linked. You can now log in with it.`);
    else toast(r.created ? `Welcome to the rookery, <b>${esc(r.username)}</b>. Deposit ZRO to start trading.` : `Welcome back, <b>${esc(r.username)}</b>`);
    return r;
  } catch (e) {
    if (e?.code === 4001) toast('Signature cancelled', 'bad'); else toast(esc(e.message || 'Wallet sign-in failed'), 'bad');
    return false;
  }
}

/* ═══════════ BRIDGE ═══════════ */
const BR_ICON = { stellar: '/assets/chains/stellar.svg', litecoin: '/assets/chains/litecoin.svg', litvm: '/assets/chains/litecoin.svg', ethereum: '/assets/chains/ethereum.svg', base: '/assets/chains/base.svg', bsc: '/assets/chains/binance.svg',
  robinhood: '/assets/chains/robinhood.png', giwa: '/assets/giwa.png' };
const BR_LETTER = { arbitrum: ['A', '#28a0f0'], optimism: ['OP', '#ff0420'], polygon: ['P', '#8247e5'], avalanche: ['A', '#e84142'], solana: ['S', '#14f195'],
  bitcoin: ['₿', '#f7931a'], tron: ['T', '#ff060a'], zero: ['Z', '#ffffff'] };
const BR_TOKICON = { XLM: '/assets/chains/stellar.svg', ETH: '/assets/chains/ethereum.svg', BNB: '/assets/chains/binance.svg' };
const BR_ORDER = ['stellar', 'ethereum', 'base', 'arbitrum', 'optimism', 'robinhood', 'bsc', 'polygon', 'avalanche', 'solana', 'bitcoin', 'litecoin', 'tron', 'zero', 'giwa'];
const BR_SOON_LABEL = { zero: 'Zero', giwa: 'GIWA' };
function brIco(src, letter, size = 20) {
  if (src) return `<img src="${src}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;background:#fff;flex:none">`;
  const [l, c] = letter || ['?', '#888'];
  return `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${c};color:#000;display:inline-grid;place-items:center;font:800 ${Math.round(size * (l.length > 1 ? 0.4 : 0.55))}px Inter,sans-serif;flex:none">${l}</span>`;
}
const brNetIco = (k, sz) => brIco(BR_ICON[k], BR_LETTER[k], sz);
const brTokIco = (sym, net, sz) => BR_TOKICON[sym] ? brIco(BR_TOKICON[sym], null, sz) : brNetIco(net, sz);
function brDrop(host, items, value, onPick) {
  const cur = items.find(i => i.key === value) || items[0];
  host.innerHTML = `<button type="button" class="br-dd">${cur.icon}<span>${esc(cur.label)}</span><span class="mu" style="margin-left:auto">▾</span></button>
    <div class="br-ls" hidden>${items.map(i => `<button type="button" class="br-it${i.disabled ? ' off' : ''}${i.key === value ? ' on' : ''}" data-k="${esc(i.key)}" ${i.disabled ? 'disabled' : ''}>
      ${i.icon}<span>${esc(i.label)}${i.sub ? `<small class="mu">${esc(i.sub)}</small>` : ''}</span>${i.tag ? `<em class="br-soon">${esc(i.tag)}</em>` : ''}</button>`).join('')}</div>`;
  const btn = host.querySelector('.br-dd'), ls = host.querySelector('.br-ls');
  btn.onclick = (e) => { e.stopPropagation(); document.querySelectorAll('.br-ls').forEach(x => { if (x !== ls) x.hidden = true; }); ls.hidden = !ls.hidden; };
  ls.querySelectorAll('.br-it:not(.off)').forEach(b => b.onclick = (e) => { e.stopPropagation(); ls.hidden = true; onPick(b.dataset.k); });
}
document.addEventListener('click', () => document.querySelectorAll('.br-ls').forEach(x => { x.hidden = true; }));
const BR_STATUS = { PENDING_DEPOSIT: 'waiting for payment', KNOWN_DEPOSIT_TX: 'payment seen', PROCESSING: 'bridging', SUCCESS: 'delivered',
  INCOMPLETE_DEPOSIT: 'payment too small', REFUNDED: 'refunded', FAILED: 'not completed' };

const BRG = {
  refs() { try { return JSON.parse(localStorage.getItem('pl_xb') || '[]'); } catch { return []; } },
  keep(ref) { const r = [ref, ...BRG.refs().filter(x => x !== ref)].slice(0, 30); localStorage.setItem('pl_xb', JSON.stringify(r)); },
  async watch(id) {
    if (BRG._w?.[id]) return;
    (BRG._w = BRG._w || {})[id] = true;
    const ref = String(id).replace(/^x/, '');
    const t0 = TXW.get(id)?.started || Date.now();
    while (Date.now() - t0 < 6 * 3600e3) {
      await new Promise(r => setTimeout(r, 6000));
      const t = TXW.get(id);
      if (!t || t.stage !== 'sent') break;
      try {
        const { order: o } = await api('/bridge/status?ref=' + ref);
        if (o.status === 'SUCCESS') {
          TXW.set(id, { stage: 'filled', ended: Date.now(), outLink: o.outLink, done: `Received <b>${esc(o.out || o.outEst)} ${esc(o.toSym)}</b> on ${esc(BRG.cfg?.nets?.[o.to]?.label || o.to)}` });
          toast(`Bridged: <b>${esc(o.out || o.outEst)} ${esc(o.toSym)}</b> delivered`);
          if (location.hash.startsWith('#/bridge')) BRG.history();
          break;
        }
        if (o.status === 'REFUNDED' || o.status === 'FAILED') {
          TXW.set(id, { stage: 'failed', ended: Date.now(), note: o.status === 'REFUNDED' ? 'Could not complete, the payment was refunded to your address.' : 'Could not complete. If you paid, it is refunded automatically.' });
          if (location.hash.startsWith('#/bridge')) BRG.history();
          break;
        }
      } catch { /* keep watching */ }
    }
    delete BRG._w[id];
  },
  async history() {
    const box = $('#brHist'); if (!box) return;
    let rows = [];
    try { rows = (await api('/bridge/orders?refs=' + BRG.refs().join(','))).orders || []; } catch { return; }
    if (!rows.length) { box.innerHTML = `<p class="mu" style="font-size:12.5px;margin:0">No transfers yet.</p>`; return; }
    const N = BRG.cfg?.nets || {};
    box.innerHTML = rows.map(o => `<div class="br-row">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${brNetIco(o.from, 16)}<b>${esc(o.amountIn)} ${esc(o.sym)}</b>
        <span class="mu">→</span>${brNetIco(o.to, 16)}<b>${esc(o.out || ('≈ ' + o.outEst))} ${esc(o.toSym)}</b></div>
      <div class="mu" style="font-size:11.5px;display:flex;gap:8px;flex-wrap:wrap"><span>${new Date(o.created).toLocaleString()}</span><span>to ${esc(short(o.recipient))}</span>
        <span style="color:${o.status === 'SUCCESS' ? '#3ddc97' : ['FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT'].includes(o.status) ? '#ff5c5c' : 'inherit'}">${esc(BR_STATUS[o.status] || o.status.toLowerCase())}</span>
        ${o.outLink ? `<a href="${esc(o.outLink)}" target="_blank" rel="noopener" style="text-decoration:underline">delivery ↗</a>` : ''}
        ${o.refundLink ? `<a href="${esc(o.refundLink)}" target="_blank" rel="noopener" style="text-decoration:underline">refund ↗</a>` : ''}
        ${o.status === 'PENDING_DEPOSIT' ? `<button class="br-link" data-pay="${esc(o.ref)}">payment details</button>` : ''}</div></div>`).join('');
    box.querySelectorAll('[data-pay]').forEach(b => b.onclick = () => { const o = rows.find(r => r.ref === b.dataset.pay); if (o) BRG.manual(o); });
  },
  manual(o, onSent) {
    const N = BRG.cfg?.nets || {};
    EVMW.box(`<div class="mono mu" style="margin-bottom:10px">Send ${esc(o.sym)} on ${esc(N[o.from]?.label || o.from)}</div>
      <div class="kv"><span>Amount</span><b>${esc(o.amountIn)} ${esc(o.sym)}</b><button class="mini" data-copy="${esc(o.amountIn)}">Copy</button></div>
      <div class="kv"><span>To</span><b class="mono" style="font-size:11px;word-break:break-all">${esc(o.depositAddress)}</b><button class="mini" data-copy="${esc(o.depositAddress)}">Copy</button></div>
      ${o.depositMemo ? `<div class="kv"><span>Memo</span><b class="mono">${esc(o.depositMemo)}</b><button class="mini" data-copy="${esc(o.depositMemo)}">Copy</button></div>
        <p style="font-size:12px;margin:8px 0 0;color:#ffb84d">The memo is required. Without it the payment cannot be matched.</p>` : ''}
      <p class="mu" style="font-size:11.5px;line-height:1.5;margin:10px 0 0">Send exactly this amount, once. This address is for this transfer only. If anything goes wrong, the payment is refunded to your address.</p>
      <input id="brTx" class="inp" style="width:100%;margin-top:10px;font-size:12px" placeholder="Transaction hash (optional, speeds it up)">
      <button class="btn sm wide" id="brSent" style="margin-top:10px">I've sent it</button>`);
    document.querySelectorAll('#evmBox [data-copy]').forEach(b => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Copied'); });
    document.getElementById('brSent').onclick = async () => {
      const h = document.getElementById('brTx').value.trim();
      if (h) { try { await api('/bridge/submit', { ref: o.ref, txHash: h }); } catch { /* the network finds it anyway */ } }
      EVMW.close();
      const id = 'x' + o.ref;
      if (!TXW.get(id)) BRG.card(o);
      TXW.set(id, { stage: 'sent', tx: h || '' });
      BRG.watch(id); onSent?.();
    };
  },
  card(o) {
    const N = BRG.cfg?.nets || {};
    const id = 'x' + o.ref;
    TXW.set(id, { kind: 'bridge', symbol: `${o.amountIn} ${o.sym} → ${N[o.to]?.label || o.to}`, chain: N[o.from]?.label, explorer: '', txp: N[o.from]?.txp || '',
      labels: [`Connect your wallet on ${esc(N[o.from]?.label || '')}`, `Send ${esc(o.amountIn)} ${esc(o.sym)}`, `Payment confirming on ${esc(N[o.from]?.label || '')}`,
        `Delivering ≈ ${esc(o.outEst)} ${esc(o.toSym)} to ${esc(short(o.recipient))}`],
      stage: 'switch', started: Date.now() });
    if (!TXW._timer) TXW._timer = setInterval(TXW.tick, 1000);
    return id;
  },
};

async function viewBridge() {
  document.title = 'Bridge — Rookery';
  app.innerHTML = `<div class="wrap page"><div class="br-wrap">
    <div style="margin-bottom:14px"><h1 style="font-size:28px;margin:0 0 4px">Bridge</h1>
      <p class="mu" style="margin:0;font-size:13.5px">Move assets between networks: Stellar, EVM chains, Litecoin, Bitcoin and more. Send to yourself or to any wallet.</p></div>
    <div class="panel pb br-card" id="brCard"><div class="mu" style="font-size:13px">Loading…</div></div>
    <div class="panel pb" style="margin-top:14px"><span class="mono mu">Your transfers</span><div id="brHist" style="margin-top:10px"></div></div>
  </div></div>`;
  let cfg;
  try { cfg = await api('/bridge/config'); } catch (e) { $('#brCard').innerHTML = `<div class="mu">${esc(e.message)}</div>`; return; }
  BRG.cfg = cfg;
  const N = cfg.nets, soon = cfg.soon;
  const st = { from: 'base', to: 'stellar', amount: '', addr: '', refund: '', q: null, qErr: '' };
  const kindOf = (k) => N[k]?.kind;
  const myAddr = (k) => kindOf(k) === 'stellar' ? (S.me?.stellarWallet || '') : kindOf(k) === 'evm' ? (S.me?.wallet || '') : '';
  const netItems = () => BR_ORDER.map(k => ({ key: k, label: N[k]?.label || BR_SOON_LABEL[k], icon: brNetIco(k, 20), disabled: soon.includes(k) || !N[k], tag: soon.includes(k) ? 'Soon' : '' }));
  const tokItems = (k) => [{ key: N[k].sym, label: N[k].sym, sub: N[k].name, icon: brTokIco(N[k].sym, k, 20) }];
  const fix = (side) => {
    const other = side === 'from' ? 'to' : 'from';
    if (st[side] === st[other]) st[other] = st[side] === 'stellar' ? 'base' : 'stellar';   // any two networks are allowed
    if (!st.addrTouched) st.addr = myAddr(st.to);
    if (!st.refundTouched) st.refund = '';
  };
  const walletPays = () => kindOf(st.from) === 'evm' || kindOf(st.from) === 'stellar';
  const paint = () => {
    const A = N[st.from], Z = N[st.to];
    $('#brCard').innerHTML = `
      <div class="br-box"><div class="br-lbl"><span class="mono mu">From</span><span class="mu" id="brUsd"></span></div>
        <div class="br-sel"><div class="br-dhost" id="brFN"></div><div class="br-dhost" id="brFT"></div></div>
        <input id="brAmt" class="br-amt" inputmode="decimal" placeholder="0.0" value="${esc(st.amount)}" autocomplete="off"></div>
      <div style="display:grid;place-items:center;margin:-6px 0"><button type="button" class="br-flip" id="brFlip" title="Swap direction">⇅</button></div>
      <div class="br-box"><div class="br-lbl"><span class="mono mu">To</span><span class="mu" id="brOutUsd"></span></div>
        <div class="br-sel"><div class="br-dhost" id="brTN"></div><div class="br-dhost" id="brTT"></div></div>
        <div class="br-out" id="brOut">—</div></div>
      <div class="br-box" style="padding-bottom:10px"><div class="br-lbl"><span class="mono mu">Destination wallet</span>
        <button type="button" class="br-link" id="brMine">${myAddr(st.to) ? 'Use my wallet' : ''}</button></div>
        <input id="brAddr" class="inp" style="width:100%;font-family:'JetBrains Mono',monospace;font-size:12.5px" placeholder="${esc(Z.label)} address" value="${esc(st.addr)}" autocomplete="off" spellcheck="false">
        <div class="mu" style="font-size:11.5px;margin-top:5px">Your own wallet or anyone else's. Double-check it: transfers cannot be reversed.</div>
        <div class="br-lbl" style="margin:12px 0 6px"><span class="mono mu">Refund address on ${esc(A.label)}</span></div>
        <input id="brRef" class="inp" style="width:100%;font-family:'JetBrains Mono',monospace;font-size:12.5px" placeholder="${walletPays() ? 'Optional' : esc(A.label) + ' address you pay from'}" value="${esc(st.refund)}" autocomplete="off" spellcheck="false">
        <div class="mu" style="font-size:11.5px;margin-top:5px">Only used if the transfer cannot complete.</div></div>
      <div class="br-det" id="brDet"></div>
      <button class="btn lg wide" id="brGo" disabled>Enter an amount</button>
      ${cfg.on ? '' : '<div class="mu" style="font-size:12px;text-align:center;margin-top:8px">The bridge is paused for a moment.</div>'}`;
    brDrop($('#brFN'), netItems(), st.from, (k) => { st.from = k; st.refundTouched = false; fix('from'); paint(); quote(); });
    brDrop($('#brFT'), tokItems(st.from), A.sym, () => {});
    brDrop($('#brTN'), netItems(), st.to, (k) => { st.to = k; st.addrTouched = false; fix('to'); paint(); quote(); });
    brDrop($('#brTT'), tokItems(st.to), Z.sym, () => {});
    $('#brAmt').oninput = () => { st.amount = $('#brAmt').value.replace(',', '.').replace(/[^0-9.]/g, ''); quote(); };
    $('#brAddr').oninput = () => { st.addr = $('#brAddr').value.trim(); st.addrTouched = true; paintGo(); };
    $('#brRef').oninput = () => { st.refund = $('#brRef').value.trim(); st.refundTouched = true; paintGo(); };
    $('#brMine').onclick = () => { st.addr = myAddr(st.to); st.addrTouched = false; $('#brAddr').value = st.addr; paintGo(); };
    $('#brFlip').onclick = () => { [st.from, st.to] = [st.to, st.from]; st.amount = ''; st.addrTouched = st.refundTouched = false; fix('from'); paint(); quote(); };
    paintQuote();
  };
  const RX = { stellar: /^G[A-Z2-7]{55}$/, evm: /^0x[0-9a-fA-F]{40}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    ltc: /^(ltc1[a-z0-9]{25,50}|[LM3][1-9A-HJ-NP-Za-km-z]{25,33})$/ };
  const okAddr = (k, a) => RX[kindOf(k)]?.test(a || '') || false;
  const paintGo = () => {
    const g = $('#brGo'); if (!g) return;
    const q = st.q;
    const needRefund = !walletPays() && !okAddr(st.from, st.refund);
    const ready = cfg.on && q && okAddr(st.to, st.addr) && !needRefund && (!st.refund || okAddr(st.from, st.refund));
    g.disabled = !ready;
    g.textContent = !cfg.on ? 'Paused' : !Number(st.amount) ? 'Enter an amount' : st.qErr ? st.qErr : !q ? 'Getting the best price…'
      : !okAddr(st.to, st.addr) ? `Enter a ${N[st.to].label} address` : needRefund || (st.refund && !okAddr(st.from, st.refund)) ? `Enter your ${N[st.from].label} refund address`
      : `Bridge ${st.amount} ${N[st.from].sym} → ${N[st.to].label}`;
  };
  const paintQuote = () => {
    const q = st.q, Z = N[st.to];
    $('#brOut').innerHTML = q ? `${esc(Number(q.amountOutFmt).toLocaleString('en-US', { maximumFractionDigits: Z.dec > 8 ? 8 : Z.dec }))} <span class="mu" style="font-size:15px">${esc(Z.sym)}</span>` : '—';
    $('#brUsd').textContent = q ? '≈ ' + fmtUsd(q.inUsd) : '';
    $('#brOutUsd').textContent = q ? '≈ ' + fmtUsd(q.outUsd) : '';
    $('#brDet').innerHTML = q ? `
      <div class="kv"><span>Rate</span><b>1 ${esc(N[st.from].sym)} ≈ ${(Number(q.amountOutFmt) / Number(q.amountInFmt)).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${esc(Z.sym)}</b></div>
      <div class="kv"><span>Fees</span><b>≈ ${fmtUsd(q.feesUsd)} <span class="mu" style="font-weight:500">incl. ${cfg.ourFeePct}% Rookery fee</span></b></div>
      <div class="kv"><span>Arrives in</span><b>about ${Math.max(1, Math.round(q.seconds / 60))}–${Math.max(3, Math.round(q.seconds / 60) + 2)} min</b></div>
      ${q.outUsd / q.inUsd < 0.96 ? `<div style="font-size:12px;color:#ffb84d;margin-top:6px">Network fees are high for this amount. A larger transfer gets a better rate.</div>` : ''}` : '';
    paintGo();
  };
  let qt, qn = 0;
  const quote = () => {
    clearTimeout(qt); st.q = null; st.qErr = '';
    if (!Number(st.amount)) { paintQuote(); return; }
    paintQuote();
    const my = ++qn;
    qt = setTimeout(async () => {
      try { const r = await api('/bridge/quote', { from: st.from, to: st.to, amount: st.amount }); if (my === qn) st.q = r.quote; }
      catch (e) { if (my === qn) st.qErr = e.message; }
      if (my === qn) paintQuote();
    }, 450);
  };
  const go = async () => {
    const g = $('#brGo'); g.disabled = true; g.textContent = 'Preparing…';
    let id;
    try {
      const A = N[st.from];
      let refund = st.refund, fromAddress = '', kind = null, evmFrom = '';
      if (A.kind === 'evm') {
        if (!window.ethereum) throw new Error('No EVM wallet found. Install MetaMask, Rabby or Coinbase Wallet, or pick a refund address and pay by hand.');
        evmFrom = await EVMW.account();
        if (!okAddr(st.from, refund)) refund = evmFrom;
      } else if (A.kind === 'stellar') {
        kind = await STW.detect();
        if (kind) { fromAddress = await STW.connect(kind); if (!okAddr(st.from, refund)) refund = fromAddress; }
        else if (!okAddr(st.from, refund)) throw new Error('Enter your Stellar refund address, then pay from any Stellar wallet');
      }
      const { order } = await api('/bridge/order', { from: st.from, to: st.to, amount: st.amount, recipient: st.addr, refund, fromAddress });
      BRG.keep(order.ref);
      if (A.kind === 'evm') {
        id = BRG.card(order);
        await EVMW.ensureChain(A.chainId);
        TXW.set(id, { stage: 'sign' });
        const tx = await EVMW.eth().request({ method: 'eth_sendTransaction', params: [{ from: evmFrom, to: order.depositAddress, value: EVMW.hex(order.amountInUnits) }] });
        TXW.set(id, { stage: 'sent', tx });
        api('/bridge/submit', { ref: order.ref, txHash: tx }).catch(() => {});
        BRG.watch(id);
      } else if (A.kind === 'stellar' && kind && order.xdr) {
        id = BRG.card(order);
        TXW.set(id, { stage: 'sign' });
        const signed = await STW.signTx(kind, fromAddress, order.xdr, 'mainnet');
        const r = await api('/bridge/submit', { ref: order.ref, xdr: signed });
        TXW.set(id, { stage: 'sent', tx: r.txid });
        BRG.watch(id);
      } else {
        BRG.manual(order, () => BRG.history());
      }
      st.amount = ''; st.q = null; paint(); BRG.history();
    } catch (e) {
      EVMW.close();
      if (id) TXW.set(id, { stage: 'failed', ended: Date.now(), note: e?.code === 4001 ? 'Cancelled in the wallet. Nothing was sent.' : String(e.message || 'Not sent') });
      if (e?.code === 4001) toast('Cancelled in the wallet. Nothing was sent.', 'bad'); else toast(esc(e.message || 'Bridge failed'), 'bad');
      paintGo();
    }
  };
  fix('from');
  paint();
  $('#brCard').addEventListener('click', (e) => { if (e.target.id === 'brGo') go(); });
  BRG.history();
}

/* ═══════════ AUTH ═══════════ */
function viewAuth(mode) {
  document.title = (mode === 'signup' ? 'Sign up' : 'Log in') + ' — Rookery';
  if (S.me) { location.hash = '#/wallet'; return; }
  app.innerHTML = `
  <section class="wrap"><div class="auth">
    <img class="logo" src="/assets/logo-256.png" alt="">
    <h1>${mode === 'signup' ? 'Join the rookery' : 'Welcome back'}</h1>
    <p>${mode === 'signup' ? 'Use your wallet or email. You get a personal ZRO deposit address on 5 chains.' : 'Log in with your wallet or email.'}</p>
    <button class="btn lg wide ghost" id="wGoAuth" type="button" style="gap:10px"><span style="font-size:17px">◈</span>Continue with wallet</button>
    <button class="btn lg wide ghost" id="stGoAuth" type="button" style="gap:10px;margin-top:8px"><span style="font-size:17px">✶</span>Continue with a Stellar wallet</button>
    <button class="btn lg wide ghost" id="wcGoAuth" type="button" style="gap:10px;margin-top:8px"><span style="font-size:17px">▲</span>Lobstr · WalletConnect</button>
    <p class="mu" style="font-size:11.5px;margin:8px 0 0;text-align:center">MetaMask, Rabby, Coinbase Wallet or any EVM wallet. Free signature, no transaction.</p>
    <div style="display:flex;align-items:center;gap:12px;margin:20px 0"><hr class="sep" style="flex:1;margin:0"><span class="mono mu">or with email</span><hr class="sep" style="flex:1;margin:0"></div>
    <form id="af">
      ${mode === 'signup' ? '<div class="f"><label>Username</label><input class="inp" name="username" placeholder="satoshi" autocomplete="username" required></div>' : ''}
      <div class="f"><label>Email</label><input class="inp" name="email" type="email" placeholder="you@email.com" autocomplete="email" required></div>
      <div class="f"><label>Password</label><input class="inp" name="password" type="password" placeholder="${mode === 'signup' ? 'At least 8 characters' : '••••••••'}" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required></div>
      <div class="err" id="aErr"></div>
      <button class="btn lg wide" type="submit">${mode === 'signup' ? 'Create account' : 'Log in'}</button>
    </form>
    <p style="margin:18px 0 0;text-align:center;font-size:13.5px">${mode === 'signup' ? 'Already have an account? <a href="#/login" style="text-decoration:underline;color:var(--tx)">Log in</a>' : 'New here? <a href="#/signup" style="text-decoration:underline;color:var(--tx)">Create an account</a>'}</p>
  </div></section>`;
  $('#wGoAuth').onclick = async () => { const r = await walletSignIn(false); if (r) location.hash = r.created ? '#/wallet' : '#/'; };
  if ($('#wcGoAuth')) $('#wcGoAuth').onclick = async () => {
    const b = $('#wcGoAuth'); const was = b.innerHTML; b.disabled = true; b.innerHTML = 'Waiting for Lobstr…';
    try { await STW.loginWc(); } catch (e) { toast(esc(e.message || e), 'bad'); WC.hideQr(); }
    finally { b.disabled = false; b.innerHTML = was; }
  };
  if ($('#stGoAuth')) $('#stGoAuth').onclick = async () => {
    const b = $('#stGoAuth'); const old = b.innerHTML; b.disabled = true; b.innerHTML = 'Waiting for your wallet…';
    try { await STW.login(); location.hash = '#/'; route(); }
    catch (e) { toast(esc(e.message || e), 'bad'); }
    finally { b.disabled = false; b.innerHTML = old; }
  };
  $('#af').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    $('#aErr').textContent = '';
    try {
      const refNow = (() => { try { return new URLSearchParams(location.search).get('ref') || localStorage.getItem('pl_ref') || ''; } catch { return ''; } })();
      const body = mode === 'signup' ? { ...fd, ref: refNow } : fd;
      await api(mode === 'signup' ? '/auth/signup' : '/auth/login', body);
      if (mode === 'signup') localStorage.removeItem('pl_ref');
      await loadMe();
      toast(mode === 'signup' ? 'Account created. Deposit ZRO to start trading.' : `Welcome back, <b>${esc(S.me?.username)}</b>`);
      location.hash = mode === 'signup' ? '#/wallet' : '#/';
    } catch (er) { $('#aErr').textContent = er.message; }
  };
}

/* ═══════════ DOCS ═══════════ */
function drawCurve(cv, usd) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, hh = cv.clientHeight;
  cv.width = w * dpr; cv.height = hh * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const C = S.stats.curve, vz = Number(C.vZro), vt = Number(C.vTok);
  const pts = []; for (let i = 0; i <= 100; i++) { const sold = 8e8 * i / 100; const t = vt - sold; const z = vz * vt / t; pts.push((z / t) * 1e9 * usd); }
  const max = Math.max(...pts), pad = 34;
  c.strokeStyle = 'rgba(255,255,255,.06)'; c.fillStyle = '#76767E'; c.font = '10px JetBrains Mono';
  for (let i = 0; i <= 4; i++) { const y = pad / 2 + (hh - pad) * i / 4; c.beginPath(); c.moveTo(pad + 20, y); c.lineTo(w - 8, y); c.stroke(); c.fillText(fmtUsd(max * (1 - i / 4)), 0, y + 3); }
  for (let i = 0; i <= 4; i++) { const x = pad + 20 + (w - pad - 28) * i / 4; c.fillText(`${i * 25}%`, x - 8, hh - 2); }
  c.beginPath();
  pts.forEach((p, i) => { const x = pad + 20 + (w - pad - 28) * i / 100, y = pad / 2 + (hh - pad) * (1 - p / max); i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.strokeStyle = '#fff'; c.lineWidth = 2.2; c.stroke();
  c.lineTo(w - 8, hh - pad / 2); c.lineTo(pad + 20, hh - pad / 2); c.closePath(); c.fillStyle = 'rgba(255,255,255,.05)'; c.fill();
}
function viewDocs() {
  document.title = 'Docs — Rookery';
  const C = S.stats.curve, usd = S.stats.zroUsd;
  const vz = Number(C.vZro), vt = Number(C.vTok);
  const startMc = (vz / vt) * 1e9 * usd, tEnd = vt - 8e8, zEnd = vz * vt / tEnd, bondMc = (zEnd / tEnd) * 1e9 * usd, raised = (zEnd - vz) * usd;
  app.innerHTML = `
  <section class="wrap docs">
    <nav class="toc">
      <a href="#/docs" data-s="overview">Overview</a><a href="#/docs" data-s="networks">Networks</a><a href="#/docs" data-s="account">Account & wallet</a>
      <a href="#/docs" data-s="curve">Bonding curve</a><a href="#/docs" data-s="fees">Fees & taxes</a><a href="#/docs" data-s="rewards">Holder rewards</a>
      <a href="#/docs" data-s="protect">Launch protection</a><a href="#/docs" data-s="migration">Mainnet migration</a><a href="#/docs" data-s="stellar">Stellar</a><a href="#/docs" data-s="plaunch">$臭企鹅 burn</a>
      <a href="#/docs" data-s="safety">Safety & proofs</a><a href="#/docs" data-s="risks">Risks</a>
    </nav>
    <article class="doc">
      <span class="mono mu">Documentation</span>
      <h1 id="overview">How Rookery works</h1>
      <p>Rookery is the Stinky Penguin launchpad. In a rookery penguins hatch; here tokens hatch before their chain exists. Create a token for a network that is announced but not live yet, and the day it launches every balance is minted 1:1 on-chain with the bonding-curve reserve becoming the first liquidity pool. Stellar is the exception: it is live today, so a Stellar token trades for real from the start and graduates on-chain into an Aquarius pool.</p>
      <div class="flow" style="margin-top:22px">
        <div><span class="n">01</span><b>Deposit ZRO, ETH or XLM</b><span>ZRO from Ethereum, Base, Arbitrum, BNB Chain or Optimism; ETH from Ethereum, Base or Arbitrum; XLM on Stellar with your memo.</span></div>
        <div><span class="n">02</span><b>Create or trade</b><span>Tokens trade instantly on a bonding curve, paid with ZRO or ETH and shown in USD.</span></div>
        <div><span class="n">03</span><b>Bond or graduate</b><span>At 800M sold the curve becomes a Rookery pool. Stellar tokens graduate into an Aquarius pool at ${gradK()}.</span></div>
        <div><span class="n">04</span><b>Mainnet</b><span>Every balance moves 1:1 to a contract address reserved in advance; the curve continues on-chain.</span></div>
      </div>

      <h2 id="networks">Supported networks</h2>
      <p>Rookery lists networks that are not on mainnet yet, plus Stellar, which is already live. Pick one when you create a token; it decides where the token ends up.</p>
      <ul>
        <li><b>Zero</b> by LayerZero: a high-throughput chain with the ATLAS exchange engine. Mainnet is scheduled for <b>30 November 2026</b>.</li>
        <li><b>GIWA</b> by Upbit (Dunamu): an Ethereum layer 2, currently on testnet. Mainnet date has not been announced.</li>
        <li><b>LitVM</b> by Litecoin: Litecoin's Virtual Machine, an EVM rollup (Arbitrum Orbit) that settles on Ethereum and brings LTC in through Charms. Testnet LiteForge runs on chain ID 4441 with <b>zkLTC</b> as the gas asset; mainnet has no announced date, so LitVM tokens trade on the Rookery ledger until it launches and then move 1:1 into the chain with a zkLTC pool.</li>
        <li><b>Stellar</b> by the Stellar Development Foundation: live since 2015, so a Stellar token trades for real from day one and graduates on-chain into an Aquarius pool at <b>${fmtUsd(S.stats?.stellar?.gradUsd || 46000)}</b> market cap. See the <a href="#/docs" data-s="stellar" style="text-decoration:underline;color:var(--tx)">Stellar</a> section.</li>
      </ul>
      <div class="callout"><b>Zero tokens pair with ZRO, GIWA tokens pair with ETH, LitVM tokens pair with zkLTC, Stellar tokens pair with XLM.</b> Each network uses its natural quote asset: ZRO is the gas token of Zero, and GIWA is an Ethereum layer 2. You can still buy any token with either asset: pick <i>Pay with ZRO</i> or <i>Pay with ETH</i> and the conversion happens in one step at the live market rate (0.5% conversion fee). When you sell, pick <i>Receive in</i> ZRO or ETH the same way.</div>

      <h2 id="account">Account & wallet</h2>
      <p>Sign up with email or with your wallet. Your account gets two personal deposit addresses: a <b>ZRO address</b> (the same on Ethereum, Base, Arbitrum, BNB Chain and Optimism; send only ZRO, <code>${esc(S.stats.zroToken)}</code>) and a separate <b>ETH address</b> (the same on Ethereum, Base and Arbitrum; send only native ETH). Switch between them with the ZRO / ETH toggle on the wallet page.</p>
      <ul>
        <li><b>Deposits</b> are detected automatically while your wallet page is open, or when you press <i>Check for deposits</i>.</li>
        <li><b>Withdrawals</b> are sent instantly on the network you choose. A small network fee in the asset you withdraw (ZRO or ETH), calculated from live gas prices, is deducted from the amount and shown before you confirm.</li>
        <li>If a withdrawal can't be sent (for example low hot-wallet liquidity on one chain), it is cancelled and the funds go straight back to your balance.</li>
      </ul>

      <h2 id="curve">Bonding curve</h2>
      <p>Every token has a fixed supply of <b>1,000,000,000</b>. <b>800M (80%)</b> are sold on a constant-product curve; <b>200M (20%)</b> are reserved for the mainnet pool. The curve uses virtual reserves of ${vz.toLocaleString()} ZRO and ${(vt / 1e6).toFixed(0)}M tokens:</p>
      <p><code>price = (virtualZRO + raisedZRO) / (virtualTokens − soldTokens)</code> &nbsp;and&nbsp; <code>(virtualZRO + raised) × (virtualTokens − sold) = k</code></p>
      <div class="fig"><canvas id="cv1"></canvas><div class="cap">Market cap (USD, at today's ZRO price) vs % of curve sold</div></div>
      <ul>
        <li>Starting market cap: <b>${fmtUsd(startMc)}</b></li>
        <li>Market cap when bonded (100% sold): <b>${fmtUsd(bondMc)}</b>. After that there is no cap: the token keeps trading on its Rookery pool.</li>
        <li>ZRO raised at bonding: <b>${Math.round(zEnd - vz).toLocaleString()} ZRO</b> (${fmtUsd(raised)})</li>
      </ul>

      <h2 id="fees">Fees & taxes</h2>
      <p>Every buy and sell pays a fee in the token's pair currency (ZRO for Zero tokens, ETH for GIWA tokens, XLM for Stellar tokens). The platform fee is fixed; the rest is set by the creator at launch and can't be changed later.</p>
      <div class="fig">
        <div class="split" style="height:16px"><i style="width:5%;background:#fff"></i><i style="width:20%;background:#9b9ba3"></i><i style="width:10%;background:#5c5c64"></i><i style="width:20%;background:var(--up)"></i></div>
        <div class="tax-row"><span class="tax-dot" style="background:#fff"></span>$臭企鹅 buy &amp; burn — platform, every trade<b>0.5%</b></div>
        <div class="tax-row"><span class="tax-dot" style="background:#9b9ba3"></span>Marketing — paid to the creator<b>0–5%</b></div>
        <div class="tax-row"><span class="tax-dot" style="background:#5c5c64"></span>Burn — that share of the token is destroyed<b>0–5%</b></div>
        <div class="tax-row"><span class="tax-dot" style="background:var(--up)"></span>Rewards — paid to all holders, pro rata<b>0–5%</b></div>
        <div class="cap">Creator taxes are capped at 10% in total. Example above: 0.5% + 2% + 1% + 2%.</div>
      </div>
      <p>Creating a token is free. There are no other hidden fees.</p>

      <h2 id="rewards">Holder rewards</h2>
      <p>When a token has a rewards tax, that tax (in ZRO or ETH, the token's pair) is shared across everyone holding the token at the moment of each trade, proportional to their balance. It is tracked with a reward-per-token accumulator, so it is exact and costs nothing to hold.</p>
      <p>Rewards are credited automatically to your balance whenever you trade that token, and can be claimed at any time from the token page.</p>

      <h2 id="protect">Launch protection</h2>
      <p>Creators can cap how much of the supply a single account may hold during the first minutes after launch (for example 1% for 30 minutes). Buys that would push an account over the cap are rejected until the window ends.</p>

      <h2 id="migration">Bonding and mainnet migration</h2>
      <p><b>Bonding (before mainnet):</b> when 800M tokens are sold, the curve turns into a Rookery pool: the ZRO raised on the curve plus the 200M reserved tokens, priced with the same constant-product math as a DEX. The pool opens at exactly the curve's final price, so there is no jump; the small part of the raised ZRO that does not fit at that price buys and burns $臭企鹅. Buys and sells continue without any market-cap limit, so a token never freezes while it waits for its chain.</p>
      <p><b>Zero (LayerZero) at mainnet.</b> Every Zero token already has its contract address reserved, and it is shown on the token page. The address is fixed by math: it depends only on Rookery's dedicated Zero deployer and the token's ID (CREATE3), never on order, name or compiler settings, and one ID can only ever be deployed once. Anyone can check it on-chain with <span class="mono">predictImported("token-id")</span> on the curve.</p>
      <ol>
        <li>As soon as a Zero RPC is verified live (chain ID 33002, the LayerZero endpoint present, blocks moving), trading on Rookery pauses for Zero tokens and a final snapshot of every balance is published with its SHA-256 at <span class="mono">/api/migration/zero/snapshot.json</span>. Pending holder rewards are paid out in ZRO first, so nothing is lost.</li>
        <li>Each token is deployed on Zero at its reserved address with a fixed supply of 1,000,000,000. Burned tokens stay burned.</li>
        <li>The bonding curve moves on-chain 1:1: the same tokens sold, the same ZRO reserve and the same price, to the wei. Trading continues on the on-chain Rookery curve, from your own wallet.</li>
        <li>Your balance moves 1:1 too. It stays in your Rookery account, and you withdraw it to your own Zero wallet whenever you want, from the token page.</li>
        <li>When an on-chain curve sells out, the token graduates to a DEX pool on Zero with the ZRO raised and the 200M reserved tokens. LP tokens go to the dead address, so the liquidity is locked forever. The DEX is confirmed at Zero mainnet: we wait to see which DEXes are live on day one, and choosing it never changes any reserved address.</li>
      </ol>
      <p><b>Taxes on Zero.</b> The creator's marketing and burn taxes keep working the same way. Holder rewards change form: on-chain they are paid in the token itself to wallets that hold it, instead of in ZRO on the pre-market ledger. Withdraw to your own wallet to receive them.</p>
      <p><b>GIWA and LitVM</b> follow the same steps when their mainnets launch.</p>
      <div class="callout"><b>Nothing to claim, nothing to connect.</b> Rookery will never ask you to sign anything on a third-party site for the migration. Anything claiming to be a Rookery token on Zero at a different address than the one on its token page is fake.</div>

      <h2 id="stellar">Stellar</h2>
      <p>Stellar is the one network on Rookery that is already live. A Stellar token is not a pre-market bet: it trades for real from day one, and at <b>${fmtUsd(S.stats.stellar?.gradUsd || 46000)}</b> market cap it graduates on-chain into an Aquarius pool on Stellar mainnet. Everything below is specific to Stellar; the curve itself works exactly like the other networks.</p>

      <h3>Deposits: XLM with your memo</h3>
      <p>Open <a href="#/wallet" style="text-decoration:underline;color:var(--tx)">Wallet → XLM</a>. You get the Rookery Stellar address and a personal <b>memo</b>, which is your account id. Send XLM from any exchange or wallet <b>with that memo</b>.</p>
      <ul>
        <li>Deposits are credited within about a minute. The minimum is 1 XLM, the amount that activates a new Stellar account.</li>
        <li>A deposit <b>without the memo</b> cannot be matched automatically. It is held and assigned manually. If the sending address is one you have already withdrawn to, Rookery recognises it as your wallet and credits you automatically.</li>
        <li>Never copy addresses from your transaction history. Attackers send dust from look-alike addresses to get you to send to them instead.</li>
      </ul>

      <h3>Trading on the curve</h3>
      <p>Stellar tokens pair with <b>XLM</b>. Buys and sells settle in the Rookery ledger at the curve price, and the full tax set applies on every trade: 0.5% platform to the $臭企鹅 burn reserve, plus the creator's marketing, burn and rewards taxes, all paid in XLM. Rewards accrue to holders pro rata and can be claimed at any time.</p>

      <h3>The token exists on Stellar from launch</h3>
      <p>The moment a Stellar token is created, Rookery issues it on-chain: a real Stellar asset with a fixed supply of 1,000,000,000, its own contract, and a home domain. It shows up on stellar.expert straight away and you can add the trustline immediately. The issuer stays open during the curve so burned tokens can be destroyed on-chain too; it is closed for good at graduation.</p>
      <p>What does <b>not</b> happen at launch is liquidity. There is no Aquarius pool until the token graduates, so the only place to trade it is the Rookery curve.</p>

      <h3>Graduation to Aquarius</h3>
      <p>When a Stellar token reaches <b>${fmtUsd(S.stats.stellar?.gradUsd || 46000)}</b> market cap, Rookery graduates it on-chain automatically, in about a minute:</p>
      <ol>
        <li>Burns on-chain everything the curve burned, then locks the issuer account, so nobody can ever mint more.</li>
        <li>Creates the token's Stellar Asset Contract and opens an <b>Aquarius</b> pool against XLM.</li>
        <li>Deposits the XLM raised on the curve plus the 200M reserved tokens into the pool.</li>
        <li>Locks the account that holds the pool shares, so the <b>LP is burned forever</b>: liquidity can never be pulled.</li>
        <li>Holders can then withdraw their tokens to their own Stellar wallet and trade on Aquarius.</li>
      </ol>
      <div class="callout"><b>Who pays for graduation.</b> Nobody adds funds. The on-chain set-up is paid out of the XLM raised on the curve: 300,000 AQUA for the Aquarius pool (bought automatically, roughly 500 XLM at today's prices), plus 11 XLM of Stellar account reserves and network fees. That is about 1.2% of the raised XLM. The rest goes into the pool with the 200M tokens. The creator pays nothing and Rookery takes no cut of it.</div>

      <h3>After graduation: taxes stop</h3>
      <p>If the curve fills before the target is reached, the token keeps trading on a Rookery pool and graduates later, when it gets there.</p>
      <p>Once the token is on Aquarius it is a normal Stellar asset, and Stellar assets cannot charge a fee on transfers. Trading on Aquarius therefore carries <b>no marketing, rewards or burn tax</b>, and Rookery no longer sees those trades. Taxes apply only on the Rookery curve. Burned tokens stay burned: they are never issued on Stellar, so the on-chain supply is 1,000,000,000 minus the burned amount. Rewards earned before graduation stay claimable on the token page.</p>
      <div class="callout">A token that charges a fee on every transfer cannot be listed on Aquarius at all: the pool assumes it receives exactly the amount sent, so a transfer fee breaks its accounting and can cost liquidity providers money. That is why Stellar tokens here are plain assets and the taxes live on the curve.</div>

      <h3>Withdrawing tokens: trustlines</h3>
      <p>To receive a Stellar token in your own wallet you first add a <b>trustline</b> for it. Stellar lets anyone issue a token, so a wallet only accepts tokens it has explicitly been told to trust, identified by the pair <b>asset code + issuer</b>.</p>
      <ul>
        <li>Find the code and issuer on the token page after graduation, both with a copy button.</li>
        <li>In Freighter: Assets → Add asset. In Lobstr: Add asset. Enter the code and the issuer address.</li>
        <li>A trustline locks <b>0.5 XLM</b> as a reserve on your account. It is not a fee: you get it back when you remove the trustline.</li>
        <li>XLM itself needs no trustline.</li>
        <li>Rookery checks the trustline before sending. Without it the withdrawal is not sent, nothing is lost, and you get the code and issuer to add.</li>
      </ul>

      <h2 id="plaunch">$臭企鹅 buy &amp; burn</h2>
      <div class="fig" style="display:grid;grid-template-columns:160px 1fr;gap:18px;align-items:center">
        <img src="/assets/penguin/sticky.webp" alt="" style="border-radius:12px;filter:grayscale(1)">
        <p style="margin:0"><b style="color:var(--tx)">Stinky Penguin ($臭企鹅)</b> is the mascot and the token behind Rookery. It lives on Robinhood Chain as a LayerZero OFT, with a 1:1 bridge to Zero at mainnet. <a href="https://stinkypenguin.xyz" target="_blank" rel="noopener" style="text-decoration:underline;color:var(--tx)">stinkypenguin.xyz</a></p>
      </div>
      <p>The 0.5% platform fee from every trade on Rookery, on every token and every network, is collected in the token's pair currency (ZRO or ETH) into the <b>$臭企鹅 burn reserve</b> (live in the header, now <b>${fmtUsd(S.stats.burnReserveUsd ?? S.stats.plaunchBurnUsd)}</b>).</p>
      <ol>
        <li>The reserve accumulates in ZRO from every buy and sell.</li>
        <li>On a fixed schedule it is used to market-buy $臭企鹅 on Robinhood Chain.</li>
        <li>Every bought $臭企鹅 is sent to the dead address and permanently burned. Each burn transaction is published on the Proofs page.</li>
      </ol>
      <p>Until $臭企鹅 trading opens, the reserve simply grows. More launches and more volume on Rookery means more penguins burned.</p>
      <div class="peng-strip"><img src="/assets/penguin/allin.webp" alt=""><img src="/assets/penguin/atlas.webp" alt=""><img src="/assets/penguin/t17.webp" alt=""><img src="/assets/penguin/stay.webp" alt=""></div>

      <h2 id="safety">Safety & proofs</h2>
      <ul>
        <li>All trades settle on a single serialized ledger: each trade either fully applies or not at all.</li>
        <li>The total ZRO owed to users, the hot-wallet address and a Merkle root of all balances are published on the <a href="#/proofs" style="text-decoration:underline;color:var(--tx)">Proofs</a> page.</li>
        <li>Withdrawals have per-transaction and daily limits and can be paused in an emergency.</li>
      </ul>

      <h2 id="risks">Risks</h2>
      <p>Pre-mainnet tokens are extremely speculative. A network's launch can be delayed or changed. Rookery holds deposits in custody until you withdraw. Only use money you can afford to lose. Rookery and Stinky Penguin are not affiliated with LayerZero Labs, the LayerZero Foundation, Bryan Pellegrino, Upbit, Dunamu or Robinhood.</p>
    </article>
  </section>`;
  $$('.toc a').forEach(a => a.onclick = (e) => { e.preventDefault(); document.getElementById(a.dataset.s)?.scrollIntoView({ behavior: 'smooth' }); });
  requestAnimationFrame(() => drawCurve($('#cv1'), usd));
}

/* ═══════════ PROOFS ═══════════ */
async function viewProofs(tab) {
  document.title = 'Proofs — Rookery';
  tab = tab === 'burns' ? 'burns' : 'reserves';
  const [p, bn] = await Promise.all([api('/proofs'), api('/burns')]);
  const ch = S.stats.chains;
  const STEP = { queued: 'Reserve moving', transferred: 'In burn wallet', bridging: 'Bridging to Robinhood', bridged: 'Buying $臭企鹅', burned: 'Burned', failed: 'Failed' };
  const txl = (base, h, label) => h ? `<a class="mono" style="letter-spacing:0;text-decoration:underline" target="_blank" rel="noopener" href="${base}/tx/${esc(h)}">${label} ↗</a>` : '<span class="mu">—</span>';
  const statusTxt = !bn.token
    ? `<b style="color:var(--tx)">Waiting for the $臭企鹅 listing on Robinhood Chain.</b> The reserve keeps growing; the first burn spends all of it the moment the pool is live.`
    : bn.auto
      ? `<b style="color:var(--tx)">Auto-burn is on.</b> Every ${bn.intervalH}h, when the reserve is at least ${bn.minZro} ZRO, up to ${bn.maxZro.toLocaleString()} ZRO is burned.${bn.nextAutoAt ? ` Next window: ${new Date(Math.max(bn.nextAutoAt, Date.now())).toUTCString().slice(5, 22)} UTC.` : ''}`
      : '<b style="color:var(--tx)">Auto-burn is paused.</b> Burns are triggered manually by the team.';

  app.innerHTML = `
  <section class="wrap page">
    <div class="page-h"><div><h1>Proofs</h1><p>What Rookery owes its users, where the ZRO sits, and every $臭企鹅 burn.</p></div></div>
    <div class="panel" style="margin-bottom:18px"><div class="tabs-h">
      <a href="#/proofs" class="${tab === 'reserves' ? 'on' : ''}" style="padding:9px 13px;border-radius:9px;font-weight:600;font-size:13px;${tab === 'reserves' ? 'background:var(--panel2)' : 'color:var(--tx2)'}">Reserves</a>
      <a href="#/proofs/burns" class="${tab === 'burns' ? 'on' : ''}" style="padding:9px 13px;border-radius:9px;font-weight:600;font-size:13px;${tab === 'burns' ? 'background:var(--panel2)' : 'color:var(--tx2)'}">Burns <span class="cnt">${bn.jobs.filter(j => j.status === 'burned').length}</span></a>
    </div></div>
    <div id="pv"></div>
  </section>`;

  if (tab === 'reserves') {
    $('#pv').innerHTML = `
    <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr));margin:0 0 18px">
      <div><span class="mono mu">ZRO owed (balances + curves)</span><b>${(Number(p.owedTotal) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO</b><span class="mu" style="font-size:12px">balances ${fmtZ(p.liabilities)} · curves ${(Number(p.curveZro) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span></div>
      <div><span class="mono mu">$臭企鹅 burn reserve (pending)</span><b>${fmtZ(bn.pendingZro)} ZRO</b><span class="mu" style="font-size:12px">${fmtUsd(bn.pendingUsd)}</span></div>
      <div><span class="mono mu">LTC we hold</span><b>${(Number(p.ltc?.held) || 0).toLocaleString('en-US', { maximumFractionDigits: 8 })} LTC</b><span class="mu" style="font-size:12px">owed ${(Number(p.ltc?.owed) || 0).toLocaleString('en-US', { maximumFractionDigits: 8 })} LTC · coverage ${p.ltc?.coverage ? Math.round(p.ltc.coverage * 100) + '%' : '—'} · ${fmtUsd(p.ltc?.heldUsd || 0)}</span></div>
      <div><span class="mono mu">Latest Merkle root</span><b style="font-size:13px;font-family:var(--mono);word-break:break-all">${p.root ? esc(p.root.slice(0, 24)) + '…' : 'Not published yet'}</b></div>
    </div>
    ${(() => {
      const tr = p.treasury; if (!tr || !tr.chains) return '';
      const owed = Number(p.owedTotal || 0), curve = Number(p.curveZro || 0);
      const cover = owed > 0 ? (tr.totals.held / owed) * 100 : 0;
      const rows = Object.entries(tr.chains).map(([k, c]) => c.error
        ? `<tr><td>${esc(c.label)}</td><td colspan="3" class="mu">unavailable right now</td><td class="mu hide-s">—</td></tr>`
        : `<tr><td><b>${esc(c.label)}</b>${c.gasOk ? '' : ' <span class="tag" style="color:var(--dn);border-color:var(--dn)">NO GAS</span>'}</td>
            <td class="r mono">${c.hotZro.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
            <td class="r mono hide-s">${c.depZro.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
            <td class="r mono"><b>${c.total.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b></td>
            <td class="r hide-s"><a class="btn sm ghost" target="_blank" rel="noopener" href="${c.explorer}/token/${p.zroToken}?a=${p.hotWallet}">${esc(c.label)} ↗</a></td></tr>`).join('');
      return `<div class="panel" style="margin-bottom:18px"><div class="panel-h"><h3>Where the ZRO is</h3><span class="mu mono" style="font-size:12px">LIVE FROM CHAIN</span></div>
      <div class="stats" style="grid-template-columns:repeat(4,1fr);margin:0 0 14px">
        <div><span class="mono mu">Total held on-chain</span><b>${tr.totals.held.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO</b></div>
        <div><span class="mono mu">ZRO balances</span><b>${fmtZ(p.liabilities)} ZRO</b></div>
        <div><span class="mono mu">ZRO in curves & pools</span><b>${curve.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO</b></div>
        <div><span class="mono mu">Coverage</span><b style="color:${cover >= 100 ? 'var(--up)' : 'var(--dn)'}">${cover.toFixed(0)}%</b></div>
      </div>
      <p class="mu" style="font-size:12.5px;margin:0 0 12px">Coverage compares everything held on-chain with everything we owe: ZRO balances plus the ZRO locked in every bonding curve and pool, which is what holders get if they sell.</p>
      <div style="overflow:auto"><table class="tbl"><thead><tr><th>Network</th><th class="r">Hot wallet</th><th class="r hide-s">Deposits</th><th class="r">Total ZRO</th><th class="r hide-s">Explorer</th></tr></thead><tbody>${rows}
      <tr><td><b>All networks</b></td><td class="r mono">${tr.totals.hot.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td><td class="r mono hide-s">${tr.totals.dep.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td><td class="r mono"><b>${tr.totals.held.toLocaleString('en-US', { maximumFractionDigits: 2 })}</b></td><td class="hide-s"></td></tr></tbody></table></div>
      <p class="mu" style="font-size:12.5px;margin-top:10px">Balances read directly from each chain. Deposit addresses are per user and are not listed here.</p></div>`;
    })()}
    ${(() => {
      const te = p.treasury?.eth, e = p.eth; if (!te || !e) return '';
      const cover = e.owed > 0 ? (te.held / e.owed) * 100 : null;
      const n = (v, d = 5) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: d });
      const rows = Object.entries(te.chains).map(([k, c]) => c.error ? `<tr><td>${esc(c.label)}</td><td colspan="2" class="mu">unavailable right now</td></tr>`
        : `<tr><td><b>${esc(c.label)}</b></td><td class="r mono">${n(c.hotEth)}</td><td class="r mono"><b>${n(c.total)}</b></td></tr>`).join('');
      return `<div class="panel" style="margin-bottom:18px"><div class="panel-h"><h3>Where the ETH is</h3><span class="mu mono" style="font-size:12px">LIVE FROM CHAIN</span></div>
      <div class="stats" style="grid-template-columns:repeat(4,1fr);margin:0 0 14px">
        <div><span class="mono mu">ETH held on-chain</span><b>${n(te.held)} ETH</b></div>
        <div><span class="mono mu">ETH balances</span><b>${n(e.balances)} ETH</b></div>
        <div><span class="mono mu">ETH in curves & pools</span><b>${n(e.curves)} ETH</b></div>
        <div><span class="mono mu">Coverage</span><b style="color:${cover === null || cover >= 100 ? 'var(--up)' : 'var(--dn)'}">${cover === null ? '—' : cover.toFixed(0) + '%'}</b></div>
      </div>
      <div style="overflow:auto"><table class="tbl"><thead><tr><th>Network</th><th class="r">Hot wallet</th><th class="r">Total ETH</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="mu" style="font-size:12.5px;margin-top:10px">The hot wallet's ETH also pays network gas for every chain operation. Instant ETH⇄ZRO conversions: ${fmtUsd(p.desk?.volumeUsd || 0)} so far; open exposure ${n(Math.abs(p.desk?.eth || 0))} ETH.</p></div>`;
    })()}
    ${(() => {
      const s = p.stellar;
      if (!s) return '';
      if (s.error) return `<div class="panel" style="margin-bottom:18px"><div class="panel-h"><h3>Where the XLM is</h3><span class="mu mono" style="font-size:12px">STELLAR</span></div><p class="mu" style="font-size:13px">Stellar balance unavailable right now: ${esc(s.error)}</p></div>`;
      const n = (v, d = 2) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: d });
      const cover = s.owed > 0 ? (s.onchain / s.owed) * 100 : null;
      return `<div class="panel" style="margin-bottom:18px"><div class="panel-h"><h3>Where the XLM is</h3><span class="mu mono" style="font-size:12px">LIVE FROM STELLAR ${s.net === 'mainnet' ? 'MAINNET' : 'TESTNET'}</span></div>
      <div class="stats" style="grid-template-columns:repeat(4,1fr);margin:0 0 14px">
        <div><span class="mono mu">XLM held on-chain</span><b>${n(s.onchain)} XLM</b><span class="mu" style="font-size:12px">${fmtUsd(s.onchain * (s.usd || 0))}</span></div>
        <div><span class="mono mu">XLM balances</span><b>${n(s.balances)} XLM</b></div>
        <div><span class="mono mu">XLM in curves &amp; pools</span><b>${n(s.curves)} XLM</b></div>
        <div><span class="mono mu">Coverage</span><b style="color:${cover === null || cover >= 100 ? 'var(--up)' : 'var(--dn)'}">${cover === null ? '—' : cover.toFixed(0) + '%'}</b></div>
      </div>
      <div style="overflow:auto"><table class="tbl"><thead><tr><th>Item</th><th class="r">XLM</th></tr></thead><tbody>
        <tr><td><b>Hot wallet</b></td><td class="r mono">${n(s.onchain)}</td></tr>
        <tr><td>Owed to users (balances)</td><td class="r mono">${n(s.balances)}</td></tr>
        <tr><td>Locked in bonding curves and Rookery pools</td><td class="r mono">${n(s.curves)}</td></tr>
        <tr><td>Moved into Aquarius pools at graduation</td><td class="r mono">${n(s.graduatedOut)}</td></tr>
        <tr><td><b>Total owed</b></td><td class="r mono"><b>${n(s.owed)}</b></td></tr>
      </tbody></table></div>
      <p class="mu" style="font-size:12.5px;margin-top:10px">XLM that graduates into an Aquarius pool leaves custody: the liquidity now sits in the pool with its LP burned, and holders withdraw their tokens from Rookery to their own Stellar wallet. Stellar deposits are credited by memo, so the hot wallet also holds a small operating reserve.</p>
      <div class="addr" style="margin-top:12px">${esc(s.hot)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><a class="btn sm ghost" target="_blank" rel="noopener" href="${s.explorer}/account/${esc(s.hot)}">Stellar explorer ↗</a></div></div>`;
    })()}
    ${(() => {
      const pr = p.platform; if (!pr) return '';
      const rows = [
        ['Trades · 0.5% of every buy and sell', pr.tradingZro, pr.tradingUsd],
        ['Withdrawals · network fee', pr.withdrawalZro, pr.withdrawalUsd],
        ['Already spent buying & burning $臭企鹅', -pr.burnedZro, -pr.burnedUsd],
      ];
      return `<div class="panel" style="margin-bottom:18px"><div class="panel-h"><h3>Platform revenue</h3><span class="mu mono" style="font-size:12px">ALL TIME</span></div>
      <div class="stats" style="grid-template-columns:repeat(3,1fr);margin:0 0 14px">
        <div><span class="mono mu">Total earned</span><b>${pr.totalZro.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO</b><span class="mu" style="font-size:12px">${fmtUsd(pr.totalUsd)}</span></div>
        <div><span class="mono mu">Spent on burns</span><b>${pr.burnedZro.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO</b><span class="mu" style="font-size:12px">${fmtUsd(pr.burnedUsd)}</span></div>
        <div><span class="mono mu">Waiting in the burn reserve</span><b>${pr.reserveZro.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO</b><span class="mu" style="font-size:12px">${fmtUsd(pr.reserveUsd)}</span></div>
      </div>
      <table class="tbl"><tbody>${rows.map(([l, z, u]) => `<tr><td>${esc(l)}</td><td class="r mono">${z.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO</td><td class="r mu">${fmtUsd(u)}</td></tr>`).join('')}</tbody></table>
      <p class="mu" style="font-size:12.5px;margin-top:10px">The platform fee is 0.5% of every trade, charged in ZRO on both buys and sells. Creator marketing and rewards taxes go to the creator and the holders, not here.</p></div>`;
    })()}
    <div class="panel pb">
      <h3 style="font-size:16px;margin-bottom:6px">Hot wallet</h3>
      <p class="mu" style="font-size:13px;margin-bottom:12px">Pays withdrawals and funds the burns. Rule: its ZRO must cover everything owed to users plus the pending burn reserve.</p>
      <div class="addr">${esc(p.hotWallet || 'Not configured')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${p.hotWallet ? Object.values(ch).map(c => `<a class="btn sm ghost" target="_blank" rel="noopener" href="${c.explorer}/token/${p.zroToken}?a=${p.hotWallet}">${esc(c.label)} ↗</a>`).join('') : ''}</div>
      ${p.stellar && !p.stellar.error ? `<h3 style="font-size:16px;margin:22px 0 6px">Stellar hot wallet</h3>
      <p class="mu" style="font-size:13px;margin-bottom:12px">Receives XLM deposits (each one carries the user's memo) and pays XLM and token withdrawals. Its XLM must cover every user balance plus every curve.</p>
      <div class="addr">${esc(p.stellar.hot)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><a class="btn sm ghost" target="_blank" rel="noopener" href="${p.stellar.explorer}/account/${esc(p.stellar.hot)}">Stellar explorer ↗</a></div>` : ''}
    </div>`;
    return;
  }

  $('#pv').innerHTML = `
    <div class="stats" style="grid-template-columns:repeat(4,1fr);margin:0 0 18px">
      <div><span class="mono mu">Pending reserve</span><b>${fmtZ(bn.pendingZro)} ZRO</b><span class="mu" style="font-size:12px">${fmtUsd(bn.pendingUsd)}</span></div>
      <div><span class="mono mu">ZRO spent on burns</span><b>${fmtZ(bn.totalZroBurned)} ZRO</b></div>
      <div><span class="mono mu">$臭企鹅 burned</span><b>${fmtT(bn.totalTokensBurned)}</b></div>
      <div><span class="mono mu">Burns</span><b>${bn.jobs.filter(j => j.status === 'burned').length}</b></div>
    </div>
    <div class="peng" style="margin:0 0 18px;grid-template-columns:280px 1fr">
      <img src="/assets/penguin/sticky.webp" alt="">
      <div class="peng-b" style="padding:24px">
        <span class="mono mu">How a burn works</span>
        <div class="flow" style="grid-template-columns:repeat(4,1fr)">
          <div><span class="n">01</span><b>Reserve</b><span>0.5% of every trade, in ZRO.</span></div>
          <div><span class="n">02</span><b>Burn wallet</b><span>ZRO moves from the hot wallet on ${esc(bn.sourceLabel || 'Arbitrum')}.</span></div>
          <div><span class="n">03</span><b>Bridge</b><span>Relay swaps ZRO into ETH on Robinhood Chain.</span></div>
          <div><span class="n">04</span><b>Buy & burn</b><span>Uniswap buys $臭企鹅 straight into the dead address.</span></div>
        </div>
        <p style="font-size:13.5px">${statusTxt}</p>
      </div>
    </div>
    <div class="wallet" style="margin-bottom:18px">
      <div class="panel pb"><span class="mono mu">Burn wallet</span><div class="addr" style="margin-top:10px">${esc(bn.burnWallet || 'Not configured')}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${bn.burnWallet ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="${bn.explorers.source}/address/${bn.burnWallet}">${esc(bn.sourceLabel)} ↗</a><a class="btn sm ghost" target="_blank" rel="noopener" href="${bn.explorers.robinhood}/address/${bn.burnWallet}">Robinhood Chain ↗</a>` : ''}</div></div>
      <div class="panel pb"><span class="mono mu">$臭企鹅 on Robinhood Chain</span><div class="addr" style="margin-top:10px">${bn.token ? esc(bn.token) : 'Not listed yet'}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${bn.token ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="${bn.explorers.robinhood}/token/${bn.token}">Token ↗</a><a class="btn sm ghost" target="_blank" rel="noopener" href="${bn.explorers.robinhood}/token/${bn.token}?a=${bn.dead}">Burned at dEaD ↗</a>` : ''}</div></div>
    </div>
    <div class="panel"><div class="panel-h"><h3>Burn history</h3></div>
      <div style="overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>Status</th><th class="r">ZRO</th><th class="r">ETH used</th><th class="r">$臭企鹅 burned</th><th>Reserve move</th><th>Bridge</th><th>Burn tx</th><th class="r">When</th></tr></thead><tbody>
      ${bn.jobs.length ? bn.jobs.map(j => `<tr>
        <td class="mu">${j.id}</td>
        <td><span class="st-tag ${j.status === 'burned' ? 'confirmed' : j.status === 'failed' ? 'failed' : ''}">${esc(STEP[j.status] || j.status)}</span>${j.note && j.status !== 'burned' ? `<div class="mu" style="font-size:11px;margin-top:4px;white-space:normal;max-width:240px">${esc(j.note)}</div>` : ''}</td>
        <td class="r">${fmtZ(j.zro)}</td><td class="r">${B(j.ethIn) > 0n ? fmtZ(j.ethIn, 5) : '—'}</td><td class="r"><b>${B(j.tokensBurned) > 0n ? fmtT(j.tokensBurned) : '—'}</b></td>
        <td>${txl(bn.explorers.source, j.txTransfer, 'transfer')}</td><td>${txl(bn.explorers.source, j.txBridge, 'relay')}</td><td>${txl(bn.explorers.robinhood, j.txBurn, 'burn')}</td>
        <td class="r mu">${ago(j.updated)}</td></tr>`).join('')
      : `<tr><td colspan="9"><div class="empty" style="border:0"><img src="/assets/penguin/t17.webp" alt="">No burns yet. The reserve is growing: <b style="color:var(--tx)">${fmtZ(bn.pendingZro)} ZRO</b> waiting for the first one.</div></td></tr>`}
      </tbody></table></div>
    </div>`;
  if (bn.jobs.some(j => !['burned', 'failed'].includes(j.status))) setTimer(() => { if (location.hash.startsWith('#/proofs/burns')) viewProofs('burns'); }, 15000);
}

/* ═══════════ ROUTER ═══════════ */
async function route() {
  clearInterval(S.timer);
  liveSub(['all'], null);
  if (S.chart) { try { S.chart.remove(); } catch {} S.chart = null; }
  const path = location.hash.replace(/^#/, '') || '/';
  const [, a, b, c, d] = path.split('/');
  $$('.nav a, .mnav a').forEach(x => x.classList.toggle('on',
    (x.dataset.nav === 'explore' && (!a || a === 't')) || x.dataset.nav === a));
  // on-chain launchpads: the UI takes the selected chain's colour
  if (typeof ocTheme === 'function') {
    ocTheme(a === 'chain' ? b : null);
    if (a !== 'chain') $('#netLabel').textContent = netLong(S.net);
    if (a === 'stellar') $('#netLabel').textContent = 'Stellar · on-chain';
    document.documentElement.classList.toggle('st-page', a === 'stellar');
  }
  window.scrollTo(0, 0);
  if (a && a !== 't' && a !== 'terminal') sessionStorage.removeItem('termBack');
  if (!S.stats) await loadStats();
  try {
    if (!a) await viewExplore();
    else if (a === 'trading') await viewTrading();
    else if (a === 'terminal') await viewTerminal(b, c, d);
    else if (a === 't') await viewToken(b);
    else if (a === 'create') await viewCreate(b);
    else if (a === 'points') await viewPoints();
    else if (a === 'wallet') await viewWallet();
    else if (a === 'u') await viewProfile(decodeURIComponent(b || ''));
    else if (a === 'login' || a === 'signup') viewAuth(a);
    else if (a === 'docs') viewDocs();
    else if (a === 'bridge') await viewBridge();
    else if (a === 'proofs') await viewProofs(b);
    else if (a === 'chain' && typeof ocRoute === 'function') await ocRoute(b, c, d);
    else if (a === 'stellar' && typeof stRoute === 'function') await stRoute(b, c);
    else await viewExplore();
  } catch (e) {
    app.innerHTML = `<div class="wrap page"><div class="empty">Something went wrong: ${esc(e.message)}</div></div>`;
  }
}

(async function boot() {
  initNet();
  fitHeader();
  await Promise.all([loadStats(), loadMe()]);
  // remember ?ref=… from a referral link until the person signs up
  try { const r = new URLSearchParams(location.search).get('ref'); if (r) localStorage.setItem('pl_ref', r.slice(0, 20)); } catch { /* ignore */ }
  liveConnect();
  TXW.resume();
  // visual preview of the status cards (renders only, nothing is stored or sent): /?txdemo
  if (/[?&]txdemo/.test(location.search)) {
    const t = Date.now();
    const fake = [
      { id: -1, symbol: 'MERLIN', chain: 'Base', explorer: 'https://basescan.org', amount: '0.010000', unit: 'ETH', stage: 'sent', tx: '0x' + 'ab'.repeat(32), started: t - 41e3 },
      { id: -2, symbol: 'BRYAN', chain: 'Arbitrum', explorer: 'https://arbiscan.io', amount: '25.0000', unit: 'ZRO', stage: 'filled', tx: '0x' + 'cd'.repeat(32), started: t - 74e3, ended: t - 2e3, tokens: '3,104,227.51' },
    ];
    TXW.load = () => fake; TXW.save = () => {}; TXW.watch = async () => {}; TXW.render();
  }
  tickerInit();
  loadHatches();
  setInterval(loadStats, 30000);
  setInterval(() => { const z = $('#zeroCd'); if (z) z.textContent = countdown(S.stats?.networks?.zero?.launchAt); }, 30000);
  window.addEventListener('hashchange', route);
  route();
})();

/* ═══════════ ROBINHOOD CHAIN · ON-CHAIN LAUNCHPAD ═══════════
   Tokens are real ERC-20s from the first second. Buys and sells go from the user's wallet straight to the
   RookeryCurve2 contract (pair: ETH, USDG or a Robinhood Stock Token), and after graduation to the Uniswap V2 pool.
   Rookery only builds the transactions and shows the result. No account needed. */
const RHW = {
  CHAIN: 4663,
  ZERO: '0x0000000000000000000000000000000000000000',
  async connect() {
    const a = await EVMW.account();
    await EVMW.ensureChain(RHW.CHAIN);
    return a;
  },
  async peek() { try { const [a] = await EVMW.eth().request({ method: 'eth_accounts' }); return a || null; } catch { return null; } },
  errMsg(e) {
    if (e?.code === 4001 || /rejected|denied/i.test(e?.message || '')) return 'Cancelled in your wallet';
    if (/insufficient funds/i.test(e?.message || '')) return 'Not enough ETH on Robinhood Chain in this wallet (amount + gas)';
    return (e?.message || String(e)).replace(/^.*?reverted:?\s*/i, '').slice(0, 180);
  },
  async mined(hash) {
    for (let i = 0; i < 90; i++) {
      const r = await EVMW.eth().request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null);
      if (r) { if (r.status !== '0x1') throw new Error('Approval failed on-chain'); return r; }
      await new Promise(res => setTimeout(res, 1000));
    }
    throw new Error('Approval still pending, try again in a moment');
  },
  // optional approve (pair asset / router), then the main transaction, then let Rookery index it
  async send(from, prep, btn) {
    if (prep.approve) {
      if (btn) btn.textContent = 'Approve in your wallet…';
      const ah = await EVMW.eth().request({ method: 'eth_sendTransaction', params: [{ from, to: prep.approve.to, data: prep.approve.data }] });
      if (btn) btn.textContent = 'Waiting for approval…';
      await RHW.mined(ah);
    }
    if (btn) btn.textContent = 'Confirm in your wallet…';
    const hash = await EVMW.eth().request({ method: 'eth_sendTransaction', params: [{ from, to: prep.tx.to, data: prep.tx.data, value: prep.tx.value }] });
    let r = null;
    for (let i = 0; i < 5; i++) { r = await api('/rh/sync', { hash }); if (!r.pending) break; }
    if (r && r.ok === false) throw new Error(r.error || 'Transaction failed');
    return { hash, ...r };
  },
  qsym(m) { return m.quote || 'ETH'; },
  isEth(m) { return !m.rh?.quote || m.rh.quote === RHW.ZERO; },
  async watch(m) {
    try {
      await RHW.connect();
      await EVMW.eth().request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: m.rh.token, symbol: m.symbol.slice(0, 11), decimals: 18 } } });
    } catch (e) { toast(esc(RHW.errMsg(e)), 'bad'); }
  },
  async create(F) {
    const btn = $('#createGo'); const label = btn.textContent; $('#cErr').textContent = '';
    try {
      btn.disabled = true;
      const from = await RHW.connect();
      const prep = await api('/rh/prepare-create', { ...F, quote: F.rhQuote || 'ETH', from, devBuy: F.devBuy ? toWei(F.devBuy).toString() : '0' });
      const r = await RHW.send(from, prep, btn);
      if (!r.market) throw new Error('Launched, indexing… refresh in a few seconds. Tx ' + r.hash.slice(0, 10));
      toast(`<b>$${esc(F.symbol)}</b> is live on Robinhood Chain`);
      location.hash = `#/t/${r.market}`;
    } catch (e) { $('#cErr').textContent = RHW.errMsg(e); }
    finally { btn.disabled = false; btn.textContent = label; }
  },
  pane(m) {
    const box = $('#rhPane'); if (!box) return;
    const ex = m.rh.explorer || 'https://robinhoodchain.blockscout.com';
    const Q = RHW.qsym(m), dex = !!(m.migrated && m.rh.pool);
    const t = m.taxes || {};
    const taxTxt = (t.marketing || t.burn || t.rewards) ? `Creator taxes ${t.marketing}% marketing · ${t.burn}% burn · ${t.rewards}% rewards${dex ? ' (on Uniswap too)' : ''}.` : 'No creator taxes.';
    if (m.graduated && !dex) {
      box.innerHTML = `<span class="net-ico rh" style="width:40px;height:40px"><img src="/assets/chains/robinhood.png" alt="Robinhood Chain"></span>
        <h3 style="font-size:16px;margin:12px 0 6px">Graduating to Uniswap…</h3>
        <p class="mu" style="font-size:13px;line-height:1.55">The curve is sold out. The contract is opening the Uniswap V2 pool and sending the LP to the dead address. This takes a few seconds.</p>`;
      return;
    }
    let side = 'buy', addr = null, timer = null, payEth = !!(S.rh?.zap && !RHW.isEth(m));   // stock pairs: pay/receive plain ETH by default
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span class="mono mu" style="font-size:11px">${dex ? 'UNISWAP V2 · ROBINHOOD CHAIN' : 'BONDING CURVE · ON-CHAIN'}</span><span class="tag robinhood">${esc(m.symbol)}/${esc(Q)}</span></div>
      <div class="tb-tabs"><button class="buy on" data-rs="buy">Buy</button><button class="sell" data-rs="sell">Sell</button></div>
      ${RHW.isEth(m) ? '' : `<div class="pay-sel" id="rhPay"><span class="mu">${side === 'buy' ? 'Pay with' : 'Get paid in'}</span><button data-pay="eth">ETH</button><button data-pay="q">${esc(Q)}</button></div>`}
      <div class="amt"><input id="rhAmt" inputmode="decimal" placeholder="0.0" autocomplete="off"><span class="unit" id="rhUnit">${esc(Q)}</span></div>
      <div class="quick" id="rhQuick"></div>
      <div class="est" id="rhEst"></div>
      <button class="btn lg wide up" id="rhGo">Buy from wallet</button>
      <p class="mu" style="font-size:11.5px;line-height:1.5;margin:10px 0 0">${dex
        ? `$${esc(m.symbol)} graduated: this trades on its Uniswap V2 pool (LP burned forever) straight from your wallet.`
        : `Your wallet signs one transaction with the RookeryCurve contract and the tokens land in that wallet. No account, no deposit.`} ${esc(taxTxt)} ${dex ? '' : 'Rookery fee 0.5% → $臭企鹅 buy &amp; burn.'}</p>
      <div id="rhMine" style="margin-top:10px"></div>
      <div class="st-asset" style="margin-top:12px">
        <div class="kv"><span>Contract</span><b class="mono" style="font-size:11px;letter-spacing:0">${esc(short(m.rh.token))}</b><button class="mini" data-copy="${esc(m.rh.token)}">Copy</button></div>
        ${dex ? `<div class="kv"><span>Pool</span><b class="mono" style="font-size:11px;letter-spacing:0">${esc(short(m.rh.pool))}</b><button class="mini" data-copy="${esc(m.rh.pool)}">Copy</button></div>` : ''}
        <div style="display:flex;gap:6px;margin-top:6px"><a class="btn sm ghost" style="flex:1" target="_blank" rel="noopener" href="${esc(ex)}/token/${esc(m.rh.token)}">Explorer ↗</a>
        <button class="btn sm ghost" style="flex:1" id="rhWatch">Add to wallet</button></div></div>`;
    const amtIn = () => { try { return toWei(($('#rhAmt').value || '0').replace(',', '.')); } catch { return 0n; } };
    const quickBuy = Q === 'ETH' ? ['0.005', '0.01', '0.05', '0.1'] : Q === 'USDG' ? ['10', '25', '50', '100'] : ['0.05', '0.1', '0.5', '1'];
    const est = () => {
      clearTimeout(timer);
      const a = amtIn();
      if (a <= 0n) { $('#rhEst').innerHTML = ''; return; }
      $('#rhEst').innerHTML = '<div class="kv"><span>You get ≈</span><b class="mu">…</b></div>';
      timer = setTimeout(async () => {
        try {
          const r = await api('/rh/prepare-trade', { market: m.id, side, amount: a.toString(), pay: payEth ? 'eth' : 'quote' });
          const outUnit = side === 'buy' ? '$' + esc(m.symbol) : (payEth ? 'ETH' : esc(Q));
          $('#rhEst').innerHTML = `<div class="kv"><span>You get ≈</span><b>${esc(weiToStr(B(r.quote), side === 'buy' ? 2 : payEth ? 6 : 4))} ${outUnit}</b></div>
            <div class="kv"><span>Slippage guard</span><b>${dex ? '5' : '3'}%</b></div>`;
        } catch (e) { $('#rhEst').innerHTML = `<div class="kv"><span class="dn">${esc(e.message)}</span></div>`; }
      }, 350);
    };
    const quick = () => {
      const pq = payEth ? 'ETH' : Q;
      $('#rhUnit').textContent = side === 'buy' ? pq : '$' + m.symbol;
      $$('#rhPay button').forEach(b => b.classList.toggle('on', b.dataset.pay === (payEth ? 'eth' : 'q')));
      $('#rhPay .mu') && ($('#rhPay .mu').textContent = side === 'buy' ? 'Pay with' : 'Get paid in');
      $('#rhGo').textContent = side === 'buy' ? 'Buy from wallet' : 'Sell from wallet';
      $('#rhGo').className = 'btn lg wide ' + (side === 'buy' ? 'up' : 'dn');
      const qb = payEth ? [0.001, 0.005, 0.01, 0.05].map(v => String(v)) : quickBuy;
      $('#rhQuick').innerHTML = side === 'buy' ? qb.map(v => `<button data-v="${v}">${v} ${esc(pq)}</button>`).join('')
        : ['25', '50', '100'].map(v => `<button data-p="${v}">${v}%</button>`).join('');
      $$('#rhQuick button').forEach(b => b.onclick = async () => {
        if (b.dataset.v) $('#rhAmt').value = b.dataset.v;
        else {
          const w = await RHW.info(m, addr || await RHW.peek());
          const part = (B(w.balance) * BigInt(b.dataset.p)) / 100n;
          $('#rhAmt').value = b.dataset.p === '100' ? weiToStr(part, 18).replace(/,/g, '') : (Number(part / 10n ** 12n) / 1e6).toString();
        }
        est();
      });
      est();
    };
    $$('[data-rs]').forEach(b => b.onclick = () => { side = b.dataset.rs; $$('[data-rs]').forEach(x => x.classList.toggle('on', x === b));
      $('#rhPay') && ($('#rhPay').innerHTML = `<span class="mu">${side === 'buy' ? 'Pay with' : 'Get paid in'}</span><button data-pay="eth">ETH</button><button data-pay="q">${esc(Q)}</button>`);
      bindPay(); $('#rhAmt').value = ''; quick(); });
    const bindPay = () => $$('#rhPay button').forEach(b => b.onclick = () => { payEth = b.dataset.pay === 'eth'; $('#rhAmt').value = ''; quick(); });
    bindPay();
    $('#rhAmt').oninput = est;
    $('#rhWatch').onclick = () => RHW.watch(m);
    $('#rhGo').onclick = async () => {
      const a = amtIn();
      if (a <= 0n) return toast('Enter an amount', 'bad');
      const btn = $('#rhGo'); btn.disabled = true;
      try {
        addr = await RHW.connect();
        const prep = await api('/rh/prepare-trade', { market: m.id, side, amount: a.toString(), from: addr, slipBps: dex ? 500 : 300, pay: payEth ? 'eth' : 'quote' });
        await RHW.send(addr, prep, btn);
        toast(side === 'buy' ? `Bought $${esc(m.symbol)}: the tokens are in your wallet` : `Sold $${esc(m.symbol)}: the ${payEth ? 'ETH' : esc(Q)} is in your wallet`);
        viewToken(m.id);
      } catch (e) { toast(esc(RHW.errMsg(e)), 'bad'); }
      finally { btn.disabled = false; quick(); }
    };
    quick();
    RHW.paintMine(m);
  },
  async info(m, a) {
    if (!a) return { balance: '0' };
    try { return await api(`/rh/wallet?market=${encodeURIComponent(m.id)}&address=${a}`); } catch { return { balance: '0' }; }
  },
  async paintMine(m) {
    const a = await RHW.peek();
    const el = $('#rhMine'); if (!el) return;
    if (!a) { el.innerHTML = '<div class="kv"><span>In your wallet</span><b><span class="mu">connect a wallet</span></b></div>'; return; }
    const w = await RHW.info(m, a);
    const Q = RHW.qsym(m);
    const pend = B(w.pendingRewards), owed = B(w.creatorOwed);
    el.innerHTML = `<div class="kv"><span>In your wallet</span><b>${esc(weiToStr(B(w.balance), 2))} $${esc(m.symbol)}</b></div>
      ${w.quoteBalance ? `<div class="kv"><span>${esc(Q)} in wallet</span><b>${esc(weiToStr(B(w.quoteBalance), Q === 'ETH' ? 5 : 3))}</b></div>` : ''}
      ${pend > 0n ? `<div class="kv"><span>Holder rewards</span><b>${esc(weiToStr(pend, 2))} $${esc(m.symbol)} <button class="mini" id="rhClaimR">Claim</button></b></div>` : ''}
      ${w.isCreator ? `<div class="kv"><span>Your marketing tax</span><b>${esc(weiToStr(owed, Q === 'ETH' ? 6 : 4))} ${esc(Q)} ${owed > 0n ? '<button class="mini" id="rhClaimC">Claim</button>' : ''}</b></div>` : ''}`;
    const claim = (kind) => async () => {
      try { const from = await RHW.connect(); await RHW.send(from, await api('/rh/prepare-claim', { market: m.id, kind })); toast('Claimed to your wallet'); RHW.paintMine(m); }
      catch (e) { toast(esc(RHW.errMsg(e)), 'bad'); }
    };
    if ($('#rhClaimR')) $('#rhClaimR').onclick = claim('rewards');
    if ($('#rhClaimC')) $('#rhClaimC').onclick = claim('creator');
  },
};

/* ═══════════ LTC DEPOSITS (wallet page) ═══════════ */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('#ltcGo');
  if (!b) return;
  e.preventDefault();
  const amt = $('#ltcAmt')?.value || '', ref = ($('#ltcRef')?.value || '').trim();
  if (!S.me) return toast('Log in to deposit', 'bad');
  b.disabled = true;
  try {
    const r = await api('/ltc/deposit', { amount: amt, refund: ref });
    $('#ltcOut').innerHTML = `<div class="st-asset">
      <div class="kv"><span>Send exactly</span><b>${esc(r.amount)} LTC</b></div>
      <div class="kv"><span>To this address</span><b class="mono" style="font-size:11px;letter-spacing:0;word-break:break-all">${esc(r.address)}</b><button class="mini" data-copy="${esc(r.address)}">Copy</button></div>
      <p class="mu" style="font-size:12px;line-height:1.5;margin:8px 0 0">The address is valid for one hour. Your balance appears after the bridge delivers, usually a few minutes after you send.</p></div>`;
    ltcPaintList();
  } catch (err) { toast(esc(err.message), 'bad'); }
  finally { b.disabled = false; }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('#ltcWGo');
  if (!b) return;
  e.preventDefault();
  if (!S.me) return toast('Log in to withdraw', 'bad');
  const amt = $('#ltcWAmt')?.value || '', to = ($('#ltcWTo')?.value || '').trim();
  b.disabled = true;
  try {
    const r = await api('/ltc/withdraw', { amount: amt, to });
    $('#ltcWOut').innerHTML = `<div class="kv"><span>Sent ${esc(r.xlm)} XLM through the bridge</span><b>≈ ${esc(r.expects || '')} LTC</b></div><p class="mu" style="font-size:12px;margin:6px 0 0">Arrives at ${esc(r.address)} in a few minutes. If the bridge fails, the LTC comes back to your balance automatically.</p>`;
    ltcPaintList();
  } catch (err) { toast(esc(err.message), 'bad'); }
  finally { b.disabled = false; }
});
function ltcPaintAddr(tries = 0) {
  const el = $('#ltcAddrBox'); if (!el) return;
  const a = S.me?.ltcAddress;
  if (!a && tries < 8) { setTimeout(() => { const e2 = $('#ltcAddrBox'); if (e2 && !e2.innerText.trim()) ltcPaintAddr(tries + 1); }, 600); }
  el.innerHTML = a
    ? `<div class="st-asset"><div class="kv"><span>Your deposit address (Litecoin, segwit)</span><b class="mono" style="font-size:11px;letter-spacing:0;word-break:break-all">${esc(a)}</b><button class="mini" data-copy="${esc(a)}">Copy</button></div>
       <p class="mu" style="font-size:12px;line-height:1.5;margin:8px 0 0">One address, always yours — send any amount whenever you want, no expiry. Credited 1:1 in LTC as soon as the transaction confirms.</p></div>`
    : `<p class="mu" style="font-size:12.5px">Log in to see your Litecoin deposit address.</p>`;
}
async function ltcPaintList() {
  const el = $('#ltcList'); if (!el || !S.me) return;
  try {
    const d = await api('/ltc/deposits');
    const rows = (d.list || []).map(r => `${esc(r.amount)} LTC · <b>${esc(r.status)}</b>${B(r.credit) > 0n ? ' · credited ' + (Number(B(r.credit)) / 1e18).toFixed(4) : ''}`);
    const w = await api('/ltc/withdrawals');
    const wd = (w.list || []).map(x => `${x.ltc ? (Number(B(x.ltc)) / 1e18).toFixed(4) : '0'} LTC · ${esc(x.status)}`);
    const parts = [];
    if (rows.length) parts.push('Recent deposits: ' + rows.join(' · '));
    if (wd.length) parts.push('withdrawals: ' + wd.join(' · '));
    el.innerHTML = parts.join(' — ');
  } catch { /* ignore */ }
}
ltcPaintAddr();
// the wallet view can mount before or after the account arrives: paint as soon as the box shows up empty
let ltcMo = null;
new MutationObserver(() => {
  if (ltcMo) return;
  ltcMo = setTimeout(() => { ltcMo = null; const el = $('#ltcAddrBox'); if (el && el.innerText.trim() === '') ltcPaintAddr(); }, 150);
}).observe(document.body, { childList: true, subtree: true });
setInterval(() => { if ($('#ltcList') && S.me) { ltcPaintList(); ltcPaintAddr(); } }, 8000);


// ───────────── Zero (after the 1:1 migration): withdraw from Rookery custody + trade the on-chain curve from a wallet
const ZW = {
  net: 'zero', info: null,
  async meta() { if (!ZW.info || ZW.info.network !== ZW.net || Date.now() - ZW.info._t > 60000) ZW.info = { ...(await api('/migration/' + ZW.net)), _t: Date.now() }; return ZW.info; },
  get LABEL() { return ZW.net === 'giwa' ? 'GIWA' : 'Zero'; },
  w: (x) => BigInt(x).toString(16).padStart(64, '0'),
  a: (x) => String(x).toLowerCase().replace(/^0x/, '').padStart(64, '0'),
  async call(to, data) {
    const i = await ZW.meta(); if (!i.rpc) throw new Error(ZW.LABEL + ' RPC not available yet');
    const r = await fetch(i.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message); return BigInt(j.result || '0x0');
  },
  async connect() {
    const i = await ZW.meta();
    const a = await EVMW.account();
    if (!i.chainId) throw new Error(ZW.LABEL + ' chain id not published yet');
    const eth = EVMW.eth(), want = EVMW.hex(i.chainId);
    if (String(await eth.request({ method: 'eth_chainId' })).toLowerCase() !== want) {
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); }
      catch (e) {
        if (e?.code !== 4902 || !i.rpc) throw e;
        await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, chainName: ZW.net === 'giwa' ? 'GIWA' : 'Zero (LayerZero)', rpcUrls: [i.rpc], nativeCurrency: { name: i.native || 'ZRO', symbol: i.native || 'ZRO', decimals: 18 }, ...(i.explorer ? { blockExplorerUrls: [i.explorer] } : {}) }] });
      }
    }
    return a;
  },
  txLink(h) { const e = ZW.info?.explorer; return e ? `<a href="${esc(e.replace(/\/$/, ''))}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 10))}…</a>` : `<span class="mono">${esc(h.slice(0, 10))}…</span>`; },
  async pane(m) {
    const box = $('#zeroLive'); if (!box) return;
    ZW.net = m.network === 'giwa' ? 'giwa' : 'zero';
    const i = await ZW.meta().catch(() => ({}));
    const L = ZW.LABEL, N = i.native || (ZW.net === 'giwa' ? 'ETH' : 'ZRO'), ADDR = m.chainContract || m.zeroContract;
    let mine = 0n;
    if (S.me) { try { const me = await api('/me'); mine = BigInt((me.holdings || me.hold || []).find(h => h.id === m.id)?.amount || 0); } catch { /* signed out */ } }
    box.innerHTML = `
      <div class="zr-h"><span class="tag net-zero">LIVE ON ${L.toUpperCase()}</span><b>$${esc(m.symbol)} is on-chain</b></div>
      <button class="zr-addr mono" data-copy="${esc(ADDR)}" title="Copy address">${esc(ADDR)}<span class="zr-cp">⧉</span></button>
      <div class="zl-row"><button class="btn sm ghost" id="zlWatch">Add to wallet</button>${i.explorer ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="${esc(i.explorer.replace(/\/$/, ''))}/token/${esc(ADDR)}">Explorer ↗</a>` : ''}</div>
      <div class="zl-sec"><h4>Withdraw to your ${L} wallet</h4>
        <p class="mu zr-n">Your Rookery balance: <b>${fmtT(mine.toString())} $${esc(m.symbol)}</b>. It moved 1:1 from the pre-market.</p>
        ${S.me ? `<input id="zlTo" class="inp mono" placeholder="0x… your wallet on ${L}" value="${esc(S.me.wallet || '')}">
        <div class="zl-amt"><input id="zlAmt" class="inp" placeholder="Amount" inputmode="decimal"><button class="btn sm ghost" id="zlMax">Max</button></div>
        <button class="btn lg wide" id="zlGo" ${mine > 0n ? '' : 'disabled'}>Withdraw to ${L}</button><div id="zlHist" class="zl-hist"></div>` : `<a class="btn lg wide" href="#/login">Log in to withdraw</a>`}
      </div>
      <div class="zl-sec"><h4>Trade on ${L} from your wallet</h4>
        <div class="tb-tabs zl-tabs"><button class="buy on" data-zs="buy">Buy</button><button class="sell" data-zs="sell">Sell</button></div>
        <div class="zl-amt"><input id="zlTrade" class="inp" placeholder="${N} to spend" inputmode="decimal"><span class="mu" id="zlUnit">${N}</span></div>
        <p class="mu zr-n" id="zlQuote">${i.rpc ? 'Enter an amount for a live quote from the curve.' : L + ' RPC is not available yet.'}</p>
        <button class="btn lg wide" id="zlTradeGo">Buy with wallet</button>
      </div>`;
    const unit = 10n ** 18n, parse = (v) => { const [a, b = ''] = String(v || '').trim().split('.'); if (!/^\d*$/.test(a) || !/^\d*$/.test(b)) return 0n; return BigInt(a || '0') * unit + BigInt((b + '0'.repeat(18)).slice(0, 18) || '0'); };
    $('#zlWatch').onclick = async () => { try { await ZW.connect(); await EVMW.eth().request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address: ADDR, symbol: m.symbol.slice(0, 11), decimals: 18 } } }); } catch (e) { toast(esc(RHW.errMsg(e)), 'bad'); } };
    if ($('#zlMax')) $('#zlMax').onclick = () => { $('#zlAmt').value = (Number(mine) / 1e18).toString(); };
    const hist = async () => {
      const el = $('#zlHist'); if (!el) return;
      const r = await api('/mig/withdrawals').catch(() => ({ items: [] }));
      const rows = (r.items || []).filter(x => x.market === m.id).slice(0, 5);
      el.innerHTML = rows.map(x => `<div class="zl-h"><span>${fmtT(x.amount)}</span><span class="mu">${esc(x.to_addr.slice(0, 6))}…${esc(x.to_addr.slice(-4))}</span><span class="${x.status === 'sent' ? 'up' : x.status === 'refunded' ? 'dn' : 'mu'}">${esc(x.status)}</span>${x.txid ? ZW.txLink(x.txid) : ''}</div>`).join('');
    };
    hist();
    if ($('#zlGo')) $('#zlGo').onclick = async () => {
      const btn = $('#zlGo'); btn.disabled = true; btn.textContent = 'Sending…';
      try { await api('/mig/withdraw', { market: m.id, to: $('#zlTo').value, amount: parse($('#zlAmt').value).toString() }); toast('Withdrawal queued: it lands in your wallet in a few seconds'); setTimeout(() => ZW.pane(m), 4000); }
      catch (e) { toast(esc(e.message || e), 'bad'); btn.disabled = false; btn.textContent = 'Withdraw to ${L}'; }
    };
    let side = 'buy';
    $$('[data-zs]').forEach(b => b.onclick = () => { side = b.dataset.zs; $$('[data-zs]').forEach(x => x.classList.toggle('on', x === b)); $('#zlUnit').textContent = side === 'buy' ? N : '$' + m.symbol; $('#zlTrade').placeholder = side === 'buy' ? N + ' to spend' : 'Tokens to sell'; $('#zlTradeGo').textContent = side === 'buy' ? 'Buy with wallet' : 'Sell with wallet'; $('#zlTrade').dispatchEvent(new Event('input')); });
    let qOut = 0n;
    $('#zlTrade').oninput = async () => {
      const amt = parse($('#zlTrade').value); qOut = 0n;
      if (!amt || !i.rpc) return;
      try {
        qOut = await ZW.call(i.curve, (side === 'buy' ? '0x0d7a94f6' : '0xd98b2f5c') + ZW.a(ADDR) + ZW.w(amt));
        $('#zlQuote').textContent = side === 'buy' ? `You get ≈ ${fmtT(qOut.toString())} $${m.symbol} (2% slippage limit)` : `You get ≈ ${(Number(qOut) / 1e18).toFixed(4)} ${N} (2% slippage limit)`;
      } catch (e) { $('#zlQuote').textContent = 'Quote failed: ' + (e.message || e); }
    };
    $('#zlTradeGo').onclick = async () => {
      const btn = $('#zlTradeGo'), amt = parse($('#zlTrade').value);
      if (!amt || !qOut) return toast('Enter an amount first', 'bad');
      const min = (qOut * 98n) / 100n;
      try {
        btn.disabled = true; btn.textContent = 'Confirm in your wallet…';
        const from = await ZW.connect();
        const data = (side === 'buy' ? '0xa59ac6dd' + ZW.a(ADDR) + ZW.w(0) + ZW.w(min) : '0x6a272462' + ZW.a(ADDR) + ZW.w(amt) + ZW.w(min));
        const hash = await EVMW.eth().request({ method: 'eth_sendTransaction', params: [{ from, to: i.curve, data, value: side === 'buy' ? EVMW.hex(amt) : '0x0' }] });
        toast('Sent on ' + L + ': ' + hash.slice(0, 10) + '…');
      } catch (e) { toast(esc(RHW.errMsg(e)).replace('Robinhood Chain', L).replace('ETH', N), 'bad'); }
      finally { btn.disabled = false; btn.textContent = side === 'buy' ? 'Buy with wallet' : 'Sell with wallet'; }
    };
  },
};


// ───────────── Terminal: one-screen trading terminal for Zero · GIWA · LitVM (feed · chart · trade + intel)
async function viewTerminal(arg1, arg2, arg3) {
  const NETS = ['zero', 'giwa', 'litvm'];
  const st = { net: NETS.includes(arg1) ? arg1 : 'zero', pad: 'all', tab: 'trending', q: '', side: 'buy', rtab: 'trade', btab: 'trades', mode: 'mcap', ival: 300, sel: null, list: [] };
  if (arg2 === 'token' && arg3) st.sel = { kind: 'c', id: arg3 };
  else if (arg2 === 'm' && arg3) st.sel = { kind: 'm', id: arg3 };
  else if (arg2 && !NETS.includes(arg2)) st.pad = arg2;
  const watch = new Set(JSON.parse(localStorage.getItem('term_watch') || '[]'));
  const saveWatch = () => localStorage.setItem('term_watch', JSON.stringify([...watch]));
  const keyOf = (t) => (t.market ? 'm:' + t.market : 'c:' + st.net + ':' + t.address);
  const short = (x) => x ? x.slice(0, 6) + '…' + x.slice(-4) : '—';
  const ago = (ts) => { const v = Math.max(0, (Date.now() - ts) / 1000); return v < 60 ? Math.round(v) + 's' : v < 3600 ? Math.round(v / 60) + 'm' : v < 86400 ? Math.round(v / 3600) + 'h' : Math.round(v / 86400) + 'd'; };
  const pct = (v, dp = 1) => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp) + '%';
  const cls = (v) => v == null ? 'mu' : v >= 0 ? 'up' : 'dn';
  const avatar = (t, c = 'tx-av') => t.image ? `<img class="${c}" src="${esc(t.image)}" alt="" loading="lazy">` : `<span class="${c} tx-av-t">${esc((t.symbol || '?')[0])}</span>`;
  const padAv = (p) => !p ? '' : p.avatar ? `<img class="tx-pad" src="${esc(p.avatar)}" alt="" referrerpolicy="no-referrer" title="${esc(p.name)}">` : p.ours ? `<img class="tx-pad" src="/assets/logo-64.png" alt="" title="Rookery">` : '';
  const go = () => history.replaceState(null, '', '#/terminal/' + st.net + (st.sel ? (st.sel.kind === 'm' ? '/m/' : '/token/') + st.sel.id : st.pad !== 'all' ? '/' + st.pad : ''));
  const app = $('#app');
  app.innerHTML = `<div class="tx">
    <div class="tx-top"><div class="tx-netbar"><div class="tx-nets"></div><span class="tx-status" id="txStatus"></span></div>
      <label class="tx-search"><span>⌕</span><input id="txQ" placeholder="Search a coin or paste a contract" autocomplete="off"><kbd>/</kbd></label>
      <select id="txPad" class="tx-sel"></select><button class="tx-btn" id="txDir">Launchpads</button></div>
    <div class="tx-body">
      <aside class="tx-feed"><div class="tx-tabs" id="txTabs"></div><div class="tx-fh"><span>Coin</span><span>MC</span></div><div class="tx-list" id="txList"></div></aside>
      <main class="tx-center" id="txCenter"></main>
      <aside class="tx-side" id="txSide"></aside>
    </div>
    <div class="tx-keys"><span class="tx-live"><i></i>Live</span><span>${S.me ? esc(S.me.username || 'signed in') : 'signed out'}</span>
      <span><kbd>/</kbd> Search</span><span><kbd>↑↓</kbd> Coins</span><span><kbd>B</kbd> Buy</span><span><kbd>S</kbd> Sell</span><span><kbd>1-4</kbd> Amount</span><span><kbd>W</kbd> Watch</span><span><kbd>Esc</kbd> Leave field</span></div>
    <div class="tx-dir" id="txDirPanel" hidden></div></div>`;
  let D = null, pads = {};

  async function loadFeed() {
    const tab = st.tab === 'watch' ? '' : st.tab;
    D = await api(`/terminal?net=${st.net}&tab=${tab}&pad=${encodeURIComponent(st.pad)}&sort=${st.tab === 'trending' ? 'trending' : st.tab === 'new' ? 'new' : 'mcap'}&q=${encodeURIComponent(st.q)}`);
    pads = Object.fromEntries(D.pads.map(p => [p.id, p]));
    let list = D.tokens;
    if (st.tab === 'watch') list = list.filter(t => watch.has(keyOf(t)));
    st.list = list;
    const N = D.nets[D.net];
    $('.tx-nets').innerHTML = Object.entries(D.nets).map(([k, v]) => `<button data-net="${k}" class="${k === st.net ? 'on' : ''}">${k === 'giwa' ? '<img src="/assets/giwa.png" alt="">' : k === 'litvm' ? '<img src="/assets/chains/litecoin.svg" alt="">' : '<b>Ø</b>'}${esc(v.label)}</button>`).join('');
    $('#txStatus').innerHTML = D.chainLive ? `<i class="tx-dot live"></i>${esc(N.label)} live · block ${D.cursor.toLocaleString('en-US')}` : `<i class="tx-dot"></i>${esc(N.label)} mainnet ${esc(N.mainnet)}`;
    $('#txPad').innerHTML = `<option value="all">All launchpads (${D.pads.length})</option>` + D.pads.map(p => `<option value="${p.id}" ${st.pad === p.id ? 'selected' : ''}>${esc(p.name)} · ${p.tokens}</option>`).join('');
    $('#txTabs').innerHTML = [['trending', 'Trending'], ['new', 'New'], ['bonding', 'Almost bonded'], ['watch', `Watch${watch.size ? ' ' + watch.size : ''}`]].map(([k, l]) => `<button data-tab="${k}" class="${st.tab === k ? 'on' : ''}">${l}</button>`).join('');
    $('#txList').innerHTML = list.length ? list.map((t, i) => `<button class="tx-row ${st.sel && keyOf(t) === (st.sel.kind === 'm' ? 'm:' + st.sel.id : 'c:' + st.net + ':' + st.sel.id) ? 'on' : ''}" data-i="${i}">
        ${avatar(t)}<span class="tx-rn"><b>${esc(t.name || 'Unnamed')}</b><span class="mu">${padAv(pads[t.pad])}$${esc(t.symbol || '?')} · ${t.ts ? ago(t.ts) : '—'}${t.address ? ` · <span class="mono">…${esc(t.address.slice(-4))}</span>` : ''}</span></span>
        <span class="tx-rm"><b>${t.mcapUsd ? fmtUsd(t.mcapUsd) : '—'}</b><span class="${t.change24h != null ? cls(t.change24h) : 'mu'}">${t.change24h != null ? pct(t.change24h) : t.x ? t.x.toFixed(1) + 'x' : t.reserved ? 'reserved' : '—'}</span></span></button>`).join('')
      : `<div class="tx-empty">${st.tab === 'watch' ? 'Press W on a coin to add it to your watchlist.' : st.tab === 'bonding' ? 'No coin above 50% of its curve yet.' : D.chainLive ? 'Nothing here yet.' : `${esc(N.label)} mainnet starts ${N.mainnet === 'TBA' ? 'soon' : 'on ' + esc(N.mainnet)}. Tokens of every launchpad land here from the first block.`}</div>`;
    $$('[data-net]').forEach(b => b.onclick = () => { if (st.net === b.dataset.net) return; st.net = b.dataset.net; st.pad = 'all'; st.sel = null; st.q = ''; $('#txQ').value = ''; go(); loadFeed().then(autoPick); });
    $$('[data-tab]').forEach(b => b.onclick = () => { st.tab = b.dataset.tab; loadFeed(); });
    $$('.tx-row').forEach(b => b.onclick = () => pick(st.list[+b.dataset.i]));
    renderDir();
  }
  function autoPick() { if (!st.sel && st.list.length) pick(st.list[0], true); else if (!st.list.length && !st.sel) { $('#txCenter').innerHTML = `<div class="tx-empty big">Pick a coin on the left.</div>`; $('#txSide').innerHTML = ''; } }
  function pick(t, quiet) {
    if (!t) return;
    st.sel = t.market ? { kind: 'm', id: t.market } : { kind: 'c', id: t.address };
    st.selRow = t; go();
    $$('.tx-row').forEach(r => r.classList.toggle('on', st.list[+r.dataset.i] === t));
    if (!quiet) $('.tx-row.on')?.scrollIntoView({ block: 'nearest' });
    loadToken().then(() => { if (!quiet && innerWidth < 960) $('#txCenter')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }
  function renderDir() {
    const el = $('#txDirPanel'); if (!D) return;
    el.innerHTML = `<div class="tx-dir-in"><div class="tx-dir-h"><b>Launchpads on ${esc(D.nets[D.net].label)}</b><button class="tx-btn" id="txDirX">✕</button></div>
      <div class="tx-dir-g">${D.pads.map(p => `<button class="tx-dp" data-dpad="${p.id}">${padAv(p) || `<span class="tx-av tx-av-t">${esc(p.name[0])}</span>`}<span><b>${esc(p.name)}</b><em class="tx-st ${p.status}">${p.status === 'live' ? 'LIVE' : p.status === 'testnet' ? 'TESTNET' : 'SOON'}</em><small class="mu">${esc(p.kind)}</small>
      <small><a href="https://x.com/${esc(p.handle)}" target="_blank" rel="noopener">@${esc(p.handle)}</a>${p.followers ? ` · ${p.followers.toLocaleString('en-US')} followers` : ''}${p.site ? ` · <a href="${esc(p.site)}" target="_blank" rel="noopener">site ↗</a>` : ''} · ${p.tokens} tokens</small></span></button>`).join('')}</div></div>`;
    $('#txDirX').onclick = () => { el.hidden = true; };
    $$('[data-dpad]').forEach(b => b.onclick = (e) => { if (e.target.closest('a')) return; st.pad = b.dataset.dpad; el.hidden = true; st.sel = null; go(); loadFeed().then(autoPick); });
  }

  // ── selected coin: center (header, stats, chart, trades/holders/about) + side (trade, intel)
  let T = null, I = null;
  async function loadToken() {
    const sel = st.sel; if (!sel) return;
    try {
      const [tok, intel] = await Promise.all([
        sel.kind === 'm' ? api('/market/' + sel.id) : api(`/terminal/token?net=${st.net}&addr=${encodeURIComponent(sel.id)}`),
        api(`/terminal/intel?net=${st.net}&${sel.kind === 'm' ? 'market' : 'addr'}=${encodeURIComponent(sel.id)}`).catch(() => null)]);
      if (st.sel !== sel) return;
      T = tok; I = intel; renderCenter(); renderSide();
    } catch (e) { $('#txCenter').innerHTML = `<div class="tx-empty big">${esc(e.message || 'Not indexed yet')}</div>`; }
  }
  function norm() {   // one shape for Rookery markets and on-chain tokens
    const row = st.selRow || st.list.find(t => (st.sel.kind === 'm' ? t.market === st.sel.id : t.address === st.sel.id)) || {};
    if (st.sel.kind === 'm') {
      const m = T.market;
      return { m, name: m.name, symbol: m.symbol, image: m.image, pad: pads.rookery, ts: m.created, priceUsd: m.priceUsd, mcapUsd: m.mcapUsd, liqUsd: m.liquidityUsd, holders: m.holders ?? row.holders,
        vol24h: row.vol24h, top10: row.top10, change24h: row.change24h, x: row.x, progress: m.progress, address: m.chainContract || m.zeroContract, reserved: !m.migrated,
        trades: (T.trades || []).slice().reverse().map(t => ({ side: t.side, usd: Number(B(t.zro)) / 1e18 * (t.usd || 0), tok: t.tokens, who: t.username || 'trader', ts: t.ts })),
        holdersList: (T.holders || []).map(h => ({ who: h.username || short(h.address), amount: h.amount, pct: h.pct, tag: h.creator ? 'creator' : h.tag || '' })),
        points: (T.trades || []).map(t => ({ ts: t.ts, p: Number(B(t.price)) / 1e18 * (t.usd || 0) })), about: m.description, links: { x: m.x, tg: m.tg, web: m.web } };
    }
    const t = T.token;
    return { name: t.name, symbol: t.symbol, pad: T.pad, ts: t.ts, priceUsd: t.priceUsd, mcapUsd: t.mcapUsd, liqUsd: null, holders: t.holders, vol24h: t.volumeUsd, top10: t.top10, change24h: null, x: null, address: t.address, est: true,
      trades: T.txs.filter(x => x.kind === 'buy' || x.kind === 'sell').map(x => ({ side: x.kind, usd: x.valueUsd, tok: x.amount, who: short(x.kind === 'buy' ? x.to_a : x.from_a), ts: x.ts, tx: x.tx })),
      holdersList: T.holders.map(h => ({ who: short(h.address), amount: h.amount, pct: h.pct, tag: h.tag })), points: T.points.map(x => ({ ts: x.ts, p: x.priceUsd })), contract: t, explorer: T.explorer };
  }
  function renderCenter() {
    const n = norm(), wk = st.sel.kind === 'm' ? 'm:' + st.sel.id : 'c:' + st.net + ':' + st.sel.id;
    const stat = (l, v, c = '') => `<div><span>${l}</span><b class="${c}">${v}</b></div>`;
    $('#txCenter').innerHTML = `
      <div class="tx-th">${avatar(n, 'tx-av lg')}<div class="tx-tn"><h2>${esc(n.name)} <span class="mu">$${esc(n.symbol)}</span></h2>
        <div class="tx-tags"><span>${n.ts ? ago(n.ts) + ' old' : ''}</span>${n.pad ? `<span class="tx-tag">${padAv(n.pad)}${esc(n.pad.name)}</span>` : ''}${n.progress != null ? `<span class="tx-tag">${Number(n.progress).toFixed(0)}% bonded</span>` : ''}
        ${n.address ? `<button class="tx-tag mono" data-copy="${esc(n.address)}">${esc(short(n.address))}${n.reserved ? ' · reserved' : ''} ⧉</button>` : ''}</div></div>
        <div class="tx-th-r"><button class="tx-btn ${watch.has(wk) ? 'on' : ''}" id="txWatch">${watch.has(wk) ? '★ Watching' : '☆ Watch'}</button>${st.sel.kind === 'm' ? `<a class="tx-btn" href="#/t/${esc(st.sel.id)}" onclick="sessionStorage.setItem('termBack', location.hash)">Full page ↗</a>` : ''}</div></div>
      <div class="tx-stats"><div class="tx-mc"><b>${n.mcapUsd ? (n.est ? '≈ ' : '') + fmtUsd(n.mcapUsd) : '—'}</b><span><em class="${cls(n.change24h)}">${n.change24h != null ? pct(n.change24h) + ' 24h' : ''}</em>${n.x ? ` <em class="up">${n.x.toFixed(2)}x since launch</em>` : ''}</span></div>
        ${stat('Price', n.priceUsd ? fmtUsd(n.priceUsd) : '—')}${stat('Liquidity', n.liqUsd ? fmtUsd(n.liqUsd) : '—')}${stat('Holders', n.holders != null ? Number(n.holders).toLocaleString('en-US') : '—')}
        ${stat('Volume 24h', n.vol24h ? fmtUsd(n.vol24h) : '$0')}${stat('Top 10', n.top10 != null ? n.top10.toFixed(1) + '%' : '—', n.top10 >= 30 ? 'dn' : n.top10 >= 15 ? 'warn' : '')}</div>
      <div class="tx-cbar"><div class="tx-seg">${[[60, '1m'], [300, '5m'], [900, '15m'], [3600, '1h']].map(([v, l]) => `<button data-iv="${v}" class="${st.ival === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="tx-seg"><button data-mode="mcap" class="${st.mode === 'mcap' ? 'on' : ''}">MCap</button><button data-mode="price" class="${st.mode === 'price' ? 'on' : ''}">Price</button></div>
        <span class="mu tx-ath">${I?.athUsd ? `ATH ${fmtUsd(st.mode === 'mcap' ? I.athUsd * 1e9 : I.athUsd)} · ${pct(I.fromAthPct, 0)}` : ''}</span></div>
      <div class="tx-chart" id="txChart">${n.points.length < 2 ? '<div class="tx-empty">The chart appears after the first trades.</div>' : ''}</div>
      <div class="tx-btabs">${[['trades', `Trades ${n.trades.length}`], ['holders', `Holders ${n.holders ?? ''}`], ['about', 'About']].map(([k, l]) => `<button data-bt="${k}" class="${st.btab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="tx-bbody" id="txB"></div>`;
    $('#txWatch').onclick = () => { watch.has(wk) ? watch.delete(wk) : watch.add(wk); saveWatch(); renderCenter(); loadFeed(); };
    $$('[data-iv]').forEach(b => b.onclick = () => { st.ival = +b.dataset.iv; renderCenter(); });
    $$('[data-mode]').forEach(b => b.onclick = () => { st.mode = b.dataset.mode; renderCenter(); });
    $$('[data-bt]').forEach(b => b.onclick = () => { st.btab = b.dataset.bt; $$('[data-bt]').forEach(x => x.classList.toggle('on', x === b)); bottom(n); });
    bottom(n); chart(n);
  }
  function bottom(n) {
    const el = $('#txB');
    if (st.btab === 'trades') el.innerHTML = `<table class="tbl tx-tbl"><thead><tr><th>Side</th><th class="num">USD</th><th class="num">Tokens</th><th>Trader</th><th>Age</th></tr></thead><tbody>${n.trades.slice(0, 60).map(t => `<tr><td class="${t.side === 'buy' ? 'up' : 'dn'}">${t.side.toUpperCase()}</td><td class="num">${t.usd ? fmtUsd(t.usd) : '—'}</td><td class="num">${fmtT(t.tok)}</td><td>${esc(t.who)}</td><td class="mu">${ago(t.ts)}</td></tr>`).join('') || '<tr><td colspan="5" class="tx-empty">No trades yet.</td></tr>'}</tbody></table>`;
    else if (st.btab === 'holders') el.innerHTML = `<table class="tbl tx-tbl"><thead><tr><th>#</th><th>Holder</th><th class="num">Tokens</th><th class="num">Share</th></tr></thead><tbody>${n.holdersList.slice(0, 50).map((h, i) => `<tr><td class="mu">${i + 1}</td><td>${esc(h.who)} ${h.tag ? `<span class="tx-tag">${esc(h.tag)}</span>` : ''}</td><td class="num">${fmtT(h.amount)}</td><td class="num">${Number(h.pct || 0).toFixed(2)}%</td></tr>`).join('') || '<tr><td colspan="4" class="tx-empty">No holders yet.</td></tr>'}</tbody></table>`;
    else el.innerHTML = `<div class="tx-about">${n.about ? `<p>${esc(n.about)}</p>` : ''}${n.links ? `<p>${['x', 'tg', 'web'].filter(k => n.links[k]).map(k => `<a href="${esc(n.links[k])}" target="_blank" rel="noopener">${k === 'x' ? 'X' : k === 'tg' ? 'Telegram' : 'Website'} ↗</a>`).join(' · ')}</p>` : ''}
      ${n.contract ? `<div class="kv"><span>Token</span><b class="mono">${esc(n.contract.address)}</b></div><div class="kv"><span>Curve / pool</span><b class="mono">${esc(short(n.contract.pool))}</b></div><div class="kv"><span>Creator</span><b class="mono">${esc(short(n.contract.creator))}</b></div><div class="kv"><span>Supply</span><b>${fmtT(n.contract.supply)}</b></div>` : ''}
      ${n.address ? `<div class="kv"><span>${esc(D.nets[st.net].label)} address</span><b class="mono">${esc(n.address)}${n.reserved ? ' <span class="mu">reserved, live at mainnet</span>' : ''}</b></div>` : ''}
      ${n.pad ? `<div class="kv"><span>Launchpad</span><b>${esc(n.pad.name)} · ${esc(n.pad.kind)}</b></div>` : ''}</div>`;
  }
  function chart(n) {
    const LW = window.LightweightCharts, el = $('#txChart');
    if (S.chart) { try { S.chart.remove(); } catch {} S.chart = null; }
    if (!LW || !el || n.points.length < 2) return;
    S.chart = LW.createChart(el, { autoSize: true, layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#76767E', fontFamily: 'JetBrains Mono', fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,.035)' }, horzLines: { color: 'rgba(255,255,255,.035)' } }, rightPriceScale: { borderColor: '#1E1E23' }, timeScale: { borderColor: '#1E1E23', timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 } });
    const mul = st.mode === 'mcap' ? 1e9 : 1;
    const ser = S.chart.addCandlestickSeries({ upColor: '#3DDC97', downColor: '#FF5C5C', borderVisible: false, wickUpColor: '#3DDC97', wickDownColor: '#FF5C5C',
      priceFormat: { type: 'custom', formatter: (v) => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v >= 1 ? v.toFixed(2) : Number(v).toPrecision(3)), minMove: 1e-12 } });
    if (n.points.length < 8) {
      const line = S.chart.addLineSeries({ color: '#3DDC97', lineWidth: 2, priceFormat: { type: 'custom', formatter: (v) => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v >= 1 ? v.toFixed(2) : Number(v).toPrecision(3)), minMove: 1e-12 } });
      S.chart.removeSeries(ser);
      const seen = new Map(); for (const x of n.points) seen.set(Math.floor(x.ts / 1000), x.p * mul);
      line.setData([...seen.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value })));
      S.chart.timeScale().fitContent(); return;
    }
    const map = new Map(); let prev = n.points[0].p * mul;
    for (const x of n.points) { const p = x.p * mul, b = Math.floor(x.ts / 1000 / st.ival) * st.ival, c = map.get(b);
      if (!c) map.set(b, { time: b, open: prev, high: Math.max(prev, p), low: Math.min(prev, p), close: p }); else { c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; } prev = p; }
    ser.setData([...map.values()].sort((x, y) => x.time - y.time));
    S.chart.timeScale().fitContent();
  }
  function renderSide() {
    const n = norm(), side = $('#txSide');
    const intelCard = I ? `<div class="tx-intel"><i class="tx-dot amber"></i><span><b>${I.inProfit}</b> in profit · <b>${I.supplyInProfitPct.toFixed(1)}%</b> ≈ <b>${fmtUsd(I.valueInProfitUsd)}</b> can sell into your buy</span><button class="tx-link" data-rt="intel">See exit pressure →</button></div>` : '';
    const tabs = `<div class="tx-rtabs"><button data-rt="trade" class="${st.rtab === 'trade' ? 'on' : ''}">Trade</button><button data-rt="intel" class="${st.rtab === 'intel' ? 'on' : ''}">Intel</button></div>`;
    if (st.rtab === 'intel') {
      const row = (l, v, c = '') => `<div class="kv"><span>${l}</span><b class="${c}">${v}</b></div>`;
      side.innerHTML = tabs + (I ? `<div class="tx-intel-full">
        ${row('Holders in profit', `${I.inProfit} of ${I.holders} (${I.inProfitPct.toFixed(0)}%)`)}${row('Supply in profit', I.supplyInProfitPct.toFixed(1) + '%')}${row('Value they can sell', fmtUsd(I.valueInProfitUsd), 'warn')}
        ${row('In-profit avg entry', I.inProfitEntryUsd ? fmtUsd(I.inProfitEntryUsd * (st.mode === 'mcap' ? 1e9 : 1)) + (st.mode === 'mcap' ? ' mcap' : '') : '—')}${row('Top 100 avg entry', I.top100EntryUsd ? fmtUsd(I.top100EntryUsd * (st.mode === 'mcap' ? 1e9 : 1)) + (st.mode === 'mcap' ? ' mcap' : '') : '—')}
        ${row('ATH', I.athUsd ? fmtUsd(I.athUsd * (st.mode === 'mcap' ? 1e9 : 1)) + ' · ' + pct(I.fromAthPct, 0) : '—')}${row('Traders · 1h', I.traders1h)}${row('Buyers / sellers · 1h', `<span class="up">${I.buyers1h}</span> / <span class="dn">${I.sellers1h}</span>`)}
        ${row('Net buyers · 1h', (I.netBuyers1h >= 0 ? '+' : '') + I.netBuyers1h, I.netBuyers1h >= 0 ? 'up' : 'dn')}<p class="mu tx-note">${esc(I.note)}</p></div>` : '<div class="tx-empty">No data yet.</div>');
    } else if (st.sel.kind === 'm' && n.m && !n.m.migrated && !n.m.rh) {
      const m = n.m, Q = m.quote || 'ZRO', QA = qaOf(Q), A = ASSET[QA] || ASSET.zro;
      side.innerHTML = tabs + `<div class="tx-bs"><button data-side="buy" class="${st.side === 'buy' ? 'on buy' : ''}">Buy <kbd>B</kbd></button><button data-side="sell" class="${st.side === 'sell' ? 'on sell' : ''}">Sell <kbd>S</kbd></button></div>
        <label class="tx-amt"><input id="txAmt" inputmode="decimal" placeholder="0.0"><span>${st.side === 'buy' ? esc(A.label) : '$' + esc(m.symbol)}</span></label>
        <div class="tx-pre">${(st.side === 'buy' ? A.quick : ['25', '50', '75', '100']).map((v, i) => `<button data-pre="${v}">${st.side === 'buy' ? v : v + '%'}<kbd>${i + 1}</kbd></button>`).join('')}</div>
        <div class="tx-get" id="txGet"><span>You get</span><b>—</b></div>
        <div class="tx-get"><span>Fees</span><b class="mu">${(0.5 + m.taxes.marketing + m.taxes.rewards).toFixed(1)}% + ${m.taxes.burn}% burn</b></div>
        ${intelCard}
        <button class="btn lg wide ${st.side === 'buy' ? 'up' : 'dn'}" id="txGo">${S.me ? (st.side === 'buy' ? 'Buy' : 'Sell') + ' $' + esc(m.symbol) : 'Log in to trade'}</button>
        ${T.me ? `<p class="mu tx-note">You hold ${fmtT(T.me.tokens || '0')} $${esc(m.symbol)} · ${fmtA(T.me[QA] || '0', QA)}</p>` : ''}`;
      const amt = $('#txAmt');
      const est = () => {
        const v = toWei(amt.value); let out = '—';
        if (v > 0n) { if (st.side === 'buy') { const e = estBuy(m, v); out = e ? `${fmtT(e.tokens)} $${esc(m.symbol)}` : '—'; } else { const e = estSell(m, v); out = e ? `${fmtA(e.zro, QA)} · ${fmtUsd(zNum(e.zro) * assetUsd(QA))}` : '—'; } }
        $('#txGet b').innerHTML = out;
      };
      amt.oninput = est;
      $$('[data-pre]').forEach(b => b.onclick = () => { amt.value = st.side === 'buy' ? b.dataset.pre : (T.me ? weiToStr((B(T.me.tokens || '0') * BigInt(b.dataset.pre)) / 100n, 4) : ''); est(); });
      $$('[data-side]').forEach(b => b.onclick = () => { st.side = b.dataset.side; renderSide(); });
      $('#txGo').onclick = async () => {
        if (!S.me) { location.hash = '#/login'; return; }
        const w = toWei(amt.value); if (w <= 0n) return toast('Enter an amount', 'bad');
        const btn = $('#txGo'); btn.disabled = true; btn.textContent = 'Sending…';
        try { await api('/trade', { market: m.id, side: st.side, amount: w.toString() }); toast(`${st.side === 'buy' ? 'Bought' : 'Sold'} $${m.symbol}`); amt.value = ''; await loadToken(); loadFeed(); }
        catch (e) { toast(esc(e.message || e), 'bad'); btn.disabled = false; btn.textContent = st.side === 'buy' ? 'Buy' : 'Sell'; }
      };
    } else {
      const p = n.pad;
      side.innerHTML = tabs + `<div class="tx-ext"><p>${p ? `$${esc(n.symbol)} trades on <b>${esc(p.name)}</b>.` : 'Trade this coin on its launchpad.'} Open it there to buy or sell with your wallet.</p>
        ${p?.site ? `<a class="btn lg wide up" href="${esc(p.site)}" target="_blank" rel="noopener">Trade on ${esc(p.name)} ↗</a>` : ''}${n.explorer ? `<a class="btn wide ghost" href="${esc(n.explorer.replace(/\/$/, ''))}/token/${esc(n.address)}" target="_blank" rel="noopener">Explorer ↗</a>` : ''}</div>
        ${intelCard}<div class="tx-risk">${n.top10 >= 30 ? `<p class="dn">⚠ Top 10 wallets hold ${n.top10.toFixed(1)}%</p>` : ''}${n.contract?.creatorPct >= 10 ? `<p class="dn">⚠ Creator holds ${n.contract.creatorPct.toFixed(1)}%</p>` : ''}<p class="mu tx-note">Price and market cap are estimated from the coin paid in buys on-chain.</p></div>`;
    }
    if (st.rtab === 'trade') {
      const it = (l, v, c = '') => `<div class="kv"><span>${l}</span><b class="${c}">${v}</b></div>`;
      const cp = n.contract?.creatorPct ?? (st.selRow?.creatorPct);
      side.insertAdjacentHTML('beforeend', `<div class="tx-safe"><h4>Safety</h4>
        ${it('Top 10 holders', n.top10 != null ? n.top10.toFixed(1) + '%' : '—', n.top10 >= 30 ? 'dn' : n.top10 >= 15 ? 'warn' : 'up')}
        ${it('Creator holds', cp != null ? Number(cp).toFixed(1) + '%' : '—', cp >= 10 ? 'dn' : 'up')}
        ${it('Holders', n.holders != null ? Number(n.holders).toLocaleString('en-US') : '—')}
        ${n.progress != null ? it('Bonding curve', Number(n.progress).toFixed(0) + '%') + `<div class="tx-prog"><i style="width:${Math.min(100, n.progress)}%"></i></div>` : ''}
        ${I ? it('Net buyers · 1h', (I.netBuyers1h >= 0 ? '+' : '') + I.netBuyers1h, I.netBuyers1h >= 0 ? 'up' : 'dn') + it('From ATH', I.fromAthPct != null ? pct(I.fromAthPct, 0) : '—', cls(I.fromAthPct)) : ''}
        ${n.address ? it(esc(D.nets[st.net].label) + ' contract', `<span class="mono">${esc(short(n.address))}</span>${n.reserved ? ' <span class="mu">reserved</span>' : ''}`) : ''}</div>`);
    }
    $$('[data-rt]').forEach(b => b.onclick = () => { st.rtab = b.dataset.rt; renderSide(); });
  }

  // ── controls, keyboard, refresh
  let qt; $('#txQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { st.q = e.target.value.trim(); loadFeed(); }, 300); };
  $('#txPad').onchange = (e) => { st.pad = e.target.value; st.sel = null; go(); loadFeed().then(autoPick); };
  $('#txDir').onclick = () => { $('#txDirPanel').hidden = false; };
  const onKey = (e) => {
    if (!location.hash.startsWith('#/terminal')) { document.removeEventListener('keydown', onKey); return; }
    const inField = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') { document.activeElement?.blur(); $('#txDirPanel').hidden = true; return; }
    if (inField) return;
    if (e.key === '/') { e.preventDefault(); $('#txQ').focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const i = st.list.findIndex(t => (st.sel?.kind === 'm' ? t.market === st.sel.id : t.address === st.sel?.id)); const j = Math.max(0, Math.min(st.list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))); pick(st.list[j]); }
    else if (e.key === 'b' || e.key === 'B') { st.side = 'buy'; st.rtab = 'trade'; renderSide(); }
    else if (e.key === 's' || e.key === 'S') { st.side = 'sell'; st.rtab = 'trade'; renderSide(); }
    else if (e.key === 'w' || e.key === 'W') $('#txWatch')?.click();
    else if (/^[1-4]$/.test(e.key)) { const b = $$('[data-pre]')[+e.key - 1]; if (b) b.click(); }
  };
  document.addEventListener('keydown', onKey);
  await loadFeed();
  if (st.sel) loadToken(); else autoPick();
  S.timer = setInterval(() => { if (!location.hash.startsWith('#/terminal')) return; loadFeed().catch(() => {}); if (st.sel && !/INPUT/.test(document.activeElement?.tagName || '')) loadToken().catch(() => {}); }, 15000);
}
