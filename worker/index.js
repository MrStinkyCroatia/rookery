// PreLaunch — launchpad for networks that are not live yet (Zero by LayerZero, GIWA).
// Worker routes /api/* into one Durable Object (SQLite) => every trade is atomic.
import { installSniper } from './sniper.js';
import { installStx } from './stx.js';
import { installRhpad } from './rhpad.js';
import { XB_NETS, XB_SOON, xbQuote, xbStatus, xbSubmit, xbStellarXdr, xbStellarSubmit, TERMINAL as XB_DONE } from './xbridge.js';
import { StellarIO, ST_NETS, xlm2wei, wei2xlm, assetCode, issuerFromSeed, verifySep53 } from './stellar.js';
import { matchOrder, ORDER_TTL_MS } from './orders.js';
import { HDNodeWallet, JsonRpcProvider, FallbackProvider, Network, FetchRequest, Wallet, Contract, Interface, Transaction, getAddress, isAddress, verifyMessage } from 'ethers';

const WEI = 10n ** 18n;
const ACC = 10n ** 36n;
const ZRO_TOKEN = '0x6985884C4392D348587B19cb9eAAf157F13271cd'; // same address on all chains below
const PLATFORM_BPS = 50n; // 0.5% of every trade -> pLAUNCH buy & burn reserve

// ZRO lives on these chains only (Robinhood Chain is ETH-only for now)
const ZRO_CHAINS = ['ethereum', 'base', 'arbitrum', 'bsc', 'optimism'];

const CHAINS = {
  ethereum: { label: 'Ethereum', chainId: 1, rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', conf: 3n,
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth-mainnet.public.blastapi.io', 'https://ethereum.publicnode.com'] },
  base: { label: 'Base', chainId: 8453, rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org', conf: 15n,
    rpcs: ['https://base-rpc.publicnode.com', 'https://1rpc.io/base', 'https://mainnet.base.org', 'https://base-mainnet.public.blastapi.io'] },
  arbitrum: { label: 'Arbitrum', chainId: 42161, rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io', conf: 40n,
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://1rpc.io/arb', 'https://arbitrum-one.public.blastapi.io', 'https://arbitrum-one-rpc.publicnode.com'] },
  bsc: { label: 'BNB Chain', chainId: 56, rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com', conf: 8n,
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-mainnet.public.blastapi.io'] },
  optimism: { label: 'Optimism', chainId: 10, rpc: 'https://optimism-rpc.publicnode.com', explorer: 'https://optimistic.etherscan.io', conf: 15n,
    rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://1rpc.io/op', 'https://optimism-mainnet.public.blastapi.io'] },
  robinhood: { label: 'Robinhood Chain', chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com', conf: 15n,
    rpcs: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com', 'https://4663.rpc.thirdweb.com'] },
};

const NETWORKS = {
  zero: { label: 'Zero', by: 'LayerZero', launchAt: '2026-11-30T00:00:00Z', status: 'Mainnet 30.11' },
  giwa: { label: 'GIWA', by: 'Upbit', launchAt: null, status: 'Testnet · mainnet TBA' },
  robinhood: { label: 'Robinhood Chain', by: 'Robinhood', launchAt: null, status: 'Live · Ethereum L2', live: true },
  stellar: { label: 'Stellar', by: 'SDF', launchAt: null, status: 'Live · graduates to Aquarius', live: true },
  litvm: { label: 'LitVM', by: 'Litecoin', launchAt: null, status: 'Pre-market · Litecoin EVM', live: true },
};
// Stellar markets: quoted in XLM, graduate at this market cap into an Aquarius pool (LP burned)
const STELLAR_GRAD_USD = 46000;

// Default curve (pump-style): 1B supply, 800M on the curve, 200M reserved for the mainnet pool.
const CURVE = { supply: 1_000_000_000n, curve: 800_000_000n, vZro: 3150n, vTok: 1_073_000_000n };

const LIMITS = { maxWithdraw: 5000n * WEI, dailyWithdraw: 20000n * WEI, minBuy: WEI / 10n };
// ETH support: GIWA markets are quoted in ETH; every user gets a separate ETH deposit address (HD child + offset)
// which we never top up with gas, so our gas never mixes with user deposits.
const ETH_OFFSET = 1_000_000_000;
const ETH_CHAINS = ['ethereum', 'base', 'arbitrum', 'robinhood'];
const MIN_BUY = { zro: WEI / 10n, eth: WEI / 20000n, xlm: WEI, ltc: WEI / 1000n, zltc: WEI / 1000n };   // ... · 1 XLM      // 0.1 ZRO · 0.00005 ETH
// points tiers: what they unlock at mainnet. Nothing here is money.
const TIERS = [
  { id: 'egg', min: 0, label: 'Egg', perk: 'everyone starts here' },
  { id: 'hatchling', min: 2500, label: 'Hatchling', perk: 'name in the migration snapshot + priority hatch slots' },
  { id: 'fledgling', min: 15000, label: 'Fledgling', perk: 'day-one pool whitelist + priority withdrawals at mainnet' },
  { id: 'emperor', min: 60000, label: 'Emperor', perk: 'first in line for day-one liquidity and new launch slots' },
];
const SWAP_FEE_BPS = 50n;                                    // 0.5% on instant ETH<->ZRO conversions
const ASSET_LABEL = { zro: 'ZRO', eth: 'ETH', xlm: 'XLM' };
// withdrawal network fee: charged in ZRO, deducted from the withdrawn amount
const NATIVE = { ethereum: 'eth', base: 'eth', arbitrum: 'eth', optimism: 'eth', bsc: 'bnb', robinhood: 'eth' };
const WD_GAS = 90_000n;          // ERC-20 transfer + headroom
const TOPUP_GAS = 21_000n;       // native gas top-up from the hot wallet to a deposit address
const FEE_MARGIN = 1.5;          // covers L1 data fees on rollups and gas spikes
const MIN_FEE_ZRO = 0.05;
// deposit addresses holding at least this much ZRO are swept into the hot wallet, so payouts come from one pool
const SWEEP_MIN = { ethereum: 10n * WEI, base: 2n * WEI, arbitrum: 2n * WEI, bsc: 2n * WEI, optimism: 2n * WEI, robinhood: 2n * WEI };

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SCAN_RANGE = 1500n; // blocks per chain per cron tick
// JSON-RPC with automatic fallback across several public endpoints per chain
async function rpc(chain, method, params, _retry = true) {
  let last = null;
  for (const u of CHAINS[chain].rpcs || [CHAINS[chain].rpc]) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) });
      if (!r.ok) { last = new Error(`${u} http ${r.status}`); continue; }
      const j = await r.json();
      if (j.error) { last = new Error(j.error.message || 'rpc error'); continue; }
      if (j.result === undefined) { last = new Error('empty rpc result'); continue; }
      return j.result;
    } catch (e) { last = e; }
  }
  // every public endpoint failed at once (usually a burst of 429s): wait a moment and try the whole list once more
  if (_retry) { await new Promise(r => setTimeout(r, 900)); return rpc(chain, method, params, false); }
  throw last || new Error('rpc');
}
async function rpcOne(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({ error: { message: `http ${r.status}` } }));
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}
// broadcast a signed tx to every endpoint of the chain at once; succeeds if any node accepts it
async function broadcastAll(chain, raw) {
  const res = await Promise.allSettled((CHAINS[chain].rpcs || [CHAINS[chain].rpc]).map(u => rpcOne(u, 'eth_sendRawTransaction', [raw])));
  if (res.some(r => r.status === 'fulfilled')) return true;
  const msgs = res.map(r => String(r.reason?.message || r.reason));
  if (msgs.some(m => /already known|known transaction|already imported|already exists/i.test(m))) return true;
  throw new Error(msgs.find(m => !/http 4|http 5|abort|timeout/i.test(m)) || msgs[0]);
}
async function waitReceipt(chain, hash, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await rpc(chain, 'eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    await new Promise(res => setTimeout(res, 2500));
  }
  return null;
}
const XFER_IFACE = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // same address on all chains
const MC_IFACE = new Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])']);
const ERC20_IFACE = new Interface(['function balanceOf(address) view returns (uint256)']);
const toHex = (n) => '0x' + BigInt(n).toString(16);
const escH = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function usdTxt(v) {
  if (!v) return '$0';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  if (v >= 1) return '$' + v.toFixed(2);
  if (v >= 0.0001) return '$' + v.toFixed(6);
  return '$' + v.toPrecision(3);
}
function tokTxt(wei) {
  const n = Number(BigInt(wei)) / 1e18;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

/* ── $臭企鹅 buy & burn pipeline ──
   reserve (ZRO, 0.5% of every trade) → burn wallet on SOURCE chain → Relay: ZRO → ETH on Robinhood Chain
   → Uniswap V3 on Robinhood: ETH → $臭企鹅 with recipient = dead address (bought and burned in one tx) */
const BURN_INDEX = 2_000_000_000; // HD child reserved for the burn wallet (never a user deposit index)
const DEAD = '0x000000000000000000000000000000000000dEaD';
const ROBINHOOD = {
  chainId: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
  router: '0xcaf681a66d020601342297493863e78c959e5cb2',
  quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
};
const RELAY_API = 'https://api.relay.link';
const ERC20_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'];

// public read endpoints served from Cloudflare's edge cache: one origin call per TTL window instead of one per visitor
// Only the heavy, rarely changing reads are cached at the edge. The live list and stats are NOT cached:
// Cloudflare rewrites the browser's max-age to the zone default (4h), which made Explore show hour-old prices.
const EDGE_TTL = { '/api/proofs': 15, '/api/burns': 15, '/api/wallet/fees': 20 };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/_cron') return new Response('not found', { status: 404 });
      const ttl = EDGE_TTL[url.pathname];
      const cacheable = ttl && req.method === 'GET';
      const cache = cacheable ? caches.default : null;
      const key = cacheable ? new Request(url.toString(), { method: 'GET' }) : null;
      if (cacheable) {
        const hit = await cache.match(key);
        if (hit) {
          const h = new Response(hit.body, hit);
          h.headers.set('x-edge-cache', 'hit');
          return h;
        }
      }
      const resp = await env.BOOKS.get(env.BOOKS.idFromName('rookery-main')).fetch(req);
      if (cacheable && resp.ok) {
        const body = await resp.clone().arrayBuffer();
        const out = new Response(body, { status: resp.status, headers: resp.headers });
        out.headers.set('Cache-Control', `public, max-age=0, must-revalidate, s-maxage=${ttl}, stale-while-revalidate=${ttl}`);
        out.headers.set('CDN-Cache-Control', `max-age=${ttl}`);
        out.headers.set('x-edge-cache', 'miss');
        out.headers.delete('set-cookie');
        ctx.waitUntil(cache.put(key, new Response(body, { status: 200, headers: out.headers })));
        return out;
      }
      return resp;
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_ev, env) {
    await env.BOOKS.get(env.BOOKS.idFromName('rookery-main')).fetch('https://do/api/_cron', { method: 'POST' });
  },
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const B = (v) => BigInt(v ?? 0);
const qa = (m) => (m.quote === 'ETH' ? 'eth' : m.quote === 'XLM' ? 'xlm' : m.quote === 'ZKLTC' ? 'zltc' : m.quote === 'LTC' ? 'ltc' : 'zro'); // a market's quote asset (ledger key)
const vQuote = (m) => (m.v_wei ? B(m.v_wei) : B(m.v_zro) * WEI);       // virtual quote reserve of the curve, in wei
const burnKey = (a) => (a === 'eth' ? 'plaunch_burn_eth' : a === 'xlm' ? 'plaunch_burn_xlm' : 'plaunch_burn');
const now = () => Date.now();

export class Books {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    if (env.RPC_OVERRIDE) {
      try { for (const [c, u] of Object.entries(JSON.parse(env.RPC_OVERRIDE))) if (CHAINS[c]) { CHAINS[c].rpcs = [u]; CHAINS[c].rpc = u; } } catch { /* ignore */ }
    }
    this.init();
    this.rhInit();
    // live push: keep-alive pings are answered by the runtime without waking the object
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"ping":1}', '{"pong":1}')); } catch { /* older runtime */ }
  }

  /* ───────────── live push (WebSocket, hibernatable) ───────────── */
  // Clients subscribe to 'all' (Explore / Trading) or 'm:<id>' (one token page). Every trade, launch and comment
  // pushes the fresh market view to the sockets that care; bursts are coalesced into one push per ~120 ms.
  webSocketMessage(ws, msg) {
    try {
      const m = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
      if (m.sub) ws.serializeAttachment({ subs: [].concat(m.sub).slice(0, 6).map(s => String(s).slice(0, 40)) });
    } catch { /* ignore junk */ }
  }
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ } }
  webSocketError() { /* the socket is dropped; clients reconnect on their own */ }
  // trade = { side, usd, user, symbol, id } for the live ticker (sent to every open page)
  queuePush(marketId, kind = 'trade', trade = null) {
    if (!this.ctx.getWebSockets().length) return;
    (this._pq ||= new Map()).set(marketId, kind);
    if (trade) { (this._tq ||= []).push(trade); if (this._tq.length > 40) this._tq.shift(); }
    if (this._pt) return;
    this._pt = setTimeout(() => {
      this._pt = null;
      const q = this._pq, tq = this._tq || []; this._pq = new Map(); this._tq = [];
      try { this.flushPush(q, tq); } catch (e) { console.warn('push', e?.message); }
    }, 120);
  }
  flushPush(q, tq = []) {
    const socks = this.ctx.getWebSockets();
    if (!socks.length) return;
    if (tq.length) { const tm = JSON.stringify({ t: 'trades', trades: tq }); for (const ws of socks) { try { ws.send(tm); } catch { /* closing */ } } }
    const usd = this.zroUsd();
    const burn = B(this.meta('plaunch_burn')), burnEth = B(this.meta('plaunch_burn_eth'));
    const stats = {
      volumeUsd: this.sql.exec('SELECT volume, quote, rh_quote FROM markets').toArray().reduce((a, r) => a + (Number(B(r.volume)) / 1e18) * (r.rh_quote ? this.rhMarketUsd(r) : this.usdOf(qa(r))), 0),
      markets: this.sql.exec('SELECT COUNT(*) c FROM markets').one().c,
      traders: this.sql.exec('SELECT COUNT(*) c FROM users').one().c,
      burnReserveUsd: (Number(burn) / 1e18) * usd + (Number(burnEth) / 1e18) * this.ethUsd() + (Number(B(this.meta('plaunch_burn_xlm'))) / 1e18) * this.xlmUsd(),
    };
    for (const [id, kind] of q) {
      const row = this.sql.exec('SELECT * FROM markets WHERE id=?', id).toArray()[0];
      if (!row) continue;
      const msg = JSON.stringify({ t: 'market', kind, market: this.view(row, usd), stats }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      const topic = 'm:' + id;
      for (const ws of socks) {
        const subs = ws.deserializeAttachment()?.subs || ['all'];
        if (subs.includes('all') || subs.includes(topic)) { try { ws.send(msg); } catch { /* closing */ } }
      }
    }
  }

  /* ───────────── schema ───────────── */
  init() {
    const q = (s) => this.sql.exec(s);
    q(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, username TEXT UNIQUE,
      pass_hash TEXT, salt TEXT, bio TEXT DEFAULT '', avatar TEXT DEFAULT '',
      dep_index INTEGER, dep_address TEXT, watch_until INTEGER DEFAULT 0, created INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, expires INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS balances (user_id INTEGER, asset TEXT, amount TEXT, PRIMARY KEY (user_id, asset))`);
    q(`CREATE TABLE IF NOT EXISTS reward_debt (user_id INTEGER, market TEXT, debt TEXT, earned TEXT DEFAULT '0', PRIMARY KEY (user_id, market))`);
    q(`CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY, creator_id INTEGER, name TEXT, symbol TEXT, description TEXT, image TEXT,
      network TEXT, quote TEXT DEFAULT 'ZRO', x TEXT, tg TEXT, web TEXT,
      supply TEXT, curve_tokens TEXT, v_zro TEXT, v_tok TEXT,
      reserve_zro TEXT DEFAULT '0', reserve_tok TEXT DEFAULT '0', burned TEXT DEFAULT '0',
      volume TEXT DEFAULT '0', trades INTEGER DEFAULT 0,
      max_buy_bps INTEGER DEFAULT 0, max_buy_until INTEGER DEFAULT 0,
      tax_mkt INTEGER DEFAULT 0, tax_burn INTEGER DEFAULT 0, tax_rew INTEGER DEFAULT 0,
      acc_rew TEXT DEFAULT '0', rewards_paid TEXT DEFAULT '0', mkt_paid TEXT DEFAULT '0',
      last_price TEXT DEFAULT '0', last_trade INTEGER DEFAULT 0, created INTEGER, migrated INTEGER DEFAULT 0)`);
    q(`CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT, user_id INTEGER, side TEXT,
      zro TEXT, tokens TEXT, price TEXT, usd REAL, ts INTEGER)`);
    q(`CREATE INDEX IF NOT EXISTS trades_m ON trades (market, id)`);
    q(`CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT, user_id INTEGER, body TEXT, ts INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, kind TEXT, chain TEXT, amount TEXT,
      txid TEXT DEFAULT '', to_addr TEXT DEFAULT '', status TEXT, note TEXT DEFAULT '', ts INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS deposit_seen (user_id INTEGER, chain TEXT, last TEXT, PRIMARY KEY (user_id, chain))`);
    q(`CREATE TABLE IF NOT EXISTS proofs (id INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT, total TEXT, accounts INTEGER, ts INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    // wallet login (Sign-In with Ethereum)
    try { q(`ALTER TABLE users ADD COLUMN wallet TEXT`); } catch { /* already there */ }
    q(`CREATE UNIQUE INDEX IF NOT EXISTS users_wallet ON users (wallet)`);
    q(`CREATE TABLE IF NOT EXISTS tg_subs (chat_id TEXT, market TEXT, min_usd REAL DEFAULT 0, created INTEGER, PRIMARY KEY (chat_id, market))`);
    for (const col of ['media_id TEXT', 'media_type TEXT', 'x TEXT', 'tg TEXT', 'web TEXT', 'emoji TEXT']) {
      try { q(`ALTER TABLE tg_subs ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    try { q(`ALTER TABLE transfers ADD COLUMN raw TEXT`); } catch { /* exists */ }
    try { q(`ALTER TABLE users ADD COLUMN referred_by INTEGER`); } catch { /* exists */ }
    for (const [t, col] of [['markets', 'v_wei TEXT'], ['users', 'eth_dep_address TEXT'], ['out_pending', "asset TEXT DEFAULT 'zro'"],
      ['out_pending', 'pre_bal TEXT'], ['transfers', "asset TEXT DEFAULT 'zro'"], ['trades', "quote TEXT DEFAULT 'ZRO'"], ['trades', 'pay TEXT'], ['trades', 'pay_amount TEXT']]) {
      try { q(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    for (const col of ["pool_zro TEXT DEFAULT '0'", "pool_tok TEXT DEFAULT '0'", 'graduated INTEGER DEFAULT 0', 'grad_at INTEGER DEFAULT 0']) {
      try { q(`ALTER TABLE markets ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    // Stellar: one row per bonded market that has to go on-chain into Aquarius (state = resumable step data)
    q(`CREATE TABLE IF NOT EXISTS stellar_jobs (market TEXT PRIMARY KEY, status TEXT, state TEXT, error TEXT, created INTEGER, updated INTEGER)`);
    for (const col of ['st_code TEXT', 'st_issuer TEXT', 'st_pool TEXT', 'st_keeper TEXT']) { try { q(`ALTER TABLE markets ADD COLUMN ${col}`); } catch { /* exists */ } }
    try { q(`ALTER TABLE markets ADD COLUMN grad_usd INTEGER DEFAULT 0`); } catch { /* exists */ }
    try { q(`ALTER TABLE users ADD COLUMN stellar_wallet TEXT`); } catch { /* exists */ }
    try { q(`ALTER TABLE transfers ADD COLUMN tg_notified INTEGER`); } catch { /* exists */ }
    q(`CREATE TABLE IF NOT EXISTS st_nonces (nonce TEXT PRIMARY KEY, address TEXT, message TEXT, expires INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS st_intents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market TEXT, amount TEXT, status TEXT, txid TEXT DEFAULT '', created INTEGER, expires INTEGER)`);
    // sender addresses an admin has already resolved by hand: next deposit from the same address needs no memo
    q(`CREATE TABLE IF NOT EXISTS st_addr_users (addr TEXT PRIMARY KEY, user_id INTEGER, ts INTEGER)`);
    // before graduation (when switched on): tokens bought by a holder with a linked Stellar wallet go straight to that wallet
    q(`CREATE TABLE IF NOT EXISTS st_out (user_id INTEGER, market TEXT, pending TEXT DEFAULT '0', sent TEXT DEFAULT '0', note TEXT DEFAULT '',
       tries INTEGER DEFAULT 0, next_try INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (user_id, market))`);
    try { q(`ALTER TABLE st_intents ADD COLUMN side TEXT DEFAULT 'buy'`); } catch { /* exists */ }
    try { q(`ALTER TABLE st_intents ADD COLUMN address TEXT`); } catch { /* exists */ }
    // after graduation, every holder with a linked Stellar wallet gets the tokens sent automatically
    q(`CREATE TABLE IF NOT EXISTS st_drops (id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT, user_id INTEGER, address TEXT,
       status TEXT, amount TEXT DEFAULT '', txid TEXT DEFAULT '', note TEXT DEFAULT '', tries INTEGER DEFAULT 0, next_try INTEGER DEFAULT 0,
       created INTEGER, updated INTEGER, UNIQUE(market, user_id))`);
    q(`CREATE TABLE IF NOT EXISTS xb_orders (ref TEXT PRIMARY KEY, user_id INTEGER, from_net TEXT, to_net TEXT, amount_in TEXT, in_usd REAL,
       out_est TEXT, out_usd REAL, recipient TEXT, refund TEXT, dep_addr TEXT, dep_memo TEXT DEFAULT '', status TEXT, in_tx TEXT DEFAULT '',
       out_tx TEXT DEFAULT '', out_fmt TEXT DEFAULT '', refund_tx TEXT DEFAULT '', created INTEGER, deadline TEXT, checked INTEGER DEFAULT 0)`);
    try { q(`ALTER TABLE xb_orders ADD COLUMN tg_state TEXT`); } catch { /* exists */ }
    // one-signature buys from a connected EVM wallet
    q(`CREATE TABLE IF NOT EXISTS orders_evm (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market TEXT,
       asset TEXT, amount TEXT, tagged TEXT, tag INTEGER, status TEXT, tokens TEXT DEFAULT '', txid TEXT DEFAULT '',
       note TEXT DEFAULT '', created INTEGER, expires INTEGER)`);
    try { q(`ALTER TABLE markets ADD COLUMN st_issued INTEGER DEFAULT 0`); } catch { /* exists */ }
    q(`CREATE TABLE IF NOT EXISTS out_pending (id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id INTEGER, src_user INTEGER, chain TEXT, amount TEXT, txid TEXT, ts INTEGER)`);
    try { q(`ALTER TABLE out_pending ADD COLUMN raw TEXT`); } catch { /* exists */ }
    // on a brand-new database the generic column loop above ran before this table existed
    try { q(`ALTER TABLE out_pending ADD COLUMN asset TEXT DEFAULT 'zro'`); } catch { /* exists */ }
    try { q(`ALTER TABLE out_pending ADD COLUMN pre_bal TEXT`); } catch { /* exists */ }
    q(`CREATE TABLE IF NOT EXISTS siwe_nonces (nonce TEXT PRIMARY KEY, address TEXT, message TEXT, expires INTEGER)`);
    // "hatching soon": a creator announces a token with a countdown; people sign up to be told when it goes live
    q(`CREATE TABLE IF NOT EXISTS hatches (
      id TEXT PRIMARY KEY, creator_id INTEGER, name TEXT, symbol TEXT, network TEXT,
      description TEXT DEFAULT '', image TEXT DEFAULT '', launch_at INTEGER, created INTEGER,
      market_id TEXT DEFAULT '', cancelled INTEGER DEFAULT 0)`);
    q(`CREATE TABLE IF NOT EXISTS hatch_subs (hatch_id TEXT, user_id INTEGER, ts INTEGER, PRIMARY KEY (hatch_id, user_id))`);
    q(`CREATE INDEX IF NOT EXISTS hatches_at ON hatches (launch_at)`);
    // points for real usage, and referrals that share the platform fee
    q(`CREATE TABLE IF NOT EXISTS points (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, kind TEXT, amount INTEGER, ref TEXT, ts INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS pts (user_id INTEGER PRIMARY KEY, total INTEGER DEFAULT 0, trade INTEGER DEFAULT 0,
      hatch INTEGER DEFAULT 0, bond INTEGER DEFAULT 0, hold INTEGER DEFAULT 0, referral INTEGER DEFAULT 0, ts INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS ref_earn (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id INTEGER, trader_id INTEGER, asset TEXT, amount TEXT, ts INTEGER)`);
    q(`CREATE INDEX IF NOT EXISTS pts_total ON pts (total)`);
    q(`CREATE TABLE IF NOT EXISTS burn_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT, zro TEXT, source TEXT,
      tx_transfer TEXT DEFAULT '', tx_bridge TEXT DEFAULT '', relay_id TEXT DEFAULT '',
      eth_in TEXT DEFAULT '0', tx_burn TEXT DEFAULT '', tokens_burned TEXT DEFAULT '0',
      attempts INTEGER DEFAULT 0, note TEXT DEFAULT '', created INTEGER, updated INTEGER)`);
    q(`INSERT INTO meta (k,v) VALUES ('dep_counter','0') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('plaunch_burn','0') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('zro_usd','1.5') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('zro_chg','0') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('zro_ts','0') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('burn_token','') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('burn_source','arbitrum') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('burn_auto','1') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('burn_min_zro','20') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('burn_max_zro','5000') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('burn_interval_h','24') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('burn_slippage_bps','300') ON CONFLICT(k) DO NOTHING`);
    q(`INSERT INTO meta (k,v) VALUES ('burn_last','0') ON CONFLICT(k) DO NOTHING`);
  }

  meta(k) { return this.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray()[0]?.v ?? null; }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v)); }

  /* ───────────── wallets (HD, xprv in secret) ───────────── */
  master() {
    if (!this._master) {
      if (!this.env.MASTER_XPRV) throw new Error('wallet service not configured');
      this._master = HDNodeWallet.fromExtendedKey(this.env.MASTER_XPRV);
    }
    return this._master;
  }
  // one queue for everything that signs with platform wallets (withdrawals, burns): no nonce clashes, no double-spend of a source
  serial(fn) { const run = (this._q || Promise.resolve()).then(fn, fn); this._q = run.catch(() => {}); return run; }
  // withdrawals have their own queue so a slow chain can never hold up deposit detection or trading
  wserial(fn) { const run = (this._wq || Promise.resolve()).then(fn, fn); this._wq = run.catch(() => {}); return run; }
  hotWallet() { return this.master().deriveChild(0); }

  /* ───────────── Stellar (XLM deposits/withdrawals, on-chain graduation into Aquarius) ───────────── */
  async stellar() {
    if (!this._st) {
      if (!this.env.MASTER_XPRV) throw new Error('wallet service not configured');
      // the Stellar hot key is derived from the same master secret (ed25519 seed = sha256(xprv + label))
      const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.env.MASTER_XPRV + ':rookery-stellar-hot-v1')));
      this._st = new StellarIO(this.env.STELLAR_NET === 'mainnet' ? 'mainnet' : 'testnet', Buffer.from(seed), this.env.STELLAR_NET === 'mainnet' ? (this.env.STELLAR_RPC || '') : '');
      if (this.env.STELLAR_SIM_SOURCE) this._st.simSource = this.env.STELLAR_SIM_SOURCE;   // read-only simulations from any funded account (tests)
    }
    return this._st;
  }
  stNet() { return this.env.STELLAR_NET === 'mainnet' ? 'mainnet' : 'testnet'; }
  stellarWalletUser(address) {
    const owner = this.sql.exec('SELECT * FROM users WHERE stellar_wallet=?', address).toArray()[0];
    if (owner) return owner;
    let uname = 'st_' + address.slice(1, 7).toLowerCase();
    while (this.sql.exec('SELECT 1 FROM users WHERE username=? COLLATE NOCASE', uname).toArray().length) uname = 'st_' + randHex(3);
    const idx = Number(this.meta('dep_counter')) + 1;
    this.setMeta('dep_counter', idx);
    this.sql.exec(`INSERT INTO users (email,username,pass_hash,salt,dep_index,dep_address,created,stellar_wallet) VALUES (?,?,?,?,?,?,?,?)`,
      `${address.toLowerCase()}@stellar.local`, uname, '', '', idx, this.depositAddressFor(idx), now(), address);
    return this.sql.exec('SELECT * FROM users WHERE stellar_wallet=?', address).one();
  }
  stGradUsd() { return Number(this.meta('stellar_grad_usd')) || STELLAR_GRAD_USD; }
  // each market keeps its own target, so a live token can never be re-priced mid-flight
  marketGradUsd(m) { return Number(m?.grad_usd) || this.stGradUsd(); }
  // the issuer key is derived, never stored: same master secret, one label per token
  async stIssuer(id) {
    if (!this.env.MASTER_XPRV) throw new Error('wallet service not configured');
    const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.env.MASTER_XPRV + ':rookery-stellar-issuer-v1:' + id)));
    return issuerFromSeed(seed);
  }
  // put a freshly created Stellar token on-chain: real asset + contract from minute one, LP only at graduation
  async stIssue(id) {
    const m = this.market(id);
    if (m.network !== 'stellar') return null;
    const st = await this.stellar();
    const code = assetCode(m.symbol);
    const kp = await this.stIssuer(id);
    if (!m.st_issuer) {
      await st.issueAt({ code, supply: Number(B(m.supply)), issuerKp: kp, log: (x) => console.log('stellar issue', id, x) });
      this.sql.exec(`UPDATE markets SET st_code=?, st_issuer=?, st_issued=1 WHERE id=?`, code, kp.publicKey(), id);
    } else {
      try { await st.ensureSac(code, m.st_issuer); } catch (e) { if (!/exist|ExistingValue|simulate/i.test(e.message)) throw e; }
    }
    return kp.publicKey();
  }
  // incoming XLM payments to the hot account: memo id (or numeric text) = Rookery user id
  async stellarScan() {
    const st = await this.stellar();
    let cursor = this.meta('st_cursor');
    if (!cursor) { cursor = await st.headCursor(); this.setMeta('st_cursor', cursor); return { credited: [] }; }
    const credited = [];
    for (let page = 0; page < 5; page++) {
      let r;
      try { r = await st.incoming(cursor === 'now' ? '' : cursor); }
      catch (e) { if (e.status === 404) return { credited, note: 'hot account not funded yet' }; throw e; }
      for (const it of r.items) {
        if (this.sql.exec(`SELECT 1 FROM transfers WHERE chain='stellar' AND txid=?`, it.id).toArray().length) continue;
        if (it.asset && it.asset !== 'native') {
          try { const r = await this.stTokenInflow(it); if (r) credited.push({ tokens: r }); } catch (e) { credited.push({ tokenError: String(e?.message || e).slice(0, 120) }); }
          continue;
        }
        const memoStr = String(it.memo || '').trim();
        const im = memoStr.match(/^r(\d{1,9})$/);
        if (im) {
          const it2 = this.sql.exec(`SELECT * FROM st_intents WHERE id=? AND status=? AND COALESCE(side,'buy')='buy'`, Number(im[1]), 'open').toArray()[0];
          if (it2 && it2.expires > now() && !this.sql.exec(`SELECT 1 FROM transfers WHERE chain='stellar' AND txid=?`, it.id).toArray().length) {
            const amt2 = xlm2wei(it.amount);
            this.ctx.storage.transactionSync(() => {
              this.addBal(it2.user_id, 'xlm', amt2);
              this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,txid,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?,?)`,
                it2.user_id, 'deposit', 'stellar', amt2.toString(), it.id, it.from || '', 'confirmed', `intent ${im[1]} tx ${it.hash}`, now(), 'xlm');
              this.sql.exec(`UPDATE st_intents SET status='paid', txid=? WHERE id=?`, it.id, it2.id);
            });
            try {
              const u3 = this.sql.exec('SELECT * FROM users WHERE id=?', it2.user_id).toArray()[0];
              if (u3) {
                // buys sent by RookerySniperBot carry its fee: booked into the burn reserve before the curve fills
                const fb = BigInt(Number(it2.fee_bps || 0)), bf = fb > 0n && fb <= 500n ? (amt2 * fb) / 10000n : 0n;
                if (bf > 0n) this.snbChargeFee(u3.id, 'xlm', bf);
                const tr = this.trade(u3, { market: it2.market, side: 'buy', amount: (amt2 - bf).toString() });
                if (fb > 0n) this.snbAfterChain(u3, it2.market, 'buy', tr, amt2, bf);
                this.sql.exec(`UPDATE st_intents SET status='done' WHERE id=?`, it2.id);
                credited.push({ user: it2.user_id, xlm: it.amount, bought: it2.market });
              }
            } catch (e) {
              this.sql.exec(`UPDATE st_intents SET status='paid' WHERE id=?`, it2.id);   // the XLM stays as balance
              credited.push({ user: it2.user_id, xlm: it.amount, buyError: String(e?.message || e).slice(0, 80) });
            }
            continue;
          }
        }
        const uid = /^\d+$/.test(memoStr) ? Number(memoStr) : 0;
        let u = uid ? this.sql.exec('SELECT id FROM users WHERE id=?', uid).toArray()[0] : null;
        let matched = '';
        // no usable memo: if this exact address is one we have already paid out to, it is that user's own wallet
        if (!u && it.from) {
          // already resolved by an admin once: remember the sender instead of asking again
          const known = this.sql.exec('SELECT user_id FROM st_addr_users WHERE addr=?', it.from).toArray()[0];
          if (known) { u = this.sql.exec('SELECT id FROM users WHERE id=?', known.user_id).toArray()[0]; matched = ' · remembered sender address'; }
        }
        if (!u && it.from) {
          const cands = this.sql.exec(`SELECT DISTINCT user_id FROM transfers WHERE chain='stellar' AND kind='withdrawal' AND to_addr=? AND status='sent'`, it.from).toArray();
          if (cands.length === 1) { u = this.sql.exec('SELECT id FROM users WHERE id=?', cands[0].user_id).toArray()[0]; matched = ' · matched sender address'; }
        }
        const amt = xlm2wei(it.amount);
        this.ctx.storage.transactionSync(() => {
          if (u) {
            this.addBal(u.id, 'xlm', amt);
            this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,txid,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?,?)`,
              u.id, 'deposit', 'stellar', amt.toString(), it.id, it.from || '', 'confirmed', 'tx ' + it.hash + matched, now(), 'xlm');
          } else {
            this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,txid,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?,?)`,
              0, 'deposit', 'stellar', amt.toString(), it.id, it.from || '', 'unassigned', `no/unknown memo (${it.memo || '—'}) tx ${it.hash}`, now(), 'xlm');
          }
        });
        if (u) credited.push({ user: u.id, xlm: it.amount });
      }
      cursor = r.cursor; this.setMeta('st_cursor', cursor);
      if (!r.more) break;
    }
    return { credited };
  }
  // queue the graduation job the moment a bonded Stellar market reaches its market-cap target
  stMaybeGraduate(id) {
    const m = this.market(id);
    if (!m || m.network !== 'stellar' || !m.graduated || m.migrated) return false;
    if (this.sql.exec('SELECT 1 FROM stellar_jobs WHERE market=?', id).toArray().length) return false;
    const mc = (Number(Books.price(m)) / 1e18) * Number(m.supply) * this.xlmUsd();
    // 0.5% tolerance: a curve sized for the target lands a hair under it after rounding
    if (mc < this.marketGradUsd(m) * 0.995) return false;
    this.sql.exec(`INSERT OR IGNORE INTO stellar_jobs (market,status,state,error,created,updated) VALUES (?,'queued','{}','',?,?)`, id, now(), now());
    this._stKick = true;
    return true;
  }
  // run every queued/failed graduation job (resumable, one step at a time is persisted)
  async stellarJobs() {
    const out = [];
    for (const j of this.sql.exec(`SELECT * FROM stellar_jobs WHERE status IN ('queued','running','retry') ORDER BY created LIMIT 3`).toArray()) {
      const m = this.market(j.market);
      const S = JSON.parse(j.state || '{}');
      const save = async (st) => this.sql.exec(`UPDATE stellar_jobs SET state=?, status='running', updated=? WHERE market=?`, JSON.stringify(st), now(), m.id);
      try {
        const st = await this.stellar();
        const code = S.code || (S.code = assetCode(m.symbol));
        const poolXlm = wei2xlm(m.pool_zro);
        const toTok = (w) => Math.floor(Number(B(w) / 100_000_000_000n)) / 1e7;   // 18 -> 7 decimals
        const poolTok = toTok(m.pool_tok);
        const circTok = toTok(Books.circulating(m));
        S.aquaMaxXlm = S.aquaMaxXlm || Math.min(poolXlm * 0.25, 2500);
        const preIssued = !!m.st_issuer;
        const burnTok = toTok(B(m.burned));
        const issuerKp = preIssued ? await this.stIssuer(m.id) : null;
        await st.graduate({ code, poolXlm, poolTok, circTok, burnTok, issuerKp, preIssued, S, save, log: (x) => console.log('stellar grad', m.id, x) });
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`UPDATE markets SET migrated=1, st_code=?, st_issuer=?, st_pool=?, st_keeper=? WHERE id=?`, code, S.issuer, S.pool, S.keeper, m.id);
          // the whole bonded XLM reserve left custody (pool deposit + on-chain set-up costs)
          this.setMeta('xlm_graduated_out', (B(this.meta('xlm_graduated_out')) + B(m.pool_zro)).toString());
          this.sql.exec(`UPDATE stellar_jobs SET status='done', state=?, error='', updated=? WHERE market=?`, JSON.stringify(S), now(), m.id);
        });
        this.queuePush(m.id, 'trade');
        out.push({ market: m.id, done: true, pool: S.pool });
      } catch (e) {
        this.sql.exec(`UPDATE stellar_jobs SET status='retry', error=?, updated=? WHERE market=?`, String(e?.message || e).slice(0, 400), now(), m.id);
        out.push({ market: m.id, error: String(e?.message || e) });
      }
    }
    return out;
  }
  stSendNowOn() { return this.meta('st_send_now') === '1'; }
  // the asset must refuse contracts (pools) before any token leaves custody
  async stEnsureAuth(m) {
    if (this.meta('st_auth_' + m.id) === '1') return;
    const st = await this.stellar();
    await st.requireAuth({ code: m.st_code, issuerKp: await this.stIssuer(m.id) });
    this.setMeta('st_auth_' + m.id, '1');
  }
  async stellarSendNow(force = false) {
    if (!this.stSendNowOn()) return { off: true };
    const st = await this.stellar();
    // holders who linked a Stellar wallet after they bought: queue their tokens once, on the next tick
    this.sql.exec(`INSERT OR IGNORE INTO st_out (user_id,market,pending,updated)
      SELECT b.user_id, m.id, b.amount, ? FROM balances b JOIN users u ON u.id=b.user_id
      JOIN markets m ON 't:' || m.id = b.asset
      WHERE m.network='stellar' AND m.migrated=0 AND m.st_issuer IS NOT NULL AND m.st_issuer!=''
        AND b.amount!='0' AND u.stellar_wallet IS NOT NULL AND u.stellar_wallet!=''`, now());
    const rows = this.sql.exec(`SELECT o.*, u.stellar_wallet FROM st_out o JOIN users u ON u.id=o.user_id
      WHERE CAST(o.pending AS REAL) > 0 AND (o.next_try<=? OR ?=1) ORDER BY o.updated LIMIT 15`, now(), force ? 1 : 0).toArray();
    const out = [];
    const unit = 100_000_000_000n;
    for (const r of rows) {
      const m = this.market(r.market);
      const u = this.sql.exec('SELECT * FROM users WHERE id=?', r.user_id).toArray()[0];
      if (!m || m.migrated || !m.st_issuer || !u?.stellar_wallet) { this.sql.exec(`UPDATE st_out SET pending='0', note=? WHERE user_id=? AND market=?`, m?.migrated ? 'graduated: sent by the graduation drop' : 'no wallet', r.user_id, r.market); continue; }
      const bal = this.bal(u.id, 't:' + m.id);
      let amt = B(r.pending) < bal ? B(r.pending) : bal;
      amt = (amt / unit) * unit;
      if (amt <= 0n) { this.sql.exec(`UPDATE st_out SET pending='0' WHERE user_id=? AND market=?`, u.id, m.id); continue; }
      let tb;
      try { tb = await st.tokenBalance(u.stellar_wallet, m.st_code, m.st_issuer); } catch { tb = undefined; }
      if (tb === undefined) { this.sql.exec('UPDATE st_out SET next_try=?, note=? WHERE user_id=? AND market=?', now() + 60e3, 'Horizon unavailable', u.id, m.id); continue; }
      if (!tb || tb.balance === null) {
        this.sql.exec('UPDATE st_out SET next_try=?, note=? WHERE user_id=? AND market=?', now() + 60e3, `add a trustline for ${m.st_code} to receive the tokens`, u.id, m.id);
        continue;
      }
      try { await this.stEnsureAuth(m); } catch (e) { this.sql.exec('UPDATE st_out SET next_try=?, note=? WHERE user_id=? AND market=?', now() + 60e3, 'auth: ' + String(e.message).slice(0, 100), u.id, m.id); continue; }
      // settle holder rewards on what leaves, exactly like a sell does
      let tid;
      this.ctx.storage.transactionSync(() => {
        this.settle(u.id, m);
        this.addBal(u.id, 't:' + m.id, -amt);
        this.resetDebt(u.id, this.market(m.id));
        tid = this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
          u.id, 'withdrawal', 'stellar', amt.toString(), u.stellar_wallet, 'pending', 'sent to your wallet after your buy', now(), 't:' + m.id).one().id;
      });
      try {
        const res = await st.payAssetAuth(u.stellar_wallet, m.st_code, await this.stIssuer(m.id), Math.floor(Number(amt / unit)) / 1e7);
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`UPDATE transfers SET status='sent', txid=? WHERE id=?`, res.hash, tid);
          const cur = this.sql.exec('SELECT pending, sent FROM st_out WHERE user_id=? AND market=?', u.id, m.id).one();
          const left = B(cur.pending) - amt;
          this.sql.exec(`UPDATE st_out SET pending=?, sent=?, tries=0, note='', updated=? WHERE user_id=? AND market=?`,
            (left > 0n ? left : 0n).toString(), (B(cur.sent) + amt).toString(), now(), u.id, m.id);
        });
        out.push({ user: u.username, market: m.id, amount: amt.toString(), tx: res.hash });
      } catch (e) {
        this.ctx.storage.transactionSync(() => {
          if (this.sql.exec('SELECT status FROM transfers WHERE id=?', tid).one().status !== 'pending') return;
          this.settle(u.id, this.market(m.id));
          this.addBal(u.id, 't:' + m.id, amt);
          this.resetDebt(u.id, this.market(m.id));
          this.sql.exec(`UPDATE transfers SET status='failed', note=? WHERE id=?`, 'not sent: ' + String(e.message).slice(0, 150), tid);
          this.sql.exec('UPDATE st_out SET tries=tries+1, next_try=?, note=? WHERE user_id=? AND market=?', now() + (r.tries + 1) * 2 * 60e3, String(e.message).slice(0, 150), u.id, m.id);
        });
      }
    }
    // every few minutes: authorize trustlines holders opened themselves, so they can pass tokens to each other
    if (now() - Number(this.meta('st_authz_last') || 0) > 5 * 60e3) {
      this.setMeta('st_authz_last', String(now()));
      for (const m of this.sql.exec(`SELECT * FROM markets WHERE network='stellar' AND migrated=0 AND st_issuer IS NOT NULL AND st_issuer!=''`).toArray()) {
        if (this.meta('st_auth_' + m.id) !== '1') continue;
        try { const n = await st.authorizeTrustlines(m.st_code, await this.stIssuer(m.id)); if (n) out.push({ market: m.id, authorized: n }); } catch { /* next round */ }
      }
    }
    return { sent: out.length, out };
  }
  // tokens arriving at the hot wallet: a sell from a holder's wallet (memo s<intent>), or a plain return
  async stTokenInflow(it) {
    if (it.from === it.issuer) return null;      // mint from the issuer (initial supply): not a holder deposit
    const st = await this.stellar();
    const m = this.sql.exec('SELECT * FROM markets WHERE st_code=? AND st_issuer=?', it.code, it.issuer).toArray()[0];
    const amt = xlm2wei(it.amount);
    if (!m) {
      this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,txid,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        0, 'deposit', 'stellar', amt.toString(), it.id, it.from || '', 'unassigned', `unknown asset ${it.code}:${String(it.issuer).slice(0, 8)} tx ${it.hash}`, now(), 'other');
      return null;
    }
    const memoStr = String(it.memo || '').trim();
    const sm = memoStr.match(/^s(\d{1,9})$/);
    const intent = sm ? this.sql.exec(`SELECT * FROM st_intents WHERE id=? AND side='sell' AND status='open'`, Number(sm[1])).toArray()[0] : null;
    let u = intent ? this.sql.exec('SELECT * FROM users WHERE id=?', intent.user_id).toArray()[0] : null;
    if (!u && it.from) u = this.sql.exec('SELECT * FROM users WHERE stellar_wallet=?', it.from).toArray()[0] || null;
    if (!u && it.from) { const k = this.sql.exec('SELECT user_id FROM st_addr_users WHERE addr=?', it.from).toArray()[0]; if (k) u = this.sql.exec('SELECT * FROM users WHERE id=?', k.user_id).toArray()[0]; }
    this.ctx.storage.transactionSync(() => {
      if (u) {
        this.settle(u.id, m);
        this.addBal(u.id, 't:' + m.id, amt);
        this.resetDebt(u.id, this.market(m.id));
      }
      this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,txid,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        u ? u.id : 0, 'deposit', 'stellar', amt.toString(), it.id, it.from || '', u ? 'confirmed' : 'unassigned', `tokens from wallet tx ${it.hash}`, now(), 't:' + m.id);
      // a plain return stays in custody: mark it so the auto-send never bounces it back out
      if (u && !intent) this.sql.exec(`INSERT OR IGNORE INTO st_out (user_id,market,pending,note,updated) VALUES (?,?,?,?,?)`, u.id, m.id, '0', 'returned to custody by the holder', now());
      if (intent) this.sql.exec(`UPDATE st_intents SET status='paid', txid=? WHERE id=?`, it.id, intent.id);
    });
    if (!u || !intent || m.migrated) return { user: u?.id, credited: amt.toString() };
    // sell on the curve, then send the XLM straight back to the wallet the tokens came from
    try {
      const r = this.trade(u, { market: m.id, side: 'sell', amount: amt.toString() });
      let xlmOut = B(r.zro);
      const fb = BigInt(Number(intent.fee_bps || 0));
      if (fb > 0n && fb <= 500n) { const f = (xlmOut * fb) / 10000n; this.snbChargeFee(u.id, 'xlm', f); xlmOut -= f; this.snbAfterChain(u, m.id, 'sell', r, xlmOut, f); }
      this.sql.exec(`UPDATE st_intents SET status='done' WHERE id=?`, intent.id);
      const to = intent.address || it.from;
      let tid;
      this.ctx.storage.transactionSync(() => {
        this.addBal(u.id, 'xlm', -xlmOut);
        tid = this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
          u.id, 'withdrawal', 'stellar', xlmOut.toString(), to, 'pending', 'proceeds of a sell from your wallet', now(), 'xlm').one().id;
      });
      try {
        const res = await st.payXlm(to, wei2xlm(xlmOut));
        this.sql.exec(`UPDATE transfers SET status='sent', txid=? WHERE id=?`, res.hash, tid);
      } catch (e) {
        this.ctx.storage.transactionSync(() => {
          this.addBal(u.id, 'xlm', xlmOut);
          this.sql.exec(`UPDATE transfers SET status='failed', note=? WHERE id=?`, 'kept on your Rookery balance: ' + String(e.message).slice(0, 120), tid);
        });
      }
      return { user: u.id, sold: amt.toString(), xlm: xlmOut.toString() };
    } catch (e) {
      this.sql.exec(`UPDATE st_intents SET status='paid', txid=? WHERE id=?`, String(e.message).slice(0, 60), intent.id);
      return { user: u.id, credited: amt.toString(), sellError: String(e.message) };
    }
  }
  // graduated tokens leave custody on their own: every holder with a linked Stellar wallet and a trustline gets them;
  // holders without a trustline are retried until they add one (30 days), the rest keep them on Rookery to withdraw by hand
  async stellarDrops(force = false) {
    if (this.meta('st_drops_off') === '1') return { off: true };
    const grads = this.sql.exec(`SELECT id FROM markets WHERE network='stellar' AND migrated=1 AND st_issuer IS NOT NULL AND st_issuer!=''`).toArray();
    if (!grads.length) return { sent: 0 };
    for (const g of grads) {
      this.sql.exec(`INSERT OR IGNORE INTO st_drops (market,user_id,address,status,created,updated)
        SELECT ?, b.user_id, u.stellar_wallet, 'queued', ?, ? FROM balances b JOIN users u ON u.id=b.user_id
        WHERE b.asset=? AND b.amount!='0' AND u.stellar_wallet IS NOT NULL AND u.stellar_wallet!=''`, g.id, now(), now(), 't:' + g.id);
    }
    this.sql.exec(`UPDATE st_drops SET status='expired', note='no trustline after 30 days: tokens stay on Rookery', updated=?
      WHERE status='no_trustline' AND created<?`, now(), now() - 30 * 86400e3);
    const rows = this.sql.exec(`SELECT * FROM st_drops WHERE status IN ('queued','no_trustline','retry') AND (next_try<=? OR ?=1)
      ORDER BY id LIMIT 15`, now(), force ? 1 : 0).toArray();
    const H = ST_NETS[this.stNet()].horizon;
    const out = [];
    const upd = (id, f) => this.sql.exec(`UPDATE st_drops SET status=?, note=?, next_try=?, tries=?, amount=COALESCE(?,amount), txid=COALESCE(?,txid), updated=? WHERE id=?`,
      f.status, f.note || '', f.next || 0, f.tries ?? 0, f.amount ?? null, f.txid ?? null, now(), id);
    for (const r of rows) {
      const m = this.market(r.market);
      const u = this.sql.exec('SELECT * FROM users WHERE id=?', r.user_id).toArray()[0];
      const unit = 100_000_000_000n;                                  // Stellar keeps 7 decimals
      const sendable = (this.bal(r.user_id, 't:' + r.market) / unit) * unit;
      if (!u || sendable <= 0n) { upd(r.id, { status: 'done', note: 'nothing left to send', tries: r.tries }); continue; }
      const addr = u.stellar_wallet || r.address;
      let acct;
      try {
        const res = await fetch(`${H}/accounts/${addr}`, { signal: AbortSignal.timeout(8000) });
        acct = res.status === 404 ? 'missing' : res.ok ? await res.json() : null;
      } catch { acct = null; }
      if (!acct) { upd(r.id, { status: r.status, note: 'Horizon unavailable, retrying', next: now() + 60e3, tries: r.tries }); continue; }
      if (acct === 'missing') { upd(r.id, { status: 'no_trustline', note: 'wallet not activated on Stellar yet', next: now() + 30 * 60e3, tries: r.tries }); continue; }
      const has = (acct.balances || []).some(b => b.asset_code === m.st_code && b.asset_issuer === m.st_issuer);
      if (!has) { upd(r.id, { status: 'no_trustline', note: `add a trustline for ${m.st_code} to receive the tokens`, next: now() + 10 * 60e3, tries: r.tries }); continue; }
      try {
        const w = await this.withdrawStellar(u, { to: addr, amount: sendable.toString(), asset: 't:' + m.id });
        upd(r.id, { status: 'sent', note: 'sent automatically after graduation', tries: r.tries, amount: sendable.toString(), txid: w.txid });
        out.push({ market: m.id, user: u.username, amount: sendable.toString(), tx: w.txid });
      } catch (e) {
        const tries = r.tries + 1;
        upd(r.id, { status: tries >= 8 ? 'failed' : 'retry', note: String(e?.message || e).slice(0, 160), next: now() + tries * 5 * 60e3, tries });
      }
    }
    return { sent: out.length, out };
  }
  async stellarCron() {
    // a Stellar token that failed to mint at creation gets another try on the next tick
    const issued = [], _cand = this.sql.exec(`SELECT id, st_issued, created FROM markets WHERE network='stellar' AND (st_issuer IS NULL OR st_issuer='') ORDER BY created LIMIT 5`).toArray();
    for (const r of _cand) {
      try { await this.stIssue(r.id); issued.push(r.id); } catch (e) { issued.push({ id: r.id, error: String(e?.message || e).slice(0, 120) }); }
    }
    // bonded markets that already reached their target (no trade needed to notice it)
    const queued = [];
    for (const m of this.sql.exec(`SELECT id FROM markets WHERE network='stellar' AND graduated=1 AND migrated=0`).toArray()) {
      try { if (this.stMaybeGraduate(m.id)) queued.push(m.id); } catch { /* next tick */ }
    }
    const [scan, jobs] = await Promise.all([this.stellarScan().catch(e => ({ error: String(e?.message || e) })), this.stellarJobs().catch(e => [{ error: String(e?.message || e) }])]);
    const sendNow = await this.stellarSendNow().catch(e => ({ error: String(e?.message || e) }));
    const drops = await this.stellarDrops().catch(e => ({ error: String(e?.message || e) }));
    return { scan, jobs, issued, queued, sendNow, drops, _cand: _cand.length };
  }
  async withdrawStellar(user, { to, amount, asset, memo }) {
    if (this.meta('withdrawals_paused') === '1') throw new Error('Withdrawals are paused for maintenance');
    to = String(to || '').trim();
    if (!/^G[A-Z2-7]{55}$/.test(to)) throw new Error('Enter a Stellar address (starts with G)');
    memo = String(memo || '').trim();
    if (memo && !/^\d{1,19}$/.test(memo) && memo.length > 28) throw new Error('Memo: a number or up to 28 characters');
    const st = await this.stellar();
    if (to === st.hotAddress) throw new Error('That is the Rookery deposit address');
    const amt = B(amount);
    if (amt <= 0n) throw new Error('Enter an amount');
    const isTok = String(asset || 'xlm').startsWith('t:');
    let m = null;
    if (isTok) {
      m = this.market(String(asset).slice(2));
      // tokens leave custody only after the Aquarius pool exists: before that nobody outside can seed a pool at a wrong price
      if (m.network !== 'stellar' || !m.st_issuer || !m.migrated) throw new Error('This token can be withdrawn to a Stellar wallet after it graduates to Aquarius');
    }
    const key = isTok ? 't:' + m.id : 'xlm';
    const fee = isTok ? 0n : WEI / 20n;                         // 0.05 XLM network fee on XLM withdrawals
    if (!isTok && amt <= fee + WEI / 10n) throw new Error('Minimum XLM withdrawal is 0.2 XLM');
    let tid;
    this.ctx.storage.transactionSync(() => {
      this.addBal(user.id, key, -amt);
      tid = this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        user.id, 'withdrawal', 'stellar', amt.toString(), to, 'pending', memo ? 'memo ' + memo : '', now(), key).one().id;
    });
    try {
      const sendAmt = isTok ? Math.floor(Number(amt / 100_000_000_000n)) / 1e7 : wei2xlm(amt - fee);
      const r = isTok ? await st.payAsset(to, m.st_code, m.st_issuer, sendAmt, memo) : await st.payXlm(to, sendAmt, memo);
      this.sql.exec(`UPDATE transfers SET status='sent', txid=? WHERE id=?`, r.hash, tid);
      if (fee > 0n) this.setMeta('fee_revenue_xlm', (B(this.meta('fee_revenue_xlm')) + fee).toString());
      return { ok: true, txid: r.hash, explorer: `${ST_NETS[this.stNet()].explorer}/tx/${r.hash}`, sent: String(sendAmt) };
    } catch (e) {
      this.ctx.storage.transactionSync(() => {
        if (this.sql.exec('SELECT status FROM transfers WHERE id=?', tid).one().status !== 'pending') return;
        this.addBal(user.id, key, amt);
        this.sql.exec(`UPDATE transfers SET status='failed', note=? WHERE id=?`, String(e.message).slice(0, 200), tid);
      });
      throw new Error(/trustline|activated|not exist/.test(e.message) ? e.message : 'Stellar payment failed, your balance was refunded: ' + String(e.message).slice(0, 120));
    }
  }
  burnWallet() { return this.master().deriveChild(BURN_INDEX); }
  depositAddressFor(index) { return this.master().deriveChild(index).address; }

  /* ───────────── $臭企鹅 buy & burn ───────────── */
  burnState() {
    const g = (k) => this.meta(k);
    return {
      token: g('burn_token'), source: g('burn_source'), auto: g('burn_auto') === '1',
      minZro: Number(g('burn_min_zro')), maxZro: Number(g('burn_max_zro')), intervalH: Number(g('burn_interval_h')),
      slippageBps: Number(g('burn_slippage_bps')), last: Number(g('burn_last')), pending: B(g('plaunch_burn')),
    };
  }
  // move the pending reserve into a new job (the reserve counter goes down by exactly that amount)
  createBurnJob(force = false) {
    const st = this.burnState();
    if (!st.token) throw new Error('Set the $臭企鹅 token address on Robinhood Chain first');
    if (this.sql.exec(`SELECT 1 FROM burn_jobs WHERE status NOT IN ('burned','failed')`).toArray().length) throw new Error('A burn is already in progress');
    let amt = st.pending;
    const max = BigInt(Math.round(st.maxZro)) * WEI;
    if (amt > max) amt = max;
    if (!force && amt < BigInt(Math.round(st.minZro)) * WEI) throw new Error('Reserve below the minimum for a burn');
    if (amt <= 0n) throw new Error('Reserve is empty');
    let id;
    this.ctx.storage.transactionSync(() => {
      this.setMeta('plaunch_burn', (st.pending - amt).toString());
      this.setMeta('burn_last', now());
      this.sql.exec(`INSERT INTO burn_jobs (status,zro,source,created,updated) VALUES ('queued',?,?,?,?)`, amt.toString(), st.source, now(), now());
      id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
    });
    return id;
  }
  jobSet(id, fields) {
    const keys = Object.keys(fields);
    this.sql.exec(`UPDATE burn_jobs SET ${keys.map(k => `${k}=?`).join(',')}, updated=? WHERE id=?`, ...keys.map(k => String(fields[k])), now(), id);
  }
  async burnTick() {
    // single-flight lock: a step awaits chain receipts, so two cron ticks must never run it at the same time
    const lock = Number(this.meta('burn_lock') || 0);
    if (now() - lock < 5 * 60e3) return null;
    this.setMeta('burn_lock', now());
    try { return await this.burnTickInner(); } finally { this.setMeta('burn_lock', 0); }
  }
  async burnTickInner() {
    const st = this.burnState();
    // auto-start
    if (st.auto && st.token && now() - st.last > st.intervalH * 3600e3) {
      try { this.createBurnJob(false); } catch { /* below minimum or already running */ }
    }
    const job = this.sql.exec(`SELECT * FROM burn_jobs WHERE status NOT IN ('burned','failed') ORDER BY id LIMIT 1`).toArray()[0];
    if (!job) return null;
    try {
      await this.burnStep(job, st);
    } catch (e) {
      const attempts = job.attempts + 1;
      const msg = String(e.shortMessage || e.message || e).slice(0, 220);
      if (attempts >= 15) {
        // give the ZRO back to the reserve if it never left the hot wallet
        if (job.status === 'queued') this.setMeta('plaunch_burn', (B(this.meta('plaunch_burn')) + B(job.zro)).toString());
        this.jobSet(job.id, { status: 'failed', attempts, note: msg });
      } else this.jobSet(job.id, { attempts, note: msg });
    }
    return job.id;
  }
  async burnStep(job, st) {
    const src = CHAINS[job.source];
    const srcProv = await this.provider(job.source);
    const burn = new Wallet(this.burnWallet().privateKey, srcProv);
    const amt = B(job.zro);

    if (job.status === 'queued') {
      const hot = new Wallet(this.hotWallet().privateKey, srcProv);
      // gas for the burn wallet on the source chain (approve + Relay deposit)
      if ((await srcProv.getBalance(burn.address)) < 300000000000000n) {
        const g = await hot.sendTransaction({ to: burn.address, value: 600000000000000n });
        await g.wait(1);
      }
      const zro = new Contract(ZRO_TOKEN, ERC20_ABI, hot);
      if ((await zro.balanceOf(hot.address)) < amt) throw new Error(`Hot wallet needs ${Number(amt) / 1e18} ZRO on ${src.label}`);
      const tx = await zro.transfer(burn.address, amt);
      await tx.wait(1);
      this.jobSet(job.id, { status: 'transferred', tx_transfer: tx.hash, note: '' });
      return;
    }

    if (job.status === 'transferred') {
      const q = await (await fetch(`${RELAY_API}/quote`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user: burn.address, recipient: burn.address, originChainId: src.chainId, destinationChainId: ROBINHOOD.chainId,
          originCurrency: ZRO_TOKEN, destinationCurrency: '0x0000000000000000000000000000000000000000',
          amount: amt.toString(), tradeType: 'EXACT_INPUT',
        }),
      })).json();
      if (!q.steps) throw new Error('Relay quote failed: ' + (q.message || 'no route'));
      let depositHash = '', requestId = '';
      for (const step of q.steps) {
        for (const it of step.items) {
          const d = it.data;
          if (Number(d.chainId) !== src.chainId) throw new Error('Unexpected Relay step chain');
          if (getAddress(d.from) !== burn.address) throw new Error('Unexpected Relay sender');
          const tx = await burn.sendTransaction({ to: d.to, data: d.data, value: B(d.value || 0) });
          await tx.wait(1);
          if (step.id === 'deposit') { depositHash = tx.hash; requestId = step.requestId || ''; }
        }
      }
      this.jobSet(job.id, { status: 'bridging', tx_bridge: depositHash, relay_id: requestId, note: '' });
      return;
    }

    const rhProv = new JsonRpcProvider(ROBINHOOD.rpc, ROBINHOOD.chainId, { staticNetwork: true });
    const rhBurn = new Wallet(this.burnWallet().privateKey, rhProv);

    if (job.status === 'bridging') {
      const s = await (await fetch(`${RELAY_API}/intents/status/v2?requestId=${job.relay_id}`)).json();
      if (s.status === 'success') {
        this.jobSet(job.id, { status: 'bridged', eth_in: (await rhProv.getBalance(rhBurn.address)).toString(), note: '' });
      } else if (['failure', 'refund'].includes(s.status)) {
        // ZRO went back to the burn wallet on the source chain: try the bridge again on the next tick
        this.jobSet(job.id, { status: 'transferred', note: 'Relay ' + s.status + ', retrying bridge' });
      } else this.jobSet(job.id, { note: 'Waiting for Relay: ' + (s.status || 'pending') });
      return;
    }

    if (job.status === 'bridged') {
      const token = getAddress(st.token);
      const factory = new Contract(ROBINHOOD.factory, ['function getPool(address,address,uint24) view returns (address)'], rhProv);
      let best = null;
      for (const fee of [10000, 3000, 500, 100]) {
        const pool = await factory.getPool(ROBINHOOD.weth, token, fee);
        if (pool === '0x0000000000000000000000000000000000000000') continue;
        const liq = await new Contract(pool, ['function liquidity() view returns (uint128)'], rhProv).liquidity();
        if (!best || liq > best.liq) best = { fee, liq };
      }
      if (!best || best.liq === 0n) throw new Error('No $臭企鹅/WETH pool with liquidity on Robinhood Chain yet');
      const bal = await rhProv.getBalance(rhBurn.address);
      const keep = 300000000000000n; // ETH kept for gas
      if (bal <= keep) throw new Error('Waiting for ETH on Robinhood Chain');
      const amountIn = bal - keep;
      const quoter = new Contract(ROBINHOOD.quoter, ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'], rhProv);
      const [quoted] = await quoter.quoteExactInputSingle.staticCall({ tokenIn: ROBINHOOD.weth, tokenOut: token, amountIn, fee: best.fee, sqrtPriceLimitX96: 0 });
      const minOut = (quoted * BigInt(10000 - st.slippageBps)) / 10000n;
      const router = new Contract(ROBINHOOD.router, ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)'], rhBurn);
      const tx = await router.exactInputSingle({ tokenIn: ROBINHOOD.weth, tokenOut: token, fee: best.fee, recipient: DEAD, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 }, { value: amountIn });
      const rc = await tx.wait(1);
      // exact amount sent to the dead address, read from the Transfer log
      const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      let burned = 0n;
      for (const l of rc.logs) {
        if (getAddress(l.address) === token && l.topics[0] === topic && ('0x' + l.topics[2].slice(26)).toLowerCase() === DEAD.toLowerCase()) burned += B(l.data);
      }
      this.jobSet(job.id, { status: 'burned', tx_burn: tx.hash, tokens_burned: (burned || quoted).toString(), eth_in: amountIn.toString(), note: '' });
      const total = B(this.meta('burn_total_tokens') || 0) + (burned || quoted);
      this.setMeta('burn_total_tokens', total.toString());
    }
  }

  /* ───────────── ZRO price ───────────── */
  async refreshPrice(force = false) {
    const ts = Number(this.meta('zro_ts') || 0);
    if (!force && now() - ts < 60_000) return;
    const sources = [
      async () => { const j = await (await fetch('https://www.okx.com/api/v5/market/ticker?instId=ZRO-USDT')).json();
        const t = j.data[0]; return [Number(t.last), (Number(t.last) / Number(t.open24h) - 1) * 100]; },
      async () => { const j = await (await fetch('https://api.bybit.com/v5/market/tickers?category=spot&symbol=ZROUSDT')).json();
        const t = j.result.list[0]; return [Number(t.lastPrice), Number(t.price24hPcnt) * 100]; },
      async () => { const j = await (await fetch('https://api.kucoin.com/api/v1/market/stats?symbol=ZRO-USDT')).json();
        return [Number(j.data.last), Number(j.data.changeRate) * 100]; },
      async () => { const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=layerzero&vs_currencies=usd&include_24hr_change=true')).json();
        return [Number(j.layerzero.usd), Number(j.layerzero.usd_24h_change)]; },
    ];
    for (const src of sources) {
      try {
        const [p, ch] = await src();
        if (p > 0 && isFinite(p)) {
          this.setMeta('zro_usd', p); this.setMeta('zro_chg', isFinite(ch) ? ch : 0); this.setMeta('zro_ts', now());
          await this.refreshNative();
          await this.refreshSecondary();
          return;
        }
      } catch { /* try next source */ }
    }
  }
  zroUsd() { return Number(this.meta('zro_usd') || 1.5); }
  ethUsd() { return Number(this.meta('eth_usd') || 3000); }
  xlmUsd() { return Number(this.meta('xlm_usd') || 0.14); }
  // LTC and its LitVM form zkLTC trade 1:1 on the Litecoin side, so one price drives both
  ltcUsd() { return Number(this.meta('ltc_usd') || 120); }
  zltcUsd() { return this.ltcUsd(); }
  usdOf(a) { return a === 'eth' ? this.ethUsd() : a === 'xlm' ? this.xlmUsd() : a === 'ltc' || a === 'zltc' ? this.ltcUsd() : this.zroUsd(); }
  async refreshSecondary() {
    const set = (k, v) => { if (v > 0 && isFinite(v)) { this.setMeta(k, v); this.setMeta(k + '_ts', now()); return true; } return false; };
    const first = async (k, fns) => { for (const f of fns) { try { if (set(k, await f())) { this.setMeta(k + '_src', f.name || ''); return; } } catch {} } };
    const get = async (u) => (await fetch(u, { signal: AbortSignal.timeout(6000), headers: { 'user-agent': 'rookery/1.0' } })).json();
    await Promise.all([
      // ETH, primary: OKX
      first('eth_usd', [async function okx() { return Number((await get('https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT')).data[0].last); }]),
      // ETH, independent second source
      first('eth_usd_b', [
        async function coinbase() { return Number((await get('https://api.coinbase.com/v2/prices/ETH-USD/spot')).data.amount); },
        async function kraken() { const j = await get('https://api.kraken.com/0/public/Ticker?pair=ETHUSD'); return Number(Object.values(j.result)[0].c[0]); },
        async function kucoin() { return Number((await get('https://api.kucoin.com/api/v1/market/stats?symbol=ETH-USDT')).data.last); },
      ]),
      // XLM (Stellar markets)
      first('xlm_usd', [
        async function okx() { return Number((await get('https://www.okx.com/api/v5/market/ticker?instId=XLM-USDT')).data[0].last); },
        async function coinbase() { return Number((await get('https://api.coinbase.com/v2/prices/XLM-USD/spot')).data.amount); },
        async function kraken() { const j = await get('https://api.kraken.com/0/public/Ticker?pair=XLMUSD'); return Number(Object.values(j.result)[0].c[0]); },
      ]),
      // LTC (LitVM pairs are quoted in zkLTC, which is LTC 1:1)
      first('ltc_usd', [async function okx() { return Number((await get('https://www.okx.com/api/v5/market/ticker?instId=LTC-USDT')).data[0].last); }]),
      first('ltc_usd_b', [
        async function coinbase() { return Number((await get('https://api.coinbase.com/v2/prices/LTC-USD/spot')).data.amount); },
        async function kraken() { const j = await get('https://api.kraken.com/0/public/Ticker?pair=LTCUSD'); return Number(Object.values(j.result)[0].c[0]); },
      ]),
      // ZRO, independent second source (primary comes from refreshPrice, usually OKX)
      first('zro_usd_b', [
        async function kucoin() { return Number((await get('https://api.kucoin.com/api/v1/market/stats?symbol=ZRO-USDT')).data.last); },
        async function gate() { return Number((await get('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=ZRO_USDT'))[0].last); },
        async function bybit() { return Number((await get('https://api.bybit.com/v5/market/tickers?category=spot&symbol=ZROUSDT')).result.list[0].lastPrice); },
        async function coingecko() { return Number((await get('https://api.coingecko.com/api/v3/simple/price?ids=layerzero&vs_currencies=usd')).layerzero.usd); },
      ]),
    ]);
  }
  // prices for instant conversions: two independent sources per asset, fresh, and agreeing within 2%
  swapPx() {
    const t = now(), out = {};
    for (const [a, k] of [['eth', 'eth_usd'], ['zro', 'zro_usd'], ['ltc', 'ltc_usd']]) {
      const p1 = Number(this.meta(k)), p2 = Number(this.meta(k + '_b'));
      const t1 = a === 'zro' ? Number(this.meta('zro_ts')) : Number(this.meta(k + '_ts'));
      const t2 = Number(this.meta(k + '_b_ts'));
      if (!(p1 > 0 && p2 > 0) || t - t1 > 180_000 || t - t2 > 180_000) throw new Error('Live prices are updating, try again in a few seconds');
      if (Math.abs(p1 - p2) / Math.min(p1, p2) > 0.02) throw new Error('Price sources disagree right now, instant conversion is paused for a moment');
      out[a] = (p1 + p2) / 2;
    }
    out.zltc = out.ltc;                 // zkLTC is LTC 1:1 on the LitVM side
    return out;
  }
  // instant ETH<->ZRO conversion inside the ledger (runs inside the caller's transaction)
  swap(user, from, to, amt) {
    if (from === to) return amt;
    const px = this.swapPx();
    const pf = BigInt(Math.round(px[from] * 1e8)), pt = BigInt(Math.round(px[to] * 1e8));
    let out = (amt * pf) / pt;
    out -= (out * SWAP_FEE_BPS) / 10000n;
    if (out <= 0n) throw new Error('Amount too small');
    // the platform now holds `from` and owes `to`: keep that exposure under a cap
    const dk = (a) => 'desk_' + a;
    const nf = B(this.meta(dk(from))) + amt, nt = B(this.meta(dk(to))) - out;
    const deskEth = from === 'eth' ? nf : nt;
    const capUsd = Number(this.meta('desk_cap_usd') || 3000);
    const before = Math.abs(Number(B(this.meta('desk_eth'))) / 1e18) * px.eth, after = Math.abs(Number(deskEth) / 1e18) * px.eth;
    if (after > capUsd && after > before) throw new Error('Instant conversion is at its limit right now. Pay with the token\'s own currency or try a smaller amount.');
    this.addBal(user.id, from, -amt);
    this.addBal(user.id, to, out);
    this.setMeta(dk(from), nf.toString()); this.setMeta(dk(to), nt.toString());
    this.setMeta('swap_volume_usd', String(Number(this.meta('swap_volume_usd') || 0) + (Number(amt) / 1e18) * px[from]));
    return out;
  }
  async refreshNative() {
    for (const [sym, inst] of [['eth', 'ETH-USDT'], ['bnb', 'BNB-USDT']]) {
      try {
        const j = await (await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${inst}`)).json();
        const v = Number(j.data[0].last);
        if (v > 0) this.setMeta(sym + '_usd', v);
      } catch { /* keep last */ }
    }
  }
  nativeUsd(chain) { return Number(this.meta(NATIVE[chain] + '_usd') || (NATIVE[chain] === 'bnb' ? 600 : 3000)); }

  /* ───────────── withdrawal fee (ZRO, from live gas) ───────────── */
  async gasPrice(chain) {
    this._gp = this._gp || {};
    const c = this._gp[chain];
    if (c && now() - c.ts < 60_000) return c.v;
    let v = BigInt(await rpc(chain, 'eth_gasPrice', [])) * 5n / 4n + 1n; // legacy gas price + 25% headroom
    v = v || 1_000_000_000n;
    this._gp[chain] = { v, ts: now() };
    return v;
  }
  // every public endpoint of the chain behind one provider: a 403/429 on one RPC just fails over to the next,
  // and signed transactions are broadcast to all of them
  async provider(chain) {
    this._prov = this._prov || {};
    if (this._prov[chain]) return this._prov[chain];
    const C = CHAINS[chain], net = Network.from(C.chainId);
    const cfgs = (C.rpcs || [C.rpc]).map((u, i) => {
      const fr = new FetchRequest(u); fr.timeout = 12_000; fr.setThrottleParams({ maxAttempts: 1 });
      return { provider: new JsonRpcProvider(fr, net, { staticNetwork: net, batchMaxCount: 1 }), priority: i + 1, stallTimeout: 2500, weight: 1 };
    });
    return (this._prov[chain] = new FallbackProvider(cfgs, net, { quorum: 1 }));
  }
  // what each network can pay out right now: largest single source (hot wallet or one deposit address) and gas availability
  async netStatus() {
    if (this._ns && now() - this._ns.ts < 60_000) return this._ns.v;
    const hot = this.hotWallet().address, v = {};
    await Promise.all(ZRO_CHAINS.map(async (c) => {
      try {
        const gp = await this.gasPrice(c);
        const nat = BigInt(await rpc(c, 'eth_getBalance', [hot, 'latest']));
        const hotZro = await this.zroBalanceOf(c, hot);
        const pend = new Map(this.sql.exec('SELECT src_user, SUM(CAST(amount AS REAL)) a FROM out_pending WHERE chain=? GROUP BY src_user', c).toArray().map(r => [r.src_user, r.a]));
        let best = hotZro;
        for (const r of this.sql.exec('SELECT user_id, last FROM deposit_seen WHERE chain=?', c).toArray()) {
          const avail = B(r.last) - BigInt(Math.ceil(pend.get(r.user_id) || 0));
          if (avail > best) best = avail;
        }
        const gasOk = hotZro > 0n ? nat >= WD_GAS * gp : nat >= (WD_GAS * 2n + TOPUP_GAS) * gp;
        v[c] = { gasOk, maxOut: Number(best) / 1e18, ok: gasOk && best > 0n };
      } catch { v[c] = { gasOk: false, maxOut: 0, ok: false }; }
    }));
    this._ns = { v, ts: now() };
    return v;
  }
  // where the ZRO actually sits: hot wallet + every deposit address, per chain (cached 2 min)
  async treasury(hot, force = false) {
    if (!force && this._tr && now() - this._tr.ts < 120_000) return this._tr.v;
    try {
      const snap = JSON.parse(this.meta('treasury_snap') || 'null');
      if (!force && snap && now() - snap.ts < 120_000) { this._tr = { v: snap.v, ts: now() }; return snap.v; } // refreshed by the cron
    } catch { /* fall through and recompute */ }
    const users = this.sql.exec('SELECT dep_address FROM users WHERE dep_address IS NOT NULL').toArray().map(r => r.dep_address);
    const chains = {}, tot = { held: 0, hot: 0, dep: 0 };
    await Promise.all(ZRO_CHAINS.map(async (chain) => {
      const C = CHAINS[chain];
      try {
        const hotZro = await this.zroBalanceOf(chain, hot);
        let depZro = 0n;
        if (users.length) { const b = await this.balancesAt(chain, users, 'latest'); depZro = b.reduce((a, x) => a + x, 0n); }
        const gasOk = BigInt(await rpc(chain, 'eth_getBalance', [hot, 'latest'])) > 0n;
        chains[chain] = { label: C.label, explorer: C.explorer, hotZro: Number(hotZro) / 1e18, depZro: Number(depZro) / 1e18,
          total: Number(hotZro + depZro) / 1e18, addresses: users.length, gasOk };
        tot.held += Number(hotZro + depZro) / 1e18; tot.hot += Number(hotZro) / 1e18; tot.dep += Number(depZro) / 1e18;
      } catch (e) { chains[chain] = { label: C.label, explorer: C.explorer, error: String(e.message || e).slice(0, 80) }; }
    }));
    const ethUsers = this.sql.exec('SELECT eth_dep_address FROM users WHERE eth_dep_address IS NOT NULL').toArray().map(r => r.eth_dep_address);
    const eth = { chains: {}, held: 0 };
    await Promise.all(ETH_CHAINS.map(async (chain) => {
      try {
        const hotEth = BigInt(await rpc(chain, 'eth_getBalance', [hot, 'latest']));
        let dep = 0n;
        if (ethUsers.length) dep = (await this.ethBalancesAt(chain, ethUsers, 'latest')).reduce((a, x) => a + x, 0n);
        eth.chains[chain] = { label: CHAINS[chain].label, hotEth: Number(hotEth) / 1e18, depEth: Number(dep) / 1e18, total: Number(hotEth + dep) / 1e18 };
        eth.held += Number(hotEth + dep) / 1e18;
      } catch (e) { eth.chains[chain] = { label: CHAINS[chain].label, error: String(e.message || e).slice(0, 80) }; }
    }));
    const v = { chains, totals: tot, eth, ts: now() };
    this._tr = { v, ts: now() };
    this.setMeta('treasury_snap', JSON.stringify(v));
    return v;
  }
  // what the platform itself earned: 0.5% of every trade + withdrawal network fees, minus what was already spent on burns
  platformRevenue(usd) {
    const jobs = this.sql.exec('SELECT * FROM burn_jobs').toArray();
    const pending = B(this.meta('plaunch_burn'));            // trading fees still in the reserve
    const moved = jobs.reduce((a, j) => a + B(j.zro), 0n);   // fees already moved into burn jobs
    const burned = jobs.filter(j => j.status === 'burned').reduce((a, j) => a + B(j.zro), 0n);
    const trading = pending + moved;
    const withdraw = B(this.meta('fee_revenue_zro'));
    const total = trading + withdraw;
    const z = (v) => Number(v) / 1e18;
    return {
      tradingZro: z(trading), tradingUsd: z(trading) * usd,
      withdrawalZro: z(withdraw), withdrawalUsd: z(withdraw) * usd,
      totalZro: z(total), totalUsd: z(total) * usd,
      burnedZro: z(burned), burnedUsd: z(burned) * usd,
      reserveZro: z(pending), reserveUsd: z(pending) * usd,
      inFlightZro: z(moved - burned), burnJobs: jobs.length,
      tradingEth: z(B(this.meta('plaunch_burn_eth'))), withdrawalEth: z(B(this.meta('fee_revenue_eth'))),
      ethTotalUsd: (z(B(this.meta('plaunch_burn_eth'))) + z(B(this.meta('fee_revenue_eth')))) * this.ethUsd(),
    };
  }
  async withdrawFee(chain) {
    const gp = await this.gasPrice(chain);
    const nativeCost = Number((WD_GAS + TOPUP_GAS) * gp) / 1e18;
    const usd = nativeCost * this.nativeUsd(chain) * FEE_MARGIN;
    const zro = Math.max(usd / this.zroUsd(), MIN_FEE_ZRO);
    const wei = BigInt(Math.ceil(zro * 100)) * (WEI / 100n); // round up to 0.01 ZRO
    return { wei, zro: Number(wei) / 1e18, usd: (Number(wei) / 1e18) * this.zroUsd() };
  }

  /* ───────────── auth ───────────── */
  async hashPass(pass, saltHex) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 20000 }, key, 256);
    return hex(bits);
  }
  session(req) {
    const c = req.headers.get('cookie') || '';
    const m = c.match(/(?:^|;\s*)pl_s=([a-f0-9]{64})/);
    if (!m) return null;
    const s = this.sql.exec('SELECT user_id, expires FROM sessions WHERE token=?', m[1]).toArray()[0];
    if (!s || s.expires < now()) return null;
    return this.sql.exec('SELECT * FROM users WHERE id=?', s.user_id).toArray()[0] || null;
  }
  newSession(userId) {
    const token = randHex(32);
    const exp = now() + 30 * 864e5;
    this.sql.exec('INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)', token, userId, exp);
    return `pl_s=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`;
  }

  /* ───────────── ledger helpers ───────────── */
  bal(uid, asset) {
    const r = this.sql.exec('SELECT amount FROM balances WHERE user_id=? AND asset=?', uid, asset).toArray()[0];
    return r ? B(r.amount) : 0n;
  }
  addBal(uid, asset, delta) {
    const v = this.bal(uid, asset) + delta;
    if (v < 0n) throw new Error(asset === 'zro' ? 'Insufficient ZRO balance' : asset === 'eth' ? 'Insufficient ETH balance' : asset === 'xlm' ? 'Insufficient XLM balance' : 'Insufficient token balance');
    this.sql.exec(`INSERT INTO balances (user_id,asset,amount) VALUES (?,?,?)
      ON CONFLICT(user_id,asset) DO UPDATE SET amount=excluded.amount`, uid, asset, v.toString());
    return v;
  }
  market(id) {
    const m = this.sql.exec('SELECT * FROM markets WHERE id=?', id).toArray()[0];
    if (!m) throw new Error('Token not found');
    return m;
  }

  // rewards in ZRO (accumulator pattern)
  settle(uid, m) {
    const tokBal = this.bal(uid, 't:' + m.id);
    const row = this.sql.exec('SELECT debt, earned FROM reward_debt WHERE user_id=? AND market=?', uid, m.id).toArray()[0];
    const debt = row ? B(row.debt) : 0n;
    const owed = (tokBal * B(m.acc_rew)) / ACC;
    const pending = owed > debt ? owed - debt : 0n;
    if (pending > 0n) {
      this.addBal(uid, qa(m), pending);
      this.sql.exec(`UPDATE markets SET rewards_paid=? WHERE id=?`, (B(m.rewards_paid) + pending).toString(), m.id);
    }
    const earned = (row ? B(row.earned) : 0n) + pending;
    this.sql.exec(`INSERT INTO reward_debt (user_id,market,debt,earned) VALUES (?,?,?,?)
      ON CONFLICT(user_id,market) DO UPDATE SET debt=excluded.debt, earned=excluded.earned`, uid, m.id, owed.toString(), earned.toString());
    return pending;
  }
  resetDebt(uid, m) {
    const fresh = this.market(m.id);
    const owed = (this.bal(uid, 't:' + m.id) * B(fresh.acc_rew)) / ACC;
    this.sql.exec(`UPDATE reward_debt SET debt=? WHERE user_id=? AND market=?`, owed.toString(), uid, m.id);
  }
  pendingRewards(uid, m) {
    const row = this.sql.exec('SELECT debt FROM reward_debt WHERE user_id=? AND market=?', uid, m.id).toArray()[0];
    const owed = (this.bal(uid, 't:' + m.id) * B(m.acc_rew)) / ACC;
    const debt = row ? B(row.debt) : 0n;
    return owed > debt ? owed - debt : 0n;
  }

  /* ───────────── bridge (thin layer, no custody, no own liquidity) ───────────── */
  xbCfg() {
    return { feeBps: Number(this.meta('xb_fee_bps') || 100), feeTo: this.meta('xb_fee_to') || '0x408c3d3fd36fdf84888f343417787d8710e76fe8', key: this.env.XB_KEY || '' };
  }
  xbOn() { return this.meta('xb_off') !== '1'; }
  xbView(o) {
    const Z = XB_NETS[o.to_net], A = XB_NETS[o.from_net];
    return { ref: o.ref, from: o.from_net, to: o.to_net, amountIn: o.amount_in, sym: A?.sym, toSym: Z?.sym, inUsd: o.in_usd, outEst: o.out_est, outUsd: o.out_usd,
      out: o.out_fmt, recipient: o.recipient, depositAddress: o.dep_addr, depositMemo: o.dep_memo, status: o.status, created: o.created, deadline: o.deadline,
      inTx: o.in_tx, outTx: o.out_tx, refundTx: o.refund_tx,
      inLink: o.in_tx && A ? A.tx + o.in_tx : '', outLink: o.out_tx && Z ? Z.tx + o.out_tx : '', refundLink: o.refund_tx && A ? A.tx + o.refund_tx : '' };
  }
  async xbRefresh(o, minGapMs = 5000) {
    if (XB_DONE.includes(o.status) || now() - (o.checked || 0) < minGapMs) return o;
    try {
      const r = await xbStatus(this.xbCfg(), o.dep_addr, o.dep_memo);
      this.sql.exec(`UPDATE xb_orders SET status=?, out_tx=CASE WHEN ?!='' THEN ? ELSE out_tx END, in_tx=CASE WHEN ?!='' THEN ? ELSE in_tx END,
        out_fmt=CASE WHEN ?!='' THEN ? ELSE out_fmt END, refund_tx=CASE WHEN ?!='' THEN ? ELSE refund_tx END, checked=? WHERE ref=?`,
        r.status, r.outTx, r.outTx, r.inTx, r.inTx, r.amountOutFmt, r.amountOutFmt, r.refundTx, r.refundTx, now(), o.ref);
    } catch { this.sql.exec('UPDATE xb_orders SET checked=? WHERE ref=?', now(), o.ref); }
    return this.sql.exec('SELECT * FROM xb_orders WHERE ref=?', o.ref).one();
  }
  async xbCron() {
    const rows = this.sql.exec(`SELECT * FROM xb_orders WHERE status NOT IN ('SUCCESS','REFUNDED','FAILED') AND created>? AND checked<? ORDER BY checked LIMIT 10`,
      now() - 48 * 3600e3, now() - 30e3).toArray();
    for (const o of rows) await this.xbRefresh(o, 0);
    return { checked: rows.length };
  }

  /* ───────────── one-signature wallet buys ───────────── */
  evmOrdersOn() { return this.meta('evm_orders') === '1'; }
  evmOrderExpire() {
    this.sql.exec(`UPDATE orders_evm SET status='expired' WHERE status='open' AND expires<?`, now());
  }
  evmOrderCreate(user, market, amountWei, pay) {
    if (!this.evmOrdersOn()) throw new Error('Wallet buys are not live yet');
    const m = this.market(String(market || ''));
    if (!m) throw new Error('Unknown token');
    if (m.network === 'stellar') throw new Error('Stellar tokens are bought with a Stellar wallet');
    if (m.migrated) throw new Error('This token already graduated');
    const asset = pay === 'eth' || pay === 'zro' ? pay : qa(m);
    if (asset === 'eth') this.ensureEthAddresses();
    const me = this.sql.exec('SELECT dep_address, eth_dep_address FROM users WHERE id=?', user.id).one();
    const to = asset === 'eth' ? me.eth_dep_address : me.dep_address;
    if (!to) throw new Error('No deposit address yet, try again in a minute');
    const amt = B(amountWei);
    if (amt < MIN_BUY[asset]) throw new Error(asset === 'eth' ? 'Minimum buy is 0.00005 ETH' : 'Minimum buy is 0.1 ZRO');
    this.evmOrderExpire();
    // a small unique tag on top of the amount tells two same-size payments apart without a contract
    const used = new Set(this.sql.exec(`SELECT tag FROM orders_evm WHERE user_id=? AND status='open'`, user.id).toArray().map(r => Number(r.tag)));
    let tag = Math.floor(Math.random() * 998) + 1;
    for (let i = 0; i < 999 && used.has(tag); i++) tag = (tag % 998) + 1;
    const tagged = amt + BigInt(tag);
    const id = this.sql.exec(`INSERT INTO orders_evm (user_id,market,asset,amount,tagged,tag,status,created,expires)
      VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`, user.id, m.id, asset, amt.toString(), tagged.toString(), tag, 'open', now(), now() + ORDER_TTL_MS).one().id;
    const q = this.view(m);
    const chains = (asset === 'eth' ? ETH_CHAINS : ZRO_CHAINS)
      .map(c => ({ key: c, label: CHAINS[c].label, chainId: CHAINS[c].chainId, explorer: CHAINS[c].explorer }));
    return { id, market: m.id, asset, amount: tagged.toString(), base: amt.toString(), tag,
      to, token: asset === 'zro' ? ZRO_TOKEN : null, chains, expires: now() + ORDER_TTL_MS,
      quote: { tokens: q.priceZro ? (Number(amt) / 1e18 / q.priceZro) : 0, priceUsd: q.priceUsd } };
  }
  // called right after a deposit is credited: does it settle an open order?
  // 1) the unique tag picks the order (also up to an hour after it expired: the tag proves intent);
  // 2) without a tag match the 2% tolerance applies only when exactly one order is open, so a payment
  //    can never land in an older, abandoned order for a different token.
  evmOrderFill(userId, asset, deltaWei) {
    if (!this.evmOrdersOn()) return null;
    this.evmOrderExpire();
    const d = B(deltaWei);
    let o = this.sql.exec(`SELECT * FROM orders_evm WHERE user_id=? AND asset=? AND tagged=? AND
      (status='open' OR (status='expired' AND expires>=?)) ORDER BY id DESC LIMIT 1`, userId, asset, d.toString(), now() - 3600e3).toArray()[0];
    let res = o ? { action: 'fill', amount: o.amount, exact: true } : null;
    if (!o) {
      const open = this.sql.exec(`SELECT * FROM orders_evm WHERE user_id=? AND asset=? AND status='open' AND expires>=?`, userId, asset, now()).toArray();
      if (open.length !== 1) return open.length ? { action: 'none', reason: 'ambiguous' } : null;
      o = open[0];
      res = matchOrder({ amount: o.amount, tagged: o.tagged }, deltaWei);
    }
    if (res.action === 'none') return { order: o.id, action: 'none' };
    if (res.action === 'cancel') {
      this.sql.exec(`UPDATE orders_evm SET status='cancelled', note=? WHERE id=?`, 'paid ' + res.shortfall + ' wei short, kept as balance', o.id);
      return { order: o.id, action: 'cancel' };
    }
    const u = this.sql.exec('SELECT * FROM users WHERE id=?', userId).toArray()[0];
    if (!u) return null;
    try {
      const r = this.trade(u, { market: o.market, side: 'buy', amount: res.amount, pay: o.asset });
      this.sql.exec(`UPDATE orders_evm SET status='filled', tokens=?, note=?, txid=? WHERE id=?`,
        String(r.tokens || ''), res.exact ? 'exact tag match' : 'within tolerance', String(r.txid || ''), o.id);
      return { order: o.id, action: 'fill', tokens: r.tokens };
    } catch (e) {
      this.sql.exec(`UPDATE orders_evm SET status='failed', note=? WHERE id=?`, String(e?.message || e).slice(0, 200), o.id);
      return { order: o.id, action: 'failed', error: String(e?.message || e) };
    }
  }

  /* ───────────── curve ───────────── */
  static reserves(m) {
    if (m.graduated) return { z: B(m.pool_zro), t: B(m.pool_tok) };
    return { z: vQuote(m) + B(m.reserve_zro), t: B(m.v_tok) * WEI - B(m.reserve_tok) };
  }
  static circulating(m) { // tokens held by users (excludes curve/pool inventory and burned)
    const out = m.graduated ? B(m.supply) * WEI - B(m.pool_tok) : B(m.reserve_tok);
    return out - B(m.burned);
  }
  static price(m) { const { z, t } = Books.reserves(m); return t > 0n ? (z * WEI) / t : 0n; } // ZRO wei per 1 token
  static quoteBuy(m, zroIn) {
    const { z, t } = Books.reserves(m);
    const out = t - (z * t) / (z + zroIn);
    if (m.graduated) return out; // pool: price keeps rising, no market-cap cap
    const left = B(m.curve_tokens) * WEI - B(m.reserve_tok);
    return out > left ? left : out;
  }
  static zroForTokens(m, tokOut) { // exact ZRO needed to buy tokOut (used when the curve is nearly sold out)
    const { z, t } = Books.reserves(m);
    return (z * t) / (t - tokOut) - z + 1n;
  }
  static quoteSell(m, tokIn) {
    const { z, t } = Books.reserves(m);
    const out = z - (z * t) / (t + tokIn);
    const cap = m.graduated ? B(m.pool_zro) : B(m.reserve_zro);
    return out > cap ? cap : out;
  }

  view(m, _usd) {
    const usd = m.rh_quote ? this.rhMarketUsd(m) : this.usdOf(qa(m)); // quote asset -> USD (Robinhood pairs: ETH, USDG or a stock token)
    const price = Books.price(m);
    const sold = B(m.reserve_tok);
    const curve = B(m.curve_tokens) * WEI;
    const curveProgress = m.graduated ? 100 : Number((sold * 10000n) / curve) / 100;
    const priceZro = Number(price) / 1e18;
    // Stellar tokens graduate at a USD market cap, not when the curve sells out: progress follows that target
    const stGrad = m.network === 'stellar' ? (Number(m.grad_usd) || this.stGradUsd()) : 0;
    // a fresh token already starts at a market cap (initial curve price x supply): count progress from there,
    // otherwise every untouched token shows a few percent it never earned
    const startMc = m.network === 'stellar' ? (Number(vQuote(m)) / (Number(B(m.v_tok)) * 1e18)) * Number(m.supply) * usd : 0;
    const span = stGrad - startMc;
    const progress = !stGrad ? curveProgress : m.migrated ? 100 : span <= 0 ? curveProgress
      : Math.max(0, Math.min(99.9, Math.round(((priceZro * Number(m.supply) * usd - startMc) / span) * 10000) / 100));
    const holders = m.rh_token
      ? this.sql.exec(`SELECT COUNT(*) c FROM rh_holdings WHERE token=? AND bal!='0' AND address NOT IN (?,?,?)`, m.rh_token,
        String(this.rhCurve()).toLowerCase(), String(m.rh_pool || ''), '0x000000000000000000000000000000000000dead').one().c
      : this.sql.exec(`SELECT COUNT(*) c FROM balances WHERE asset=? AND amount!='0'`, 't:' + m.id).one().c;
    const ch = (ms) => {
      const r = this.sql.exec('SELECT price FROM trades WHERE market=? AND ts<=? ORDER BY id DESC LIMIT 1', m.id, now() - ms).toArray()[0]
        || this.sql.exec('SELECT price FROM trades WHERE market=? ORDER BY id ASC LIMIT 1', m.id).toArray()[0];
      const base = r ? Number(B(r.price)) : Number((vQuote(m) * WEI) / (B(m.v_tok) * WEI));
      return base ? ((Number(price) - base) / base) * 100 : 0;
    };
    return {
      id: m.id, name: m.name, symbol: m.symbol, description: m.description,
      image: m.image ? `/api/img/m/${m.id}` : '', network: m.network, quote: m.quote || 'ZRO', quoteUsd: usd, vQuote: vQuote(m).toString(),
      x: m.x, tg: m.tg, web: m.web, creator: this.userName(m.creator_id), created: m.created,
      supply: m.supply, sold: sold.toString(), burned: m.burned, curveTokens: m.curve_tokens,
      reserveZro: m.reserve_zro, volume: m.volume, trades: m.trades,
      priceZro, priceUsd: priceZro * usd,
      mcapUsd: priceZro * Number(m.supply) * usd,
      liquidityUsd: (Number(m.graduated ? B(m.pool_zro) : B(m.reserve_zro)) / 1e18) * usd,
      poolZro: m.pool_zro, poolTok: m.pool_tok, gradAt: m.grad_at,
      volumeUsd: (Number(B(m.volume)) / 1e18) * usd,
      progress, curveProgress, graduated: !!m.graduated, migrated: !!m.migrated,
      stellar: m.network === 'stellar' ? { code: m.st_code || null, issuer: m.st_issuer || null, pool: m.st_pool || null, keeper: m.st_keeper || null,
        net: this.stNet(), explorer: ST_NETS[this.stNet()].explorer,
        gradUsd: Number(m.grad_usd) || ((m.graduated || m.migrated) ? Math.round(Number(B(m.v_wei || 0)) / 1e18 * 14.397 * this.xlmUsd()) : this.stGradUsd()),
        job: m.graduated && !m.migrated ? (this.sql.exec('SELECT status, error FROM stellar_jobs WHERE market=?', m.id).toArray()[0] || null) : null } : null,
      rh: m.rh_token ? { token: m.rh_token, pool: m.rh_pool || null, curve: this.rhCurve(), creator: m.rh_creator, quote: m.rh_quote || '0x0000000000000000000000000000000000000000',
        rewards: m.rh_rewards || '0', explorer: 'https://robinhoodchain.blockscout.com' } : null,
      maxBuyBps: m.max_buy_bps, maxBuyUntil: m.max_buy_until,
      taxes: { platform: 0.5, marketing: m.tax_mkt / 100, burn: m.tax_burn / 100, rewards: m.tax_rew / 100 },
      rewardsPaidUsd: (Number(B(m.rewards_paid)) / 1e18) * usd,
      mktPaid: m.mkt_paid, mktPaidUsd: (Number(B(m.mkt_paid)) / 1e18) * usd,
      rewardsPaid: m.rewards_paid,
      holders, lastTrade: m.last_trade,
      change5m: ch(5 * 60e3), change1h: ch(3600e3), change24h: ch(864e5),
    };
  }
  // realised + unrealised result of one user on one token, from the trade ledger: net ZRO paid in vs current value
  position(userId, m) {
    const price = Books.price(m);
    const bal = this.bal(userId, 't:' + m.id);
    let zin = 0n, zout = 0n, n = 0;
    for (const r of this.sql.exec('SELECT side, zro, tokens FROM trades WHERE market=? AND user_id=?', m.id, userId).toArray()) {
      n++;
      if (r.side === 'buy') zin += B(r.zro); else zout += B(r.zro);
    }
    const cost = zin - zout;                       // ZRO still at risk in this token
    const value = (bal * price) / WEI;             // what it is worth now
    const pnl = value - cost;
    const z = (v) => Number(v) / 1e18;
    return {
      tokens: bal.toString(), costZro: z(cost), valueZro: z(value), pnlZro: z(pnl),
      pnlPct: cost > 0n ? (Number((pnl * 10000n) / cost) / 100) : null,
      trades: n, paidZro: z(zin), receivedZro: z(zout),
    };
  }
  userName(id) { return this.sql.exec('SELECT username FROM users WHERE id=?', id).toArray()[0]?.username || 'anon'; }

  /* ───────────── points & referrals ───────────── */
  // Points are a loyalty counter, not money: they buy priority at mainnet, nothing else.
  award(userId, kind, amount, ref = '') {
    const n = Math.round(Number(amount) || 0);
    if (!userId || !isFinite(n) || n <= 0) return 0;
    const col = ['trade', 'hatch', 'bond', 'hold', 'referral'].includes(kind) ? kind : null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT OR IGNORE INTO pts (user_id,total,trade,hatch,bond,hold,referral,ts) VALUES (?,0,0,0,0,0,0,?)', userId, now());
      if (col) this.sql.exec(`UPDATE pts SET total=total+?, ${col}=${col}+?, ts=? WHERE user_id=?`, n, n, now(), userId);
      else this.sql.exec('UPDATE pts SET total=total+?, ts=? WHERE user_id=?', n, now(), userId);
      this.sql.exec('INSERT INTO points (user_id,kind,amount,ref,ts) VALUES (?,?,?,?,?)', userId, kind, n, String(ref || '').slice(0, 40), now());
    });
    return n;
  }
  // 20% of the platform fee goes to whoever referred this trader
  refCutFor(traderId, platform) {
    if (platform <= 0n) return null;
    const r = this.sql.exec('SELECT referred_by FROM users WHERE id=?', traderId).toArray()[0];
    if (!r || !r.referred_by) return null;
    const cut = (platform * 2000n) / 10000n;
    return cut > 0n ? { to: r.referred_by, amount: cut } : null;
  }
  chargePlatform(traderId, asset, platform) {
    const cut = this.refCutFor(traderId, platform);
    this.setMeta(burnKey(asset), (B(this.meta(burnKey(asset))) + (platform - (cut ? cut.amount : 0n))).toString());
    if (cut) {
      this.addBal(cut.to, asset, cut.amount);
      this.sql.exec('INSERT INTO ref_earn (referrer_id,trader_id,asset,amount,ts) VALUES (?,?,?,?,?)', cut.to, traderId, asset, cut.amount.toString(), now());
      const extra = Math.min(200, Math.round((Number(cut.amount) / 1e18) * 5));
      if (extra > 0) this._pa = [...(this._pa || []), { u: cut.to, kind: 'referral', amount: extra, ref: 'trade' }];
    }
  }
  pointsOf(userId) {
    const row = this.sql.exec('SELECT * FROM pts WHERE user_id=?', userId).toArray()[0]
      || { user_id: userId, total: 0, trade: 0, hatch: 0, bond: 0, hold: 0, referral: 0 };
    const rank = this.sql.exec('SELECT COUNT(*) c FROM pts WHERE total>?', row.total).one().c + 1;
    const tier = TIERS.slice().reverse().find(t => row.total >= t.min) || TIERS[0];
    return { total: row.total, trade: row.trade, hatch: row.hatch, bond: row.bond, hold: row.hold, referral: row.referral, rank, tier };
  }
  refStats(user) {
    const invited = this.sql.exec('SELECT COUNT(*) c FROM users WHERE referred_by=?', user.id).one().c;
    let zro = 0, eth = 0, xlm = 0;
    for (const e of this.sql.exec('SELECT asset, amount FROM ref_earn WHERE referrer_id=?', user.id).toArray()) {
      if (e.asset === 'eth') eth += Number(B(e.amount)) / 1e18; else if (e.asset === 'xlm') xlm += Number(B(e.amount)) / 1e18; else zro += Number(B(e.amount)) / 1e18;
    }
    return { code: user.username, invited, earnedZro: zro, earnedEth: eth, earnedXlm: xlm, earnedUsd: zro * this.zroUsd() + eth * this.ethUsd() + xlm * this.xlmUsd() };
  }
  // once a day: holding bags in the launchpad earns a little too (capped)
  dailyHoldPoints() {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (this.meta('pts_hold_day') === day) return 0;
    this.setMeta('pts_hold_day', day);
    const ms = new Map(this.sql.exec('SELECT * FROM markets').toArray().map(m => [m.id, m]));
    const val = new Map();
    for (const r of this.sql.exec(`SELECT user_id u, asset, amount FROM balances WHERE asset LIKE 't:%' AND amount!='0'`).toArray()) {
      const m = ms.get(r.asset.slice(2)); if (!m) continue;
      const usd = (Number(B(r.amount)) / 1e18) * (Number(Books.price(m)) / 1e18) * this.usdOf(qa(m));
      if (usd > 0) val.set(r.u, (val.get(r.u) || 0) + usd);
    }
    let n = 0;
    for (const [u, usd] of val) { const pts = Math.min(500, Math.round(usd * 0.1)); if (pts > 0) { this.award(u, 'hold', pts, day); n++; } }
    return n;
  }

  /* ───────────── badges ───────────── */
  // Earned, never bought. A few bulk queries for a whole page, then one list per user.
  badges(ids) {
    const out = new Map(); const uniq = [...new Set((ids || []).filter(x => typeof x === 'number'))].slice(0, 600);
    uniq.forEach(i => out.set(i, []));
    if (!uniq.length) return out;
    const grad = new Set(this.sql.exec('SELECT DISTINCT creator_id c FROM markets WHERE graduated=1').toArray().map(r => r.c));
    // SQLite caps the number of bound variables per statement, so look these up in small chunks
    for (let k = 0; k < uniq.length; k += 80) {
      const chunk = uniq.slice(k, k + 80);
      const ph = chunk.map(() => '?').join(',');
      const made = new Set(this.sql.exec(`SELECT DISTINCT creator_id c FROM markets WHERE creator_id IN (${ph})`, ...chunk).toArray().map(r => r.c));
      const nt = new Map(this.sql.exec(`SELECT user_id u, COUNT(*) n FROM trades WHERE user_id IN (${ph}) GROUP BY user_id`, ...chunk).toArray().map(r => [r.u, r.n]));
      for (const id of chunk) {
        const b = [];
        if (id <= 500) b.push('early');            // one of the first 500 accounts
        if (made.has(id)) b.push('creator');       // has hatched at least one token
        if (grad.has(id)) b.push('bonded');        // one of their tokens reached 100% of the curve
        if ((nt.get(id) || 0) >= 25) b.push('diamond'); // 25+ trades
        out.set(id, b);
      }
    }
    return out;
  }
  badgesOf(id) { return this.badges([id]).get(id) || []; }

  /* ───────────── hatching soon ───────────── */
  hatchView(h, nowMs, waiting, subscribed, isMine, creator) {
    const live = h.launch_at <= nowMs;
    return {
      id: h.id, name: h.name, symbol: h.symbol, network: h.network, description: h.description,
      image: h.image ? `/api/img/h/${h.id}` : '', launchAt: h.launch_at, created: h.created,
      creator: creator || this.userName(h.creator_id), waiting, subscribed, isMine,
      status: h.market_id ? 'launched' : live ? 'live' : 'upcoming',
      marketId: h.market_id || '', secsLeft: Math.max(0, Math.round((h.launch_at - nowMs) / 1000)),
    };
  }
  hatchList(user) {
    const t = now();
    // upcoming ones plus the last 24 h of live ones; launched or cancelled drops off
    const rows = this.sql.exec(`SELECT * FROM hatches WHERE cancelled=0 AND market_id='' AND launch_at>? ORDER BY launch_at ASC LIMIT 24`, t - 864e5).toArray();
    const waits = new Map(this.sql.exec(`SELECT hatch_id h, COUNT(*) n FROM hatch_subs GROUP BY hatch_id`).toArray().map(r => [r.h, r.n]));
    const mine = new Set(user ? this.sql.exec('SELECT hatch_id h FROM hatch_subs WHERE user_id=?', user.id).toArray().map(r => r.h) : []);
    // creator names in one query instead of one per hatch
    const ids = [...new Set(rows.map(r => r.creator_id))];
    const names = new Map(ids.length ? this.sql.exec(`SELECT id, username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).toArray().map(r => [r.id, r.username]) : []);
    return rows.map(h => this.hatchView(h, t, waits.get(h.id) || 0, mine.has(h.id), !!user && user.id === h.creator_id, names.get(h.creator_id)));
  }
  createHatch(user, b) {
    const name = String(b.name || '').trim().slice(0, 32);
    const symbol = String(b.symbol || '').trim().replace(/^\$/, '').slice(0, 12);
    if (name.length < 2) throw new Error('Name is too short');
    if (!symbol) throw new Error('Ticker is required');
    const network = ['giwa', 'stellar', 'robinhood'].includes(b.network) ? b.network : 'zero';
    const at = Number(b.launchAt);
    if (!isFinite(at)) throw new Error('Pick a launch time');
    if (at < now() + 5 * 60e3) throw new Error('Pick a time at least 5 minutes from now');
    if (at > now() + 30 * 864e5) throw new Error('Pick a time within 30 days');
    const active = this.sql.exec(`SELECT COUNT(*) c FROM hatches WHERE creator_id=? AND cancelled=0 AND market_id=''`, user.id).one().c;
    if (active >= 5) throw new Error('You already have 5 hatches waiting. Launch or cancel one first.');
    const img = String(b.image || '');
    if (img && (!img.startsWith('data:image/') || img.length > 300_000)) throw new Error('Image must be under 200 KB');
    const id = 'h-' + randHex(5);
    this.sql.exec(`INSERT INTO hatches (id,creator_id,name,symbol,network,description,image,launch_at,created)
      VALUES (?,?,?,?,?,?,?,?,?)`, id, user.id, name, symbol, network, String(b.description || '').slice(0, 600), img, at, now());
    this.award(user.id, 'hatch', 250, id);
    return { ok: true, id };
  }

  /* ───────────── trading ───────────── */
  trade(user, { market, side, amount, pay }) {
    const amt = B(amount);
    if (amt <= 0n) throw new Error('Enter an amount');
    let res;
    this.ctx.storage.transactionSync(() => {
      const m0 = this.market(market), q = qa(m0);
      const via = pay && pay !== q ? pay : null;
      if (via && !['eth', 'zro', 'ltc', 'zltc'].includes(via)) throw new Error('Unsupported payment asset');
      if (via && q === 'xlm') throw new Error('Stellar tokens are bought and sold in XLM');
      if (via === 'xlm') throw new Error('XLM can only be used for Stellar tokens');
      if (side === 'buy' && via) {
        const qIn = this.swap(user, via, q, amt);             // e.g. ETH -> ZRO at the live rate
        res = { ...this.tradeCore(user, market, 'buy', qIn), paid: { asset: via, amount: amt.toString() } };
      } else if (side === 'sell' && via) {
        const r = this.tradeCore(user, market, 'sell', amt);
        const out = this.swap(user, q, via, r.zro);            // proceeds converted back, e.g. ZRO -> ETH
        res = { ...r, received: { asset: via, amount: out.toString() } };
      } else res = this.tradeCore(user, market, side, amt);
    });
    const mf = this.market(market), q = qa(mf);
    if (side === 'buy' && mf.network === 'stellar' && mf.st_issuer && !mf.migrated && this.stSendNowOn() && user.stellar_wallet && B(res.tokens || 0) > 0n) {
      this.sql.exec(`INSERT OR IGNORE INTO st_out (user_id,market,pending,updated) VALUES (?,?,?,?)`, user.id, mf.id, '0', now());
      const row = this.sql.exec('SELECT pending FROM st_out WHERE user_id=? AND market=?', user.id, mf.id).one();
      this.sql.exec('UPDATE st_out SET pending=?, next_try=0 WHERE user_id=? AND market=?', (B(row.pending) + B(res.tokens)).toString(), user.id, mf.id);
      this._stSendKick = true;
    }
    // points for real volume: 10 per $1 traded, capped per trade so nobody farms the counter
    const usd = (Number(B(res.zro)) / 1e18) * this.usdOf(q);
    const pts = Math.min(20000, Math.round(usd * 10));
    if (pts > 0) this.award(user.id, 'trade', pts, market);
    const ref = this.sql.exec('SELECT referred_by FROM users WHERE id=?', user.id).toArray()[0]?.referred_by;
    if (ref && pts > 0) this.award(ref, 'referral', Math.min(500, Math.round(pts * 0.1)), 'trade');
    for (const a of this._pa || []) this.award(a.u, a.kind, a.amount, a.ref);
    this._pa = [];
    if (this._stKick) { this._stKick = false; this.wserial(() => this.stellarJobs()).catch(() => {}); }
    if (this._stSendKick) { this._stSendKick = false; this.ctx.waitUntil(this.wserial(() => this.stellarSendNow()).catch(() => {})); }
    return { ok: true, ...res, points: pts, quote: mf.quote || 'ZRO', market: this.view(mf) };
  }
  // one trade in the market's own quote asset; must run inside a transaction
  tradeCore(user, market, side, amt) {
    let res, res_graduated = false;
    {
      let m = this.market(market);
      if (m.rh_token) throw new Error('This token lives on Robinhood Chain: buy and sell it from your wallet');
      if (m.migrated) throw new Error(m.network === 'stellar' ? 'This token graduated to Aquarius on Stellar: trade it there, or withdraw it to your Stellar wallet' : 'Token migrated to mainnet');
      // bonded Stellar tokens keep trading on the Rookery pool; only the graduation itself freezes the book
      if (m.network === 'stellar' && m.graduated && this.sql.exec('SELECT 1 FROM stellar_jobs WHERE market=?', m.id).toArray().length)
        throw new Error('Graduating to Aquarius right now: the pool opens in about a minute');
      const q = qa(m), usd = this.usdOf(q);
      const creator = m.creator_id;
      const bps = (v, b) => (v * BigInt(b)) / 10000n;

      if (side === 'buy') {
        if (amt < MIN_BUY[q]) throw new Error(q === 'eth' ? 'Minimum buy is 0.00005 ETH' : q === 'xlm' ? 'Minimum buy is 1 XLM' : 'Minimum buy is 0.1 ZRO');
        this.addBal(user.id, q, -amt);
        let platform = bps(amt, PLATFORM_BPS), mkt = bps(amt, m.tax_mkt), rew = bps(amt, m.tax_rew);
        let net = amt - platform - mkt - rew;
        let tokOut = Books.quoteBuy(m, net);
        if (tokOut <= 0n) throw new Error('Amount too small');
        // if curve capped the output, refund the unused ZRO
        const needed = Books.zroForTokens(m, tokOut);
        if (needed < net) { const refund = net - needed; net = needed; this.addBal(user.id, q, refund); }
        // max-buy window
        if (m.max_buy_bps > 0 && now() < m.max_buy_until) {
          const cap = (B(m.supply) * WEI * BigInt(m.max_buy_bps)) / 10000n;
          if (this.bal(user.id, 't:' + m.id) + tokOut > cap) throw new Error(`Max buy at launch: ${(m.max_buy_bps / 100).toFixed(2)}% of supply per wallet`);
        }
        // fees
        this.chargePlatform(user.id, q, platform);
        if (mkt > 0n) { this.addBal(creator, q, mkt); }
        const circ = Books.circulating(m);
        let acc = B(m.acc_rew);
        if (rew > 0n) {
          if (circ > 0n) acc += (rew * ACC) / circ; else this.addBal(creator, q, rew);
        }
        this.sql.exec('UPDATE markets SET acc_rew=?, mkt_paid=? WHERE id=?', acc.toString(), (B(m.mkt_paid) + mkt).toString(), m.id);
        m = this.market(market);
        this.settle(user.id, m);
        const burn = bps(tokOut, m.tax_burn);
        const got = tokOut - burn;
        this.addBal(user.id, 't:' + m.id, got);
        if (m.graduated) {
          this.sql.exec(`UPDATE markets SET pool_zro=?, pool_tok=?, burned=?, volume=?, trades=trades+1, last_trade=? WHERE id=?`,
            (B(m.pool_zro) + net).toString(), (B(m.pool_tok) - tokOut).toString(), (B(m.burned) + burn).toString(),
            (B(m.volume) + amt).toString(), now(), m.id);
        } else {
          this.sql.exec(`UPDATE markets SET reserve_zro=?, reserve_tok=?, burned=?, volume=?, trades=trades+1, last_trade=? WHERE id=?`,
            (B(m.reserve_zro) + net).toString(), (B(m.reserve_tok) + tokOut).toString(), (B(m.burned) + burn).toString(),
            (B(m.volume) + amt).toString(), now(), m.id);
          const mm = this.market(market);
          // bonded: the curve becomes a real-reserve pool (raised ZRO + the 200M reserved tokens) and trading continues
          if (B(mm.reserve_tok) >= B(mm.curve_tokens) * WEI) {
            // seamless hand-off: the pool opens at exactly the curve's final price (zEnd/tEnd)
            const zEnd = vQuote(mm) + B(mm.reserve_zro), tEnd = B(mm.v_tok) * WEI - B(mm.reserve_tok);
            const raised = B(mm.reserve_zro), resTok = (B(mm.supply) - B(mm.curve_tokens)) * WEI;
            let pz = (resTok * zEnd) / tEnd, pt = resTok, extraZro = 0n, extraTok = 0n;
            if (pz > raised) { pz = raised; pt = (raised * tEnd) / zEnd; extraTok = resTok - pt; } // not enough ZRO: burn the spare tokens
            else extraZro = raised - pz;                                                          // spare ZRO buys and burns $臭企鹅
            this.sql.exec('UPDATE markets SET graduated=1, grad_at=?, pool_zro=?, pool_tok=?, burned=? WHERE id=?',
              now(), pz.toString(), pt.toString(), (B(mm.burned) + extraTok).toString(), m.id);
            if (extraZro > 0n) this.setMeta(burnKey(q), (B(this.meta(burnKey(q))) + extraZro).toString());
            res_graduated = true;
            this._pa = [...(this._pa || []), { u: creator, kind: 'bond', amount: 5000, ref: m.id }];
            // Stellar: the token keeps trading on the Rookery pool and graduates only when it reaches its target
            if (mm.network === 'stellar') this.stMaybeGraduate(m.id);
          }
        }
        m = this.market(market);
        this.resetDebt(user.id, m);
        const price = Books.price(m);
        this.sql.exec('UPDATE markets SET last_price=? WHERE id=?', price.toString(), m.id);
        this.sql.exec('INSERT INTO trades (market,user_id,side,zro,tokens,price,usd,ts,quote) VALUES (?,?,?,?,?,?,?,?,?)',
          m.id, user.id, 'buy', amt.toString(), got.toString(), price.toString(), usd, now(), m.quote || 'ZRO');
        res = { side, zro: amt, tokens: got, burned: burn, fees: { platform, marketing: mkt, rewards: rew }, bonded: res_graduated };
      } else if (side === 'sell') {
        this.settle(user.id, m);
        this.addBal(user.id, 't:' + m.id, -amt);
        const burn = bps(amt, m.tax_burn);
        const sellTok = amt - burn;
        const gross = Books.quoteSell(m, sellTok);
        if (gross <= 0n) throw new Error('Amount too small');
        const platform = bps(gross, PLATFORM_BPS), mkt = bps(gross, m.tax_mkt), rew = bps(gross, m.tax_rew);
        const net = gross - platform - mkt - rew;
        if (m.graduated) {
          this.sql.exec(`UPDATE markets SET pool_zro=?, pool_tok=?, burned=?, volume=?, trades=trades+1, last_trade=? WHERE id=?`,
            (B(m.pool_zro) - gross).toString(), (B(m.pool_tok) + sellTok).toString(), (B(m.burned) + burn).toString(),
            (B(m.volume) + gross).toString(), now(), m.id);
        } else {
          this.sql.exec(`UPDATE markets SET reserve_zro=?, reserve_tok=?, burned=?, volume=?, trades=trades+1, last_trade=? WHERE id=?`,
            (B(m.reserve_zro) - gross).toString(), (B(m.reserve_tok) - sellTok).toString(), (B(m.burned) + burn).toString(),
            (B(m.volume) + gross).toString(), now(), m.id);
        }
        m = this.market(market);
        this.chargePlatform(user.id, q, platform);
        if (mkt > 0n) this.addBal(creator, q, mkt);
        const circ = Books.circulating(m);
        let acc = B(m.acc_rew);
        if (rew > 0n) { if (circ > 0n) acc += (rew * ACC) / circ; else this.addBal(creator, q, rew); }
        this.sql.exec('UPDATE markets SET acc_rew=?, mkt_paid=? WHERE id=?', acc.toString(), (B(m.mkt_paid) + mkt).toString(), m.id);
        m = this.market(market);
        this.addBal(user.id, q, net);
        this.resetDebt(user.id, m);
        const price = Books.price(m);
        this.sql.exec('UPDATE markets SET last_price=? WHERE id=?', price.toString(), m.id);
        this.sql.exec('INSERT INTO trades (market,user_id,side,zro,tokens,price,usd,ts,quote) VALUES (?,?,?,?,?,?,?,?,?)',
          m.id, user.id, 'sell', gross.toString(), amt.toString(), price.toString(), usd, now(), m.quote || 'ZRO');
        res = { side, zro: net, tokens: amt, burned: burn, fees: { platform, marketing: mkt, rewards: rew } };
      } else throw new Error('bad side');
    }
    if (this.sql.exec(`SELECT 1 FROM markets WHERE id=? AND network='stellar' AND graduated=1 AND migrated=0`, market).toArray().length) this.stMaybeGraduate(market);
    return res;
  }

  /* ───────────── backups (R2) ───────────── */
  // Whole-ledger snapshot. Every table is read synchronously with no await in between, so the
  // snapshot is one consistent point in time (the DO can't interleave a trade mid-dump).
  async backup(reason = 'cron') {
    const bucket = this.env.BACKUPS;
    if (!bucket) return { skipped: 'no R2 binding' };
    const t0 = now();
    const SKIP = new Set(['sessions', 'siwe_nonces']); // short-lived login state, never restored
    const objs = this.sql.exec(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).toArray();
    const tables = objs.filter(o => o.type === 'table' && !SKIP.has(o.name));
    const indexes = objs.filter(o => o.type === 'index' && !SKIP.has(o.tbl_name)).map(o => o.sql);
    const counts = {}, parts = [];
    parts.push(`{"v":1,"ts":${t0},"reason":${JSON.stringify(reason)},"indexes":${JSON.stringify(indexes)},"tables":{`);
    tables.forEach((t, i) => {
      const cur = this.sql.exec(`SELECT * FROM "${t.name}"`);
      const rows = cur.raw().toArray();
      counts[t.name] = rows.length;
      parts.push((i ? ',' : '') + JSON.stringify(t.name) + ':' + JSON.stringify({ schema: t.sql, cols: cur.columnNames, rows }));
    });
    parts.push('}}');
    // ledger fingerprint stored next to the file, so a restore can be checked against it
    const fp = { users: counts.users || 0, markets: counts.markets || 0, trades: counts.trades || 0,
      maxTrade: this.sql.exec('SELECT COALESCE(MAX(id),0) m FROM trades').one().m,
      maxTransfer: this.sql.exec('SELECT COALESCE(MAX(id),0) m FROM transfers').one().m };
    const raw = new Blob(parts);
    const gz = await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const sha = hex(await crypto.subtle.digest('SHA-256', gz));
    const iso = new Date(t0).toISOString();
    const key = reason === 'cron' ? `rookery/${iso.slice(0, 10)}/${iso.slice(11, 13)}00.json.gz`
      : `rookery/${iso.slice(0, 10)}/${iso.slice(11, 19).replace(/:/g, '')}-${reason}.json.gz`;
    await bucket.put(key, gz, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
      customMetadata: { sha256: sha, rawBytes: String(raw.size), ts: String(t0), reason, fp: JSON.stringify(fp) } });
    const report = { key, bytes: gz.byteLength, rawBytes: raw.size, sha256: sha, ms: now() - t0, rows: counts, fp };
    this.setMeta('backup_last', String(t0));
    this.setMeta('backup_report', JSON.stringify(report).slice(0, 3000));
    this.setMeta('backup_error', '');
    if (reason === 'cron') await this.pruneBackups().catch(() => {});
    return report;
  }
  // keep every hourly copy for 48 h, then one per day (the 00:00 copy) for 30 days
  async pruneBackups() {
    const bucket = this.env.BACKUPS, cutHourly = now() - 48 * 3600e3, cutDaily = now() - 30 * 864e5;
    let cursor, del = [];
    do {
      const l = await bucket.list({ prefix: 'rookery/', cursor, include: ['customMetadata'] });
      for (const o of l.objects) {
        const ts = Number(o.customMetadata?.ts || o.uploaded.getTime());
        const daily = /\/0000\.json\.gz$/.test(o.key);
        if (ts < cutDaily || (ts < cutHourly && !daily)) del.push(o.key);
      }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < del.length; i += 500) await bucket.delete(del.slice(i, i + 500));
    return del.length;
  }
  async listBackups() {
    const out = []; let cursor;
    do {
      const l = await this.env.BACKUPS.list({ prefix: 'rookery/', cursor, include: ['customMetadata'] });
      for (const o of l.objects) out.push({ key: o.key, bytes: o.size, uploaded: o.uploaded, reason: o.customMetadata?.reason, fp: JSON.parse(o.customMetadata?.fp || 'null') });
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    return out.sort((a, b) => (a.key < b.key ? 1 : -1));
  }
  // Replace the ledger with a backup. Takes a fresh safety copy first; sessions are kept.
  async restoreBackup(key) {
    const obj = await this.env.BACKUPS.get(key);
    if (!obj) throw new Error('Backup not found: ' + key);
    const gz = await obj.arrayBuffer();
    const sha = hex(await crypto.subtle.digest('SHA-256', gz));
    if (obj.customMetadata?.sha256 && obj.customMetadata.sha256 !== sha) throw new Error('Backup checksum mismatch');
    const data = JSON.parse(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
    const safety = await this.backup('pre-restore');
    const restored = {};
    this.ctx.storage.transactionSync(() => {
      for (const [name, t] of Object.entries(data.tables)) {
        this.sql.exec(t.schema.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS '));
        const have = new Set(this.sql.exec(`SELECT * FROM "${name}" LIMIT 0`).columnNames);
        for (const c of t.cols) if (!have.has(c)) throw new Error(`Column ${name}.${c} is missing in the live schema`);
        this.sql.exec(`DELETE FROM "${name}"`);
        const ins = `INSERT INTO "${name}" (${t.cols.map(c => `"${c}"`).join(',')}) VALUES (${t.cols.map(() => '?').join(',')})`;
        for (const r of t.rows) this.sql.exec(ins, ...r);
        restored[name] = t.rows.length;
      }
      for (const ix of data.indexes || []) this.sql.exec(ix.replace(/^CREATE (UNIQUE )?INDEX\s+/i, (m0, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `));
    });
    return { ok: true, key, backupTs: data.ts, restored, safetyCopy: safety.key };
  }

  /* ───────────── create token ───────────── */
  createMarket(user, b) {
    const name = String(b.name || '').trim().slice(0, 32);
    const symbol = String(b.symbol || '').trim().replace(/^\$/, '').slice(0, 12);
    if (name.length < 2) throw new Error('Name is too short');
    if (!symbol) throw new Error('Ticker is required');
    const network = ['giwa', 'stellar', 'robinhood', 'litvm'].includes(b.network) ? b.network : 'zero';
    if (network === 'robinhood' && this.rhLive()) throw new Error('Robinhood Chain tokens are launched from your wallet: the contract goes on-chain right away');
    // double-submit guard: the same creator can't launch the same name twice within 2 minutes
    const dup = this.sql.exec(`SELECT id FROM markets WHERE creator_id=? AND lower(trim(name))=lower(?) AND created>? ORDER BY created DESC LIMIT 1`,
      user.id, name, now() - 120_000).toArray()[0];
    if (dup) { const e = new Error(`You just launched "${name}". Wait 2 minutes before creating another token with the same name.`); e.existing = dup.id; throw e; }
    const quote = network === 'giwa' || network === 'robinhood' ? 'ETH' : network === 'stellar' ? 'XLM' : network === 'litvm' ? 'ZKLTC' : 'ZRO';
    // same starting market cap in USD as a ZRO market: 3,150 ZRO worth of ETH as the virtual reserve
    let vWei = quote === 'ETH' ? BigInt(Math.round(Number(CURVE.vZro) * this.zroUsd() / this.ethUsd() * 1e9)) * 1_000_000_000n
      : quote === 'ZKLTC' ? BigInt(Math.round(Number(CURVE.vZro) * this.zroUsd() / this.ltcUsd() * 1e9)) * 1_000_000_000n : null;
    if (quote === 'XLM') {
      // virtual XLM reserve chosen so the curve's final price = STELLAR_GRAD_USD market cap at today's XLM price
      const vT = Number(CURVE.vTok), tEnd = vT - Number(CURVE.curve), sup = Number(CURVE.supply);
      const vXlm = this.stGradUsd() / ((vT * sup) / (tEnd * tEnd)) / this.xlmUsd();
      vWei = BigInt(Math.round(vXlm * 1e6)) * 1_000_000_000_000n;
    }
    const img = String(b.image || '');
    if (img && (!img.startsWith('data:image/') || img.length > 300_000)) throw new Error('Image must be under 200 KB');
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
    const taxMkt = clamp(b.taxMarketing * 100, 0, 500), taxBurn = clamp(b.taxBurn * 100, 0, 500), taxRew = clamp(b.taxRewards * 100, 0, 500);
    if (taxMkt + taxBurn + taxRew > 1000) throw new Error('Total creator taxes can be at most 10%');
    const maxBuyBps = clamp((Number(b.maxBuyPct) || 0) * 100, 0, 500);
    const maxBuyMins = clamp(b.maxBuyMinutes, 0, 1440);
    const url = (u, re) => { u = String(u || '').trim(); if (!u) return ''; if (!/^https?:\/\//.test(u)) u = 'https://' + u; return re.test(u) ? u.slice(0, 200) : ''; };
    const id = (symbol.toLowerCase().replace(/[^a-z0-9]/g, '') || 'tkn').slice(0, 10) + '-' + randHex(3);
    this.sql.exec(`INSERT INTO markets (id,creator_id,name,symbol,description,image,network,quote,x,tg,web,
      supply,curve_tokens,v_zro,v_tok,max_buy_bps,max_buy_until,tax_mkt,tax_burn,tax_rew,created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, user.id, name, symbol, String(b.description || '').slice(0, 600), img, network, quote,
      url(b.x, /^https:\/\/(x|twitter)\.com\//), url(b.tg, /^https:\/\/t\.me\//), url(b.web, /^https:\/\//),
      CURVE.supply.toString(), CURVE.curve.toString(), CURVE.vZro.toString(), CURVE.vTok.toString(),
      maxBuyBps, maxBuyBps && maxBuyMins ? now() + maxBuyMins * 60e3 : 0, taxMkt, taxBurn, taxRew, now());
    if (vWei) this.sql.exec('UPDATE markets SET v_wei=? WHERE id=?', vWei.toString(), id);
    if (network === 'stellar') this.sql.exec('UPDATE markets SET grad_usd=? WHERE id=?', this.stGradUsd(), id);
    // this token was announced as a hatch: pull it off the "hatching soon" list
    if (b.hatchId) {
      const h = this.sql.exec('SELECT * FROM hatches WHERE id=? AND creator_id=? AND market_id=?', String(b.hatchId), user.id, '').toArray()[0];
      if (h) this.sql.exec('UPDATE hatches SET market_id=? WHERE id=?', id, h.id);
    }
    this.award(user.id, 'hatch', 500, id);
    let dev = null;
    if (B(b.devBuy) > 0n) dev = this.trade(user, { market: id, side: 'buy', amount: b.devBuy, pay: b.devPay });
    if (this.snbOn()) this.ctx.waitUntil(this.snbOnLaunch(id).catch(() => {}));
    return { ok: true, id, dev };
  }

  /* ───────────── deposits ───────────── */
  async zroBalanceOf(chain, address) {
    const data = '0x70a08231' + address.toLowerCase().replace('0x', '').padStart(64, '0');
    const res = await rpc(chain, 'eth_call', [{ to: ZRO_TOKEN, data }, 'latest']);
    return BigInt(res === '0x' ? 0 : res);
  }
  // manual "check deposits" button: same engine as the cron, for one user
  async checkDeposits(user) {
    const found = [];
    for (const chain of ZRO_CHAINS) {
      try { found.push(...(await this.scanChain(chain, [user])).map(f => ({ chain: f.chain, amount: f.amount }))); } catch { /* next tick */ }
    }
    return found;
  }

  /* ───────────── withdrawals (hot wallet, instant) ───────────── */
  // sign a legacy tx locally: nonce / gas price / gas limit all come from the fallback rpc() helper
  async signTx(chain, wallet, { to, data = '0x', value = 0n, gasLimit }) {
    const [nonceH, gpH] = await Promise.all([rpc(chain, 'eth_getTransactionCount', [wallet.address, 'pending']), rpc(chain, 'eth_gasPrice', [])]);
    let nonce = BigInt(nonceH);
    const nk = `nonce_${chain}_${wallet.address.toLowerCase()}`;
    // public RPCs can lag behind our own just-broadcast txs, so remember the next nonce for 2 minutes only:
    // after that the chain is the truth (a tx that never landed must not leave a permanent nonce gap)
    let local = 0n;
    try { const j = JSON.parse(this.meta(nk) || 'null'); if (j && now() - j.ts < 120_000) local = B(j.n); } catch { /* legacy value: ignore */ }
    if (local > nonce) nonce = local;
    const gasPrice = BigInt(gpH) * 5n / 4n + 1n;
    if (!gasLimit) gasLimit = BigInt(await rpc(chain, 'eth_estimateGas', [{ from: wallet.address, to, data, value: toHex(value) }])) * 13n / 10n;
    const raw = await wallet.signTransaction({ type: 0, chainId: CHAINS[chain].chainId, nonce: Number(nonce), gasPrice, gasLimit, to, data, value });
    return { raw, hash: Transaction.from(raw).hash, gasPrice, gasLimit, used: () => this.setMeta(nk, JSON.stringify({ n: (nonce + 1n).toString(), ts: now() })) };
  }
  async withdrawTimed(user, body) {
    let timer;
    const ctx = { tid: null };
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__timeout')), 90_000); });
    try { return await Promise.race([this.withdraw(user, body, ctx), timeout]); }
    catch (e) {
      if (e.message !== '__timeout') throw e;
      const t = ctx.tid && this.sql.exec('SELECT * FROM transfers WHERE id=?', ctx.tid).toArray()[0];
      if (t && t.status === 'sent') return { ok: true, pending: true, txid: t.txid, note: 'Sent, waiting for confirmation' };
      if (t && t.status === 'pending') this.ctx.storage.transactionSync(() => {
        this.addBal(t.user_id, t.asset || 'zro', B(t.amount));
        this.sql.exec(`UPDATE transfers SET status='failed', note='Network too slow, refunded' WHERE id=?`, t.id);
      });
      throw new Error(`${CHAINS[body.chain]?.label || 'This network'} is slow right now, your balance was refunded. Try again or pick another network.`);
    } finally { clearTimeout(timer); }
  }
  async withdraw(user, { chain, to, amount, asset, memo }, ctx = {}) {
    if (chain === 'stellar') return this.withdrawStellar(user, { to, amount, asset, memo });
    if (asset === 'eth') return this.withdrawEth(user, { chain, to, amount }, ctx);
    if (!CHAINS[chain]) throw new Error('Unsupported network');
    if (!isAddress(to)) throw new Error('Invalid destination address');
    const amt = B(amount);
    if (amt <= 0n) throw new Error('Enter an amount');
    if (this.meta('withdrawals_paused') === '1') throw new Error('Withdrawals are paused for maintenance');
    const fee = (await this.withdrawFee(chain)).wei;
    if (amt <= fee) throw new Error(`Amount must be higher than the ${Number(fee) / 1e18} ZRO network fee`);
    const send = amt - fee; // what arrives on-chain

    let tid;
    this.ctx.storage.transactionSync(() => {
      this.addBal(user.id, 'zro', -amt);
      this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?)`,
        user.id, 'withdrawal', chain, amt.toString(), getAddress(to), 'pending', `fee ${Number(fee) / 1e18} ZRO`, now(), 'zro');
      tid = this.sql.exec('SELECT last_insert_rowid() id').one().id;
    });
    ctx.tid = tid;
    try {
      const C = CHAINS[chain];
      const hot = new Wallet(this.hotWallet().privateKey);
      const native = async (a) => BigInt(await rpc(chain, 'eth_getBalance', [a, 'latest']));

      // 1) hot wallet first, 2) otherwise any deposit address on this chain that holds enough ZRO (omnibus pool)
      let source = null, sourceUser = null;
      if ((await this.zroBalanceOf(chain, hot.address)) >= send) source = hot;
      if (!source) {
        const cands = this.sql.exec(`SELECT d.user_id, d.last, u.dep_index FROM deposit_seen d JOIN users u ON u.id=d.user_id
          WHERE d.chain=? AND d.user_id NOT IN (SELECT src_user FROM out_pending WHERE chain=?)`, chain, chain).toArray()
          .filter(r => B(r.last) >= send).sort((a, b) => (B(b.last) > B(a.last) ? 1 : -1)).slice(0, 5);
        for (const c of cands) {
          const w = new Wallet(this.master().deriveChild(c.dep_index).privateKey);
          if ((await this.zroBalanceOf(chain, w.address)) >= send) { source = w; sourceUser = c; break; }
        }
      }
      if (!source) throw new Error(`Not enough ZRO liquidity on ${C.label} right now. Try another network.`);

      const data = XFER_IFACE.encodeFunctionData('transfer', [getAddress(to), send]);
      let gasLimit;
      try { gasLimit = BigInt(await rpc(chain, 'eth_estimateGas', [{ from: source.address, to: ZRO_TOKEN, data }])) * 13n / 10n; } catch { gasLimit = WD_GAS; }
      const gp = BigInt(await rpc(chain, 'eth_gasPrice', [])) * 5n / 4n + 1n;
      const need = gasLimit * gp * 2n; // x2 covers rollup L1 data fees and price moves
      const have = await native(source.address);
      if (have < need) {
        if (source === hot) throw new Error(`Withdrawals on ${C.label} are waiting for a gas top-up. Try another network.`);
        const top = need - have;
        if ((await native(hot.address)) < top + TOPUP_GAS * gp * 3n) throw new Error(`Withdrawals on ${C.label} are waiting for a gas top-up. Try another network.`);
        const t = await this.signTx(chain, hot, { to: source.address, value: top });
        await broadcastAll(chain, t.raw); t.used();
        const rc = await waitReceipt(chain, t.hash, 60_000);
        if (!rc || rc.status !== '0x1') throw new Error(`${C.label} is slow right now, please try again in a moment.`);
      }

      // sign first, persist the signed tx, THEN broadcast: a crash/redeploy at any point is recoverable
      const signed = await this.signTx(chain, source, { to: ZRO_TOKEN, data, gasLimit });
      const raw = signed.raw;
      const tx = { hash: signed.hash };
      this.ctx.storage.transactionSync(() => {
        if (this.sql.exec('SELECT status FROM transfers WHERE id=?', tid).one().status !== 'pending') throw new Error('__aborted');
        this.sql.exec(`UPDATE transfers SET status='sent', txid=?, raw=? WHERE id=?`, tx.hash, raw, tid);
        if (sourceUser) this.sql.exec('INSERT INTO out_pending (transfer_id,src_user,chain,amount,txid,ts,raw) VALUES (?,?,?,?,?,?,?)', tid, sourceUser.user_id, chain, send.toString(), tx.hash, now(), raw);
      });
      try { await broadcastAll(chain, raw); signed.used(); }
      catch (be) {
        await new Promise(r => setTimeout(r, 1500));
        const known = await rpc(chain, 'eth_getTransactionByHash', [tx.hash]).catch(() => null);
        if (!known) {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec('DELETE FROM out_pending WHERE transfer_id=?', tid);
            this.sql.exec(`UPDATE transfers SET status='pending', txid='', raw=NULL WHERE id=?`, tid);
          });
          throw be; // -> refund below
        }
      }
      this.setMeta('fee_revenue_zro', (B(this.meta('fee_revenue_zro')) + fee).toString());
      return { ok: true, txid: tx.hash, explorer: `${C.explorer}/tx/${tx.hash}`, sent: send.toString(), fee: fee.toString() };
    } catch (e) {
      const st = this.sql.exec('SELECT status FROM transfers WHERE id=?', tid).toArray()[0]?.status;
      if (st === 'sent') return { ok: true, pending: true, note: 'Sent, waiting for confirmation' };
      // refund and mark failed — the user never loses funds on a failed send
      if (st !== 'pending') throw new Error('Withdrawal was cancelled and refunded'); // already refunded by the timeout
      this.ctx.storage.transactionSync(() => {
        if (this.sql.exec('SELECT status FROM transfers WHERE id=?', tid).one().status !== 'pending') return;
        this.addBal(user.id, 'zro', amt);
        this.sql.exec(`UPDATE transfers SET status='failed', note=? WHERE id=?`, String(e.shortMessage || e.message).slice(0, 200), tid);
      });
      const friendly = /liquidity|gas top-up|slow right now/.test(e.message || '');
      throw new Error(friendly ? e.message : `${CHAINS[chain].label} network is busy right now, your balance was refunded. Please try again in a moment.`);
    }
  }

  // withdrawals interrupted by a restart: unsigned -> refund; signed but unseen -> rebroadcast, or refund if the nonce was used by something else
  async recoverWithdrawals() {
    const out = [];
    for (const t of this.sql.exec(`SELECT * FROM transfers WHERE kind='withdrawal' AND status='pending' AND ts<?`, now() - 10 * 60e3).toArray()) {
      this.ctx.storage.transactionSync(() => {
        this.addBal(t.user_id, t.asset || 'zro', B(t.amount));
        this.sql.exec(`UPDATE transfers SET status='failed', note='Interrupted before sending, refunded' WHERE id=?`, t.id);
      });
      out.push({ id: t.id, action: 'refunded' });
    }
    for (const t of this.sql.exec(`SELECT * FROM transfers WHERE kind='withdrawal' AND status='sent' AND raw IS NOT NULL AND ts<? AND ts>?`, now() - 3 * 60e3, now() - 3 * 864e5).toArray()) {
      let rc = null, known = null;
      try { rc = await rpc(t.chain, 'eth_getTransactionReceipt', [t.txid]); known = rc || await rpc(t.chain, 'eth_getTransactionByHash', [t.txid]); } catch { continue; }
      if (rc) { // mined: only a status 1 receipt actually paid anyone
        if (rc.status !== '0x1') {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec('DELETE FROM out_pending WHERE transfer_id=?', t.id);
            this.addBal(t.user_id, t.asset || 'zro', B(t.amount));
            this.sql.exec(`UPDATE transfers SET status='failed', raw=NULL, note='Reverted on-chain, refunded' WHERE id=?`, t.id);
          });
          out.push({ id: t.id, action: 'refunded-reverted' });
        } else this.sql.exec('UPDATE transfers SET raw=NULL WHERE id=?', t.id);
        continue;
      }
      if (known) continue; // in the mempool
      try { await rpc(t.chain, 'eth_sendRawTransaction', [t.raw]); out.push({ id: t.id, action: 'rebroadcast' }); }
      catch (e) {
        if (/nonce too low/i.test(String(e.message))) {
          const again = await rpc(t.chain, 'eth_getTransactionReceipt', [t.txid]).catch(() => null);
          if (again) continue;
          this.ctx.storage.transactionSync(() => {
            this.sql.exec('DELETE FROM out_pending WHERE transfer_id=?', t.id);
            this.addBal(t.user_id, t.asset || 'zro', B(t.amount));
            this.sql.exec(`UPDATE transfers SET status='failed', raw=NULL, note='Not sent (nonce replaced), refunded' WHERE id=?`, t.id);
          });
          out.push({ id: t.id, action: 'refunded' });
        }
      }
    }
    return out;
  }
  // Re-send a withdrawal whose recorded tx reverted. Refuses if that tx actually succeeded,
  // and only ever runs once per transfer (the note is stamped 'resent').
  async retryWithdrawal(id, dryRun = false) {
    const t = this.sql.exec(`SELECT * FROM transfers WHERE id=? AND kind='withdrawal'`, id).toArray()[0];
    if (!t) throw new Error('No withdrawal with id ' + id);
    const asset = t.asset || 'zro';
    const amt = B(t.amount);
    const feeM = /fee ([\d.]+)/.exec(t.note || ''); const fee = feeM ? BigInt(Math.round(Number(feeM[1]) * 1e18)) : 0n;
    const send = amt > fee ? amt - fee : amt;
    // is the original really dead?
    if (t.txid) {
      const rc = await rpc(t.chain, 'eth_getTransactionReceipt', [t.txid]).catch(() => null);
      if (rc && rc.status === '0x1') throw new Error('The original transaction actually succeeded on-chain — nothing to resend');
      if (!rc) { const known = await rpc(t.chain, 'eth_getTransactionByHash', [t.txid]).catch(() => null); if (known) throw new Error('The original transaction is still in the mempool'); }
    }
    if (/resent/.test(t.note || '')) throw new Error('This withdrawal was already resent');
    const plan = { id: t.id, user: t.user_id, chain: t.chain, asset, debit: amt.toString(), fee: fee.toString(), send: send.toString(), to: t.to_addr, oldTx: t.txid };
    if (dryRun) return { ok: true, dryRun: true, plan };
    const C = CHAINS[t.chain] || { label: t.chain, explorer: '' };
    const hot = new Wallet(this.hotWallet().privateKey);
    let signed;
    if (asset === 'eth') {
      const bal = BigInt(await rpc(t.chain, 'eth_getBalance', [hot.address, 'latest']));
      if (bal < send) throw new Error('Hot wallet is short on gas ETH for this payout');
      signed = await this.signTx(t.chain, hot, { to: t.to_addr, value: send, gasLimit: 21000n });
    } else {
      const data = '0xa9059cbb' + t.to_addr.toLowerCase().replace('0x', '').padStart(64, '0') + send.toString(16).padStart(64, '0');
      signed = await this.signTx(t.chain, hot, { to: ZRO_TOKEN, data, gasLimit: 90000n });
    }
    this.sql.exec(`UPDATE transfers SET note=? WHERE id=?`, (t.note || '') + ' · resent', t.id);
    try { await broadcastAll(t.chain, signed.raw); signed.used(); }
    catch (e) { this.sql.exec(`UPDATE transfers SET note=? WHERE id=?`, (t.note || '') + ' · resend failed: ' + String(e.message).slice(0, 80), t.id); throw e; }
    const rc = await waitReceipt(t.chain, signed.hash, 120_000).catch(() => null);
    if (rc && rc.status !== '0x1') {
      this.ctx.storage.transactionSync(() => {
        this.addBal(t.user_id, asset, amt);
        this.sql.exec(`UPDATE transfers SET status='failed', txid=?, note=? WHERE id=?`, signed.hash, 'Resend reverted on-chain, refunded', t.id);
      });
      return { ok: false, reverted: true, txid: signed.hash, refunded: amt.toString() };
    }
    this.sql.exec('UPDATE transfers SET txid=?, status=?, note=? WHERE id=?', signed.hash, rc ? 'sent' : 'sent', rc ? 'resent after revert, confirmed' : 'resent after revert, awaiting confirmation', t.id);
    return { ok: true, txid: signed.hash, explorer: `${C.explorer}/tx/${signed.hash}`, sent: send.toString(), confirmed: !!rc, rc: rc ? rc.status : null };
  }

  // move ZRO from deposit addresses into the hot wallet. Two phases, never blocking: gas top-up now, sweep on a later tick.
  async sweepDeposits() {
    const hot = new Wallet(this.hotWallet().privateKey);
    const done = [];
    for (const chain of ZRO_CHAINS) {
      try {
        const busy = new Set(this.sql.exec(`SELECT src_user FROM out_pending WHERE chain=? AND COALESCE(asset,'zro')='zro'`, chain).toArray().map(r => r.src_user));
        const cands = this.sql.exec(`SELECT d.user_id, d.last, u.dep_index, u.dep_address FROM deposit_seen d JOIN users u ON u.id=d.user_id WHERE d.chain=?`, chain)
          .toArray().filter(r => B(r.last) >= SWEEP_MIN[chain] && !busy.has(r.user_id)).sort((a, b) => (B(b.last) > B(a.last) ? 1 : -1)).slice(0, 2);
        if (!cands.length) continue;
        const gp = BigInt(await rpc(chain, 'eth_gasPrice', [])) * 5n / 4n + 1n;
        let hotNative = BigInt(await rpc(chain, 'eth_getBalance', [hot.address, 'latest']));
        for (const c of cands) {
          const w = new Wallet(this.master().deriveChild(c.dep_index).privateKey);
          const bal = await this.zroBalanceOf(chain, w.address);
          if (bal < SWEEP_MIN[chain]) continue;
          // only sweep what has been credited: a fresh, not yet confirmed deposit would otherwise leave with it
          if (bal !== B(c.last)) continue;
          const data = XFER_IFACE.encodeFunctionData('transfer', [hot.address, bal]);
          let gasLimit;
          try { gasLimit = BigInt(await rpc(chain, 'eth_estimateGas', [{ from: w.address, to: ZRO_TOKEN, data }])) * 13n / 10n; } catch { gasLimit = WD_GAS; }
          const need = gasLimit * gp * 2n;
          const have = BigInt(await rpc(chain, 'eth_getBalance', [w.address, 'latest']));
          if (have < need) {
            const tk = `topup_${chain}_${c.user_id}`;
            if (now() - Number(this.meta(tk) || 0) < 3 * 60e3) continue; // top-up already on its way
            const top = need - have;
            if (hotNative < top + TOPUP_GAS * gp * 3n) break; // hot wallet is out of gas on this chain
            const t = await this.signTx(chain, hot, { to: w.address, value: top });
            await broadcastAll(chain, t.raw); t.used();
            hotNative -= top + t.gasLimit * t.gasPrice;
            this.setMeta(tk, String(now()));
            done.push({ chain, user: c.user_id, action: 'gas', tx: t.hash });
            continue;
          }
          const sg = await this.signTx(chain, w, { to: ZRO_TOKEN, data, gasLimit });
          let oid;
          this.ctx.storage.transactionSync(() => {
            this.sql.exec('INSERT INTO out_pending (transfer_id,src_user,chain,amount,txid,ts,raw) VALUES (?,?,?,?,?,?,?)', 0, c.user_id, chain, bal.toString(), sg.hash, now(), sg.raw);
            oid = this.sql.exec('SELECT last_insert_rowid() id').one().id;
          });
          try { await broadcastAll(chain, sg.raw); sg.used(); done.push({ chain, user: c.user_id, action: 'sweep', zro: Number(bal) / 1e18, tx: sg.hash }); }
          catch (e) {
            sg.used();   // keep it on the books: the scanner settles it from the receipt or drops it after 10 minutes
            done.push({ chain, user: c.user_id, action: 'sweep', zro: Number(bal) / 1e18, tx: sg.hash, note: 'broadcast uncertain: ' + String(e.message || e).slice(0, 80) });
          }
        }
      } catch (e) { done.push({ chain, error: String(e.message || e).slice(0, 120) }); }
    }
    if (done.length) this.setMeta('last_sweep', JSON.stringify({ ts: now(), done }).slice(0, 4000));
    return done;
  }
  settleOutflows() { /* outflows are settled inside scanChain, against the same block the balances are read at */ }

  /* ───────────── deposit detection ─────────────
     Every minute, for every chain: read the ZRO balance of ALL deposit addresses with one Multicall3 eth_call,
     pinned to a confirmed block. Balance growth = deposit. Outgoing omnibus transfers (withdrawals paid from a
     deposit address) are subtracted only once their receipt block is <= that same block, so a lagging node or a
     race can never turn our own withdrawal into a phantom deposit. */
  async balancesAt(chain, addrs, tag) {
    const out = [];
    for (let i = 0; i < addrs.length; i += 200) {
      const part = addrs.slice(i, i + 200);
      const data = MC_IFACE.encodeFunctionData('aggregate3', [part.map(a => ({ target: ZRO_TOKEN, allowFailure: false, callData: ERC20_IFACE.encodeFunctionData('balanceOf', [a]) }))]);
      const res = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data }, tag]);
      const [rows] = MC_IFACE.decodeFunctionResult('aggregate3', res);
      for (const r of rows) { if (!r.success) throw new Error('balanceOf failed'); out.push(BigInt(r.returnData)); }
    }
    return out;
  }
  async scanChain(chain, users) {
    const C = CHAINS[chain];
    const head = BigInt(await rpc(chain, 'eth_blockNumber', []));
    let blk = head - (C.conf || 5n);
    const prev = B(this.meta('balblk_' + chain));
    if (blk < prev) blk = prev; // never look at an older state than last time
    const tag = toHex(blk);
    // 1) settle our own outflows that are final at or before blk
    const busy = new Set();
    for (const o of this.sql.exec(`SELECT * FROM out_pending WHERE chain=? AND COALESCE(asset,'zro')='zro' ORDER BY id`, chain).toArray()) {
      let rc = null;
      try { rc = await rpc(chain, 'eth_getTransactionReceipt', [o.txid]); } catch { busy.add(o.src_user); continue; }
      if (!rc && !o.transfer_id && now() - o.ts > 10 * 60e3) {
        // a sweep that has not landed in 10 minutes is dead (dropped, or stuck behind a nonce gap): forget it.
        // Safe: the ledger is only reduced when a sweep confirms, and the ZRO is still on the deposit address.
        this.sql.exec('DELETE FROM out_pending WHERE id=?', o.id);
        this.setMeta('dropped_sweep_' + o.id, JSON.stringify({ chain, txid: o.txid, ts: now() }));
        continue;
      }
      if (!rc && o.raw && now() - o.ts > 3 * 60e3) { // never landed: rebroadcast, or drop if its nonce was used by another tx
        const known = await rpc(chain, 'eth_getTransactionByHash', [o.txid]).catch(() => 'err');
        if (!known) {
          try { await broadcastAll(chain, o.raw); }
          catch (e) {
            // a sweep (transfer_id 0) that never landed is safe to drop: the ledger was never reduced, the ZRO is still on the address
            if (!o.transfer_id && now() - o.ts > 10 * 60e3) {
              this.sql.exec('DELETE FROM out_pending WHERE id=?', o.id);
              this.setMeta('dropped_sweep_' + o.id, JSON.stringify({ chain, txid: o.txid, reason: String(e.message).slice(0, 120), ts: now() }));
              continue;
            }
            if (/nonce too low/i.test(String(e.message)) && !(await rpc(chain, 'eth_getTransactionReceipt', [o.txid]).catch(() => 1))) {
              this.ctx.storage.transactionSync(() => {
                this.sql.exec('DELETE FROM out_pending WHERE id=?', o.id);
                const t = o.transfer_id && this.sql.exec('SELECT * FROM transfers WHERE id=?', o.transfer_id).toArray()[0];
                if (t && t.status === 'sent') { this.addBal(t.user_id, t.asset || 'zro', B(t.amount)); this.sql.exec(`UPDATE transfers SET status='failed', raw=NULL, note='Not sent (nonce replaced), refunded' WHERE id=?`, t.id); }
              });
              continue;
            }
          }
        }
      }
      if (!rc || BigInt(rc.blockNumber) > blk) { busy.add(o.src_user); continue; }
      this.ctx.storage.transactionSync(() => {
        if (!this.sql.exec('SELECT id FROM out_pending WHERE id=?', o.id).toArray().length) return;
        if (rc.status === '0x1') {
          const r = this.sql.exec('SELECT last FROM deposit_seen WHERE user_id=? AND chain=?', o.src_user, chain).toArray()[0];
          const nl = (r ? B(r.last) : 0n) - B(o.amount);
          this.sql.exec('UPDATE deposit_seen SET last=? WHERE user_id=? AND chain=?', (nl > 0n ? nl : 0n).toString(), o.src_user, chain);
        } else {
          const t = this.sql.exec('SELECT * FROM transfers WHERE id=?', o.transfer_id).toArray()[0];
          if (t && t.status === 'sent') { this.addBal(t.user_id, t.asset || 'zro', B(t.amount)); this.sql.exec(`UPDATE transfers SET status='failed', note='Reverted on-chain, refunded' WHERE id=?`, t.id); }
        }
        this.sql.exec('DELETE FROM out_pending WHERE id=?', o.id);
      });
    }
    // 2) one multicall for every deposit address
    const bals = await this.balancesAt(chain, users.map(u => u.dep_address), tag);
    const found = [];
    users.forEach((u, i) => {
      if (busy.has(u.id)) return;
      const cur = bals[i];
      this.ctx.storage.transactionSync(() => {
        // re-check synchronously: a withdrawal may have been sent from this address while we were reading
        if (this.sql.exec(`SELECT id FROM out_pending WHERE src_user=? AND chain=? AND COALESCE(asset,'zro')='zro'`, u.id, chain).toArray().length) return;
        const row = this.sql.exec('SELECT last FROM deposit_seen WHERE user_id=? AND chain=?', u.id, chain).toArray()[0];
        const last = row ? B(row.last) : 0n;
        if (cur > last) {
          const delta = cur - last;
          this.addBal(u.id, 'zro', delta);
          this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,status,note,ts) VALUES (?,?,?,?,?,?,?)`,
            u.id, 'deposit', chain, delta.toString(), 'confirmed', `Detected on-chain (block ${blk})`, now());
          found.push({ user: u.username, chain, amount: delta.toString() });
        }
        if (!row || cur !== last) this.sql.exec(`INSERT INTO deposit_seen (user_id,chain,last) VALUES (?,?,?)
          ON CONFLICT(user_id,chain) DO UPDATE SET last=excluded.last`, u.id, chain, cur.toString());
      });
    });
    // deposits credited above may settle a one-signature order
    for (const f of found) {
      const uu = this.sql.exec('SELECT id FROM users WHERE username=?', f.user).toArray()[0];
      if (uu) { try { const r = this.evmOrderFill(uu.id, 'zro', f.amount); if (r) f.order = r; } catch { /* next tick */ } }
    }
    this.setMeta('balblk_' + chain, blk.toString()); // monotonic: every later read uses this block or newer
    if (users.length > 1) this.setMeta('scan_ok_' + chain, String(now()));
    return found;
  }
  async scanDeposits() {
    this._scanning = true;
    try { return await this.scanDepositsInner(); } finally { this._scanning = false; }
  }
  async scanDepositsInner() {
    const users = this.sql.exec('SELECT * FROM users WHERE dep_address IS NOT NULL').toArray();
    if (!users.length) return { credited: [] };
    const credited = [], errors = {};
    this.ensureEthAddresses();
    const ethUsers = this.sql.exec('SELECT * FROM users WHERE eth_dep_address IS NOT NULL').toArray();
    await Promise.all([
      ...ZRO_CHAINS.map(async (chain) => {
        try { credited.push(...(await this.scanChain(chain, users))); }
        catch (e) { errors[chain] = String(e.message || e).slice(0, 160); this.setMeta('scan_err_' + chain, errors[chain]); }
      }),
      ...ETH_CHAINS.map(async (chain) => {
        try { credited.push(...(await this.scanEthChain(chain, ethUsers))); this.setMeta('scan_ok_eth@' + chain, String(now())); }
        catch (e) { errors['eth@' + chain] = String(e.message || e).slice(0, 160); this.setMeta('scan_err_eth@' + chain, errors['eth@' + chain]); }
      }),
    ]);
    for (const c of credited) this.notifyDeposit?.(c);
    return { credited, errors };
  }

  /* ───────────── ETH: deposit addresses, detection, sweeps, withdrawals ───────────── */
  ethReserve(chain) {
    const d = { ethereum: 5n * WEI / 1000n, base: 2n * WEI / 1000n, arbitrum: 2n * WEI / 1000n, robinhood: 2n * WEI / 1000n }[chain] || 0n;
    const o = this.meta('eth_reserve_' + chain);
    return o !== null && o !== '' ? B(o) : d;
  }
  ethWallet(depIndex) { return new Wallet(this.master().deriveChild(ETH_OFFSET + depIndex).privateKey); }
  ensureEthAddresses() {
    for (const u of this.sql.exec('SELECT id, dep_index FROM users WHERE eth_dep_address IS NULL AND dep_index IS NOT NULL LIMIT 500').toArray())
      this.sql.exec('UPDATE users SET eth_dep_address=? WHERE id=?', this.master().deriveChild(ETH_OFFSET + u.dep_index).address, u.id);
  }
  async ethBalancesAt(chain, addrs, tag) {
    const IF = new Interface(['function getEthBalance(address addr) view returns (uint256)']);
    const out = [];
    for (let i = 0; i < addrs.length; i += 200) {
      const part = addrs.slice(i, i + 200);
      const data = MC_IFACE.encodeFunctionData('aggregate3', [part.map(a => ({ target: MULTICALL3, allowFailure: false, callData: IF.encodeFunctionData('getEthBalance', [a]) }))]);
      const res = await rpc(chain, 'eth_call', [{ to: MULTICALL3, data }, tag]);
      const [rows] = MC_IFACE.decodeFunctionResult('aggregate3', res);
      for (const r of rows) { if (!r.success) throw new Error('getEthBalance failed'); out.push(BigInt(r.returnData)); }
    }
    return out;
  }
  // Same model as ZRO: balances read at a confirmed block; our own sweeps are settled against that block.
  // A sweep records the credited balance it started from (pre_bal) and the value sent; once its receipt is final,
  // the address should hold pre_bal - value - gas actually paid. Anything above that is a new deposit.
  async scanEthChain(chain, users) {
    const C = CHAINS[chain], key = 'eth@' + chain;
    const head = BigInt(await rpc(chain, 'eth_blockNumber', []));
    let blk = head - (C.conf || 5n);
    const prev = B(this.meta('balblk_' + key));
    if (blk < prev) blk = prev;
    const tag = toHex(blk);
    const busy = new Set(), done = new Map();
    for (const o of this.sql.exec(`SELECT * FROM out_pending WHERE chain=? AND asset='eth' ORDER BY id`, chain).toArray()) {
      let rc = null;
      try { rc = await rpc(chain, 'eth_getTransactionReceipt', [o.txid]); } catch { busy.add(o.src_user); continue; }
      if (!rc) {
        if (now() - o.ts > 10 * 60e3) { this.sql.exec('DELETE FROM out_pending WHERE id=?', o.id); continue; } // dead sweep: nothing moved
        if (now() - o.ts > 3 * 60e3 && o.raw) await broadcastAll(chain, o.raw).catch(() => {});
        busy.add(o.src_user); continue;
      }
      if (BigInt(rc.blockNumber) > blk) { busy.add(o.src_user); continue; }
      done.set(o.src_user, { o, rc });
    }
    const bals = users.length ? await this.ethBalancesAt(chain, users.map(u => u.eth_dep_address), tag) : [];
    const found = [];
    users.forEach((u, i) => {
      if (busy.has(u.id)) return;
      const cur = bals[i];
      this.ctx.storage.transactionSync(() => {
        const d = done.get(u.id);
        if (!d && this.sql.exec(`SELECT id FROM out_pending WHERE src_user=? AND chain=? AND asset='eth'`, u.id, chain).toArray().length) return;
        const row = this.sql.exec('SELECT last FROM deposit_seen WHERE user_id=? AND chain=?', u.id, key).toArray()[0];
        let last = row ? B(row.last) : 0n;
        if (d) {
          const gas = B(d.rc.gasUsed) * B(d.rc.effectiveGasPrice || d.rc.gasPrice || 0) + B(d.rc.l1Fee || 0);
          last = B(d.o.pre_bal) - (d.rc.status === '0x1' ? B(d.o.amount) : 0n) - gas;
          if (last < 0n) last = 0n;
          this.sql.exec('DELETE FROM out_pending WHERE id=?', d.o.id);
        }
        if (cur > last) {
          const delta = cur - last;
          this.addBal(u.id, 'eth', delta);
          this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?)`,
            u.id, 'deposit', chain, delta.toString(), 'confirmed', `Detected on-chain (block ${blk})`, now(), 'eth');
          found.push({ user: u.username, chain, asset: 'eth', amount: delta.toString() });
        }
        if (!row || cur !== last) this.sql.exec(`INSERT INTO deposit_seen (user_id,chain,last) VALUES (?,?,?)
          ON CONFLICT(user_id,chain) DO UPDATE SET last=excluded.last`, u.id, key, cur.toString());
      });
    });
    // deposits credited above may settle a one-signature order
    for (const f of found) {
      const uu = this.sql.exec('SELECT id FROM users WHERE username=?', f.user).toArray()[0];
      if (uu) { try { const r = this.evmOrderFill(uu.id, 'eth', f.amount); if (r) f.order = r; } catch { /* next tick */ } }
    }
    this.setMeta('balblk_' + key, blk.toString());
    return found;
  }
  // move credited ETH from deposit addresses to the hot wallet; gas is paid from the swept ETH itself
  async sweepEth() {
    const MINS = { ethereum: 3n * WEI / 1000n, base: 3n * WEI / 10000n, arbitrum: 3n * WEI / 10000n };
    const hot = this.hotWallet().address, done = [];
    for (const chain of ETH_CHAINS) {
      try {
        const key = 'eth@' + chain;
        const busy = new Set(this.sql.exec(`SELECT src_user FROM out_pending WHERE chain=? AND asset='eth'`, chain).toArray().map(r => r.src_user));
        const cands = this.sql.exec(`SELECT d.user_id, d.last, u.dep_index FROM deposit_seen d JOIN users u ON u.id=d.user_id WHERE d.chain=?`, key)
          .toArray().filter(r => B(r.last) >= MINS[chain] && !busy.has(r.user_id)).slice(0, 3);
        for (const c of cands) {
          const w = this.ethWallet(c.dep_index), seen = B(c.last);
          const onchain = BigInt(await rpc(chain, 'eth_getBalance', [w.address, 'latest']));
          // anything else means a payment or an earlier sweep is still in flight: sweeping now could move
          // money the scanner has not credited yet. Wait for the next tick.
          if (onchain !== seen) continue;
          const gp = BigInt(await rpc(chain, 'eth_gasPrice', [])) * 5n / 4n + 1n;
          let gasLimit = 21000n;
          try { gasLimit = BigInt(await rpc(chain, 'eth_estimateGas', [{ from: w.address, to: hot, value: toHex(1n) }])) * 13n / 10n; } catch {}
          const l1Buf = chain === 'base' ? 10_000_000_000_000n : 0n;      // 0.00001 ETH for Base's L1 data fee
          const value = seen - gasLimit * gp * 2n - l1Buf;
          if (value <= 0n) continue;
          const sg = await this.signTx(chain, w, { to: hot, value, gasLimit });
          this.sql.exec('INSERT INTO out_pending (transfer_id,src_user,chain,amount,txid,ts,raw,asset,pre_bal) VALUES (?,?,?,?,?,?,?,?,?)',
            0, c.user_id, chain, value.toString(), sg.hash, now(), sg.raw, 'eth', seen.toString());
          try { await broadcastAll(chain, sg.raw); sg.used(); done.push({ chain, user: c.user_id, eth: Number(value) / 1e18, tx: sg.hash }); }
          catch (e) {
            // never forget a signed sweep on a failed broadcast: it may still land. The scanner rebroadcasts it,
            // settles it from its receipt, or drops it after 10 minutes without one.
            sg.used();
            done.push({ chain, user: c.user_id, eth: Number(value) / 1e18, tx: sg.hash, note: 'broadcast uncertain: ' + String(e.message || e).slice(0, 80) });
          }
        }
      } catch (e) { done.push({ chain, error: String(e.message || e).slice(0, 120) }); }
    }
    if (done.length) this.setMeta('last_sweep_eth', JSON.stringify({ ts: now(), done }).slice(0, 3000));
    return done;
  }
  async ethFee(chain) {
    const gp = await this.gasPrice(chain);
    const gas = chain === 'arbitrum' ? 600_000n : 21_000n;            // Arbitrum gas includes the L1 component
    const min = chain === 'ethereum' ? 2n * WEI / 10000n : 2n * WEI / 100000n; // 0.0002 / 0.00002 ETH
    let fee = BigInt(Math.ceil(Number(gas * gp) * FEE_MARGIN));
    if (chain === 'base') fee += 30_000_000_000_000n;
    if (fee < min) fee = min;
    return fee;
  }
  async withdrawEth(user, { chain, to, amount }, ctx = {}) {
    if (!ETH_CHAINS.includes(chain)) throw new Error('ETH withdrawals are available on Ethereum, Base, Arbitrum and Robinhood Chain');
    if (!isAddress(to)) throw new Error('Invalid destination address');
    const amt = B(amount);
    if (amt <= 0n) throw new Error('Enter an amount');
    if (this.meta('withdrawals_paused') === '1') throw new Error('Withdrawals are paused for maintenance');
    const fee = await this.ethFee(chain);
    if (amt <= fee) throw new Error(`Amount must be higher than the ${Number(fee) / 1e18} ETH network fee`);
    const send = amt - fee;
    let tid;
    this.ctx.storage.transactionSync(() => {
      this.addBal(user.id, 'eth', -amt);
      this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?)`,
        user.id, 'withdrawal', chain, amt.toString(), getAddress(to), 'pending', `fee ${Number(fee) / 1e18} ETH`, now(), 'eth');
      tid = this.sql.exec('SELECT last_insert_rowid() id').one().id;
    });
    ctx.tid = tid;
    const C = CHAINS[chain];
    try {
      const hot = new Wallet(this.hotWallet().privateKey);
      const bal = BigInt(await rpc(chain, 'eth_getBalance', [hot.address, 'latest']));
      if (bal < send + this.ethReserve(chain)) throw new Error(`ETH payouts on ${C.label} are short on liquidity right now. Try another network.`);
      let gasLimit = 21000n;
      try { gasLimit = BigInt(await rpc(chain, 'eth_estimateGas', [{ from: hot.address, to: getAddress(to), value: toHex(send) }])) * 13n / 10n; } catch {}
      const signed = await this.signTx(chain, hot, { to: getAddress(to), value: send, gasLimit });
      this.ctx.storage.transactionSync(() => {
        if (this.sql.exec('SELECT status FROM transfers WHERE id=?', tid).one().status !== 'pending') throw new Error('__aborted');
        this.sql.exec(`UPDATE transfers SET status='sent', txid=?, raw=? WHERE id=?`, signed.hash, signed.raw, tid);
      });
      try { await broadcastAll(chain, signed.raw); signed.used(); }
      catch (be) {
        await new Promise(r => setTimeout(r, 1500));
        const known = await rpc(chain, 'eth_getTransactionByHash', [signed.hash]).catch(() => null);
        if (!known) {
          this.sql.exec(`UPDATE transfers SET status='pending', txid='', raw=NULL WHERE id=?`, tid);
          throw be;
        }
      }
      this.setMeta('fee_revenue_eth', (B(this.meta('fee_revenue_eth')) + fee).toString());
      return { ok: true, asset: 'eth', txid: signed.hash, explorer: `${C.explorer}/tx/${signed.hash}`, sent: send.toString(), fee: fee.toString() };
    } catch (e) {
      const st = this.sql.exec('SELECT status FROM transfers WHERE id=?', tid).toArray()[0]?.status;
      if (st === 'sent') return { ok: true, pending: true, note: 'Sent, waiting for confirmation' };
      if (st !== 'pending') throw new Error('Withdrawal was cancelled and refunded');
      this.ctx.storage.transactionSync(() => {
        if (this.sql.exec('SELECT status FROM transfers WHERE id=?', tid).one().status !== 'pending') return;
        this.addBal(user.id, 'eth', amt);
        this.sql.exec(`UPDATE transfers SET status='failed', note=? WHERE id=?`, String(e.shortMessage || e.message).slice(0, 200), tid);
      });
      const friendly = /liquidity|slow right now/.test(e.message || '');
      throw new Error(friendly ? e.message : `${C.label} network is busy right now, your balance was refunded. Please try again in a moment.`);
    }
  }

  /* ───────────── owner feed: every deposit and withdrawal, privately, to one Telegram chat ───────────── */
  async ownerFeed(dry = false) {
    const chat = this.meta('tg_owner_chat');
    if (!dry && (!chat || !this.env.TG_BOT_TOKEN)) return { off: true };
    const rows = this.sql.exec(`SELECT t.*, u.username FROM transfers t LEFT JOIN users u ON u.id=t.user_id
      WHERE ${dry ? '1=1' : 't.tg_notified IS NULL'} AND t.kind IN ('deposit','withdrawal') AND t.status IN ('confirmed','sent','failed','unassigned','reversed')
      ORDER BY t.id ${dry ? 'DESC LIMIT 8' : 'LIMIT 25'}`).toArray();
    if (!rows.length) return { sent: 0 };
    const host = this.meta('public_host') || 'rookery.stinkypenguin.xyz';
    const n = (w, d = 4) => (Number(B(w)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: d });
    const lines = [];
    for (const t of rows) {
      const asset = t.asset || 'zro';
      // address-poisoning dust (0.0001 XLM with a copied memo) is not worth a ping
      if (t.kind === 'deposit' && t.status === 'unassigned' && B(t.amount) < 10n ** 16n) continue;
      let label = asset.toUpperCase(), usd = 0;
      if (asset.startsWith('t:')) { const m = this.sql.exec('SELECT symbol FROM markets WHERE id=?', asset.slice(2)).toArray()[0]; label = '$' + (m?.symbol || asset.slice(2)); }
      else usd = (Number(B(t.amount)) / 1e18) * this.usdOf(asset);
      const net = t.chain === 'stellar' ? 'Stellar' : t.chain === 'manual' ? 'admin credit' : (CHAINS[t.chain]?.label || t.chain);
      const hash = t.chain === 'stellar' ? ((String(t.note || '').match(/tx ([0-9a-f]{64})/) || [])[1] || (/^[0-9a-f]{64}$/.test(t.txid || '') ? t.txid : '')) : (t.txid || '');
      const explorer = t.chain === 'stellar' ? ST_NETS[this.stNet()].explorer : CHAINS[t.chain]?.explorer;
      const link = hash && explorer ? ` · <a href="${explorer}/tx/${hash}">tx</a>` : '';
      const who = t.username ? `<a href="https://${host}/#/u/${encodeURIComponent(t.username)}">${escH(t.username)}</a>` : 'no account';
      const amt = `<b>${n(t.amount)} ${escH(label)}</b>${usd >= 0.01 ? ` ($${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : ''}`;
      if (t.kind === 'deposit' && t.status === 'unassigned') lines.push(`🟡 <b>Deposit without memo</b> · ${amt} · ${net}${link}\nfrom <code>${escH(String(t.to_addr || '').slice(0, 8))}…</code> — assign it in admin`);
      else if (t.kind === 'deposit') lines.push(`🟢 <b>Deposit</b> · ${amt} · ${net} · ${who}${link}`);
      else if (t.status === 'sent') lines.push(`🔴 <b>Withdrawal</b> · ${amt} · ${net} · ${who}${link}`);
      else lines.push(`⚠️ <b>Withdrawal ${t.status === 'reversed' ? 'reversed' : 'failed, refunded'}</b> · ${amt} · ${net} · ${who}\n<i>${escH(String(t.note || '').slice(0, 120))}</i>`);
    }
    if (dry) return { preview: lines };
    // one message per batch keeps the chat readable; Telegram caps a message at 4096 chars
    let buf = '';
    const flush = async () => { if (buf) { await this.tg('sendMessage', { chat_id: chat, text: buf, parse_mode: 'HTML', disable_web_page_preview: true }); buf = ''; } };
    for (const l of lines) { if ((buf + '\n\n' + l).length > 3800) await flush(); buf = buf ? buf + '\n\n' + l : l; }
    await flush();
    for (const t of rows) this.sql.exec('UPDATE transfers SET tg_notified=1 WHERE id=?', t.id);
    return { sent: rows.length };
  }

  // bridge transfers for the owner chat: success, refunds, failures and anything stuck
  async ownerBridgeFeed(dry = false) {
    const chat = this.meta('tg_owner_chat');
    if (!dry && (!chat || !this.env.TG_BOT_TOKEN)) return { off: true };
    const t = now();
    const rows = this.sql.exec(`SELECT o.*, u.username FROM xb_orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${dry ? '1=1' : `(
        (o.status IN ('SUCCESS','REFUNDED','FAILED','INCOMPLETE_DEPOSIT') AND COALESCE(o.tg_state,'')!=o.status)
        OR (o.status IN ('KNOWN_DEPOSIT_TX','PROCESSING') AND (o.in_tx!='' OR o.status='PROCESSING') AND o.created<? AND COALESCE(o.tg_state,'')=''))`}
      ORDER BY o.created ${dry ? 'DESC LIMIT 8' : 'LIMIT 20'}`, ...(dry ? [] : [t - 30 * 60e3])).toArray();
    if (!rows.length) return { sent: 0 };
    const host = this.meta('public_host') || 'rookery.stinkypenguin.xyz';
    const usd = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const lines = rows.map(o => {
      const A = XB_NETS[o.from_net] || {}, Z = XB_NETS[o.to_net] || {};
      const who = o.username ? `<a href="https://${host}/#/u/${encodeURIComponent(o.username)}">${escH(o.username)}</a>` : 'guest';
      const f6 = (x) => Number(x || 0).toLocaleString('en-US', { maximumFractionDigits: 6 });
      const route = `<b>${f6(o.amount_in)} ${escH(A.sym || '')}</b> ${escH(A.label || o.from_net)} → <b>${o.out_fmt ? f6(o.out_fmt) : '≈' + f6(o.out_est)} ${escH(Z.sym || '')}</b> ${escH(Z.label || o.to_net)} (${usd(o.in_usd)})`;
      const inL = o.in_tx && A.tx ? ` · <a href="${A.tx}${o.in_tx}">in</a>` : '';
      const outL = o.out_tx && Z.tx ? ` · <a href="${Z.tx}${o.out_tx}">out</a>` : '';
      const refL = o.refund_tx && A.tx ? ` · <a href="${A.tx}${o.refund_tx}">refund</a>` : '';
      const to = `\nto <code>${escH(String(o.recipient).slice(0, 10))}…</code> · ${who}`;
      if (o.status === 'SUCCESS') return `🌉 <b>Bridge delivered</b> · ${route}${inL}${outL}${to}\nfee earned ≈ ${usd(o.in_usd * this.xbCfg().feeBps / 20000)}`;
      if (o.status === 'REFUNDED') return `↩️ <b>Bridge refunded</b> · ${route}${inL}${refL}${to}`;
      if (o.status === 'FAILED') return `❌ <b>Bridge failed</b> · ${route}${inL}${to}\n<i>funds go back to the refund address automatically, check it</i>`;
      if (o.status === 'INCOMPLETE_DEPOSIT') return `⚠️ <b>Bridge underpaid</b> · ${route}${inL}${to}\n<i>the payment was smaller than the order, it will be refunded</i>`;
      return `⏳ <b>Bridge slow (30+ min)</b> · ${route}${inL}${to}\nstatus: ${escH(o.status)}`;
    });
    if (dry) return { preview: lines };
    let buf = '';
    const flush = async () => { if (buf) { await this.tg('sendMessage', { chat_id: chat, text: buf, parse_mode: 'HTML', disable_web_page_preview: true }); buf = ''; } };
    for (const l of lines) { if ((buf + '\n\n' + l).length > 3800) await flush(); buf = buf ? buf + '\n\n' + l : l; }
    await flush();
    for (const o of rows) this.sql.exec('UPDATE xb_orders SET tg_state=? WHERE ref=?', ['SUCCESS', 'REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(o.status) ? o.status : 'SLOW', o.ref);
    return { sent: rows.length };
  }

  /* ───────────── Telegram buybot ───────────── */
  async tg(method, body) {
    if (!this.env.TG_BOT_TOKEN) return null;
    const r = await fetch(`https://api.telegram.org/bot${this.env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => null);
  }
  tgNet(m) {
    if (m.network === 'giwa') return 'GIWA by Upbit (pre-mainnet)';
    if (m.network === 'robinhood') return 'Robinhood Chain';
    if (m.network === 'stellar') return m.migrated ? 'Stellar · on Aquarius' : `Stellar · graduates to Aquarius at ${usdTxt(m.stellar?.gradUsd || 46000)}`;
    return 'Zero by LayerZero (pre-mainnet)';
  }
  buyMessage(m, t, usd, buyer, host, emoji) {
    usd = m.quoteUsd || usd;
    const spentUsd = (Number(B(t.zro)) / 1e18) * usd;
    const unit = emoji || '🟢';
    const dots = unit.repeat(Math.max(1, Math.min(30, Math.round(spentUsd / 10))));
    const bars = Math.round(Math.min(100, m.progress) / 10);
    return `<b>${escH(m.name)} ($${escH(m.symbol)}) Buy!</b>\n${dots}\n\n` +
      `💸 <b>Spent:</b> ${(Number(B(t.zro)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: m.quote === 'ETH' ? 5 : 2 })} ${m.quote || 'ZRO'} (${usdTxt(spentUsd)})\n` +
      `🐧 <b>Got:</b> ${tokTxt(t.tokens)} ${escH(m.symbol)}\n` +
      `👤 <b>Buyer:</b> <a href="https://${host}/#/u/${encodeURIComponent(buyer)}">${escH(buyer)}</a>\n` +
      `💲 <b>Price:</b> ${usdTxt(m.priceUsd)}\n` +
      `📊 <b>Market cap:</b> ${usdTxt(m.mcapUsd)}\n` +
      `🥚 <b>${m.network === 'stellar' ? 'To Aquarius' : 'Bonded'}:</b> ${m.progress.toFixed(1)}%  ${'▰'.repeat(bars)}${'▱'.repeat(10 - bars)}\n` +
      `👥 <b>Holders:</b> ${m.holders}\n` +
      `🌐 <b>Network:</b> ${this.tgNet(m)}`;
  }
  // inline buttons: Buy / Chart, then socials, then the penguin burn
  buyKeyboard(m, sub, host) {
    const page = `https://${host}/#/t/${m.id}`;
    const rows = [[{ text: `🛒 Buy $${m.symbol}`, url: page }, { text: '📈 Chart', url: page }]];
    const x = sub?.x || m.x, tg = sub?.tg || m.tg, web = sub?.web || m.web;
    const social = [];
    if (x) social.push({ text: '𝕏 Twitter', url: x });
    if (tg) social.push({ text: '💬 Telegram', url: tg });
    if (web) social.push({ text: '🌐 Website', url: web });
    if (social.length) rows.push(social);
    rows.push([{ text: '🔥 0.5% of every trade burns $臭企鹅', url: `https://${host}/#/proofs/burns` }]);
    return { inline_keyboard: rows };
  }
  async postTo(chat_id, text, keyboard, media, fallbackPhoto) {
    const base = { chat_id, caption: text, parse_mode: 'HTML', reply_markup: keyboard };
    let r = null;
    if (media?.id) {
      if (media.type === 'animation') r = await this.tg('sendAnimation', { ...base, animation: media.id });
      else if (media.type === 'video') r = await this.tg('sendVideo', { ...base, video: media.id });
      else r = await this.tg('sendPhoto', { ...base, photo: media.id });
    } else if (fallbackPhoto) {
      r = await this.tg('sendPhoto', { ...base, photo: fallbackPhoto });
    }
    if (!r || !r.ok) r = await this.tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
    return r;
  }
  async notifyBuy(marketId, trade, buyer, host) {
    if (!this.env.TG_BOT_TOKEN) return;
    const m = this.view(this.market(marketId), this.zroUsd());
    const usd = m.quoteUsd || this.usdOf(qa(m));
    const spentUsd = (Number(B(trade.zro)) / 1e18) * usd;
    const subs = this.sql.exec('SELECT * FROM tg_subs WHERE market=?', marketId).toArray().filter(s => spentUsd >= (s.min_usd || 0));
    const feed = this.meta('tg_feed_chat');
    if (feed && !subs.some(s => s.chat_id === feed)) subs.push({ chat_id: feed });
    const raw = this.sql.exec('SELECT image FROM markets WHERE id=?', marketId).toArray()[0]?.image;
    const tokenImg = raw ? `https://${host}/api/img/m/${marketId}` : null;
    for (const s of subs) {
      const text = this.buyMessage(m, trade, usd, buyer, host, s.emoji);
      const r = await this.postTo(s.chat_id, text, this.buyKeyboard(m, s, host), s.media_id ? { id: s.media_id, type: s.media_type } : null, tokenImg);
      if (r && !r.ok && [400, 403].includes(r.error_code) && /chat not found|kicked|not a member|blocked/i.test(r.description || '')) {
        this.sql.exec('DELETE FROM tg_subs WHERE chat_id=?', s.chat_id);
      }
    }
  }
  async notifyLaunch(marketId, host) {
    const feed = this.meta('tg_feed_chat');
    if (!this.env.TG_BOT_TOKEN || !feed) return;
    const m = this.view(this.market(marketId), this.zroUsd());
    const text = `🥚 <b>New token hatched on Rookery</b>\n\n<b>${escH(m.name)} ($${escH(m.symbol)})</b>\n` +
      `🌐 ${this.tgNet(m)} · pair ${escH(m.symbol)}/${m.quote || 'ZRO'}\n👤 by ${escH(m.creator)}\n` +
      `🧾 Taxes: ${m.taxes.marketing}% marketing · ${m.taxes.burn}% burn · ${m.taxes.rewards}% ${m.quote || 'ZRO'} rewards`;
    const raw = this.sql.exec('SELECT image FROM markets WHERE id=?', marketId).toArray()[0]?.image;
    await this.postTo(feed, text, this.buyKeyboard(m, null, host), null, raw ? `https://${host}/api/img/m/${marketId}` : null);
  }
  parseMarketRef(s) {
    s = String(s || '').trim();
    const mm = s.match(/#\/t\/([a-z0-9-]+)/i);
    const id = mm ? mm[1] : s.replace(/^\$/, '');
    let row = this.sql.exec('SELECT id FROM markets WHERE id=?', id).toArray()[0];
    if (!row) row = this.sql.exec('SELECT id FROM markets WHERE symbol=? COLLATE NOCASE ORDER BY created DESC LIMIT 1', id).toArray()[0];
    return row?.id || null;
  }
  mediaOf(msg) {
    if (!msg) return null;
    if (msg.animation) return { id: msg.animation.file_id, type: 'animation' };
    if (msg.video) return { id: msg.video.file_id, type: 'video' };
    if (msg.photo?.length) return { id: msg.photo[msg.photo.length - 1].file_id, type: 'photo' };
    if (msg.document && /gif|mp4/.test(msg.document.mime_type || '')) return { id: msg.document.file_id, type: 'animation' };
    return null;
  }
  async tgUpdate(u, host) {
    const msg = u.message || u.channel_post;
    if (!msg) return;
    const text = (msg.text || msg.caption || '').trim();
    if (!text.startsWith('/')) return;
    const chat = msg.chat;
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    const reply = (t, extra = {}) => this.tg('sendMessage', { chat_id: chat.id, text: t, parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id, ...extra });
    const isGroup = ['group', 'supergroup', 'channel'].includes(chat.type);
    const isAdmin = async () => {
      if (chat.type === 'channel' || !isGroup) return true;
      if (!msg.from) return false;
      const r = await this.tg('getChatMember', { chat_id: chat.id, user_id: msg.from.id });
      return r?.ok && ['creator', 'administrator'].includes(r.result.status);
    };
    const subsHere = () => this.sql.exec('SELECT * FROM tg_subs WHERE chat_id=?', String(chat.id)).toArray();
    // optional trailing ticker narrows a setting to one tracked token
    const target = (arg) => { const id = arg ? this.parseMarketRef(arg) : null; return id ? ' AND market=' + `'${id.replace(/'/g, '')}'` : ''; };
    const url = (u) => { u = String(u || '').trim(); if (!u) return ''; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; return /^https:\/\/[^\s]+$/.test(u) ? u.slice(0, 200) : ''; };

    if (cmd === '/owner') {
      if (isGroup) return reply('Send this in a private chat with the bot, not in a group.');
      const code = String(args[0] || '').trim();
      if (code.toLowerCase() === 'off') {
        if (String(chat.id) !== this.meta('tg_owner_chat')) return reply('This chat is not linked.');
        this.setMeta('tg_owner_chat', '');
        return reply('🔕 Deposit and withdrawal alerts are off.');
      }
      const want = this.meta('tg_owner_code'), exp = Number(this.meta('tg_owner_code_exp') || 0);
      if (!want || !code || code !== want || exp < now()) return reply('Invalid or expired code.');
      this.setMeta('tg_owner_code', '');
      this.setMeta('tg_owner_chat', String(chat.id));
      // start from now: older transfers are not replayed
      this.sql.exec('UPDATE transfers SET tg_notified=1 WHERE tg_notified IS NULL');
      return reply('🔔 Linked. This chat now gets every deposit and withdrawal on Rookery: ZRO, ETH and XLM, plus deposits without a memo and failed payouts.\n\nSend <code>/owner off</code> to stop.');
    }
    if (cmd === '/start' || cmd === '/help') {
      return reply(`<b>Rookery Buy Bot</b> 🐧\nPosts every buy of a Rookery token in your group.\n\n` +
        `<b>Setup</b>\n<code>/track TICKER</code> start posting buys\n<code>/untrack</code> stop\n<code>/tracked</code> what is tracked here\n\n` +
        `<b>Make it yours</b>\n<code>/setmedia</code> reply to a GIF, photo or video (or send one with this caption)\n<code>/clearmedia</code> back to the token image\n` +
        `<code>/socials x=x.com/you tg=t.me/you web=you.xyz</code> buttons under each post\n<code>/socials clear</code> use the token's own links\n` +
        `<code>/emoji 🐧</code> buy-size emoji\n<code>/minbuy 25</code> only buys above $25\n<code>/preview</code> see how a post looks\n\nTrade: https://${host}`,
        { reply_markup: { inline_keyboard: [[{ text: '➕ Add me to your group', url: `https://t.me/${this.meta('tg_bot') || 'RookeryBuyBot'}?startgroup=track` }], [{ text: '🥚 Open Rookery', url: `https://${host}` }]] } });
    }
    if (cmd === '/track') {
      if (!isGroup) return reply('Add me to a group first, then use /track there.');
      if (!(await isAdmin())) return reply('Only group admins can do that.');
      const id = this.parseMarketRef(args[0]);
      if (!id) return reply('Token not found. Use the ticker, the token id or the Rookery link.');
      this.sql.exec('INSERT INTO tg_subs (chat_id,market,min_usd,created) VALUES (?,?,0,?) ON CONFLICT(chat_id,market) DO NOTHING', String(chat.id), id, now());
      const m = this.view(this.market(id), this.zroUsd());
      return reply(`✅ Tracking <b>${escH(m.name)} ($${escH(m.symbol)})</b>. Every buy will be posted here.\n\nTip: reply to a GIF with /setmedia and use /socials to add your links. /preview shows the result.`,
        { reply_markup: this.buyKeyboard(m, null, host) });
    }
    if (!isGroup && cmd !== '/preview') return reply('Use this command inside the group where the bot is tracking a token.');
    if (!(await isAdmin())) return reply('Only group admins can do that.');
    const subs = subsHere();
    if (!subs.length && cmd !== '/untrack') return reply('Nothing tracked here yet. Use /track TICKER first.');

    if (cmd === '/untrack') {
      const id = args[0] ? this.parseMarketRef(args[0]) : null;
      if (id) this.sql.exec('DELETE FROM tg_subs WHERE chat_id=? AND market=?', String(chat.id), id);
      else this.sql.exec('DELETE FROM tg_subs WHERE chat_id=?', String(chat.id));
      return reply('Stopped tracking.');
    }
    if (cmd === '/minbuy') {
      const v = Math.max(0, Number(args[0]) || 0);
      this.sql.exec(`UPDATE tg_subs SET min_usd=? WHERE chat_id=?${target(args[1])}`, v, String(chat.id));
      return reply(`Posting buys above $${v}.`);
    }
    if (cmd === '/setmedia') {
      let media = this.mediaOf(msg) || this.mediaOf(msg.reply_to_message);
      if (!media && args[0] && /^https?:\/\//i.test(args[0])) media = { id: args[0], type: /\.(gif|mp4)(\?|$)/i.test(args[0]) ? 'animation' : 'photo' };
      if (!media) return reply('Reply to a GIF, photo or video with /setmedia, or send the media with /setmedia as its caption.');
      const tick = media.id.startsWith('http') ? args[1] : args[0];
      this.sql.exec(`UPDATE tg_subs SET media_id=?, media_type=? WHERE chat_id=?${target(tick)}`, media.id, media.type, String(chat.id));
      return reply(`✅ ${media.type === 'animation' ? 'GIF' : media.type === 'video' ? 'Video' : 'Image'} saved. It will be shown with every buy. Send /preview to check.`);
    }
    if (cmd === '/clearmedia') {
      this.sql.exec(`UPDATE tg_subs SET media_id=NULL, media_type=NULL WHERE chat_id=?${target(args[0])}`, String(chat.id));
      return reply('Media cleared. Posts will use the token image.');
    }
    if (cmd === '/socials') {
      if ((args[0] || '').toLowerCase() === 'clear') {
        this.sql.exec('UPDATE tg_subs SET x=NULL, tg=NULL, web=NULL WHERE chat_id=?', String(chat.id));
        return reply("Socials cleared. Buttons will use the token's own links.");
      }
      const kv = Object.fromEntries(args.map(a => a.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.toLowerCase(), v]));
      const x = url(kv.x || kv.twitter), tg = url(kv.tg || kv.telegram), web = url(kv.web || kv.site || kv.website);
      if (!x && !tg && !web) return reply('Usage: <code>/socials x=x.com/you tg=t.me/you web=you.xyz</code>');
      const sets = []; const vals = [];
      if (x) { sets.push('x=?'); vals.push(x); } if (tg) { sets.push('tg=?'); vals.push(tg); } if (web) { sets.push('web=?'); vals.push(web); }
      this.sql.exec(`UPDATE tg_subs SET ${sets.join(',')} WHERE chat_id=?`, ...vals, String(chat.id));
      return reply('✅ Social buttons saved. Send /preview to check.');
    }
    if (cmd === '/emoji') {
      const e = [...(args[0] || '')].slice(0, 2).join('');
      if (!e) return reply('Usage: <code>/emoji 🐧</code>');
      this.sql.exec(`UPDATE tg_subs SET emoji=? WHERE chat_id=?${target(args[1])}`, e, String(chat.id));
      return reply(`Buy emoji set to ${escH(e)}.`);
    }
    if (cmd === '/tracked') {
      const rows = this.sql.exec('SELECT s.*, m.symbol FROM tg_subs s JOIN markets m ON m.id=s.market WHERE s.chat_id=?', String(chat.id)).toArray();
      return reply(rows.map(r => `• <b>$${escH(r.symbol)}</b> · min $${r.min_usd}${r.media_id ? ' · ' + r.media_type : ''}${r.emoji ? ' · ' + escH(r.emoji) : ''}${r.x || r.tg || r.web ? ' · custom socials' : ''}`).join('\n'));
    }
    if (cmd === '/preview') {
      const s = subs[0];
      const usd = this.zroUsd();
      const m = this.view(this.market(s.market), usd);
      const sample = { zro: (25n * WEI).toString(), tokens: Books.quoteBuy(this.market(s.market), 25n * WEI).toString() };
      const raw = this.sql.exec('SELECT image FROM markets WHERE id=?', s.market).toArray()[0]?.image;
      await this.postTo(chat.id, '👀 <i>Preview</i>\n\n' + this.buyMessage(m, sample, usd, 'preview', host, s.emoji), this.buyKeyboard(m, s, host),
        s.media_id ? { id: s.media_id, type: s.media_type } : null, raw ? `https://${host}/api/img/m/${s.market}` : null);
    }
  }

  /* ───────────── HTTP ───────────── */
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/^\/api/, '');
    const method = req.method;
    try {
      if (p.startsWith('/snb/hook/')) {
        const secret = this.meta('snb_secret');
        if (!secret || p !== '/snb/hook/' + secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) return json({ ok: false }, 403);
        const upd = await req.json().catch(() => null);
        if (upd) {
          // Telegram re-delivers an update it thinks timed out: handle each update id once, and answer at once
          this.snbInit();
          const uid = Number(upd.update_id || 0);
          if (uid && this.sql.exec('SELECT 1 FROM snb_upd WHERE id=?', uid).toArray().length) return json({ ok: true, dup: true });
          if (uid) { this.sql.exec('INSERT OR IGNORE INTO snb_upd (id,ts) VALUES (?,?)', uid, now()); this.sql.exec('DELETE FROM snb_upd WHERE ts<?', now() - 864e5); }
          const job = this.snbUpdate(upd, this.meta('public_host') || url.host).catch((e) => console.log('snb', e?.stack || e));
          if (this.env.SNB_SYNC) await job; else this.ctx.waitUntil(job);
        }
        return json({ ok: true });
      }
      if (method === 'GET' && p.startsWith('/snb/login/')) {
        this.snbInit();
        const tok = p.split('/')[3] || '';
        const t = this.sql.exec(`SELECT * FROM snb_tokens WHERE token=? AND kind='login' AND expires>?`, tok, now()).toArray()[0];
        if (!t) return new Response('This login link expired. Open the bot and tap Open Rookery again.', { status: 410 });
        this.sql.exec('DELETE FROM snb_tokens WHERE token=?', tok);
        return new Response(null, { status: 302, headers: { location: '/#/wallet', 'set-cookie': this.newSession(t.user_id) } });
      }
      if (p.startsWith('/tg/')) {
        const secret = this.meta('tg_secret');
        if (!secret || p !== '/tg/' + secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) return json({ ok: false }, 403);
        const upd = await req.json().catch(() => null);
        if (upd) await this.tgUpdate(upd, this.meta('public_host') || url.host).catch(() => {});
        return json({ ok: true });
      }
      if (p === '/ws') {
        if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected a websocket' }, 426);
        if (this.ctx.getWebSockets().length >= 5000) return json({ error: 'busy' }, 503);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ subs: ['all'] });
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (method !== 'GET' && p !== '/_cron' && req.headers.get('x-pl') !== '1') return json({ error: 'bad request' }, 400);
      if (p === '/_cron') {
        await this.refreshPrice(true);
        const watch = this.sql.exec('SELECT * FROM users WHERE watch_until>? ORDER BY watch_until DESC LIMIT 20', now()).toArray();
        // stages run in parallel on their own queues: deposits never wait behind sweeps or the Proofs snapshot
        const t0 = now(), dur = {};
        const timed = (k, pr) => Promise.resolve(pr).then(v => { dur[k] = now() - t0; return v; }, e => { dur[k] = now() - t0; return { error: String(e?.message || e) }; });
        const snapDue = now() - Number(this.meta('treasury_forced') || 0) > 110_000;
        const backupDue = now() - Number(this.meta('backup_last') || 0) > 3600_000 && now() - Number(this.meta('backup_try') || 0) > 600_000;
        if (backupDue) this.setMeta('backup_try', String(now()));
        const [, scan, , recovered, swept, burnJob] = await Promise.all([
          timed('backup', backupDue ? this.backup('cron').catch(e => { this.setMeta('backup_error', String(e?.message || e).slice(0, 300)); throw e; }) : null),
          timed('scan', this.serial(() => this.scanDeposits())),
          timed('treasury', snapDue ? this.treasury(this.hotWallet().address, true).then(v => { this.setMeta('treasury_forced', String(now())); return v; }) : null),
          timed('recover', this.wserial(() => this.recoverWithdrawals())),
          timed('sweep', this.meta('sweep_off') === '1' ? [] : this.wserial(async () => [...await this.sweepDeposits(), ...await this.sweepEth()])),
          timed('burn', this.serial(() => this.burnTick()).catch(() => null)),
          timed('points', this.serial(() => this.dailyHoldPoints()).catch(() => null)),
          timed('stellar', this.wserial(() => this.stellarCron()).catch(e => ({ error: String(e?.message || e) }))),
          timed('bridge', this.xbCron().catch(e => ({ error: String(e?.message || e) }))),
          timed('rh', this.rhScan().catch(e => ({ error: String(e?.message || e) }))),
        ]);
        this.setMeta('cron_dur', JSON.stringify(dur));
        await this.ownerFeed().catch(() => null);
        await this.ownerBridgeFeed().catch(() => null);
        if (this.snbOn()) {
          try { this.snbInit(); this.stxInit(); if (this.sql.exec('SELECT COUNT(*) c FROM snb_terms').one().c + this.sql.exec(`SELECT COUNT(*) c FROM snb_watch WHERE status='armed'`).one().c) await this.snbArm(); } catch { /* next minute */ }
          await this.stxNewPools().catch(() => null);
          await this.lumenNewLaunches().catch(() => null);
          try { this.snbRefSettle(); } catch { /* next minute */ }
          await this.stxSweepOwed().catch(() => null);
        }
        // heartbeat for the health check: when the cron last finished and what each stage reported
        this.setMeta('cron_last', String(now()));
        this.setMeta('cron_report', JSON.stringify({ scanErrors: scan?.errors || (scan?.error ? { all: scan.error } : {}), credited: (scan?.credited || []).length,
          recovered: Array.isArray(recovered) ? recovered.length : recovered, swept: Array.isArray(swept) ? swept.filter(x => x.action === 'sweep').length : swept,
          sweepErrors: Array.isArray(swept) ? swept.filter(x => x.error).map(x => x.chain + ': ' + x.error) : [] }).slice(0, 3000));
        return json({ ok: true, watched: watch.length, scan, recovered, swept, burnJob });
      }
      if (url.host && !url.host.startsWith('do')) { if (this.meta('public_host') !== url.host && !url.host.endsWith('workers.dev')) this.setMeta('public_host', url.host); }
      await this.refreshPrice();
      const usd = this.zroUsd();
      const user = this.session(req);

      /* public */
      if (method === 'GET' && p === '/stats') {
        const volUsd = this.sql.exec('SELECT volume, quote, rh_quote FROM markets').toArray().reduce((a, r) => a + (Number(B(r.volume)) / 1e18) * (r.rh_quote ? this.rhMarketUsd(r) : this.usdOf(qa(r))), 0);
        const burn = B(this.meta('plaunch_burn')), burnEth = B(this.meta('plaunch_burn_eth')), burnXlm = B(this.meta('plaunch_burn_xlm'));
        return json({
          zroUsd: usd, zroChange24h: Number(this.meta('zro_chg') || 0), ethUsd: this.ethUsd(), ethChains: ETH_CHAINS, xlmUsd: this.xlmUsd(),
          stellar: { net: this.stNet(), explorer: ST_NETS[this.stNet()].explorer, gradUsd: this.stGradUsd() },
          plaunchBurnEth: burnEth.toString(), plaunchBurnXlm: burnXlm.toString(),
          burnReserveUsd: (Number(burn) / 1e18) * usd + (Number(burnEth) / 1e18) * this.ethUsd() + (Number(burnXlm) / 1e18) * this.xlmUsd(),
          volumeUsd: volUsd,
          plaunchBurnZro: burn.toString(), plaunchBurnUsd: (Number(burn) / 1e18) * usd,
          markets: this.sql.exec('SELECT COUNT(*) c FROM markets').one().c,
          netTokens: (() => { const o = { zero: 0, giwa: 0, stellar: 0, robinhood: 0 }; for (const r of this.sql.exec('SELECT network, COUNT(*) c FROM markets GROUP BY network').toArray()) o[r.network] = r.c; return o; })(),
          traders: this.sql.exec('SELECT COUNT(*) c FROM users').one().c,
          networks: NETWORKS, chains: Object.fromEntries(Object.entries(CHAINS).map(([k, v]) => [k, { label: v.label, explorer: v.explorer, chainId: v.chainId }])),
          walletBuy: this.evmOrdersOn(), zroToken: ZRO_TOKEN, stellarSendNow: this.stSendNowOn(),
          tgBot: this.meta('tg_bot') || '', zroToken: ZRO_TOKEN, curve: { supply: CURVE.supply.toString(), curve: CURVE.curve.toString(), vZro: CURVE.vZro.toString(), vTok: CURVE.vTok.toString() },
        });
      }
      if (method === 'GET' && p === '/markets') {
        const net = url.searchParams.get('network');
        const rows = this.sql.exec(net ? 'SELECT * FROM markets WHERE network=?' : 'SELECT * FROM markets', ...(net ? [net] : [])).toArray();
        return json({ markets: rows.map(m => this.view(m, usd)) });
      }
      if (method === 'GET' && p.startsWith('/market/')) {
        const id = p.split('/')[2];
        const m = this.market(id);
        const trades = this.sql.exec(`SELECT t.*, u.username, u.id uid FROM trades t LEFT JOIN users u ON u.id=t.user_id
          WHERE market=? ORDER BY t.id DESC LIMIT 400`, id).toArray().reverse();
        const holders = m?.rh_token ? this.rhHolders(m, 50).map(h => ({ amount: h.amount, username: h.username || (h.tag ? h.tag : h.address.slice(0, 6) + '…' + h.address.slice(-4)),
          uid: h.username ? this.sql.exec('SELECT id FROM users WHERE username=?', h.username).toArray()[0]?.id : null, address: h.address, tag: h.tag })) : this.sql.exec(`SELECT b.amount, u.username, u.id uid FROM balances b JOIN users u ON u.id=b.user_id
          WHERE b.asset=? AND b.amount!='0'`, 't:' + id).toArray()
          .sort((a, b) => (B(b.amount) > B(a.amount) ? 1 : -1)).slice(0, 50)
          .map(h => ({ username: h.username, uid: h.uid, amount: h.amount, creator: h.uid === m.creator_id, pct: Number((B(h.amount) * 1000000n) / (B(m.supply) * WEI)) / 10000 }));
        const comments = this.sql.exec(`SELECT c.id, c.body, c.ts, u.username, u.avatar!='' AS has_avatar, u.id uid
          FROM comments c JOIN users u ON u.id=c.user_id WHERE market=? ORDER BY c.id DESC LIMIT 100`, id).toArray()
          .map(c => ({ ...c, avatar: c.has_avatar ? `/api/img/u/${c.uid}` : '' }));
        // one bulk badge lookup for every trader, holder and commenter on this page
        const bm = this.badges([...trades.map(t => t.uid), ...holders.map(h => h.uid), ...comments.map(c => c.uid)]);
        const me = user ? {
          zro: this.bal(user.id, 'zro').toString(), eth: this.bal(user.id, 'eth').toString(), tokens: this.bal(user.id, 't:' + id).toString(),
          pendingRewards: this.pendingRewards(user.id, m).toString(),
          pnl: this.position(user.id, m),
        } : null;
        return json({
          market: this.view(m, usd), zroUsd: usd,
          trades: trades.map(t => ({ side: t.side, zro: t.zro, tokens: t.tokens, price: t.price, usd: t.usd, ts: t.ts, username: t.username, uid: t.uid, tx: t.txid || undefined, badges: bm.get(t.uid) || [] })),
          holders: holders.map(h => ({ ...h, badges: bm.get(h.uid) || [] })),
          comments: comments.map(c => ({ ...c, badges: bm.get(c.uid) || [] })), me,
          burned: m.burned,
        });
      }
      if (method === 'GET' && p === '/feed') {
        const rows = this.sql.exec(`SELECT t.side,t.zro,t.tokens,t.price,t.usd,t.ts,t.market,m.symbol,m.name,u.username
          FROM trades t JOIN markets m ON m.id=t.market LEFT JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 40`).toArray();
        return json({ trades: rows });
      }
      if (method === 'GET' && p.startsWith('/img/')) {
        const [, , kind, id] = p.split('/');
        const v = kind === 'm' ? this.sql.exec('SELECT image v FROM markets WHERE id=?', id).toArray()[0]?.v
          : kind === 'h' ? this.sql.exec('SELECT image v FROM hatches WHERE id=?', id).toArray()[0]?.v
          : this.sql.exec('SELECT avatar v FROM users WHERE id=?', Number(id)).toArray()[0]?.v;
        if (!v) return new Response('not found', { status: 404 });
        const m2 = v.match(/^data:(image\/[a-z+]+);base64,(.*)$/);
        if (!m2) return new Response('bad image', { status: 400 });
        const bin = Uint8Array.from(atob(m2[2]), c => c.charCodeAt(0));
        return new Response(bin, { headers: { 'content-type': m2[1], 'cache-control': 'public, max-age=86400' } });
      }
      if (method === 'GET' && p.startsWith('/u/')) {
        const uname = decodeURIComponent(p.split('/')[2]);
        const u = this.sql.exec('SELECT * FROM users WHERE username=?', uname).toArray()[0];
        if (!u) throw new Error('Trader not found');
        const hold = this.sql.exec(`SELECT asset, amount FROM balances WHERE user_id=? AND asset LIKE 't:%' AND amount!='0'`, u.id).toArray()
          .map(h => { const m = this.sql.exec('SELECT * FROM markets WHERE id=?', h.asset.slice(2)).toArray()[0]; if (!m) return null;
            const v = this.view(m, usd); return { id: m.id, name: m.name, symbol: m.symbol, image: v.image, amount: h.amount, valueUsd: (Number(B(h.amount)) / 1e18) * v.priceUsd }; })
          .filter(Boolean).sort((a, b) => b.valueUsd - a.valueUsd);
        const st = this.sql.exec(`SELECT COUNT(*) n, COALESCE(SUM(usd * CAST(zro AS REAL) / 1e18),0) vol FROM trades WHERE user_id=?`, u.id).one();
        const created = this.sql.exec('SELECT * FROM markets WHERE creator_id=? ORDER BY created DESC', u.id).toArray().map(m => this.view(m, usd));
        // what the creator earned from the marketing tax of their own tokens (paid in each token's quote asset)
        const creatorEarned = { usd: 0, zro: 0, eth: 0 };
        for (const v of created) { creatorEarned[v.quote === 'ETH' ? 'eth' : 'zro'] += Number(B(v.mktPaid)) / 1e18; creatorEarned.usd += v.mktPaidUsd; }
        const recent = this.sql.exec(`SELECT t.side,t.zro,t.tokens,t.usd,t.ts,m.symbol,m.id market FROM trades t JOIN markets m ON m.id=t.market
          WHERE t.user_id=? ORDER BY t.id DESC LIMIT 30`, u.id).toArray();
        return json({
          username: u.username, bio: u.bio, avatar: u.avatar ? `/api/img/u/${u.id}` : '', joined: u.created,
          trades: st.n, volumeUsd: st.vol, holdings: hold, portfolioUsd: hold.reduce((a, h) => a + h.valueUsd, 0),
          created, creatorEarned, recent, badges: this.badgesOf(u.id), isMe: !!user && user.id === u.id,
          ref: !!user && user.id === u.id ? this.refStats(u) : null,
        });
      }

      /* points & referrals */
      if (method === 'GET' && p === '/points') {
        const top = this.sql.exec(`SELECT p.total, p.trade, p.hatch, p.bond, p.hold, p.referral, u.username, u.id uid
          FROM pts p JOIN users u ON u.id=p.user_id ORDER BY p.total DESC LIMIT 25`).toArray();
        const bm = this.badges(top.map(t => t.uid));
        return json({
          top: top.map(t => ({ ...t, badges: bm.get(t.uid) || [] })),
          tiers: TIERS,
          me: user ? { ...this.pointsOf(user.id), ref: this.refStats(user) } : null,
        });
      }

      /* hatching soon */
      if (method === 'GET' && p === '/hatches') return json({ hatches: this.hatchList(user) });
      if (method === 'GET' && p.startsWith('/hatch/')) {
        const h = this.sql.exec('SELECT * FROM hatches WHERE id=?', p.split('/')[2]).toArray()[0];
        if (!h) throw new Error('Hatch not found');
        const waiting = this.sql.exec('SELECT COUNT(*) c FROM hatch_subs WHERE hatch_id=?', h.id).one().c;
        const subscribed = !!user && this.sql.exec('SELECT 1 FROM hatch_subs WHERE hatch_id=? AND user_id=?', h.id, user.id).toArray().length > 0;
        return json({ hatch: this.hatchView(h, now(), waiting, subscribed, !!user && user.id === h.creator_id) });
      }
      if (method === 'POST' && p === '/hatch') {
        if (!user) throw new Error('Log in to announce a hatch');
        return json(this.createHatch(user, await req.json()));
      }
      if (method === 'POST' && p === '/hatch/sub') {
        if (!user) throw new Error('Log in to get notified');
        const h = this.sql.exec('SELECT * FROM hatches WHERE id=? AND cancelled=0', String((await req.json()).id || '')).toArray()[0];
        if (!h) throw new Error('Hatch not found');
        const has = this.sql.exec('SELECT 1 FROM hatch_subs WHERE hatch_id=? AND user_id=?', h.id, user.id).toArray().length > 0;
        if (has) this.sql.exec('DELETE FROM hatch_subs WHERE hatch_id=? AND user_id=?', h.id, user.id);
        else this.sql.exec('INSERT INTO hatch_subs (hatch_id,user_id,ts) VALUES (?,?,?)', h.id, user.id, now());
        return json({ ok: true, subscribed: !has, waiting: this.sql.exec('SELECT COUNT(*) c FROM hatch_subs WHERE hatch_id=?', h.id).one().c });
      }
      if (method === 'POST' && p === '/hatch/cancel') {
        if (!user) throw new Error('Log in first');
        const h = this.sql.exec('SELECT * FROM hatches WHERE id=? AND creator_id=?', String((await req.json()).id || ''), user.id).toArray()[0];
        if (!h) throw new Error('Hatch not found');
        this.sql.exec('UPDATE hatches SET cancelled=1 WHERE id=?', h.id);
        return json({ ok: true });
      }

      /* auth */
      if (method === 'POST' && p === '/auth/signup') {
        const b = await req.json();
        const email = String(b.email || '').trim().toLowerCase();
        const username = String(b.username || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email');
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw new Error('Username: 3–20 letters, numbers or _');
        if (String(b.password || '').length < 8) throw new Error('Password must be at least 8 characters');
        if (this.sql.exec('SELECT 1 FROM users WHERE email=?', email).toArray().length) throw new Error('Email already registered');
        if (this.sql.exec('SELECT 1 FROM users WHERE username=? COLLATE NOCASE', username).toArray().length) throw new Error('Username taken');
        const salt = randHex(16);
        const hash = await this.hashPass(String(b.password), salt);
        const idx = Number(this.meta('dep_counter')) + 1;
        const addr = this.depositAddressFor(idx);
        this.setMeta('dep_counter', idx);
        const refCode = String(b.ref || '').trim().slice(0, 20);
        const who = refCode ? this.sql.exec('SELECT id FROM users WHERE username=? COLLATE NOCASE', refCode).toArray()[0] : null;
        const referredBy = who ? who.id : null;
        this.sql.exec(`INSERT INTO users (email,username,pass_hash,salt,dep_index,dep_address,created,referred_by) VALUES (?,?,?,?,?,?,?,?)`,
          email, username, hash, salt, idx, addr, now(), referredBy);
        const id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
        if (referredBy) { this.award(referredBy, 'referral', 500, username); this.award(id, 'referral', 250, 'welcome'); }
        return json({ ok: true, username, ref: referredBy ? refCode : '' }, 200, { 'set-cookie': this.newSession(id) });
      }
      if (method === 'POST' && p === '/auth/login') {
        const b = await req.json();
        const u = this.sql.exec('SELECT * FROM users WHERE email=?', String(b.email || '').trim().toLowerCase()).toArray()[0];
        if (!u || (await this.hashPass(String(b.password || ''), u.salt)) !== u.pass_hash) throw new Error('Wrong email or password');
        return json({ ok: true, username: u.username }, 200, { 'set-cookie': this.newSession(u.id) });
      }
      /* stellar wallet login — SEP-53 signed message, no transaction, no fee */
      if (method === 'POST' && p === '/auth/stellar/nonce') {
        const b = await req.json();
        const address = String(b.address || '').trim();
        if (!/^G[A-Z2-7]{55}$/.test(address)) throw new Error('Enter a Stellar address (starts with G)');
        const nonce = randHex(12), host = url.host;
        const message = `${host} wants you to sign in with your Stellar account:\n${address}\n\n` +
          `Sign in to Rookery, the Stinky Penguin launchpad. This request will not trigger a blockchain transaction or cost any fee.\n\n` +
          `URI: https://${host}\nVersion: 1\nNetwork: ${this.stNet()}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
        this.sql.exec('DELETE FROM st_nonces WHERE expires<?', now());
        this.sql.exec('INSERT INTO st_nonces (nonce,address,message,expires) VALUES (?,?,?,?)', nonce, address, message, now() + 10 * 60e3);
        return json({ message, nonce });
      }
      if (method === 'POST' && p === '/auth/stellar/verify') {
        const b = await req.json();
        const address = String(b.address || '').trim();
        const row = this.sql.exec('SELECT * FROM st_nonces WHERE address=? ORDER BY expires DESC LIMIT 1', address).toArray()[0];
        if (!row || row.expires < now()) throw new Error('Sign-in request expired, try again');
        if (String(b.nonce || '') && String(b.nonce) !== row.nonce) throw new Error('Wrong sign-in request');
        this.sql.exec('DELETE FROM st_nonces WHERE nonce=?', row.nonce);      // single use
        if (!(await verifySep53(address, row.message, b.signature))) throw new Error('Invalid signature');
        const owner = this.sql.exec('SELECT * FROM users WHERE stellar_wallet=?', address).toArray()[0];
        if (user && b.link) {
          if (owner && owner.id !== user.id) throw new Error('This Stellar wallet is already linked to another account');
          this.sql.exec('UPDATE users SET stellar_wallet=? WHERE id=?', address, user.id);
          return json({ ok: true, linked: address, username: user.username });
        }
        if (owner) return json({ ok: true, username: owner.username }, 200, { 'set-cookie': this.newSession(owner.id) });
        let uname = 'st_' + address.slice(1, 7).toLowerCase();
        while (this.sql.exec('SELECT 1 FROM users WHERE username=? COLLATE NOCASE', uname).toArray().length) uname = 'st_' + randHex(3);
        const idx = Number(this.meta('dep_counter')) + 1;
        this.setMeta('dep_counter', idx);
        this.sql.exec(`INSERT INTO users (email,username,pass_hash,salt,dep_index,dep_address,created,stellar_wallet) VALUES (?,?,?,?,?,?,?,?)`,
          `${address.toLowerCase()}@stellar.local`, uname, '', '', idx, this.depositAddressFor(idx), now(), address);
        const id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
        return json({ ok: true, username: uname }, 200, { 'set-cookie': this.newSession(id) });
      }
      /* buy intent: one wallet signature sends XLM with a short memo, Rookery credits it and buys the token */
      if (method === 'POST' && p === '/intent') {
        if (!user) throw new Error('Log in first');
        const b = await req.json();
        const m = this.market(String(b.market || ''));
        if (!m || m.network !== 'stellar') throw new Error('Not a Stellar token');
        const amt = B(b.amount);
        if (amt < WEI) throw new Error('Minimum is 1 XLM');
        this.sql.exec('DELETE FROM st_intents WHERE status=? AND expires<?', 'open', now());
        this.sql.exec('INSERT INTO st_intents (user_id,market,amount,status,created,expires) VALUES (?,?,?,?,?,?)', user.id, m.id, amt.toString(), 'open', now(), now() + 30 * 60e3);
        const id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
        const st = await this.stellar();
        return json({ ok: true, id, memo: 'r' + id, address: st.hotAddress, xlm: Number(amt) / 1e18, expires: now() + 30 * 60e3 });
      }
      if (method === 'POST' && p === '/stellar/prep') {
        const b = await req.json();
        const m = this.market(String(b.market || ''));
        if (!m || m.network !== 'stellar') throw new Error('Not a Stellar token');
        const amt = B(b.amount);
        if (amt < WEI) throw new Error('Minimum is 1 XLM');
        const from = String(b.address || '').trim();
        if (!/^G[A-Z2-7]{55}$/.test(from)) throw new Error('Connect your Stellar wallet first');
        const owner = user || this.stellarWalletUser(from);   // no account needed: the wallet signs the payment
        this.sql.exec('DELETE FROM st_intents WHERE status=? AND expires<?', 'open', now());
        this.sql.exec('INSERT INTO st_intents (user_id,market,amount,status,created,expires) VALUES (?,?,?,?,?,?)', owner.id, m.id, amt.toString(), 'open', now(), now() + 30 * 60e3);
        const id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
        const st = await this.stellar();
        const memo = 'r' + id;
        const trust = this.stSendNowOn() && m.st_issuer && !m.migrated ? { code: m.st_code, issuer: m.st_issuer } : null;
        const xdrB64 = await st.buildPaymentXdr({ from, to: st.hotAddress, amount: Number(amt) / 1e18, memo, trust });
        return json({ ok: true, id, memo, xdr: xdrB64, address: st.hotAddress });
      }
      // sell tokens that sit in the holder's own wallet: one signature sends them back with a memo, XLM comes back
      if (method === 'POST' && p === '/stellar/prep-sell') {
        const b = await req.json();
        const m = this.market(String(b.market || ''));
        if (!m || m.network !== 'stellar' || !m.st_issuer) throw new Error('Not a Stellar token');
        if (m.migrated) throw new Error('This token trades on Aquarius now');
        const from = String(b.address || '').trim();
        if (!/^G[A-Z2-7]{55}$/.test(from)) throw new Error('Connect your Stellar wallet first');
        const owner = user || this.stellarWalletUser(from);   // no account needed
        const amt = B(b.amount);
        if (amt < 100_000_000_000n) throw new Error('Enter an amount');
        const st = await this.stellar();
        this.sql.exec('INSERT INTO st_intents (user_id,market,amount,status,created,expires,side,address) VALUES (?,?,?,?,?,?,?,?)', owner.id, m.id, amt.toString(), 'open', now(), now() + 30 * 60e3, 'sell', from);
        const id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
        const xdrB64 = await st.buildTokenPaymentXdr({ from, to: st.hotAddress, code: m.st_code, issuer: m.st_issuer, amount: Math.floor(Number(amt / 100_000_000_000n)) / 1e7, memo: 's' + id });
        return json({ ok: true, id, memo: 's' + id, xdr: xdrB64 });
      }
      if (method === 'GET' && p === '/stellar/wallet') {
        // a wallet-first view: holdings of a Stellar address, no login needed
        const m = this.market(String(url.searchParams.get('market') || ''));
        const address = String(url.searchParams.get('address') || '');
        if (!m || m.network !== 'stellar' || !m.st_issuer || !/^G[A-Z2-7]{55}$/.test(address)) throw new Error('bad request');
        const st = await this.stellar();
        const tb = await st.tokenBalance(address, m.st_code, m.st_issuer);
        let xlm = null;
        try { const a = await st.account(address); xlm = Number(a?.balances?.find(b => b.asset_type === 'native')?.balance || 0); } catch { /* new wallet */ }
        return json({ ok: true, market: m.id, symbol: m.symbol, code: m.st_code, trust: !!(tb && tb.balance !== null),
          wallet: tb?.balance || 0, xlm, migrated: !!m.migrated, sellable: !m.migrated, xlmUsd: this.xlmUsd() });
      }
      if (method === 'POST' && p === '/stellar/prep-trust') {
        const b = await req.json();
        const m = this.market(String(b.market || ''));
        if (!m || m.network !== 'stellar' || !m.st_issuer) throw new Error('Not a Stellar token');
        const from = String(b.address || '').trim();
        if (!/^G[A-Z2-7]{55}$/.test(from)) throw new Error('Connect your Stellar wallet first');
        const st = await this.stellar();
        return json({ ok: true, xdr: await st.buildTrustXdr({ from, code: m.st_code, issuer: m.st_issuer }) });
      }
      if (method === 'GET' && p === '/stellar/holding') {
        const m = this.market(String(url.searchParams.get('market') || ''));
        const address = String(url.searchParams.get('address') || '');
        if (!m || !m.st_issuer || !/^G[A-Z2-7]{55}$/.test(address)) throw new Error('bad request');
        const st = await this.stellar();
        const h = await st.tokenBalance(address, m.st_code, m.st_issuer);
        const q = user ? this.sql.exec('SELECT pending, note FROM st_out WHERE user_id=? AND market=?', user.id, m.id).toArray()[0] : null;
        return json({ ok: true, wallet: h ? h.balance : null, trust: !!(h && h.balance !== null), queued: q ? q.pending : '0', note: q?.note || '', sendNow: this.stSendNowOn() });
      }
      if (method === 'GET' && p === '/rh/config') return json(await this.rhConfig());
      if (method === 'POST' && p === '/rh/prepare-create') return json(await this.rhPrepareCreate(user, await req.json().catch(() => ({}))));
      if (method === 'POST' && p === '/rh/prepare-trade') return json(await this.rhPrepareTrade(await req.json().catch(() => ({}))));
      if (method === 'POST' && p === '/rh/sync') { const b = await req.json().catch(() => ({})); return json(await this.rhSyncTx(String(b.hash || ''))); }
      if (method === 'GET' && p === '/rh/wallet') {
        const m = this.market(url.searchParams.get('market') || '');
        return json({ ok: true, ...(await this.rhWalletInfo(m, url.searchParams.get('address') || '')) });
      }
      if (method === 'POST' && p === '/rh/prepare-claim') return json(await this.rhPrepareClaim(await req.json().catch(() => ({}))));
      if (method === 'GET' && p === '/rh/balance') {
        const m = this.market(url.searchParams.get('market') || '');
        return json({ ok: true, balance: await this.rhWalletBalance(m, url.searchParams.get('address') || '') });
      }
      if (method === 'GET' && p === '/bridge/config') {
        const nets = Object.fromEntries(Object.entries(XB_NETS).map(([k, v]) => [k, { label: v.label, sym: v.sym, name: v.name, dec: v.dec, kind: v.kind, chainId: v.chainId || null, txp: v.tx, minUsd: v.minUsd || 0, minUsdFrom: v.minUsdFrom || 0 }]));
        return json({ ok: true, on: this.xbOn(), nets, soon: XB_SOON, ourFeePct: this.xbCfg().feeBps / 200 });
      }
      if (method === 'POST' && p === '/bridge/quote') {
        const b = await req.json();
        return json({ ok: true, quote: await xbQuote(this.xbCfg(), { from: b.from, to: b.to, amount: String(b.amount || ''), recipient: b.recipient, refund: b.refund, dry: true }) });
      }
      if (method === 'POST' && p === '/bridge/order') {
        if (!this.xbOn()) throw new Error('The bridge is paused for a moment');
        const b = await req.json();
        const q = await xbQuote(this.xbCfg(), { from: b.from, to: b.to, amount: String(b.amount || ''), recipient: String(b.recipient || '').trim(), refund: String(b.refund || '').trim(), dry: false });
        if (!q.depositAddress) throw new Error('No route for this amount right now, try a different amount');
        const ref = [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
        this.sql.exec(`INSERT INTO xb_orders (ref,user_id,from_net,to_net,amount_in,in_usd,out_est,out_usd,recipient,refund,dep_addr,dep_memo,status,created,deadline)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ref, user?.id || null, b.from, b.to, q.amountInFmt, q.inUsd, q.amountOutFmt, q.outUsd,
          String(b.recipient).trim(), String(b.refund).trim(), q.depositAddress, q.depositMemo, 'PENDING_DEPOSIT', now(), q.deadline);
        const out = { ...this.xbView(this.sql.exec('SELECT * FROM xb_orders WHERE ref=?', ref).one()), amountInUnits: q.amountIn, seconds: q.seconds, feesUsd: q.feesUsd };
        if (b.from === 'stellar' && /^G[A-Z2-7]{55}$/.test(String(b.fromAddress || ''))) {
          try { out.xdr = await xbStellarXdr({ from: b.fromAddress, to: q.depositAddress, amountFmt: q.amountInFmt, memo: q.depositMemo }); } catch (e) { out.xdrError = e.message; }
        }
        return json({ ok: true, order: out });
      }
      if (method === 'POST' && p === '/bridge/submit') {
        const b = await req.json();
        const o = this.sql.exec('SELECT * FROM xb_orders WHERE ref=?', String(b.ref || '')).toArray()[0];
        if (!o) throw new Error('Transfer not found');
        let tx = String(b.txHash || '').trim();
        if (b.xdr) tx = (await xbStellarSubmit(String(b.xdr))).hash;
        if (!/^(0x)?[0-9a-fA-F]{64}$|^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(tx)) throw new Error('Bad transaction hash');
        this.sql.exec(`UPDATE xb_orders SET in_tx=?, status=CASE WHEN status='PENDING_DEPOSIT' THEN 'KNOWN_DEPOSIT_TX' ELSE status END WHERE ref=?`, tx, o.ref);
        await xbSubmit(this.xbCfg(), o.dep_addr, tx, o.dep_memo);
        return json({ ok: true, txid: tx });
      }
      if (method === 'GET' && p === '/bridge/status') {
        const o = this.sql.exec('SELECT * FROM xb_orders WHERE ref=?', url.searchParams.get('ref') || '').toArray()[0];
        if (!o) throw new Error('Transfer not found');
        return json({ ok: true, order: this.xbView(await this.xbRefresh(o)) });
      }
      if (method === 'GET' && p === '/bridge/orders') {
        const refs = String(url.searchParams.get('refs') || '').split(',').filter(r => /^[0-9a-f]{24}$/.test(r)).slice(0, 30);
        const rows = this.sql.exec(`SELECT * FROM xb_orders WHERE user_id=? OR ref IN (${refs.map(() => '?').join(',') || "''"}) ORDER BY created DESC LIMIT 20`, user?.id || -1, ...refs).toArray();
        return json({ ok: true, orders: rows.map(o => this.xbView(o)) });
      }
      if (method === 'POST' && p === '/stellar/submit') {
        const b = await req.json();
        const st = await this.stellar();
        const r = await st.submitXdr(String(b.xdr || ''));
        return json({ ok: true, txid: r.hash, explorer: `${ST_NETS[this.stNet()].explorer}/tx/${r.hash}` });
      }
      if (method === 'POST' && p === '/auth/logout') {
        const m = (req.headers.get('cookie') || '').match(/pl_s=([a-f0-9]{64})/);
        if (m) this.sql.exec('DELETE FROM sessions WHERE token=?', m[1]);
        return json({ ok: true }, 200, { 'set-cookie': 'pl_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
      }

      /* wallet login — Sign-In with Ethereum (EIP-4361), no gas, no transaction */
      if (method === 'POST' && p === '/auth/wallet/nonce') {
        const b = await req.json();
        if (!isAddress(b.address || '')) throw new Error('Invalid wallet address');
        const address = getAddress(b.address);
        const nonce = randHex(12);
        const host = url.host;
        const message = `${host} wants you to sign in with your Ethereum account:\n${address}\n\n` +
          `Sign in to Rookery, the Stinky Penguin launchpad. This request will not trigger a blockchain transaction or cost any gas.\n\n` +
          `URI: https://${host}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
        this.sql.exec('DELETE FROM siwe_nonces WHERE expires<?', now());
        this.sql.exec('INSERT INTO siwe_nonces (nonce,address,message,expires) VALUES (?,?,?,?)', nonce, address, message, now() + 10 * 60e3);
        return json({ message, nonce });
      }
      if (method === 'POST' && p === '/auth/wallet/verify') {
        const b = await req.json();
        const row = this.sql.exec('SELECT * FROM siwe_nonces WHERE nonce=?', String(b.nonce || '')).toArray()[0];
        if (!row || row.expires < now()) throw new Error('Sign-in request expired, try again');
        this.sql.exec('DELETE FROM siwe_nonces WHERE nonce=?', row.nonce); // single use
        let signer;
        try { signer = getAddress(verifyMessage(row.message, String(b.signature || ''))); } catch { throw new Error('Invalid signature'); }
        if (signer !== row.address) throw new Error('Signature does not match the wallet');
        const owner = this.sql.exec('SELECT * FROM users WHERE wallet=?', signer).toArray()[0];
        // already logged in (email) -> link this wallet to the current account
        if (user && b.link) {
          if (owner && owner.id !== user.id) throw new Error('This wallet is already linked to another account');
          this.sql.exec('UPDATE users SET wallet=? WHERE id=?', signer, user.id);
          return json({ ok: true, linked: signer, username: user.username });
        }
        if (owner) return json({ ok: true, username: owner.username }, 200, { 'set-cookie': this.newSession(owner.id) });
        // first time: create an account for this wallet
        let uname = 'pengu_' + signer.slice(2, 8).toLowerCase();
        while (this.sql.exec('SELECT 1 FROM users WHERE username=? COLLATE NOCASE', uname).toArray().length) uname = 'pengu_' + randHex(3);
        const idx = Number(this.meta('dep_counter')) + 1;
        const dep = this.depositAddressFor(idx);
        this.setMeta('dep_counter', idx);
        this.sql.exec(`INSERT INTO users (email,username,pass_hash,salt,dep_index,dep_address,wallet,created) VALUES (NULL,?,?,?,?,?,?,?)`,
          uname, '', '', idx, dep, signer, now());
        const id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
        return json({ ok: true, username: uname, created: true }, 200, { 'set-cookie': this.newSession(id) });
      }

      if (method === 'GET' && p === '/wallet/fees') {
        const out = {};
        const st = await this.netStatus();
        for (const c of ZRO_CHAINS) { try { const f = await this.withdrawFee(c); out[c] = { zro: f.zro, usd: f.usd, ...st[c] }; } catch { out[c] = null; } }
        const eth = {}, hotA = this.hotWallet().address;
        await Promise.all(ETH_CHAINS.map(async (c) => {
          try {
            const fee = await this.ethFee(c), hotBal = BigInt(await rpc(c, 'eth_getBalance', [hotA, 'latest']));
            const res = this.ethReserve(c), avail = hotBal > res ? hotBal - res : 0n;
            eth[c] = { eth: Number(fee) / 1e18, usd: (Number(fee) / 1e18) * this.ethUsd(), maxOut: Number(avail) / 1e18, ok: avail > fee };
          } catch { eth[c] = null; }
        }));
        return json({ fees: out, eth });
      }

      /* proofs (public) */
      if (method === 'GET' && p === '/burns') {
        const st = this.burnState();
        let burnAddr = '';
        try { burnAddr = this.burnWallet().address; } catch {}
        const jobs = this.sql.exec('SELECT * FROM burn_jobs ORDER BY id DESC LIMIT 100').toArray();
        const done = jobs.filter(j => j.status === 'burned');
        return json({
          burnWallet: burnAddr, dead: DEAD, token: st.token, source: st.source, sourceLabel: CHAINS[st.source]?.label,
          auto: st.auto, intervalH: st.intervalH, minZro: st.minZro, maxZro: st.maxZro,
          pendingZro: st.pending.toString(), pendingUsd: (Number(st.pending) / 1e18) * usd,
          totalZroBurned: done.reduce((a, j) => a + B(j.zro), 0n).toString(),
          totalTokensBurned: this.meta('burn_total_tokens') || '0',
          explorers: { source: CHAINS[st.source]?.explorer, robinhood: ROBINHOOD.explorer },
          jobs: jobs.map(j => ({ id: j.id, status: j.status, zro: j.zro, ethIn: j.eth_in, tokensBurned: j.tokens_burned,
            txTransfer: j.tx_transfer, txBridge: j.tx_bridge, txBurn: j.tx_burn, note: j.note, created: j.created, updated: j.updated })),
          nextAutoAt: st.auto && st.token ? st.last + st.intervalH * 3600e3 : null,
        });
      }
      if (method === 'GET' && p === '/proofs') {
        const last = this.sql.exec('SELECT * FROM proofs ORDER BY id DESC LIMIT 1').toArray()[0] || null;
        const liab = this.sql.exec(`SELECT amount FROM balances WHERE asset='zro'`).toArray().reduce((a, r) => a + B(r.amount), 0n);
        let hot = '';
        try { hot = this.hotWallet().address; } catch {}
        return json({
          root: last?.root || null, rootTotal: last?.total || '0', accounts: last?.accounts || 0, ts: last?.ts || null,
          liabilities: liab.toString(), liabilitiesUsd: (Number(liab) / 1e18) * usd,
          ...(() => {
            const mk = this.sql.exec('SELECT * FROM markets').toArray();
            const curve = (a) => Number(mk.filter(m => qa(m) === a).reduce((s, m) => s + B(m.graduated ? m.pool_zro : m.reserve_zro), 0n)) / 1e18;
            const liabEth = Number(this.sql.exec(`SELECT amount FROM balances WHERE asset='eth'`).toArray().reduce((a, r) => a + B(r.amount), 0n)) / 1e18;
            const cz = curve('zro'), ce = curve('eth');
            return { curveZro: cz, owedTotal: Number(liab) / 1e18 + cz,
              eth: { balances: liabEth, curves: ce, owed: liabEth + ce, burnReserve: Number(B(this.meta('plaunch_burn_eth'))) / 1e18, usd: this.ethUsd() },
              desk: { eth: Number(B(this.meta('desk_eth'))) / 1e18, zro: Number(B(this.meta('desk_zro'))) / 1e18, ethWei: B(this.meta('desk_eth')).toString(), zroWei: B(this.meta('desk_zro')).toString(),
                migratedZroWei: B(this.meta('migrated_zro_reserve')).toString(), migratedEthWei: B(this.meta('migrated_eth_reserve')).toString(), volumeUsd: Number(this.meta('swap_volume_usd') || 0) } };
          })(),
          plaunchBurn: this.meta('plaunch_burn'), hotWallet: hot, zroToken: ZRO_TOKEN,
          stellar: await (async () => {
            try {
              const st = await this.stellar();
              const bals = await st.balances().catch(() => []);
              const onchain = Number(bals.find(b => b.asset_type === 'native')?.balance || 0);
              const sum = (sql, ...args) => this.sql.exec(sql, ...args).toArray().reduce((a, r) => a + B(r.amount), 0n);
              const bal = Number(sum(`SELECT amount FROM balances WHERE asset='xlm'`)) / 1e18;
              let curves = 0n;
              for (const m of this.sql.exec(`SELECT * FROM markets WHERE quote='XLM'`).toArray()) {
                if (m.migrated) continue;                                     // its XLM left custody into the Aquarius pool
                curves += B(m.graduated ? m.pool_zro : m.reserve_zro);
              }
              const graduatedOut = Number(B(this.meta('xlm_graduated_out'))) / 1e18;
              const owed = bal + Number(curves) / 1e18;
              return { net: this.stNet(), hot: st.hotAddress, onchain, balances: bal, curves: Number(curves) / 1e18,
                graduatedOut, owed, usd: this.xlmUsd(), explorer: ST_NETS[this.stNet()].explorer,
                open: !!bals.length };
            } catch (e) { return { error: String(e?.message || e).slice(0, 120) }; }
          })(),
          treasury: await this.treasury(hot),
          platform: this.platformRevenue(usd),
          history: this.sql.exec('SELECT root,total,accounts,ts FROM proofs ORDER BY id DESC LIMIT 30').toArray(),
        });
      }

      /* admin */
      if (p.startsWith('/admin/')) {
        const key = url.searchParams.get('key') || (method === 'POST' ? (await req.clone().json().catch(() => ({}))).key : '');
        if (!this.env.ADMIN_KEY || key !== this.env.ADMIN_KEY) throw new Error('forbidden');
        if (p === '/admin/proof') {
          const rows = this.sql.exec(`SELECT user_id, amount FROM balances WHERE asset='zro' ORDER BY user_id`).toArray();
          const root = await merkleRoot(await Promise.all(rows.map(r => sha256(`${r.user_id}:${r.amount}`))));
          const total = rows.reduce((a, r) => a + B(r.amount), 0n).toString();
          this.sql.exec('INSERT INTO proofs (root,total,accounts,ts) VALUES (?,?,?,?)', root, total, rows.length, now());
          return json({ ok: true, root, total, accounts: rows.length });
        }
        if (p === '/admin/credit') {
          const b = await req.json();
          const u = this.sql.exec('SELECT * FROM users WHERE username=? OR email=?', b.user, b.user).toArray()[0];
          if (!u) throw new Error('user not found');
          this.ctx.storage.transactionSync(() => {
            const as = ['eth', 'zro', 'xlm', 'ltc', 'zltc'].includes(b.asset) ? b.asset : 'zro';
            this.addBal(u.id, as, B(b.amount));
            this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?)`,
              u.id, 'deposit', b.chain || 'manual', String(b.amount), 'confirmed', b.note || 'Manual credit', now(), as);
          });
          return json({ ok: true, zro: this.bal(u.id, 'zro').toString(), eth: this.bal(u.id, 'eth').toString() });
        }
        // corrective trade on a user's behalf (e.g. a payment that bought the wrong token); recorded like any trade
        if (p === '/admin/trade') {
          const b = await req.json();
          const u = this.sql.exec('SELECT * FROM users WHERE username=?', String(b.user || '')).toArray()[0];
          if (!u) throw new Error('user not found');
          return json(this.trade(u, { market: String(b.market || ''), side: b.side === 'sell' ? 'sell' : 'buy', amount: String(b.amount || '0'), pay: b.pay }));
        }
        if (p === '/admin/migrate-quote') {
          // ZRO market -> ETH market, keeping the token price in USD exactly; holders keep their tokens 1:1
          const b = await req.json();
          const m = this.market(b.market);
          if (qa(m) === 'eth') throw new Error('already ETH');
          if (m.graduated) throw new Error('bonded markets are not migrated');
          await this.refreshPrice(true);
          const zu = this.zroUsd(), eu = this.ethUsd();
          const rate = zu / eu;                                           // ETH per ZRO
          const toEth = (wei) => (B(wei) * BigInt(Math.round(rate * 1e12))) / 1_000_000_000_000n;
          const report = { market: m.id, zroUsd: zu, ethUsd: eu, holdersPaid: 0 };
          this.ctx.storage.transactionSync(() => {
            // 1) pay every holder's pending ZRO rewards in ZRO, then start a fresh ETH accumulator
            for (const h of this.sql.exec(`SELECT user_id FROM balances WHERE asset=? AND amount!='0'`, 't:' + m.id).toArray()) {
              if (this.settle(h.user_id, this.market(m.id)) > 0n) report.holdersPaid++;
            }
            const mm = this.market(m.id);
            const priceZro = Books.price(mm);                                // ZRO wei per token
            const resEth = toEth(mm.reserve_zro);
            const tLeft = B(mm.v_tok) * WEI - B(mm.reserve_tok);
            // pick the ETH virtual reserve so (vEth + resEth) / tLeft equals the old price in ETH
            const targetPriceEth = toEth(priceZro);
            let vWei = (targetPriceEth * tLeft) / WEI - resEth;
            if (vWei <= 0n) throw new Error('cannot preserve price');
            // the old ZRO reserve stays with the platform (it is replaced by the same value in ETH on the curve)
            this.setMeta('migrated_zro_reserve', (B(this.meta('migrated_zro_reserve')) + B(mm.reserve_zro)).toString());
            this.setMeta('migrated_eth_reserve', (B(this.meta('migrated_eth_reserve')) + resEth).toString());
            this.sql.exec(`UPDATE markets SET quote='ETH', v_wei=?, reserve_zro=?, volume=?, acc_rew='0', mkt_paid=?, rewards_paid=? WHERE id=?`,
              vWei.toString(), resEth.toString(), toEth(mm.volume).toString(), toEth(mm.mkt_paid).toString(), toEth(mm.rewards_paid).toString(), m.id);
            this.sql.exec('UPDATE reward_debt SET debt=0 WHERE market=?', m.id);
            // chart history converted at the same rate so the candles stay continuous in USD
            // amounts x rate, per-unit USD / rate: every trade keeps exactly the same USD value and price
            this.sql.exec(`UPDATE trades SET price=CAST(CAST(price AS REAL) * ? AS INTEGER), zro=CAST(CAST(zro AS REAL) * ? AS INTEGER), usd=usd / ?, quote='ETH' WHERE market=?`, rate, rate, rate, m.id);
            const after = this.market(m.id);
            report.priceUsdBefore = Number(priceZro) / 1e18 * zu;
            report.priceUsdAfter = Number(Books.price(after)) / 1e18 * eu;
            report.reserveEth = Number(resEth) / 1e18;
          });
          return json({ ok: true, ...report });
        }
        if (p === '/admin/pause') { this.setMeta('withdrawals_paused', url.searchParams.get('on') === '1' ? '1' : '0'); return json({ ok: true }); }
        if (p === '/admin/burn/config') {
          const b = await req.json();
          if (b.token !== undefined) {
            if (b.token && !isAddress(b.token)) throw new Error('bad token address');
            this.setMeta('burn_token', b.token ? getAddress(b.token) : '');
          }
          if (b.source !== undefined) { if (!CHAINS[b.source]) throw new Error('bad source chain'); this.setMeta('burn_source', b.source); }
          if (b.auto !== undefined) this.setMeta('burn_auto', b.auto ? '1' : '0');
          for (const [k, mk] of [['minZro', 'burn_min_zro'], ['maxZro', 'burn_max_zro'], ['intervalH', 'burn_interval_h'], ['slippageBps', 'burn_slippage_bps']]) {
            if (b[k] !== undefined && Number(b[k]) >= 0) this.setMeta(mk, Number(b[k]));
          }
          return json({ ok: true, burn: { ...this.burnState(), pending: this.burnState().pending.toString() } });
        }
        if (p === '/admin/burn/run') {
          const id = this.createBurnJob(true);
          const r = await this.burnTick().catch(e => String(e.message));
          return json({ ok: true, job: id, tick: r });
        }
        if (p === '/admin/burn/tick') return json({ ok: true, tick: await this.burnTick() });
        if (p === '/admin/wd/resolve') { // stuck 'pending' withdrawal: refund it, or record the tx that actually went out
          const b = await req.json();
          const t = this.sql.exec(`SELECT * FROM transfers WHERE id=? AND kind='withdrawal' AND status='pending'`, b.id).toArray()[0];
          if (!t) throw new Error('no pending withdrawal with this id');
          this.ctx.storage.transactionSync(() => {
            if (b.action === 'refund') { this.addBal(t.user_id, t.asset || 'zro', B(t.amount)); this.sql.exec(`UPDATE transfers SET status='failed', note='Interrupted before sending, refunded' WHERE id=?`, t.id); }
            else if (b.action === 'sent' && /^0x[0-9a-fA-F]{64}$/.test(b.txid || '')) this.sql.exec(`UPDATE transfers SET status='sent', txid=? WHERE id=?`, b.txid, t.id);
            else throw new Error('action must be refund or sent+txid');
          });
          return json({ ok: true, transfer: this.sql.exec('SELECT * FROM transfers WHERE id=?', t.id).one() });
        }
        if (p === '/admin/health') { // fast: no per-address chain reads
          const t = now(), ago = (k) => { const v = Number(this.meta(k) || 0); return v ? Math.round((t - v) / 1000) : null; };
          const chains = {};
          for (const c of ZRO_CHAINS) chains[c] = { lastScanOkSec: ago('scan_ok_' + c), scanBlock: this.meta('balblk_' + c), lastError: this.meta('scan_err_' + c) };
          for (const c of ETH_CHAINS) chains['eth@' + c] = { lastScanOkSec: ago('scan_ok_eth@' + c), scanBlock: this.meta('balblk_eth@' + c), lastError: this.meta('scan_err_eth@' + c) };
          let tg = null;
          try { const w = await this.tg('getWebhookInfo', {}); tg = w?.result ? { url: !!w.result.url, pending: w.result.pending_update_count, lastError: w.result.last_error_message || null, lastErrorAgoSec: w.result.last_error_date ? Math.round(t / 1000 - w.result.last_error_date) : null } : w; } catch (e) { tg = { error: String(e.message) }; }
          let snapAge = null; try { snapAge = Math.round((t - JSON.parse(this.meta('treasury_snap') || '{}').ts) / 1000); } catch {}
          return json({ ok: true, cronLastSec: ago('cron_last'), cronReport: JSON.parse(this.meta('cron_report') || '{}'), chains,
            pendingWithdrawals: this.sql.exec(`SELECT COUNT(*) c FROM transfers WHERE kind='withdrawal' AND status='pending'`).one().c,
            outPending: this.sql.exec('SELECT COUNT(*) c FROM out_pending').one().c,
            outPendingRows: this.sql.exec('SELECT o.id, o.transfer_id, o.chain, o.amount, o.txid, o.ts, o.raw IS NOT NULL AS has_raw, u.username FROM out_pending o LEFT JOIN users u ON u.id=o.src_user').toArray(),
            failures1h: this.sql.exec(`SELECT id, chain, amount, note FROM transfers WHERE kind='withdrawal' AND status='failed' AND ts>? ORDER BY id DESC LIMIT 20`, t - 3600e3).toArray(),
            oldestOutPendingSec: (() => { const r = this.sql.exec('SELECT MIN(ts) m FROM out_pending').one().m; return r ? Math.round((t - r) / 1000) : null; })(),
            failedWithdrawals24h: this.sql.exec(`SELECT COUNT(*) c FROM transfers WHERE kind='withdrawal' AND status='failed' AND ts>?`, t - 864e5).one().c,
            sentWithdrawals24h: this.sql.exec(`SELECT COUNT(*) c FROM transfers WHERE kind='withdrawal' AND status='sent' AND ts>?`, t - 864e5).one().c,
            deposits1h: this.sql.exec(`SELECT COUNT(*) c FROM transfers WHERE kind='deposit' AND ts>?`, t - 3600e3).one().c,
            lastDepositSec: (() => { const r = this.sql.exec(`SELECT MAX(ts) m FROM transfers WHERE kind='deposit'`).one().m; return r ? Math.round((t - r) / 1000) : null; })(),
            lastTradeSec: (() => { const r = this.sql.exec('SELECT MAX(ts) m FROM trades').one().m; return r ? Math.round((t - r) / 1000) : null; })(),
            treasurySnapshotAgeSec: snapAge, cronStageMs: JSON.parse(this.meta('cron_dur') || '{}'), lastSweep: JSON.parse(this.meta('last_sweep') || 'null'), telegram: tg, zroUsd: this.zroUsd(), withdrawalsPaused: this.meta('withdrawals_paused') === '1',
            dbBytes: this.ctx.storage.sql.databaseSize,
            backup: { lastAgoSec: ago('backup_last'), error: this.meta('backup_error') || null, last: JSON.parse(this.meta('backup_report') || 'null') } });
        }
        if (p === '/admin/backup') return json({ ok: true, ...(await this.backup('manual')) });
        if (p === '/admin/backups') return json({ ok: true, backups: await this.listBackups() });
        if (p === '/admin/restore') {
          const b = await req.json();
          if (b.confirm !== 'RESTORE') throw new Error('Pass confirm: "RESTORE"');
          return json(await this.restoreBackup(String(b.object || '')));
        }
        if (p === '/admin/prices') {
          await this.refreshPrice(true);
          const m = (k) => ({ v: Number(this.meta(k)), ageSec: Math.round((now() - Number(this.meta(k + '_ts') || this.meta('zro_ts'))) / 1000), src: this.meta(k + '_src') });
          let swap = null; try { swap = this.swapPx(); } catch (e) { swap = { error: e.message }; }
          const dbg = {}; for (const k of ['zro_usd', 'zro_ts', 'zro_usd_b', 'zro_usd_b_ts', 'eth_usd', 'eth_usd_ts', 'eth_usd_b', 'eth_usd_b_ts']) dbg[k] = this.meta(k);
          return json({ ok: true, now: now(), dbg, zro: m('zro_usd'), zroB: m('zro_usd_b'), eth: m('eth_usd'), ethB: m('eth_usd_b'), swap });
        }
        if (p === '/admin/config') { // whitelisted runtime knobs
          const b = await req.json();
          const ok = ['desk_cap_usd', 'eth_reserve_ethereum', 'eth_reserve_base', 'eth_reserve_arbitrum', 'sweep_off'];
          if (!ok.includes(b.k)) throw new Error('not allowed');
          this.setMeta(b.k, String(b.v));
          return json({ ok: true, k: b.k, v: this.meta(b.k) });
        }
        if (p === '/admin/ledger') {
          // Per-asset conservation over the WHOLE ledger:
          //   deposits - withdrawals - desk - migrated(zro) + migrated(eth) - burn jobs
          //   == user balances + curve/pool reserves + platform burn reserve + accrued-unpaid rewards
          const out = {};
          const mk = this.sql.exec('SELECT * FROM markets').toArray();
          for (const a of ['zro', 'eth', 'xlm']) {
            const sum = (sql, ...args) => this.sql.exec(sql, ...args).toArray().reduce((s, r) => s + B(r.amount), 0n);
            const dep = sum(`SELECT amount FROM transfers WHERE kind='deposit' AND status='confirmed' AND COALESCE(asset,'zro')=?`, a);
            const wd = sum(`SELECT amount FROM transfers WHERE kind='withdrawal' AND status IN ('sent','pending') AND COALESCE(asset,'zro')=?`, a);
            const bal = sum(`SELECT amount FROM balances WHERE asset=?`, a);
            let curves = 0n, pend = 0n;
            for (const m of mk.filter(m => qa(m) === a)) {
              if (m.network === 'stellar' && m.migrated) continue;           // its XLM left custody into Aquarius
              curves += B(m.graduated ? m.pool_zro : m.reserve_zro);
              if (B(m.acc_rew) > 0n) for (const h of this.sql.exec(`SELECT user_id FROM balances WHERE asset=? AND amount!='0'`, 't:' + m.id).toArray()) pend += this.pendingRewards(h.user_id, m);
            }
            const burnRes = B(this.meta(burnKey(a)));
            const jobs = a === 'zro' ? this.sql.exec('SELECT zro FROM burn_jobs').toArray().reduce((s, j) => s + B(j.zro), 0n) : 0n;
            const desk = B(this.meta('desk_' + a));
            const mig = a === 'zro' ? -B(this.meta('migrated_zro_reserve')) : a === 'xlm' ? -B(this.meta('xlm_graduated_out')) : B(this.meta('migrated_eth_reserve'));
            const inflow = dep - wd - desk + mig - jobs;
            const held = bal + curves + burnRes + pend;
            out[a] = { deposits: dep.toString(), withdrawals: wd.toString(), desk: desk.toString(), migrated: mig.toString(), burnJobs: jobs.toString(),
              balances: bal.toString(), curves: curves.toString(), burnReserve: burnRes.toString(), pendingRewards: pend.toString(),
              inflow: inflow.toString(), held: held.toString(), diff: (inflow - held).toString(), diffUnits: Number(inflow - held) / 1e18 };
          }
          return json({ ok: true, ...out });
        }
        if (p === '/admin/pos') {
          const u = this.sql.exec('SELECT * FROM users WHERE username=?', url.searchParams.get('user') || '').toArray()[0];
          if (!u) throw new Error('user not found');
          const mk = this.market(url.searchParams.get('market'));
          return json({ ok: true, user: u.username, market: mk.id, position: this.position(u.id, mk) });
        }
        if (p === '/admin/recover') { try { return json({ ok: true, recovered: await this.wserial(() => this.recoverWithdrawals()) }); } catch (e) { return json({ ok: false, error: String(e.stack || e) }); } }
        if (p === '/admin/sweep') return json({ ok: true, swept: await this.wserial(() => this.sweepDeposits()) });
        if (p === '/admin/scan') return json({ ok: true, scan: await this.scanDeposits() });
        // one-time export of the EVM hot wallet key (the master secret is write-only; the key is derived here)
        // default: sent to the owner's private Telegram chat, never printed in a response
        if (p === '/admin/hotkey') {
          const b = method === 'POST' ? await req.json().catch(() => ({})) : {};
          const chat = this.meta('tg_owner_chat');
          if (b.chain === 'stellar') {
            const st = await this.stellar();
            const addr = st.hotAddress, secret = st.hot.secret();
            if (b.to === 'telegram') {
              if (!chat || !this.env.TG_BOT_TOKEN) return json({ error: 'no owner chat configured' });
              await this.tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
                text: `<b>Stellar hot wallet</b>\n<code>${addr}</code>\n<code>${secret}</code>\n\nSave it offline and delete this message. It holds every XLM and Rookery token deposit.` });
              return json({ ok: true, sent: true, chain: 'stellar', address: addr });
            }
            return json({ ok: true, chain: 'stellar', address: addr, secret, note: 'shown once: store it offline' });
          }
          const w = this.hotWallet();
          if (b.to === 'telegram') {
            if (!chat || !this.env.TG_BOT_TOKEN) return json({ error: 'no owner chat configured' });
            await this.tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
              text: `<b>Hot wallet key</b>\n<code>${w.address}</code>\n<code>${w.privateKey}</code>\n\nSave it offline and delete this message. Anyone with this key can move every deposit on the four EVM chains.` });
            return json({ ok: true, sent: true, address: w.address });
          }
          return json({ ok: true, address: w.address, key: w.privateKey, note: 'shown once: store it offline' });
        }
        if (p === '/admin/rh') {
          const b = method === 'POST' ? await req.json().catch(() => ({})) : {};
          if (b.action === 'fund') return json({ ok: true, ...(await this.rhFund(b)) });
          if (b.action === 'deploy') return json({ ok: true, ...(await this.rhDeploy(b)) });
          if (b.action === 'scan') return json({ ok: true, scan: await this.rhScan() });
          if (b.action === 'quotes') return json({ ok: true, refreshed: await this.rhRefreshQuotes(true), sync: await this.rhSyncQuotes(true) });
          if (b.action === 'selftest') return json({ ok: true, ...(await this.rhSelfTest(b)) });
          // our own smoke-test token: drop it from Rookery's lists (it stays on-chain; seen events are never re-applied)
          if (b.action === 'forget') {
            const m = this.market(String(b.market || ''));
            if (!m?.rh_token) throw new Error('not a Robinhood on-chain market');
            this.sql.exec('DELETE FROM trades WHERE market=?', m.id); this.sql.exec('DELETE FROM markets WHERE id=?', m.id);
            this.sql.exec('DELETE FROM rh_holdings WHERE token=?', m.rh_token);
            return json({ ok: true, forgot: m.id });
          }
          if (b.action === 'set') { if (b.curve !== undefined) this.setMeta('rh_curve', b.curve); if (b.block !== undefined) this.setMeta('rh_block', String(b.block)); if (b.off !== undefined) this.setMeta('rh_onchain_off', b.off ? '1' : ''); }
          return json({ ok: true, ...(await this.rhStatus()) });
        }
        if (p === '/admin/bridge') {
          const b = await req.json().catch(() => ({}));
          if (b.on === true || b.on === false) this.setMeta('xb_off', b.on ? '' : '1');
          if (b.feeBps !== undefined) this.setMeta('xb_fee_bps', String(Math.max(0, Math.min(400, Math.round(Number(b.feeBps) || 0)))));
          if (b.feeTo) this.setMeta('xb_fee_to', String(b.feeTo).toLowerCase());
          if (b.refresh) await this.xbCron();
          return json({ ok: true, on: this.xbOn(), ...this.xbCfg(), key: !!this.env.XB_KEY,
            volumeUsd: this.sql.exec(`SELECT COALESCE(SUM(in_usd),0) v FROM xb_orders WHERE status='SUCCESS'`).one().v,
            orders: this.sql.exec('SELECT * FROM xb_orders ORDER BY created DESC LIMIT 30').toArray() });
        }
        if (p === '/admin/evm-orders') {
          const b = await req.json().catch(() => ({}));
          if (b.on === true || b.on === false) this.setMeta('evm_orders', b.on ? '1' : '');
          this.evmOrderExpire();
          return json({ ok: true, on: this.evmOrdersOn(),
            counts: Object.fromEntries(this.sql.exec(`SELECT status, COUNT(*) c FROM orders_evm GROUP BY status`).toArray().map(r => [r.status, r.c])),
            recent: b.list ? this.sql.exec(`SELECT o.id, u.username, o.market, o.asset, o.amount, o.tagged, o.status, o.tokens, o.note, o.created, o.expires
              FROM orders_evm o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.id DESC LIMIT 50`).toArray() : undefined });
        }
        if (p === '/admin/audit') {
          const users = this.sql.exec('SELECT id, username, dep_address FROM users WHERE dep_address IS NOT NULL').toArray();
          const hot = this.hotWallet().address;
          const chains = {};
          await Promise.all(ZRO_CHAINS.map(async (chain) => {
            const c = { addrs: [] };
            try {
              const head = BigInt(await rpc(chain, 'eth_blockNumber', []));
              c.head = Number(head); c.cursor = Number(this.meta('scan_' + chain) || 0); c.lag = c.head - c.cursor;
              c.hotNative = Number(BigInt(await rpc(chain, 'eth_getBalance', [hot, 'latest']))) / 1e18;
              c.hotZro = Number(await this.zroBalanceOf(chain, hot)) / 1e18;
              c.fee = (await this.withdrawFee(chain)).zro;
              let onchain = 0n, ledger = 0n;
              for (const u of users) {
                const bal = await this.zroBalanceOf(chain, u.dep_address);
                const seen = B(this.sql.exec('SELECT last FROM deposit_seen WHERE user_id=? AND chain=?', u.id, chain).toArray()[0]?.last || '0');
                onchain += bal; ledger += seen;
                if (bal > 0n || seen > 0n) c.addrs.push({ user: u.username, addr: u.dep_address, onchain: Number(bal) / 1e18, seen: Number(seen) / 1e18, match: bal === seen });
              }
              c.onchainZro = Number(onchain) / 1e18; c.seenZro = Number(ledger) / 1e18;
            } catch (e) { c.error = String(e.message || e); }
            chains[chain] = c;
          }));
          const bals = this.sql.exec(`SELECT u.username, b.amount FROM balances b JOIN users u ON u.id=b.user_id WHERE b.asset='zro' AND b.amount!='0'`).toArray();
          const transfers = this.sql.exec('SELECT id,user_id,kind,chain,amount,to_addr,status,txid,note,ts FROM transfers ORDER BY id DESC LIMIT 40').toArray();
          const stuck = this.sql.exec(`SELECT t.*, u.username, u.dep_address FROM transfers t JOIN users u ON u.id=t.user_id WHERE t.kind='withdrawal' AND t.status='pending'`).toArray();
          return json({ ok: true, chains, balances: bals.map(r => ({ user: r.username, zro: Number(B(r.amount)) / 1e18 })),
            outPending: this.sql.exec('SELECT * FROM out_pending').toArray(), recheck: this.meta('dep_recheck') || '[]',
            paused: this.meta('withdrawals_paused') === '1', plaunchBurn: Number(B(this.meta('plaunch_burn'))) / 1e18,
            feeRevenue: Number(B(this.meta('fee_revenue_zro'))) / 1e18, stuck, transfers });
        }
        if (p === '/admin/adjust') {
          const b = await req.json();
          const u = this.sql.exec('SELECT * FROM users WHERE username=?', b.user).toArray()[0];
          if (!u) throw new Error('user not found');
          this.ctx.storage.transactionSync(() => {
            this.addBal(u.id, 'zro', B(b.amount));
            if (b.reverseTransfer) this.sql.exec(`UPDATE transfers SET status='reversed', note=? WHERE id=? AND user_id=?`, String(b.note || 'Reversed'), Number(b.reverseTransfer), u.id);
          });
          return json({ ok: true, zro: this.bal(u.id, 'zro').toString() });
        }
        if (p === '/admin/withdrawals') { // recent withdrawals, for auditing against the chain
          const st = url.searchParams.get('status') || 'sent';
          const lim = Math.min(500, Number(url.searchParams.get('limit') || 200));
          return json({ ok: true, rows: this.sql.exec(`SELECT t.id,t.user_id,u.username,t.chain,COALESCE(t.asset,'zro') asset,t.amount,t.txid,t.status,t.note,t.ts
            FROM transfers t LEFT JOIN users u ON u.id=t.user_id WHERE t.kind='withdrawal' AND t.status=? ORDER BY t.id DESC LIMIT ?`, st, lim).toArray() });
        }
        if (p === '/admin/withdraw/refund') { // credit back a withdrawal that reverted on-chain
          const b = await req.json();
          const t = this.sql.exec(`SELECT * FROM transfers WHERE id=? AND kind='withdrawal' AND status='sent'`, Number(b.id)).toArray()[0];
          if (!t) throw new Error('No sent withdrawal with id ' + b.id);
          const rc = await rpc(t.chain, 'eth_getTransactionReceipt', [t.txid]).catch(() => null);
          if (!rc) throw new Error('No receipt on-chain yet — not refunding');
          if (rc.status === '0x1') throw new Error('That transaction succeeded on-chain — not refunding');
          this.ctx.storage.transactionSync(() => {
            this.sql.exec('DELETE FROM out_pending WHERE transfer_id=?', t.id);
            this.addBal(t.user_id, t.asset || 'zro', B(t.amount));
            this.sql.exec(`UPDATE transfers SET status='failed', raw=NULL, note='Reverted on-chain, refunded' WHERE id=?`, t.id);
          });
          return json({ ok: true, id: t.id, refunded: t.amount, user: t.user_id });
        }
        if (p === '/admin/withdraw/retry') {
          const b = await req.json();
          return json(await this.wserial(() => this.retryWithdrawal(Number(b.id), !!b.dryRun)));
        }
        if (p === '/admin/tx') { // look up a withdrawal/deposit by on-chain hash
          const h = String(url.searchParams.get('hash') || '').toLowerCase();
          if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error('pass ?hash=0x…');
          return json({ ok: true,
            transfers: this.sql.exec('SELECT t.*, u.username FROM transfers t LEFT JOIN users u ON u.id=t.user_id WHERE lower(t.txid)=?', h).toArray(),
            outPending: this.sql.exec('SELECT * FROM out_pending WHERE lower(txid)=?', h).toArray() });
        }
        if (p === '/admin/user') {
          const q = url.searchParams.get('q') || '';
          const u = this.sql.exec('SELECT id,username,email,wallet,dep_address,dep_index,created,referred_by FROM users WHERE username=? OR email=? OR wallet=? OR dep_address=? COLLATE NOCASE', q, q, q, q).toArray()[0];
          if (!u) throw new Error('user not found');
          return json({ user: u, balances: this.sql.exec('SELECT asset,amount FROM balances WHERE user_id=?', u.id).toArray(),
            transfers: this.sql.exec('SELECT * FROM transfers WHERE user_id=? ORDER BY id', u.id).toArray(),
            trades: this.sql.exec('SELECT market,side,zro,tokens,ts FROM trades WHERE user_id=? ORDER BY id', u.id).toArray(),
            seen: this.sql.exec('SELECT chain,last FROM deposit_seen WHERE user_id=?', u.id).toArray() });
        }
        if (p === '/admin/snb') {
          this.snbInit();
          const b = await req.json().catch(() => ({}));
          if (b.feeBps !== undefined) this.setMeta('snb_fee_bps', String(Math.max(0, Math.min(300, Math.round(Number(b.feeBps) || 0)))));
          const out = { ok: true };
          if (b.setup) {
            if (!this.env.SNIPER_BOT_TOKEN) throw new Error('Set the SNIPER_BOT_TOKEN secret first');
            let secret = this.meta('snb_secret'); if (!secret) { secret = randHex(16); this.setMeta('snb_secret', secret); }
            const host = b.host || this.meta('public_host') || url.host;
            out.webhook = await this.tgS('setWebhook', { url: `https://${host}/api/snb/hook/${secret}`, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
            const me = await this.tgS('getMe', {}); if (me?.result?.username) this.setMeta('snb_bot', me.result.username); out.bot = me?.result?.username;
            out.commands = await this.tgS('setMyCommands', { commands: [
              { command: 'start', description: 'Main menu' }, { command: 'positions', description: 'Your bags and live PnL' },
              { command: 'sniper', description: 'Auto-buy new launches' }, { command: 'wallet', description: 'Your Stellar wallet: export / import' }, { command: 'referral', description: 'Invite friends, earn 25% of their fees' }, { command: 'deposit', description: 'Top up XLM, ZRO or ETH' },
              { command: 'withdraw', description: 'Send XLM out: /withdraw 25 G…' }, { command: 'help', description: 'How it works' }] });
            await this.tgS('setMyShortDescription', { short_description: 'Trade and snipe any Stellar token: SDEX, AMM pools, Aquarius and Rookery. Your own wallet, live PnL.' });
            await this.tgS('setMyDescription', { description: 'RookerySniperBot: the Stellar trading terminal by Rookery, the Stinky Penguin launchpad.\n\n• Trade any Stellar token with the best route across SDEX, AMM pools, Aquarius and the Rookery curve\n• Your own Stellar wallet: export or import any time\n• Snipe launches, new pools and tokens the moment they get liquidity\n• Live Position Terminal with PnL after every buy\n\nParody project, not financial advice.' });
          }
          if (b.tick) out.tick = await this.snbTick();
          out.fees = Object.fromEntries(['xlm', 'zro', 'eth'].map(a => [a, Number(B(this.meta('snb_fees_' + a))) / 1e18]));
          out.users = this.sql.exec('SELECT COUNT(*) c FROM snb_users').one().c;
          out.trades24h = this.sql.exec('SELECT COUNT(*) c FROM snb_log WHERE ts>?', now() - 864e5).one().c;
          out.live = this.sql.exec('SELECT COUNT(*) c FROM snb_terms').one().c;
          // who actually traded vs who only opened the bot
          out.tradesTotal = this.sql.exec('SELECT COUNT(*) c FROM snb_log').one().c;
          out.traders = this.sql.exec('SELECT COUNT(DISTINCT user_id) c FROM snb_log').one().c;
          out.traders7d = this.sql.exec('SELECT COUNT(DISTINCT user_id) c FROM snb_log WHERE ts>?', now() - 7 * 864e5).one().c;
          out.lastTrade = this.sql.exec('SELECT MAX(ts) t FROM snb_log').one().t || 0;
          out.new7d = this.sql.exec('SELECT COUNT(*) c FROM snb_users WHERE created>?', now() - 7 * 864e5).one().c;
          out.top = this.sql.exec(`SELECT l.user_id, u.username, u.tg_id, COUNT(*) n, MAX(l.ts) last FROM snb_log l
            LEFT JOIN snb_users u ON u.user_id=l.user_id GROUP BY l.user_id ORDER BY n DESC LIMIT 6`).toArray();
          out.feeBps = Number(this.snbFeeBps()); out.on = this.snbOn(); out.botName = this.snbBot(); if (b.hook) out.hook = '/api/snb/hook/' + this.meta('snb_secret');
          return json(out);
        }
        if (p === '/admin/snbstats') {
          this.snbInit();
          return json({ ok: true,
            tradesTotal: this.sql.exec('SELECT COUNT(*) c FROM snb_log').one().c,
            traders: this.sql.exec('SELECT COUNT(DISTINCT user_id) c FROM snb_log').one().c,
            traders7d: this.sql.exec('SELECT COUNT(DISTINCT user_id) c FROM snb_log WHERE ts>?', now() - 7 * 864e5).one().c,
            users: this.sql.exec('SELECT COUNT(*) c FROM snb_users').one().c,
            new7d: this.sql.exec('SELECT COUNT(*) c FROM snb_users WHERE created>?', now() - 7 * 864e5).one().c,
            lastTrade: this.sql.exec('SELECT MAX(ts) t FROM snb_log').one().t || 0 });
        }
        if (p === '/admin/tg/setup') {
          if (!this.env.TG_BOT_TOKEN) throw new Error('Set the TG_BOT_TOKEN secret first');
          let secret = this.meta('tg_secret'); if (!secret) { secret = randHex(16); this.setMeta('tg_secret', secret); }
          const host = this.meta('public_host') || url.host;
          const me = await this.tg('getMe', {});
          const wh = await this.tg('setWebhook', { url: `https://${host}/api/tg/${secret}`, secret_token: secret, allowed_updates: ['message', 'channel_post'] });
          await this.tg('setMyCommands', { commands: [
            { command: 'track', description: 'Post every buy of a Rookery token here' },
            { command: 'untrack', description: 'Stop posting buys' },
            { command: 'minbuy', description: 'Only post buys above this USD value' },
            { command: 'tracked', description: 'Show tracked tokens' },
            { command: 'setmedia', description: 'Reply to a GIF/photo/video to show it with every buy' },
            { command: 'clearmedia', description: 'Use the token image again' },
            { command: 'socials', description: 'Buttons: /socials x=... tg=... web=...' },
            { command: 'emoji', description: 'Buy-size emoji, e.g. /emoji 🐧' },
            { command: 'preview', description: 'Show a sample buy post' },
            { command: 'help', description: 'How to use the buybot' }] });
          if (me?.ok) this.setMeta('tg_bot', me.result.username);
          return json({ ok: true, bot: me?.result?.username, webhook: wh });
        }
        if (p === '/admin/tg/feed') { const b = await req.json(); this.setMeta('tg_feed_chat', String(b.chat_id || '')); return json({ ok: true }); }
        if (p === '/admin/restart') { setTimeout(() => this.ctx.abort('restart requested'), 50); return json({ ok: true, restarting: true }); }
        if (p === '/admin/stellar') {   // status: hot account, balances, scan cursor, graduation jobs, unassigned deposits
          const st = await this.stellar();
          const bals = await st.balances().catch(e => [{ error: e.message }]);
          return json({ ok: true, net: this.stNet(), hot: st.hotAddress, balances: bals, cursor: this.meta('st_cursor'), rpc: await st.rpcHealth(),
            jobs: this.sql.exec('SELECT market,status,error,updated,state FROM stellar_jobs ORDER BY created DESC LIMIT 20').toArray()
              .map(j => { const S = JSON.parse(j.state || '{}'); delete j.state; return { ...j, pool: S.pool || null, depositXlm: S.depositXlm ?? null, aquaCostXlm: S.aquaCostXlm ?? null }; }),
            unassigned: this.sql.exec(`SELECT id,amount,txid,to_addr,note,ts FROM transfers WHERE chain='stellar' AND status='unassigned' ORDER BY id DESC LIMIT 50`).toArray() });
        }
        if (p === '/admin/stellar/assign') {   // credit an unassigned XLM deposit (no/wrong memo) to a user
          const b = await req.json();
          const t = this.sql.exec(`SELECT * FROM transfers WHERE id=? AND chain='stellar' AND status='unassigned'`, b.id).toArray()[0];
          const u = this.sql.exec('SELECT id FROM users WHERE username=? OR id=?', String(b.user || ''), Number(b.user) || -1).toArray()[0];
          if (!t || !u) throw new Error('transfer or user not found');
          this.ctx.storage.transactionSync(() => {
            this.addBal(u.id, 'xlm', B(t.amount));
            this.sql.exec(`UPDATE transfers SET status='confirmed', user_id=?, note=note || ' · assigned by admin' WHERE id=?`, u.id, t.id);
            if (b.remember !== false && /^G[A-Z2-7]{55}$/.test(String(t.to_addr || '')))
              this.sql.exec('INSERT OR REPLACE INTO st_addr_users (addr,user_id,ts) VALUES (?,?,?)', t.to_addr, u.id, now());
          });
          return json({ ok: true });
        }
        if (p === '/admin/stellar/grad') { const b = await req.json();
          if (b.market) { const m = this.market(String(b.market)); if (m.network !== 'stellar' || m.migrated) throw new Error('not a live Stellar market');
            this.sql.exec('UPDATE markets SET grad_usd=? WHERE id=?', Number(b.usd), m.id); return json({ ok: true, market: m.id, gradUsd: Number(b.usd) }); }
          this.setMeta('stellar_grad_usd', Number(b.usd) || ''); return json({ ok: true, gradUsd: this.stGradUsd() }); }
        if (p === '/admin/stellar/run') return json({ ok: true, ...(await this.wserial(() => this.stellarCron())) });
        if (p === '/admin/stellar/lock') {   // close the issuer of an already graduated token (idempotent)
          const b = await req.json();
          const m = this.market(String(b.market || ''));
          if (!m.st_code || !m.st_issuer) throw new Error('this token is not on Stellar');
          const st = await this.stellar();
          await st.lockIssuer({ code: m.st_code, issuerKp: await this.stIssuer(m.id), burnTok: 0 });
          return json({ ok: true, issuer: m.st_issuer });
        }
        if (p === '/admin/tg/owner') {
          const b = await req.json().catch(() => ({}));
          if (b.action === 'code') {
            const code = randHex(4);
            this.setMeta('tg_owner_code', code);
            this.setMeta('tg_owner_code_exp', String(now() + 15 * 60e3));
            return json({ ok: true, code, expiresInMin: 15, send: `/owner ${code}` });
          }
          if (b.action === 'test') {
            const chat = this.meta('tg_owner_chat');
            if (!chat) throw new Error('no owner chat linked');
            const r = await this.tg('sendMessage', { chat_id: chat, text: '✅ Rookery owner alerts are working.', parse_mode: 'HTML' });
            return json({ ok: !!r?.ok, error: r?.description || null });
          }
          if (b.action === 'off') { this.setMeta('tg_owner_chat', ''); return json({ ok: true }); }
          if (b.action === 'preview') return json({ ok: true, ...(await this.ownerFeed(true)), bridge: (await this.ownerBridgeFeed(true)).preview || [] });
          return json({ ok: true, linked: !!this.meta('tg_owner_chat'), queued: this.sql.exec(`SELECT COUNT(*) c FROM transfers WHERE tg_notified IS NULL AND kind IN ('deposit','withdrawal')`).one().c });
        }
        if (p === '/admin/stellar/send-now') {
          const b = await req.json().catch(() => ({}));
          if (b.on === true || b.on === false) this.setMeta('st_send_now', b.on ? '1' : '');
          if (b.authz) this.setMeta('st_authz_last', '0');
          if (b.cleanTokens) { const c = this.sql.exec(`UPDATE transfers SET status='ignored', note='token mint, not a deposit' WHERE status='unassigned' AND asset LIKE 't:%'`); }
          // send what current wallet holders already hold (pre-graduation tokens with a linked Stellar wallet)
          let seeded = 0;
          if (b.seed && this.stSendNowOn()) {
            for (const r of this.sql.exec(`SELECT b.user_id, b.asset, b.amount FROM balances b JOIN users u ON u.id=b.user_id JOIN markets m ON 't:' || m.id = b.asset
                WHERE m.network='stellar' AND m.migrated=0 AND m.st_issuer IS NOT NULL AND m.st_issuer!='' AND b.amount!='0' AND u.stellar_wallet IS NOT NULL AND u.stellar_wallet!=''`).toArray()) {
              const mk = r.asset.slice(2);
              this.sql.exec(`INSERT OR IGNORE INTO st_out (user_id,market,pending,updated) VALUES (?,?,?,?)`, r.user_id, mk, '0', now());
              this.sql.exec(`UPDATE st_out SET pending=?, next_try=0 WHERE user_id=? AND market=?`, r.amount, r.user_id, mk);
              seeded++;
            }
          }
          const run = b.run ? await this.stellarSendNow(!!b.force) : null;
          return json({ ok: true, on: this.stSendNowOn(), seeded, run, queue: this.sql.exec(`SELECT o.*, u.username FROM st_out o LEFT JOIN users u ON u.id=o.user_id ORDER BY o.updated DESC LIMIT 50`).toArray() });
        }
        if (p === '/admin/stellar/drops') {
          const b = await req.json().catch(() => ({}));
          const run = b.run ? await this.stellarDrops(!!b.force) : null;
          return json({ ok: true, run, rows: this.sql.exec(`SELECT d.*, u.username FROM st_drops d LEFT JOIN users u ON u.id=d.user_id
            ${b.market ? 'WHERE d.market=?' : ''} ORDER BY d.id DESC LIMIT 100`, ...(b.market ? [String(b.market)] : [])).toArray() });
        }
        if (p === '/admin/stellar/job/clear') {
          const b = await req.json();
          this.sql.exec('DELETE FROM stellar_jobs WHERE market=?', String(b.market || ''));
          return json({ ok: true, market: String(b.market || '') });
        }
        if (p === '/admin/network') { const b = await req.json(); if (NETWORKS[b.id]) Object.assign(NETWORKS[b.id], b.patch || {}); return json({ ok: true }); }
        throw new Error('unknown admin op');
      }

      /* authed */
      if (!user) return json({ error: 'Log in to continue' }, 401);

      if (method === 'GET' && p === '/me') {
        const hold = this.sql.exec(`SELECT asset, amount FROM balances WHERE user_id=? AND asset LIKE 't:%' AND amount!='0'`, user.id).toArray()
          .map(h => { const m = this.sql.exec('SELECT * FROM markets WHERE id=?', h.asset.slice(2)).toArray()[0]; if (!m) return null;
            const v = this.view(m, usd); const pend = this.pendingRewards(user.id, m);
            return { id: m.id, name: m.name, symbol: m.symbol, image: v.image, quote: v.quote, amount: h.amount, priceUsd: v.priceUsd,
              network: m.network, stellar: m.network === 'stellar' && m.st_issuer ? { code: m.st_code, issuer: m.st_issuer, withdrawable: !!m.migrated,
                drop: this.sql.exec('SELECT status, note, txid FROM st_drops WHERE market=? AND user_id=?', m.id, user.id).toArray()[0] || null,
                wallet: user.stellar_wallet || null } : null,
              valueUsd: (Number(B(h.amount)) / 1e18) * v.priceUsd, pendingRewards: pend.toString() }; })
          .filter(Boolean);
        // whole-wallet PnL over every token this user ever traded (open and closed), valued in USD at today's ZRO/ETH prices.
        // Only computed when the wallet asks for it (?pnl=1): /me is also polled by every page.
        let pnl = null;
        if (url.searchParams.get('pnl') === '1') {
          pnl = { totalUsd: 0, openUsd: 0, closedUsd: 0, boughtUsd: 0, pct: null, positions: 0 };
          const byId = Object.fromEntries(hold.map(x => [x.id, x]));
          for (const r of this.sql.exec('SELECT DISTINCT market FROM trades WHERE user_id=?', user.id).toArray()) {
            const m = this.sql.exec('SELECT * FROM markets WHERE id=?', r.market).toArray()[0]; if (!m) continue;
            const pos = this.position(user.id, m), qu = this.usdOf(qa(m));
            const pu = pos.pnlZro * qu;
            pnl.totalUsd += pu; pnl.boughtUsd += pos.paidZro * qu; pnl.positions++;
            if (B(pos.tokens) > 0n) pnl.openUsd += pu; else pnl.closedUsd += pu;
            if (byId[m.id]) { byId[m.id].pnlUsd = pu; byId[m.id].pnlPct = pos.pnlPct; byId[m.id].costUsd = pos.costZro * qu; }
          }
          pnl.pct = pnl.boughtUsd > 0 ? (pnl.totalUsd / pnl.boughtUsd) * 100 : null;
        }
        const zro = this.bal(user.id, 'zro'), eth = this.bal(user.id, 'eth'), xlm = this.bal(user.id, 'xlm');
        let stDep = null;
        try { const st = await this.stellar(); stDep = { address: st.hotAddress, memo: String(user.id), net: this.stNet(), explorer: ST_NETS[this.stNet()].explorer }; } catch { /* not configured */ }
        if (!user.eth_dep_address && user.dep_index != null) {
          user.eth_dep_address = this.master().deriveChild(ETH_OFFSET + user.dep_index).address;
          this.sql.exec('UPDATE users SET eth_dep_address=? WHERE id=?', user.eth_dep_address, user.id);
        }
        return json({
          username: user.username, email: user.email, wallet: user.wallet || '', stellarWallet: user.stellar_wallet || '', bio: user.bio, avatar: user.avatar ? `/api/img/u/${user.id}` : '',
          zro: zro.toString(), zroUsd: (Number(zro) / 1e18) * usd, depositAddress: user.dep_address,
          eth: eth.toString(), ethUsd: (Number(eth) / 1e18) * this.ethUsd(), ethPrice: this.ethUsd(), ethDepositAddress: user.eth_dep_address,
          xlm: xlm.toString(), xlmUsd: (Number(xlm) / 1e18) * this.xlmUsd(), xlmPrice: this.xlmUsd(), stellarDeposit: stDep,
          holdings: hold, pnl, badges: this.badgesOf(user.id), hatches: this.hatchList(user).filter(h => h.isMine || h.subscribed),
          points: this.pointsOf(user.id), ref: this.refStats(user),
          transfers: this.sql.exec(`SELECT kind,chain,amount,txid,to_addr,status,note,ts,COALESCE(asset,'zro') asset FROM transfers WHERE user_id=? ORDER BY id DESC LIMIT 50`, user.id).toArray(),
        });
      }
      if (method === 'POST' && p === '/me') {
        const b = await req.json();
        if (b.username !== undefined) {
          const u2 = String(b.username).trim();
          if (!/^[a-zA-Z0-9_]{3,20}$/.test(u2)) throw new Error('Username: 3–20 letters, numbers or _');
          if (u2.toLowerCase() !== user.username.toLowerCase() && this.sql.exec('SELECT 1 FROM users WHERE username=? COLLATE NOCASE', u2).toArray().length) throw new Error('Username taken');
          this.sql.exec('UPDATE users SET username=? WHERE id=?', u2, user.id);
        }
        if (b.bio !== undefined) this.sql.exec('UPDATE users SET bio=? WHERE id=?', String(b.bio).slice(0, 280), user.id);
        if (b.avatar !== undefined) {
          const a = String(b.avatar);
          if (a && (!a.startsWith('data:image/') || a.length > 200_000)) throw new Error('Avatar must be under 150 KB');
          this.sql.exec('UPDATE users SET avatar=? WHERE id=?', a, user.id);
        }
        return json({ ok: true });
      }
      if (method === 'POST' && p === '/trade') {
        const body = await req.json();
        if (body.pay) await this.refreshPrice(); // cron keeps prices <1 min old; this only fills a gap
        const r = this.trade(user, body);
        const mk = this.market(body.market);
        this.queuePush(body.market, 'trade', { side: r.side || body.side, usd: (Number(B(r.zro)) / 1e18) * this.usdOf(qa(mk)), user: user.username, symbol: mk.symbol, id: mk.id });
        if (r.side === 'buy') this.ctx.waitUntil(this.notifyBuy(body.market, { zro: r.zro, tokens: r.tokens }, user.username, this.meta('public_host') || url.host).catch(() => {}));
        return json(r);
      }
      if (method === 'POST' && p === '/markets') {
        const r = this.createMarket(user, await req.json());
        if (r && r.ok) this.ctx.waitUntil(this.stIssue(r.id).catch((e) => console.log('stellar issue failed', r.id, String(e?.message || e).slice(0, 200))));
        { const mk = this.market(r.id);
          this.queuePush(r.id, 'launch', r.dev ? { side: 'buy', usd: (Number(B(r.dev.zro)) / 1e18) * this.usdOf(qa(mk)), user: user.username, symbol: mk.symbol, id: mk.id } : null); }
        const host = this.meta('public_host') || url.host;
        this.ctx.waitUntil((async () => {
          await this.notifyLaunch(r.id, host).catch(() => {});
          if (r.dev) await this.notifyBuy(r.id, { zro: r.dev.zro, tokens: r.dev.tokens }, user.username, host).catch(() => {});
        })());
        return json(r);
      }
      if (method === 'POST' && p === '/comment') {
        const b = await req.json();
        const body = String(b.body || '').trim().slice(0, 500);
        if (!body) throw new Error('Write something first');
        this.market(b.market);
        const lastC = this.sql.exec('SELECT ts FROM comments WHERE user_id=? ORDER BY id DESC LIMIT 1', user.id).toArray()[0];
        if (lastC && now() - lastC.ts < 10_000) throw new Error('Slow down — one comment every 10 seconds');
        this.sql.exec('INSERT INTO comments (market,user_id,body,ts) VALUES (?,?,?,?)', b.market, user.id, body, now());
        this.queuePush(b.market, 'comment');
        return json({ ok: true });
      }
      if (method === 'POST' && p === '/wallet/check') {
        // Deposits are credited for everyone by the cron scan every minute. This endpoint never touches the chain:
        // it only reports deposits credited since this user's last look (so each one is announced once).
        const key = 'chkseen_' + user.id;
        const since = Number(this.meta(key) || (now() - 120_000));
        const found = this.sql.exec(`SELECT chain, amount, ts, COALESCE(asset,'zro') asset FROM transfers WHERE user_id=? AND kind='deposit' AND ts>? ORDER BY id`, user.id, since).toArray();
        this.setMeta(key, String(now()));
        return json({ ok: true, found, lastScanSec: Math.round((now() - Number(this.meta('scan_ok_ethereum') || now())) / 1000) });
      }
      if (method === 'POST' && p === '/wallet/order') {
        if (!user) throw new Error('Log in first');
        const b = await req.json();
        return json({ ok: true, order: this.evmOrderCreate(user, b.market, b.amount, b.pay) });
      }
      if (method === 'POST' && p === '/wallet/order/cancel') {
        if (!user) throw new Error('Log in first');
        const b = await req.json();
        this.sql.exec(`UPDATE orders_evm SET status='cancelled', note='cancelled before payment' WHERE id=? AND user_id=? AND status='open'`, Number(b.id) || 0, user.id);
        return json({ ok: true });
      }
      if (method === 'GET' && p === '/wallet/orders') {
        if (!user) throw new Error('Log in first');
        this.evmOrderExpire();
        return json({ ok: true, live: this.evmOrdersOn(), orders: this.sql.exec(`SELECT id,market,asset,amount,tagged,status,tokens,note,created,expires
          FROM orders_evm WHERE user_id=? ORDER BY id DESC LIMIT 10`, user.id).toArray() });
      }
      if (method === 'POST' && p === '/snb/link') {
        this.snbInit();
        const tok = randHex(12);
        this.sql.exec('INSERT INTO snb_tokens (token,kind,user_id,expires) VALUES (?,?,?,?)', tok, 'link', user.id, now() + 15 * 60e3);
        const linked = this.sql.exec('SELECT 1 FROM snb_users WHERE user_id=?', user.id).toArray().length > 0;
        return json({ ok: true, url: `https://t.me/${this.snbBot()}?start=L${tok}`, linked });
      }
      if (method === 'POST' && p === '/wallet/withdraw') { const body = await req.json(); return json(await this.wserial(() => this.withdrawTimed(user, body))); }
      if (method === 'POST' && p === '/rewards/claim') {
        const b = await req.json();
        let claimed = 0n;
        this.ctx.storage.transactionSync(() => { claimed = this.settle(user.id, this.market(b.market)); });
        return json({ ok: true, claimed: claimed.toString() });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message || 'error' }, 400);
    }
  }
}

/* ───────────── merkle ───────────── */
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
async function merkleRoot(leaves) {
  if (!leaves.length) return sha256('empty');
  let level = leaves.slice().sort();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(await sha256(level[i] + (level[i + 1] || level[i])));
    level = next;
  }
  return level[0];
}

installSniper(Books, { B, WEI, now, escH, randHex, qa, burnKey });
installStx(Books, { B, WEI, now });
installRhpad(Books, { B, WEI, now, randHex, CHAINS });
