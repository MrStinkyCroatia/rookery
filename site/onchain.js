/* Rookery On-chain — real EVM launchpads (RookeryPad) on live chains.
   Loaded after app.js; shares its helpers ($, $$, esc, fmtUsd, fmtT, toast, ago, S, app, debounce, toWei, weiToStr, axisUsd). */
'use strict';

const OC_CHAINS = {
  eth:  { name: 'Ethereum', chainId: 1, native: 'ETH', color: '#7B93F5', ink: '#0B0D1A', logo: '/assets/chains/ethereum.svg',
          rpc: 'https://ethereum.publicnode.com', explorer: 'https://etherscan.io', explorerName: 'Etherscan', dex: 'Uniswap V2',
          dexUrl: (t) => `https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${t}`, target: 4, cg: 'ethereum',
          pad: null, deployBlock: 0 },
  base: { name: 'Base', chainId: 8453, native: 'ETH', color: '#3C7BFF', ink: '#fff', logo: '/assets/chains/base.svg',
          rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org', explorerName: 'BaseScan', dex: 'Uniswap V2',
          dexUrl: (t) => `https://app.uniswap.org/swap?chain=base&outputCurrency=${t}`, target: 2, cg: 'ethereum',
          pad: null, deployBlock: 0 },
  bsc:  { name: 'BNB Chain', chainId: 56, native: 'BNB', color: '#F0B90B', ink: '#141006', logo: '/assets/chains/binance.svg',
          rpc: 'https://bsc-dataseed.binance.org', explorer: 'https://bscscan.com', explorerName: 'BscScan', dex: 'PancakeSwap V2',
          dexUrl: (t) => `https://pancakeswap.finance/swap?outputCurrency=${t}`, target: 12, cg: 'binancecoin',
          pad: null, deployBlock: 0 },
  rh:   { name: 'Robinhood Chain', chainId: 4663, native: 'ETH', color: '#CCFF00', ink: '#101400', logo: '/assets/chains/robinhood.png',
          rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com', explorerName: 'Blockscout', dex: 'Uniswap V2',
          dexUrl: (t) => `https://robinhoodchain.blockscout.com/token/${t}`, target: 2, cg: 'ethereum',
          pad: null, deployBlock: 0 },
  elysium: { name: 'Elysium', chainId: 1338, native: 'LAVA', color: '#B6F23A', ink: '#0E1400', logo: '/assets/chains/elysium.png', soon: true,
          rpc: '', explorer: 'https://elysium-explorer.vulcanforged.com', explorerName: 'Explorer', dex: 'TBA', target: 0, cg: null, pad: null },
};
const OC_ORDER = ['eth', 'base', 'bsc', 'rh', 'elysium'];
const OC_FEE_BPS = 50n;
const OC_CURVE = 800_000_000n * WEI, OC_LP = 200_000_000n * WEI, OC_SUPPLY = 1_000_000_000n * WEI;
const OC_ZERO = '0x0000000000000000000000000000000000000000';
const OC = { key: null, px: {}, wallet: null, data: {}, ethers: null, net: {}, statT: null,
  demo: localStorage.getItem('oc_demo') != null ? localStorage.getItem('oc_demo') === '1' : /workers\.dev$/.test(location.hostname),
  view: localStorage.getItem('oc_view') || 'table', slip: Number(localStorage.getItem('oc_slip') || 2) };

/* ───────── theme ───────── */
function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return `${n >> 16 & 255},${n >> 8 & 255},${n & 255}`; }
function ocTheme(key) {
  const root = document.documentElement, c = OC_CHAINS[key];
  if (!c) {
    delete root.dataset.chain; ['--acc', '--acc-ink', '--acc-rgb'].forEach(v => root.style.removeProperty(v));
    clearInterval(OC.statT); OC.statT = null; return;
  }
  root.dataset.chain = key;
  root.style.setProperty('--acc', c.color); root.style.setProperty('--acc-ink', c.ink); root.style.setProperty('--acc-rgb', hexRgb(c.color));
  const lbl = $('#netLabel'); if (lbl) lbl.innerHTML = `<img class="oc-lg" src="${c.logo}" alt="">${esc(c.name)}`;
  $$('#netMenu .mi[data-oc]').forEach(b => b.classList.toggle('on', b.dataset.oc === key));
  $$('#netMenu .mi[data-net]').forEach(b => b.classList.remove('on'));
}
function ocInitMenu() {
  const menu = $('#netMenu'); if (!menu || menu.dataset.oc) return;
  menu.dataset.oc = '1';
  const first = menu.querySelector('.menu-h'); if (first) first.textContent = 'Rookery ledger · pre-mainnet';
  const html = `<div class="menu-h" style="margin-top:4px">On-chain launchpads</div>` +
    OC_ORDER.map(k => { const c = OC_CHAINS[k]; return `<button class="mi" data-oc="${k}"><img class="oc-mi" src="${c.logo}" alt="">
      <div><b>${c.name}</b><br><span class="mu" style="font-size:11.5px">${c.soon ? 'Coming soon' : `${c.dex} · ${c.native}`}</span></div><small>${c.soon ? 'Soon' : c.pad ? 'Live' : 'Pending'}</small></button>`; }).join('');
  const dep = [...menu.querySelectorAll('.menu-h')].find(x => /deposit/i.test(x.textContent));
  if (dep) dep.insertAdjacentHTML('beforebegin', html); else menu.insertAdjacentHTML('beforeend', html);
  const last = localStorage.getItem('oc_last');
  if (OC_CHAINS[last]) $$('a[data-nav="chain"]').forEach(a => a.setAttribute('href', `#/chain/${last}`));
  $$('#netMenu .mi[data-oc]').forEach(b => b.onclick = () => { menu.classList.remove('open'); location.hash = `#/chain/${b.dataset.oc}`; });
}

/* ───────── curve math — identical to RookeryPad.sol (BigInt) ───────── */
const ceilDiv = (a, b) => (a + b - 1n) / b;
function ocNewSale(target) { return { target, vq: target * 25n / 73n, vt: OC_CURVE * 98n / 73n, raised: 0n, sold: 0n, graduated: false }; }
function ocQuoteBuy(s, amountIn) {
  if (s.graduated || amountIn <= 0n) return { out: 0n, used: 0n, fee: 0n, net: 0n, refund: 0n };
  let fee = amountIn * OC_FEE_BPS / 10000n, net = amountIn - fee;
  const room = s.target - s.raised;
  if (net > room) { net = room; fee = ceilDiv(net * OC_FEE_BPS, 10000n - OC_FEE_BPS); }
  const qv = s.vq + s.raised, tv = s.vt - s.sold;
  let out = tv - ceilDiv(qv * tv, qv + net);
  if (s.sold + out > OC_CURVE) out = OC_CURVE - s.sold;
  return { out, used: net + fee, fee, net, refund: amountIn - net - fee };
}
function ocQuoteSell(s, tokensIn) {
  if (s.graduated || tokensIn <= 0n) return { out: 0n, fee: 0n, gross: 0n };
  const qv = s.vq + s.raised, tv = s.vt - s.sold;
  let gross = qv - ceilDiv(qv * tv, tv + tokensIn);
  if (gross > s.raised) gross = s.raised;
  const fee = gross * OC_FEE_BPS / 10000n;
  return { out: gross - fee, fee, gross };
}
const ocPrice = (s) => s.graduated ? Number(s.target * 98n / 100n) / Number(OC_LP) : Number(s.vq + s.raised) / Number(s.vt - s.sold);
const ocNum = (wei) => Number(wei) / 1e18;
function ocFmtN(n, dp = 4) {
  if (!n) return '0';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n < 0.0001) return n.toPrecision(2);
  return n.toLocaleString('en-US', { maximumFractionDigits: dp });
}
const ocShort = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const ocProgress = (s) => Math.min(100, Number(s.raised * 10000n / (s.target || 1n)) / 100);
const ocUsd = (key) => OC.px[OC_CHAINS[key].cg] || 0;
const ocMcapUsd = (key, s) => ocPrice(s) * 1e9 * ocUsd(key);
const ocGradMcUsd = (key, target) => Number(target * 98n / 100n) / Number(OC_LP) * 1e9 * ocUsd(key);

/* ───────── identicon (deterministic, from address) ───────── */
function ocHash(str) { let h = 2166136261; for (const ch of String(str).toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function ocIdent(seed, size = 32) {
  let h = ocHash(seed); const nx = () => (h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0, h);
  const hue = nx() % 360, fg = `hsl(${hue} 62% 58%)`, bg = `hsl(${(hue + 180) % 360} 22% 14%)`;
  let r = '';
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (nx() % 2) {
    r += `<rect x="${x}" y="${y}" width="1" height="1"/>`; if (x < 2) r += `<rect x="${4 - x}" y="${y}" width="1" height="1"/>`;
  }
  return `<svg class="oc-id" width="${size}" height="${size}" viewBox="-.5 -.5 6 6" shape-rendering="crispEdges"><rect x="-.5" y="-.5" width="6" height="6" fill="${bg}"/><g fill="${fg}">${r}</g></svg>`;
}
const ocAvatar = (s, size = 32) => s.img ? `<img class="oc-av" style="width:${size}px;height:${size}px" src="${esc(s.img)}" alt="" loading="lazy">` : ocIdent(s.token || s.symbol, size);

/* ───────── prices + network stats ───────── */
async function ocPrices() {
  if (OC.px.t && Date.now() - OC.px.t < 120000) return OC.px;
  OC.px = { ethereum: S.stats?.ethUsd || 3000, binancecoin: 600, t: Date.now() };
  try {
    const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin&vs_currencies=usd')).json();
    if (j.ethereum?.usd) OC.px.ethereum = j.ethereum.usd;
    if (j.binancecoin?.usd) OC.px.binancecoin = j.binancecoin.usd;
  } catch { /* fallback values */ }
  return OC.px;
}
async function ocRpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function ocNetStats(key) {
  const c = OC_CHAINS[key]; if (!c.rpc) return;
  try {
    const [bn, gp] = await Promise.all([ocRpc(c.rpc, 'eth_blockNumber'), ocRpc(c.rpc, 'eth_gasPrice')]);
    OC.net[key] = { block: parseInt(bn, 16), gwei: parseInt(gp, 16) / 1e9, t: Date.now() };
  } catch { /* rpc down — keep last */ }
  ocPaintNet(key);
}
function ocPaintNet(key) {
  const el = $('#ocNet'); if (!el || OC.key !== key) return;
  const n = OC.net[key], c = OC_CHAINS[key];
  const g = n ? (n.gwei >= 1 ? n.gwei.toFixed(2) : n.gwei.toPrecision(2)) : '—';
  el.innerHTML = `<span><i class="oc-pulse"></i>Block <b>${n ? n.block.toLocaleString('en-US') : '—'}</b></span>
    <span>Gas <b>${g}</b> gwei</span><span>${c.native} <b>${fmtUsd(ocUsd(key))}</b></span>`;
}
function ocStartNet(key) {
  clearInterval(OC.statT);
  if (OC_CHAINS[key].soon) return;
  ocNetStats(key);
  OC.statT = setInterval(() => { if (location.hash.startsWith('#/chain/' + key)) ocNetStats(key); }, 12000);
}

/* ───────── DEMO data (contracts not deployed yet) — deterministic, run through the real curve math ───────── */
const OC_SAMPLE = [
  ['Glacier', 'GLCR', 'Slow, cold, unstoppable.'], ['Polar Labs', 'POLAR', 'Research collective for cold-weather memes.'],
  ['Emperor', 'EMPR', 'Only the coldest survive.'], ['Krill', 'KRILL', 'Small individually, enormous together.'],
  ['Tundra', 'TNDR', 'Frozen supply, warm community.'], ['Floe', 'FLOE', 'Drifting with the current.'],
  ['Aurora', 'AUR', 'Lights in the northern sky.'], ['Fjord', 'FJRD', 'Deep water, steep walls.'],
  ['Rookie', 'ROOK', 'First flight energy.'], ['Huddle', 'HUDL', 'Stay warm, stay together.'],
  ['Waddle', 'WADL', 'Walk slow, hold long.'], ['Iceberg', 'BERG', 'Ninety percent below the surface.'],
];
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x ^= x << 13, x ^= x >>> 17, x ^= x << 5) >>> 0) / 4294967296; }
const rhex = (r) => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(r() * 16)]).join('');
function ocDemo(key) {
  const ck = 'demo_' + key;
  if (OC.data[ck]) return OC.data[ck];
  const c = OC_CHAINS[key], r = rng(ocHash(key) || 7);
  const T = BigInt(Math.round(c.target * 1e6)) * 10n ** 12n;
  const now = Date.now(), sales = [];
  OC_SAMPLE.forEach(([name, symbol, desc], i) => {
    const target = i % 4 === 3 ? T / 2n : T;
    const s = Object.assign(ocNewSale(target), {
      id: i, name, symbol, desc, creator: rhex(r), token: rhex(r), img: '',
      created: now - Math.floor(r() * 3 * 864e5) - 6e5, creatorBps: [0, 0, 50, 100, 200][Math.floor(r() * 5)],
      maxWallet: [0, 0, 200, 300][Math.floor(r() * 4)], trades: [], holders: 0,
    });
    const goal = i === 0 ? 1.01 : i === 1 ? 0.93 : r() ** 1.6 * 0.9;
    const steps = 8 + Math.floor(r() * 40);
    let t = s.created;
    for (let k = 0; k < steps && !s.graduated; k++) {
      t += Math.floor(r() * (now - s.created) / steps);
      if (r() > 0.28 || s.sold === 0n) {
        const want = BigInt(Math.floor(Number(target) * goal / steps * (0.4 + r() * 1.4)));
        const q = ocQuoteBuy(s, want > 0n ? want : 1n);
        if (q.out <= 0n) continue;
        s.raised += q.net; s.sold += q.out;
        s.trades.push({ side: 'buy', native: q.net, tokens: q.out, ts: t, who: rhex(r), price: ocPrice(s) });
        if (s.raised >= s.target) s.graduated = true;
      } else {
        const tk = s.sold * BigInt(Math.floor(r() * 12 + 1)) / 100n;
        const q = ocQuoteSell(s, tk);
        if (q.out <= 0n) continue;
        s.raised -= q.gross; s.sold -= tk;
        s.trades.push({ side: 'sell', native: q.out, tokens: tk, ts: t, who: rhex(r), price: ocPrice(s) });
      }
    }
    if (goal > 0.9 && !s.graduated) {
      const want = s.target * BigInt(Math.round(goal * 1000)) / 1000n - s.raised;
      const q = ocQuoteBuy(s, want * 10050n / 10000n);
      if (q.out > 0n) { s.raised += q.net; s.sold += q.out; s.trades.push({ side: 'buy', native: q.net, tokens: q.out, ts: now - 9e5, who: rhex(r), price: ocPrice(s) }); }
      if (s.raised >= s.target) s.graduated = true;
    }
    s.holders = Math.max(1, Math.round(s.trades.length * 0.7));
    s.volume = s.trades.reduce((a, x) => a + ocNum(x.native), 0);
    sales.push(s);
  });
  OC.data[ck] = { demo: true, sales };
  return OC.data[ck];
}

/* ───────── LIVE data (pad deployed): read the chain directly ───────── */
const OC_ABI = [
  'function salesCount() view returns (uint256)',
  'function getSales(uint256 from, uint256 n) view returns (tuple(address token,address creator,address pair,uint64 createdAt,bool graduated,uint256 target,uint256 virtualQuote,uint256 virtualTokens,uint256 raised,uint256 sold)[])',
  'function defaultTarget() view returns (uint256)',
  'function create(string name,string symbol,string meta,uint16 creatorBps,address creatorWallet,uint256 maxWalletBps,uint256 customTarget,address referrer) payable returns (uint256,address)',
  'function buy(uint256 id,uint256 minOut,address referrer) payable returns (uint256)',
  'function sell(uint256 id,uint256 tokensIn,uint256 minOut,address referrer) returns (uint256)',
  'event Created(uint256 indexed id,address indexed token,address indexed creator,string name,string symbol,string meta,uint256 target,uint16 creatorBps,uint256 maxWallet)',
  'event Trade(uint256 indexed id,address indexed trader,bool isBuy,uint256 quoteAmt,uint256 tokenAmt,uint256 fee,address referrer,uint256 raised,uint256 sold)',
];
const OC_ERC20 = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];
async function ocEthers() {
  if (!OC.ethers) OC.ethers = await import('https://cdn.jsdelivr.net/npm/ethers@6.13.2/+esm');
  return OC.ethers;
}
async function ocLive(key) {
  const c = OC_CHAINS[key], ex = await ocEthers();
  const prov = new ex.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
  const pad = new ex.Contract(c.pad, OC_ABI, prov);
  const n = Number(await pad.salesCount());
  const raw = n ? await pad.getSales(0, n) : [];
  const head = await prov.getBlockNumber();
  const logs = [];
  for (let from = c.deployBlock; from <= head; from += 45000) {
    logs.push(...await prov.getLogs({ address: c.pad, fromBlock: from, toBlock: Math.min(head, from + 44999) }));
  }
  const sales = raw.map((x, i) => ({ id: i, token: x.token, creator: x.creator, pair: x.pair, created: Number(x.createdAt) * 1000,
    graduated: x.graduated, target: x.target, vq: x.virtualQuote, vt: x.virtualTokens, raised: x.raised, sold: x.sold, trades: [], holders: 0, volume: 0 }));
  const holders = sales.map(() => new Set()), blockTs = new Map();
  for (const l of logs) {
    let ev; try { ev = pad.interface.parseLog(l); } catch { continue; }
    if (!ev) continue;
    const s = sales[Number(ev.args.id)]; if (!s) continue;
    if (ev.name === 'Created') {
      let meta = {}; try { meta = JSON.parse(ev.args.meta || '{}'); } catch { /* bad meta */ }
      Object.assign(s, { name: ev.args.name, symbol: ev.args.symbol, desc: meta.d || '', img: /^https:\/\//.test(meta.i || '') ? meta.i : '',
        web: meta.w, x: meta.x, tg: meta.t, creatorBps: Number(ev.args.creatorBps), maxWallet: Number(ev.args.maxWallet * 10000n / OC_SUPPLY) });
    } else if (ev.name === 'Trade') {
      blockTs.set(l.blockNumber, null);
      s.trades.push({ side: ev.args.isBuy ? 'buy' : 'sell', native: ev.args.quoteAmt, tokens: ev.args.tokenAmt, who: ev.args.trader,
        block: l.blockNumber, tx: l.transactionHash, price: Number(s.vq + ev.args.raised) / Number(s.vt - ev.args.sold) });
      holders[Number(ev.args.id)].add(ev.args.trader);
      s.volume += ocNum(ev.args.quoteAmt);
    }
  }
  await Promise.all([...blockTs.keys()].slice(-300).map(async b => { try { blockTs.set(b, (await prov.getBlock(b)).timestamp * 1000); } catch { /* skip */ } }));
  sales.forEach((s, i) => { s.holders = holders[i].size; s.trades.forEach(t => { t.ts = blockTs.get(t.block) || s.created; }); });
  OC.data[key] = { demo: false, sales, t: Date.now() };
  return OC.data[key];
}
async function ocData(key, fresh = false) {
  const c = OC_CHAINS[key];
  if (!c.pad) return OC.demo ? ocDemo(key) : { demo: false, empty: true, sales: [] };
  if (!fresh && OC.data[key] && Date.now() - OC.data[key].t < 15000) return OC.data[key];
  return ocLive(key);
}

/* ───────── wallet (EIP-1193) ───────── */
async function ocConnect(key) {
  const eth = window.ethereum;
  if (!eth) { toast('No browser wallet found. Install MetaMask, Rabby or Coinbase Wallet.', 'bad'); return null; }
  const [addr] = await eth.request({ method: 'eth_requestAccounts' });
  OC.wallet = { addr, chainId: parseInt(await eth.request({ method: 'eth_chainId' }), 16) };
  if (key) await ocSwitch(key);
  ocPaintWallet(key);
  return OC.wallet;
}
async function ocSwitch(key) {
  const c = OC_CHAINS[key], eth = window.ethereum; if (!eth) return;
  const hex = '0x' + c.chainId.toString(16);
  try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
  catch (e) {
    if (e.code !== 4902) throw e;
    await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: c.name, rpcUrls: [c.rpc],
      nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, blockExplorerUrls: [c.explorer] }] });
  }
  if (OC.wallet) OC.wallet.chainId = c.chainId;
}
function ocPaintWallet(key) {
  const b = $('#ocWallet'); if (!b || !key) return;
  const c = OC_CHAINS[key], w = OC.wallet;
  if (!w) { b.className = 'btn sm oc-wbtn'; b.innerHTML = 'Connect wallet'; return; }
  const wrong = w.chainId !== c.chainId;
  b.className = `btn sm ghost oc-wbtn ${wrong ? 'warn' : ''}`;
  b.innerHTML = wrong ? `Switch to ${esc(c.name)}` : `${ocIdent(w.addr, 16)}<span class="mono-s">${ocShort(w.addr)}</span>`;
}
if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', (a) => { if (OC.wallet) { OC.wallet.addr = a[0]; if (!a[0]) OC.wallet = null; ocPaintWallet(OC.key); } });
  window.ethereum.on('chainChanged', (id) => { if (OC.wallet) { OC.wallet.chainId = parseInt(id, 16); ocPaintWallet(OC.key); } });
}
const ocRef = () => { const r = localStorage.getItem('oc_ref'); return /^0x[0-9a-fA-F]{40}$/.test(r || '') ? r : OC_ZERO; };
try { const r = new URLSearchParams(location.search).get('r'); if (/^0x[0-9a-fA-F]{40}$/.test(r || '')) localStorage.setItem('oc_ref', r); } catch { /* ignore */ }

/* ───────── shared layout ───────── */
function ocShell(key, tail, body) {
  return `
  <div class="ocx">
    <div class="wrap ocx-in">
      <nav class="ocx-tabs">${OC_ORDER.map(k => { const c = OC_CHAINS[k]; return `<a href="#/chain/${k}${tail}" class="ocx-tab ${k === key ? 'on' : ''}" style="--c:${c.color}">
        <img src="${c.logo}" alt=""><span>${c.name}</span>${c.soon ? '<em>Soon</em>' : ''}</a>`; }).join('')}</nav>
      <div class="ocx-r"><div class="ocx-net num" id="ocNet"></div><button class="btn sm oc-wbtn" id="ocWallet">Connect wallet</button></div>
    </div>
  </div>
  <section class="wrap page oc">${body}</section>`;
}
function ocBind(key) {
  const bar = $('.ocx-tabs'), on = $('.ocx-tab.on');
  if (bar && on) bar.scrollLeft = Math.max(0, on.offsetLeft - 16);
  ocPaintNet(key); ocPaintWallet(key);
  const b = $('#ocWallet');
  if (b) b.onclick = async () => {
    try {
      if (!OC.wallet) await ocConnect(key);
      else if (OC.wallet.chainId !== OC_CHAINS[key].chainId) { await ocSwitch(key); ocPaintWallet(key); }
    } catch (e) { toast(e.shortMessage || e.message || 'Wallet error', 'bad'); }
  };
  $$('[data-copy]').forEach(el => el.onclick = (e) => { e.preventDefault(); navigator.clipboard?.writeText(el.dataset.copy); toast('Copied'); });
}
const ocStatus = (c, d) => c.soon ? `<span class="oc-st">Coming soon</span>`
  : c.pad ? `<span class="oc-st live"><i></i>Live</span>`
  : `<span class="oc-st pend"><i></i>Contracts pending</span>`;
const ocDemoBar = (key, d) => {
  const c = OC_CHAINS[key]; if (c.pad || c.soon) return '';
  return `<div class="oc-info"><span class="oc-info-i">i</span>
    <div><b>RookeryPad is not deployed on ${esc(c.name)} yet.</b> ${d.demo ? 'You are viewing demo data generated with the real curve maths — none of these tokens exist.' : 'Trading opens once the contracts are live.'}</div>
    <label class="oc-sw"><input type="checkbox" id="ocDemo" ${OC.demo ? 'checked' : ''}><span></span>Demo data</label></div>`;
};
function ocBindDemo() {
  const t = $('#ocDemo'); if (!t) return;
  t.onchange = () => { OC.demo = t.checked; localStorage.setItem('oc_demo', OC.demo ? '1' : '0'); route(); };
}
const ocBar = (p, w = 100) => `<div class="oc-bar" style="width:${typeof w === 'number' ? w + 'px' : w}"><i style="width:${Math.max(2, p)}%"></i></div>`;

/* ═══════════ EXPLORE ═══════════ */
async function ocExplore(key) {
  const c = OC_CHAINS[key];
  document.title = `${c.name} launchpad — Rookery`;
  if (c.soon) return ocSoon(key);
  app.innerHTML = ocShell(key, '', `<div class="skel" style="height:120px;border-radius:14px"></div><div class="skel" style="height:420px;border-radius:14px;margin-top:16px"></div>`);
  ocBind(key);
  await ocPrices();
  const d = await ocData(key), sales = d.sales;
  const volN = sales.reduce((a, s) => a + s.volume, 0);
  const raisedN = sales.reduce((a, s) => a + ocNum(s.raised), 0);
  const grads = sales.filter(s => s.graduated).length;
  let tab = localStorage.getItem('oc_tab') || 'trending';
  app.innerHTML = ocShell(key, '', `
    <header class="oc-ph">
      <img class="oc-ph-logo" src="${c.logo}" alt="">
      <div class="oc-ph-t">
        <div class="oc-ph-row"><h1>${esc(c.name)}</h1>${ocStatus(c, d)}</div>
        <p>Bonding-curve launchpad · ${esc(c.native)} pairs · graduates to ${esc(c.dex)} at ${ocFmtN(c.target, 2)} ${esc(c.native)} · liquidity burned</p>
      </div>
      <div class="oc-ph-a"><a class="btn ghost" href="#/chain/${key}/how">How it works</a><a class="btn acc" href="#/chain/${key}/create">Create token</a></div>
    </header>
    <div class="oc-kpi">
      <div><span>Tokens launched</span><b>${sales.length.toLocaleString('en-US')}</b></div>
      <div><span>Graduated</span><b>${grads}</b></div>
      <div><span>Trading volume</span><b>${fmtUsd(volN * ocUsd(key))}</b><small>${ocFmtN(volN, 2)} ${esc(c.native)}</small></div>
      <div><span>Raised on curves</span><b>${fmtUsd(raisedN * ocUsd(key))}</b><small>${ocFmtN(raisedN, 2)} ${esc(c.native)}</small></div>
      <div><span>To $臭企鹅 burn</span><b>${fmtUsd(volN * 0.005 * ocUsd(key))}</b><small>0.5% of volume</small></div>
    </div>
    ${ocDemoBar(key, d)}
    <div class="panel oc-list">
      <div class="oc-tb">
        <div class="oc-utabs" id="ocTabs">${[['trending', 'Trending'], ['new', 'New'], ['soon', 'Near graduation'], ['grad', 'Graduated']].map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="oc-tb-r">
          <div class="oc-search"><svg viewBox="0 0 20 20" width="14" height="14"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input id="ocQ" placeholder="Search token or address"></div>
          <div class="oc-vt"><button data-v="table" class="${OC.view === 'table' ? 'on' : ''}" title="Table"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 3h12M2 8h12M2 13h12" stroke="currentColor" stroke-width="1.6"/></svg></button><button data-v="grid" class="${OC.view === 'grid' ? 'on' : ''}" title="Grid"><svg viewBox="0 0 16 16" width="14" height="14"><rect x="2" y="2" width="5" height="5" rx="1" fill="currentColor"/><rect x="9" y="2" width="5" height="5" rx="1" fill="currentColor"/><rect x="2" y="9" width="5" height="5" rx="1" fill="currentColor"/><rect x="9" y="9" width="5" height="5" rx="1" fill="currentColor"/></svg></button></div>
        </div>
      </div>
      <div id="ocBody"></div>
    </div>`);
  ocBind(key); ocBindDemo();
  const usd = ocUsd(key);
  const paint = () => {
    const q = ($('#ocQ').value || '').trim().toLowerCase();
    let list = sales.filter(s => !q || s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q) || s.token.toLowerCase() === q);
    if (tab === 'trending') list = list.filter(s => !s.graduated).sort((a, b) => b.volume - a.volume);
    else if (tab === 'new') list = list.sort((a, b) => b.created - a.created);
    else if (tab === 'soon') list = list.filter(s => !s.graduated).sort((a, b) => ocProgress(b) - ocProgress(a));
    else list = list.filter(s => s.graduated);
    const body = $('#ocBody');
    if (!list.length) {
      body.innerHTML = `<div class="oc-empty"><img src="${c.logo}" alt=""><h3>${d.empty ? `No tokens on ${esc(c.name)} yet` : 'Nothing matches'}</h3>
        <p>${d.empty ? 'The launchpad opens here as soon as the contracts are deployed.' : 'Try another tab or search term.'}</p>
        ${d.empty ? '' : `<a class="btn acc sm" href="#/chain/${key}/create">Create token</a>`}</div>`;
      return;
    }
    if (OC.view === 'grid') {
      body.innerHTML = `<div class="oc-grid">${list.map(s => { const p = ocProgress(s); return `<a class="oc-card" href="#/chain/${key}/t/${s.id}">
        <div class="oc-card-h">${ocAvatar(s, 40)}<div><b>${esc(s.name)}</b><span>$${esc(s.symbol)} · ${ago(s.created)}</span></div>${s.graduated ? '<span class="oc-chip">Graduated</span>' : ''}</div>
        <p>${esc(s.desc || 'No description.')}</p>
        <div class="oc-card-m"><span>Market cap</span><b>${fmtUsd(ocMcapUsd(key, s))}</b></div>
        <div class="oc-card-m"><span>Bonding</span><b>${p.toFixed(1)}%</b></div>
        ${ocBar(p, '100%')}</a>`; }).join('')}</div>`;
      return;
    }
    body.innerHTML = `<div class="oc-tw"><table class="oc-t"><thead><tr>
      <th class="n">#</th><th>Token</th><th class="r">Price</th><th class="r">Market cap</th><th class="r hm">Volume</th><th class="r hm">Txns</th><th class="r hm">Holders</th><th>Bonding curve</th><th class="hm">Creator</th></tr></thead><tbody>
      ${list.map((s, i) => { const p = ocProgress(s); return `<tr data-id="${s.id}">
        <td class="n mu">${i + 1}</td>
        <td><div class="oc-tok">${ocAvatar(s, 30)}<div><b>${esc(s.name)}</b><span>$${esc(s.symbol)} · ${ago(s.created)} ago</span></div></div></td>
        <td class="r num">${fmtUsd(ocPrice(s) * usd)}</td>
        <td class="r num"><b>${fmtUsd(ocMcapUsd(key, s))}</b></td>
        <td class="r num hm">${fmtUsd(s.volume * usd)}</td>
        <td class="r num hm">${s.trades.length}</td>
        <td class="r num hm">${s.holders}</td>
        <td>${s.graduated ? `<span class="oc-chip">Graduated · ${esc(c.dex.split(' ')[0])}</span>` : `<div class="oc-bc">${ocBar(p, 96)}<span class="num">${p.toFixed(1)}%</span></div>`}</td>
        <td class="hm mono-s mu">${ocShort(s.creator)}</td></tr>`; }).join('')}
      </tbody></table></div>`;
    $$('#ocBody tr[data-id]').forEach(r => r.onclick = () => (location.hash = `#/chain/${key}/t/${r.dataset.id}`));
  };
  $$('#ocTabs button').forEach(b => b.onclick = () => { tab = b.dataset.t; localStorage.setItem('oc_tab', tab); $$('#ocTabs button').forEach(x => x.classList.toggle('on', x === b)); paint(); });
  $$('.oc-vt button').forEach(b => b.onclick = () => { OC.view = b.dataset.v; localStorage.setItem('oc_view', OC.view); $$('.oc-vt button').forEach(x => x.classList.toggle('on', x === b)); paint(); });
  $('#ocQ').oninput = debounce(paint, 120);
  paint();
  if (c.pad) setTimer(async () => { if (location.hash === `#/chain/${key}`) { await ocData(key, true); paint(); } }, 15000);
}

function ocSoon(key) {
  const c = OC_CHAINS[key];
  app.innerHTML = ocShell(key, '', `
    <header class="oc-ph">
      <img class="oc-ph-logo" src="${c.logo}" alt="">
      <div class="oc-ph-t"><div class="oc-ph-row"><h1>${esc(c.name)}</h1>${ocStatus(c)}</div>
        <p>Native gas token ${esc(c.native)} · launchpad deployment under review</p></div>
    </header>
    <div class="panel oc-empty" style="padding:56px 20px">
      <img src="${c.logo}" alt=""><h3>${esc(c.name)} support is coming</h3>
      <p>We are verifying the ${esc(c.name)} mainnet, its DEX and RPC infrastructure before deploying RookeryPad.<br>Launch on another network in the meantime.</p>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:6px">${OC_ORDER.filter(k => !OC_CHAINS[k].soon).map(k => `<a class="btn ghost sm" href="#/chain/${k}"><img src="${OC_CHAINS[k].logo}" class="oc-lg" alt="">${OC_CHAINS[k].name}</a>`).join('')}</div>
    </div>`);
  ocBind(key);
}

/* ═══════════ TOKEN PAGE ═══════════ */
async function ocToken(key, id) {
  const c = OC_CHAINS[key];
  await ocPrices();
  const d = await ocData(key);
  const s = d.sales[Number(id)];
  if (!s) { app.innerHTML = ocShell(key, '', `<div class="panel oc-empty"><h3>Token not found</h3><p>This token does not exist on ${esc(c.name)}.</p><a class="btn ghost sm" href="#/chain/${key}">Back to ${esc(c.name)}</a></div>`); ocBind(key); return; }
  const usd = ocUsd(key), N = c.native, p = ocProgress(s);
  const left = s.target - s.raised;
  document.title = `${s.symbol} · ${c.name} — Rookery`;
  let side = 'buy', tokBal = d.demo ? 25_000_000n * WEI : 0n, nativeBal = null;
  const quick = { buy: key === 'bsc' ? ['0.05', '0.1', '0.5', '1'] : ['0.005', '0.01', '0.05', '0.1'], sell: ['25', '50', '75', '100'] };
  const tax = ((50 + (s.creatorBps || 0)) / 100).toFixed(2);
  app.innerHTML = ocShell(key, '', `
    <div class="oc-crumb"><a href="#/chain/${key}">${esc(c.name)}</a><span>/</span><a href="#/chain/${key}">Tokens</a><span>/</span><b>${esc(s.symbol)}</b></div>
    ${ocDemoBar(key, d)}
    <header class="oc-th">
      ${ocAvatar(s, 56)}
      <div class="oc-th-t">
        <div class="oc-ph-row"><h1>${esc(s.name)}</h1><span class="oc-sym">$${esc(s.symbol)}</span>
          <span class="oc-chip net"><img src="${c.logo}" alt="">${esc(c.name)}</span>${s.graduated ? '<span class="oc-chip">Graduated</span>' : '<span class="oc-chip acc">Bonding curve</span>'}</div>
        <div class="oc-th-m">
          <span>CA <a class="mono-s" target="_blank" rel="noopener" href="${c.explorer}/token/${s.token}">${ocShort(s.token)}</a><button class="oc-copy" data-copy="${s.token}" title="Copy">⧉</button></span>
          <span>Creator <span class="mono-s">${ocShort(s.creator)}</span></span><span>Created ${ago(s.created)} ago</span>
          ${s.web ? `<a target="_blank" rel="noopener" href="${esc(s.web)}">Website</a>` : ''}${s.x ? `<a target="_blank" rel="noopener" href="${esc(s.x)}">X</a>` : ''}${s.tg ? `<a target="_blank" rel="noopener" href="${esc(s.tg)}">Telegram</a>` : ''}
        </div>
      </div>
    </header>
    <div class="oc-kpi oc-kpi-t">
      <div><span>Price</span><b>${fmtUsd(ocPrice(s) * usd)}</b><small>${ocPrice(s).toPrecision(3)} ${esc(N)}</small></div>
      <div><span>Market cap</span><b>${fmtUsd(ocMcapUsd(key, s))}</b></div>
      <div><span>Raised</span><b>${ocFmtN(ocNum(s.raised), 3)} ${esc(N)}</b><small>of ${ocFmtN(ocNum(s.target), 2)} ${esc(N)}</small></div>
      <div><span>Volume</span><b>${fmtUsd(s.volume * usd)}</b><small>${s.trades.length} txns</small></div>
      <div><span>Holders</span><b>${s.holders}</b></div>
    </div>
    <div class="oc-tl">
      <div class="oc-main">
        <div class="panel"><div class="oc-ph2"><b>Price</b><span class="mu mono-s">${esc(s.symbol)}/${esc(N)} · USD</span></div><div id="ocChart" style="height:360px;padding:0 6px 6px"></div></div>
        <div class="panel" style="margin-top:14px">
          <div class="oc-tb"><div class="oc-utabs" id="ocTt"><button data-t="trades" class="on">Trades</button><button data-t="info">Contract</button></div></div>
          <div id="ocTbody"></div>
        </div>
      </div>
      <aside class="oc-side">
        ${s.graduated ? `
        <div class="panel oc-box">
          <h3>Trading on ${esc(c.dex)}</h3>
          <p class="mu">This token reached its ${ocFmtN(ocNum(s.target), 2)} ${esc(N)} target and graduated. Liquidity is locked permanently — the LP tokens were sent to 0xdead.</p>
          <a class="btn wide acc" target="_blank" rel="noopener" href="${c.dexUrl(s.token)}">Trade on ${esc(c.dex)}</a>
        </div>` : `
        <div class="panel oc-box">
          <div class="oc-bs"><button class="on" data-s="buy">Buy</button><button data-s="sell">Sell</button></div>
          <div class="oc-in-h"><span>Amount</span><span class="mu" id="ocBal"></span></div>
          <div class="oc-in"><input id="ocAmt" inputmode="decimal" placeholder="0.00" autocomplete="off"><span id="ocUnit">${esc(N)}</span></div>
          <div class="oc-qk" id="ocQuick"></div>
          <div class="oc-sum" id="ocEst"></div>
          <div class="oc-slip"><span>Max slippage</span><div>${[0.5, 1, 2, 5].map(v => `<button data-v="${v}" class="${v === OC.slip ? 'on' : ''}">${v}%</button>`).join('')}</div></div>
          <button class="btn wide oc-go buy" id="ocGo">${OC.wallet ? `Buy ${esc(s.symbol)}` : 'Connect wallet'}</button>
        </div>`}
        <div class="panel oc-box">
          <div class="oc-row"><span>Bonding curve</span><b>${p.toFixed(1)}%</b></div>
          <div class="oc-bar big"><i style="width:${Math.max(2, p)}%"></i></div>
          <p class="mu oc-small">${s.graduated ? `Graduated to ${esc(c.dex)}.` : `${ocFmtN(ocNum(left > 0n ? left : 0n), 4)} ${esc(N)} more to graduate. At ${ocFmtN(ocNum(s.target), 2)} ${esc(N)} the curve closes and ${esc(c.dex)} liquidity is created and burned.`}</p>
        </div>
        <div class="panel oc-box">
          <h4>Token parameters</h4>
          <div class="oc-row"><span>Total supply</span><b>1,000,000,000</b></div>
          <div class="oc-row"><span>Curve fee</span><b>0.5%</b></div>
          <div class="oc-row"><span>DEX tax after graduation</span><b>${tax}%</b></div>
          <div class="oc-row sub"><span>Burn reserve · creator</span><b>0.50% · ${((s.creatorBps || 0) / 100).toFixed(2)}%</b></div>
          <div class="oc-row"><span>Max wallet</span><b>${s.maxWallet ? `${s.maxWallet / 100}% · 30 min` : 'None'}</b></div>
          <div class="oc-row"><span>Liquidity</span><b>Burned at graduation</b></div>
        </div>
      </aside>
    </div>`);
  ocBind(key);
  // chart (line + area, accent coloured)
  const LW = window.LightweightCharts;
  if (LW && $('#ocChart')) {
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#fff';
    S.chart = LW.createChart($('#ocChart'), {
      autoSize: true, layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#76767E', fontFamily: 'JetBrains Mono', fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,.04)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } }, timeScale: { borderVisible: false, timeVisible: true },
      crosshair: { mode: 1, vertLine: { color: 'rgba(255,255,255,.18)', labelBackgroundColor: '#1E1E23' }, horzLine: { color: 'rgba(255,255,255,.18)', labelBackgroundColor: '#1E1E23' } },
      handleScroll: false, handleScale: false,
    });
    const rgb = hexRgb(acc.length === 7 ? acc : '#ffffff');
    const ser = S.chart.addAreaSeries({ lineColor: acc, lineWidth: 2, topColor: `rgba(${rgb},.28)`, bottomColor: `rgba(${rgb},0)`,
      priceFormat: { type: 'custom', formatter: (v) => (v <= 1e-15 ? '0' : fmtUsd(v).replace('$', '')), minMove: 1e-12 }, priceLineVisible: false,
      autoscaleInfoProvider: (orig) => { const r = orig(); if (r && r.priceRange.minValue < 0) r.priceRange.minValue = 0; return r; } });
    const pts = new Map();
    pts.set(Math.floor(s.created / 1000), Number(s.vq) / Number(s.vt) * usd);
    for (const t of s.trades) pts.set(Math.floor(t.ts / 1000), t.price * usd);
    pts.set(Math.floor(Date.now() / 1000), ocPrice(s) * usd);
    ser.setData([...pts.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value })));
    S.chart.timeScale().fitContent();
  }
  // tabs under chart
  const paintTab = (t) => {
    $$('#ocTt button').forEach(x => x.classList.toggle('on', x.dataset.t === t));
    if (t === 'trades') {
      $('#ocTbody').innerHTML = `<div class="oc-tw" style="max-height:440px"><table class="oc-t sm"><thead><tr><th>Time</th><th>Type</th><th class="r">USD</th><th class="r">${esc(N)}</th><th class="r">${esc(s.symbol)}</th><th class="r hm">Price</th><th class="hm">Trader</th></tr></thead><tbody>
        ${s.trades.slice().reverse().slice(0, 80).map(x => `<tr class="nc"><td class="mu">${ago(x.ts)} ago</td><td class="${x.side === 'buy' ? 'up' : 'dn'}"><b>${x.side === 'buy' ? 'Buy' : 'Sell'}</b></td>
          <td class="r num">${fmtUsd(ocNum(x.native) * usd)}</td><td class="r num">${ocFmtN(ocNum(x.native), 4)}</td><td class="r num">${fmtT(x.tokens)}</td><td class="r num hm">${fmtUsd(x.price * usd)}</td>
          <td class="mono-s hm">${x.tx ? `<a target="_blank" rel="noopener" href="${c.explorer}/tx/${x.tx}">${ocShort(x.who)}</a>` : `<span class="mu">${ocShort(x.who)}</span>`}</td></tr>`).join('') || `<tr class="nc"><td colspan="7"><div class="oc-empty sm"><p>No trades yet.</p></div></td></tr>`}
        </tbody></table></div>`;
    } else {
      const row = (l, a, note = '') => `<div class="oc-ci"><span>${l}</span>${a ? `<a class="mono-s" target="_blank" rel="noopener" href="${c.explorer}/address/${a}">${a}</a><button class="oc-copy" data-copy="${a}">⧉</button>` : `<b class="mu">${note}</b>`}</div>`;
      $('#ocTbody').innerHTML = `<div style="padding:6px 16px 14px">
        ${row('Token', s.token)}${row('Launchpad', c.pad, d.demo ? 'Not deployed' : '')}${row(`${c.dex} pair`, s.pair, s.graduated ? '' : 'Created at graduation')}${row('Creator', s.creator)}
        <p class="mu oc-small" style="margin-top:10px">The token contract has no owner, no mint and no blacklist. Taxes are fixed at deployment and cannot be changed.</p></div>`;
      $$('#ocTbody [data-copy]').forEach(el => el.onclick = () => { navigator.clipboard?.writeText(el.dataset.copy); toast('Copied'); });
    }
  };
  $$('#ocTt button').forEach(b => b.onclick = () => paintTab(b.dataset.t));
  paintTab('trades');
  if (s.graduated) return;
  // trade box
  const amtEl = $('#ocAmt');
  const paintBal = () => {
    const el = $('#ocBal'); if (!el) return;
    if (side === 'sell') el.textContent = `Balance ${fmtT(tokBal)} ${s.symbol}`;
    else el.textContent = nativeBal != null ? `Balance ${ocFmtN(ocNum(nativeBal), 4)} ${N}` : '';
  };
  const paintQuick = () => {
    $('#ocQuick').innerHTML = quick[side].map(v => `<button data-v="${v}">${side === 'buy' ? `${v} ${esc(N)}` : v === '100' ? 'Max' : `${v}%`}</button>`).join('');
    $$('#ocQuick button').forEach(b => b.onclick = () => { amtEl.value = side === 'buy' ? b.dataset.v : weiToStr(tokBal * BigInt(b.dataset.v) / 100n, 2); est(); });
  };
  const slipBps = () => BigInt(Math.round(OC.slip * 100));
  const est = () => {
    const v = toWei(amtEl.value);
    let html;
    if (side === 'buy') {
      const q = ocQuoteBuy(s, v), p0 = ocPrice(s);
      const impact = q.out > 0n ? (ocPrice({ ...s, raised: s.raised + q.net, sold: s.sold + q.out }) / p0 - 1) * 100 : 0;
      html = `<div class="oc-row"><span>You receive</span><b>${fmtT(q.out)} ${esc(s.symbol)}</b></div>
        <div class="oc-row"><span>Minimum received</span><b>${fmtT(q.out * (10000n - slipBps()) / 10000n)}</b></div>
        <div class="oc-row"><span>Price impact</span><b class="${impact > 5 ? 'dn' : ''}">${impact.toFixed(2)}%</b></div>
        <div class="oc-row"><span>Fee (0.5%)</span><b>${ocFmtN(ocNum(q.fee), 6)} ${esc(N)}</b></div>
        ${q.refund > 0n ? `<div class="oc-row"><span>Refunded (curve full)</span><b>${ocFmtN(ocNum(q.refund), 6)} ${esc(N)}</b></div>` : ''}
        ${s.maxWallet && q.out > OC_SUPPLY * BigInt(s.maxWallet) / 10000n ? `<div class="oc-warn">Exceeds the ${s.maxWallet / 100}% max-wallet limit — the transaction would revert.</div>` : ''}`;
    } else {
      const q = ocQuoteSell(s, v);
      html = `<div class="oc-row"><span>You receive</span><b>${ocFmtN(ocNum(q.out), 6)} ${esc(N)}</b></div>
        <div class="oc-row"><span>Minimum received</span><b>${ocFmtN(ocNum(q.out * (10000n - slipBps()) / 10000n), 6)} ${esc(N)}</b></div>
        <div class="oc-row"><span>Value</span><b>${fmtUsd(ocNum(q.out) * usd)}</b></div>
        <div class="oc-row"><span>Fee (0.5%)</span><b>${ocFmtN(ocNum(q.fee), 6)} ${esc(N)}</b></div>
        ${v > tokBal ? `<div class="oc-warn">Amount exceeds your balance.</div>` : ''}`;
    }
    $('#ocEst').innerHTML = html;
  };
  const paintGo = () => {
    const g = $('#ocGo');
    g.className = `btn wide oc-go ${side}`;
    g.textContent = !OC.wallet && !d.demo ? 'Connect wallet' : `${side === 'buy' ? 'Buy' : 'Sell'} ${s.symbol}`;
  };
  $$('.oc-bs button').forEach(b => b.onclick = () => {
    side = b.dataset.s; $$('.oc-bs button').forEach(x => x.classList.toggle('on', x === b));
    $('.oc-bs').dataset.side = side;
    $('#ocUnit').textContent = side === 'buy' ? N : s.symbol;
    amtEl.value = ''; paintQuick(); paintBal(); est(); paintGo();
  });
  $$('.oc-slip button').forEach(b => b.onclick = () => { OC.slip = Number(b.dataset.v); localStorage.setItem('oc_slip', OC.slip); $$('.oc-slip button').forEach(x => x.classList.toggle('on', x === b)); est(); });
  amtEl.oninput = est;
  paintQuick(); paintBal(); est(); paintGo();
  $('#ocGo').onclick = async () => {
    if (d.demo || !c.pad) { toast(`Demo only — RookeryPad is not deployed on ${c.name} yet`, 'bad'); return; }
    try {
      if (!OC.wallet) { await ocConnect(key); paintGo(); return; }
      const v = toWei(amtEl.value);
      if (v <= 0n) { toast('Enter an amount', 'bad'); return; }
      if (OC.wallet.chainId !== c.chainId) await ocSwitch(key);
      const ex = await ocEthers();
      const signer = await new ex.BrowserProvider(window.ethereum).getSigner();
      const pad = new ex.Contract(c.pad, OC_ABI, signer);
      $('#ocGo').disabled = true;
      let tx;
      if (side === 'buy') {
        tx = await pad.buy(s.id, ocQuoteBuy(s, v).out * (10000n - slipBps()) / 10000n, ocRef(), { value: v });
      } else {
        const tok = new ex.Contract(s.token, OC_ERC20, signer);
        if ((await tok.allowance(OC.wallet.addr, c.pad)) < v) { toast('Approve the token in your wallet…'); await (await tok.approve(c.pad, ex.MaxUint256)).wait(); }
        tx = await pad.sell(s.id, v, ocQuoteSell(s, v).out * (10000n - slipBps()) / 10000n, ocRef());
      }
      toast('Transaction submitted');
      await tx.wait();
      toast(`${side === 'buy' ? 'Bought' : 'Sold'} ${s.symbol}`, 'ok');
      await ocData(key, true); ocToken(key, id);
    } catch (e) { toast(e.shortMessage || e.reason || e.message || 'Transaction failed', 'bad'); }
    finally { const g = $('#ocGo'); if (g) g.disabled = false; }
  };
  if (!d.demo && OC.wallet) {
    try {
      const ex = await ocEthers(), prov = new ex.JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
      [tokBal, nativeBal] = await Promise.all([new ex.Contract(s.token, OC_ERC20, prov).balanceOf(OC.wallet.addr), prov.getBalance(OC.wallet.addr)]);
      paintBal();
    } catch { /* ignore */ }
  }
}

/* ═══════════ CREATE ═══════════ */
function ocCreate(key) {
  const c = OC_CHAINS[key];
  if (c.soon) return ocSoon(key);
  document.title = `Create token on ${c.name} — Rookery`;
  const N = c.native;
  app.innerHTML = ocShell(key, '/create', `
    <div class="oc-crumb"><a href="#/chain/${key}">${esc(c.name)}</a><span>/</span><b>Create token</b></div>
    <header class="oc-ph sm"><div class="oc-ph-t"><div class="oc-ph-row"><h1>Create a token</h1><span class="oc-chip net"><img src="${c.logo}" alt="">${esc(c.name)}</span></div>
      <p>Deploys an ERC-20 with its own bonding curve in a single transaction from your wallet.</p></div></header>
    ${!c.pad ? `<div class="oc-info"><span class="oc-info-i">i</span><div><b>RookeryPad is not deployed on ${esc(c.name)} yet.</b> You can configure a token and review the numbers; launching opens once the contracts are live.</div></div>` : ''}
    <div class="oc-cl">
      <div class="panel oc-form">
        <section><h3><span>1</span>Token</h3>
          <div class="oc-f2"><div class="oc-f"><label>Name</label><input class="inp" id="cN" maxlength="32" placeholder="e.g. Glacier"></div>
            <div class="oc-f"><label>Symbol</label><input class="inp" id="cS" maxlength="12" placeholder="e.g. GLCR" style="text-transform:uppercase"></div></div>
          <div class="oc-f"><label>Description <em>optional</em></label><textarea class="inp" id="cD" maxlength="280" rows="3" placeholder="What is this token about?"></textarea></div>
          <div class="oc-f"><label>Image URL <em>optional · https, square, min 256px</em></label><input class="inp" id="cI" placeholder="https://"></div>
        </section>
        <section><h3><span>2</span>Links <em>optional</em></h3>
          <div class="oc-f3"><div class="oc-f"><label>Website</label><input class="inp" id="cW" placeholder="https://"></div>
            <div class="oc-f"><label>X</label><input class="inp" id="cX" placeholder="https://x.com/"></div>
            <div class="oc-f"><label>Telegram</label><input class="inp" id="cT" placeholder="https://t.me/"></div></div>
        </section>
        <section><h3><span>3</span>Launch settings</h3>
          <div class="oc-set"><div><b>Graduation target</b><p>${esc(N)} raised on the curve before ${esc(c.dex)} liquidity is created.</p></div>
            <div class="oc-seg" id="cTgt">${[25, 50, 75, 100].map(v => `<button data-v="${v}" class="${v === 100 ? 'on' : ''}">${ocFmtN(c.target * v / 100, 2)} ${esc(N)}</button>`).join('')}</div></div>
          <div class="oc-set"><div><b>Creator tax</b><p>Charged on ${esc(c.dex)} trades after graduation, paid to your wallet. Immutable.</p></div>
            <div class="oc-seg" id="cTax">${[0, 50, 100, 200, 300].map(v => `<button data-v="${v}" class="${v === 0 ? 'on' : ''}">${v ? v / 100 + '%' : 'None'}</button>`).join('')}</div></div>
          <div class="oc-set"><div><b>Max wallet</b><p>Anti-snipe cap per wallet. Switches off 30 minutes after graduation.</p></div>
            <div class="oc-seg" id="cMw">${[0, 100, 200, 300, 500].map(v => `<button data-v="${v}" class="${v === 0 ? 'on' : ''}">${v ? v / 100 + '%' : 'None'}</button>`).join('')}</div></div>
        </section>
        <section><h3><span>4</span>Initial buy <em>optional</em></h3>
          <p class="mu oc-small" style="margin:-4px 0 10px">Executed in the same transaction as the launch, so nobody can buy before you.</p>
          <div class="oc-in"><input id="cB" inputmode="decimal" placeholder="0.00" autocomplete="off"><span>${esc(N)}</span></div>
        </section>
      </div>
      <aside class="oc-side">
        <div class="panel oc-box">
          <h4>Preview</h4>
          <div class="oc-prev" id="cPrev"></div>
          <h4 style="margin-top:16px">Summary</h4>
          <div class="oc-sum" id="cEst"></div>
          <button class="btn wide acc" id="cGo" style="margin-top:14px">${c.pad ? 'Create token' : 'Deployment pending'}</button>
          <p class="mu oc-small" style="margin-top:12px">Supply 1B · 800M on the curve · 200M + 98% of the raise seed the ${esc(c.dex)} pool and the LP is burned · 2% graduation fee · 0.5% trade fee to the $臭企鹅 burn reserve. Not financial advice.</p>
        </div>
      </aside>
    </div>`);
  ocBind(key);
  if (!c.pad) $('#cGo').disabled = true;
  const st = { tgt: 100, tax: 0, mw: 0 };
  const seg = (id, k) => $$(`#${id} button`).forEach(b => b.onclick = () => { st[k] = Number(b.dataset.v); $$(`#${id} button`).forEach(x => x.classList.toggle('on', x === b)); paint(); });
  seg('cTgt', 'tgt'); seg('cTax', 'tax'); seg('cMw', 'mw');
  const paint = () => {
    const target = BigInt(Math.round(c.target * st.tgt / 100 * 1e6)) * 10n ** 12n;
    const s = Object.assign(ocNewSale(target), { id: 0, name: $('#cN').value.trim() || 'Token name', symbol: ($('#cS').value.trim() || 'SYMBOL').toUpperCase(),
      desc: $('#cD').value, img: /^https:\/\//.test($('#cI').value.trim()) ? $('#cI').value.trim() : '', token: $('#cN').value + $('#cS').value, created: Date.now() });
    const b = toWei($('#cB').value), q = ocQuoteBuy(s, b), usd = ocUsd(key);
    $('#cPrev').innerHTML = `${ocAvatar(s, 44)}<div><b>${esc(s.name)}</b><span>$${esc(s.symbol)}</span><p>${esc(s.desc || 'No description.')}</p></div>`;
    $('#cEst').innerHTML = `
      <div class="oc-row"><span>Network</span><b><img class="oc-lg" src="${c.logo}" alt="">${esc(c.name)}</b></div>
      <div class="oc-row"><span>Creation fee</span><b>Free</b></div>
      <div class="oc-row"><span>Starting market cap</span><b>${fmtUsd(ocMcapUsd(key, s))}</b></div>
      <div class="oc-row"><span>Graduation market cap</span><b>${fmtUsd(ocGradMcUsd(key, target))}</b></div>
      <div class="oc-row"><span>Graduation target</span><b>${ocFmtN(ocNum(target), 2)} ${esc(N)}</b></div>
      <div class="oc-row"><span>Creator tax · max wallet</span><b>${st.tax ? st.tax / 100 + '%' : 'None'} · ${st.mw ? st.mw / 100 + '%' : 'None'}</b></div>
      <div class="oc-row"><span>Initial buy</span><b>${b > 0n ? `${ocFmtN(ocNum(b), 4)} ${esc(N)}` : '—'}</b></div>
      ${b > 0n ? `<div class="oc-row sub"><span>Tokens received</span><b>${fmtT(q.out)} · ${(Number(q.out * 10000n / OC_SUPPLY) / 100).toFixed(2)}%</b></div>` : ''}
      <div class="oc-row tot"><span>Total</span><b>${ocFmtN(ocNum(b), 4)} ${esc(N)} + gas</b></div>
      ${st.mw && q.out > OC_SUPPLY * BigInt(st.mw) / 10000n ? `<div class="oc-warn">The initial buy exceeds the ${st.mw / 100}% max wallet. Lower it or raise the limit.</div>` : ''}`;
  };
  ['cN', 'cS', 'cD', 'cI', 'cB'].forEach(i => $('#' + i).oninput = paint);
  ocPrices().then(paint); paint();
  $('#cGo').onclick = async () => {
    if (!c.pad) return;
    const name = $('#cN').value.trim(), sym = $('#cS').value.trim().toUpperCase();
    if (!name || !sym) { toast('Name and symbol are required', 'bad'); return; }
    const meta = JSON.stringify({ i: $('#cI').value.trim(), d: $('#cD').value.trim(), w: $('#cW').value.trim(), x: $('#cX').value.trim(), t: $('#cT').value.trim() });
    try {
      if (!OC.wallet) await ocConnect(key);
      if (OC.wallet.chainId !== c.chainId) await ocSwitch(key);
      const ex = await ocEthers();
      const signer = await new ex.BrowserProvider(window.ethereum).getSigner();
      const pad = new ex.Contract(c.pad, OC_ABI, signer);
      const def = await pad.defaultTarget();
      $('#cGo').disabled = true;
      const tx = await pad.create(name, sym, meta, st.tax, st.tax ? OC.wallet.addr : OC_ZERO, st.mw, st.tgt >= 100 ? 0n : def * BigInt(st.tgt) / 100n, ocRef(), { value: toWei($('#cB').value) });
      toast('Transaction submitted');
      const rc = await tx.wait();
      const ev = rc.logs.map(l => { try { return pad.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Created');
      await ocData(key, true);
      location.hash = `#/chain/${key}/t/${ev ? Number(ev.args.id) : 0}`;
    } catch (e) { toast(e.shortMessage || e.reason || e.message || 'Launch failed', 'bad'); }
    finally { const g = $('#cGo'); if (g) g.disabled = false; }
  };
}

/* ═══════════ HOW IT WORKS ═══════════ */
function ocHow(key) {
  const c = OC_CHAINS[key];
  document.title = `How it works · ${c.name} — Rookery`;
  app.innerHTML = ocShell(key, '/how', `
    <div class="oc-crumb"><a href="#/chain/${key}">${esc(c.name)}</a><span>/</span><b>How it works</b></div>
    <header class="oc-ph sm"><div class="oc-ph-t"><h1>How the launchpad works</h1><p>Fully on-chain. Every trade is a transaction between your wallet and the RookeryPad contract — no Rookery account required.</p></div></header>
    <div class="oc-steps">
      ${[['Create', `One transaction deploys a 1B-supply ERC-20, opens its bonding curve and fixes the address of its future ${c.dex} pool. An optional initial buy executes in the same transaction.`],
         ['Trade on the curve', `Buy and sell against the contract in ${c.native}. Price follows a constant-product curve. A 0.5% fee on each trade goes to the $臭企鹅 burn reserve, 20% of it to the trader's referrer.`],
         ['Graduate', `At ${ocFmtN(c.target, 2)} ${c.native} raised the contract seeds ${c.dex} with 200M tokens and 98% of the raise, then burns the LP. The pool opens at the curve's final price.`],
         ['Trade on the DEX', `The token trades freely on ${c.dex}. A fixed 0.5% DEX tax feeds the burn reserve, plus the creator tax if one was set (max 3%). Wallet transfers are never taxed.`]]
        .map(([h, p], i) => `<div class="oc-step"><span>${String(i + 1).padStart(2, '0')}</span><h3>${h}</h3><p>${esc(p)}</p></div>`).join('')}
    </div>
    <div class="oc-2">
      <div class="panel oc-box"><h4>Contract parameters</h4>
        ${[['Total supply', '1,000,000,000'], ['Bonding curve allocation', '800,000,000 (80%)'], ['DEX liquidity allocation', '200,000,000 (20%)'], ['Trade fee', '0.5% → burn reserve'],
           ['Referral share', '20% of the trade fee'], ['Graduation fee', '2% of the raise'], ['Graduation target', `${ocFmtN(c.target, 2)} ${c.native} (creator can choose 25–100%)`], ['Creator tax', '0–3%, immutable'], ['LP tokens', 'Burned (sent to 0xdead)']]
          .map(([a, b]) => `<div class="oc-row"><span>${a}</span><b>${b}</b></div>`).join('')}
      </div>
      <div class="panel oc-box"><h4>Safety</h4>
        ${[['Pool pre-seeding by snipers', 'Blocked by the token until graduation'], ['Withdrawal of curve funds by the team', 'Not possible — no such function'], ['Changing taxes after launch', 'Not possible — immutable'],
           ['Token owner / mint / blacklist', 'None'], ['Admin permissions', 'Fee recipient, default target, pause new launches'], ['Tests', 'Fork-tested against live Uniswap V2 deployments']]
          .map(([a, b]) => `<div class="oc-row"><span>${a}</span><b>${b}</b></div>`).join('')}
      </div>
    </div>
    <p class="mu oc-small" style="margin-top:16px">Rookery is a parody project and is not affiliated with LayerZero or any network listed. Not financial advice.</p>`);
  ocBind(key);
}

/* ═══════════ router entry ═══════════ */
async function ocRoute(key, sub, id) {
  if (!OC_CHAINS[key]) { location.hash = '#/chain/eth'; return; }
  const changed = OC.key !== key || !OC.statT;
  OC.key = key;
  localStorage.setItem('oc_last', key);
  $$('a[data-nav="chain"]').forEach(a => a.setAttribute('href', `#/chain/${key}`));
  ocPrices().then(() => ocPaintNet(key));
  if (changed) ocStartNet(key);
  if (sub === 't') return ocToken(key, id);
  if (sub === 'create') return ocCreate(key);
  if (sub === 'how') return ocHow(key);
  return ocExplore(key);
}
ocInitMenu();
