// Zero Terminal: every launchpad on Zero in one place (ArcTools-style tabs: All · New · one tab per launchpad).
// Before Zero mainnet it lists the launchpads and Rookery's own Zero tokens (with their reserved addresses).
// From the first Zero block it indexes every new token on-chain: the first mint (Transfer from 0x0) of a contract is
// its birth; the transaction's `to` is the factory, mapped to a launchpad (factories are learned at launch and can
// be mapped later, retroactively). Activity = Transfer count, refreshed in batches.
const ZERO_ADDR_TOPIC = '0x' + '0'.repeat(64);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// launchpads announced for Zero (profile data from their X accounts, 22 Nov 2026)
export const PADS = [
  { id: 'rookery', name: 'Rookery', handle: 'StinkyPenguinL0', site: 'https://rookery.stinkypenguin.xyz', kind: 'Pre-market launchpad · 1:1 to Zero', status: 'live', followers: null, ours: true, net: 'both' },
  { id: 'tzero', name: 'Tzero', handle: 'T0dotfun', site: 'https://testnet.tzer0.fun/launch', kind: 'First launchpad on Zero (bonding curve)', status: 'testnet', followers: 3790, avatar: 'https://pbs.twimg.com/profile_images/2106911707251531776/8XoApRRl_200x200.jpg', net: 'zero' },
  { id: '000', name: '000.fun', handle: '000dotfun', site: 'https://000.fun', kind: 'Token launchpad', status: 'soon', followers: 2238, avatar: 'https://pbs.twimg.com/profile_images/2110214996106137600/4zHcR0kq_200x200.jpg', net: 'zero' },
  { id: 'zrofun', name: 'ZROfun', handle: 'ZROfun', site: 'https://ZRO.fun', kind: 'Meme launchpad (ZRO paired)', status: 'soon', followers: 406, avatar: 'https://pbs.twimg.com/profile_images/2120982327384010752/2DGpI4aG_200x200.jpg', net: 'zero' },
  { id: 'nilly', name: 'nilly', handle: 'nillyfun', site: 'https://testnet.nilly.fun/', kind: 'Anti-rug focused launchpad', status: 'testnet', followers: 618, avatar: 'https://pbs.twimg.com/profile_images/2120972424397119489/27i5RPAg_200x200.jpg', net: 'zero' },
  { id: 'zerolotl', name: 'Zerolotl', handle: 'zerolotl', site: 'https://zerolotl.fun/', kind: 'Launchpad · custom fee sharing (70% to whom you choose)', status: 'soon', followers: 169, avatar: 'https://pbs.twimg.com/profile_images/2121544389704962048/2IR2_C5G_200x200.jpg', net: 'zero' },
  { id: 'peal', name: 'Peal', handle: 'pealhq', site: null, kind: 'Daily sealed-bid launchpad · LP locked 90 days', status: 'soon', followers: 130, avatar: 'https://pbs.twimg.com/profile_images/2121219918989295616/OxgiUWer_200x200.jpg', net: 'zero' },
  { id: 'st0cks', name: 'st0cks', handle: 'St0cksfun', site: 'https://st0cks.fun', kind: 'Stock meme launchpad', status: 'soon', followers: 148, avatar: 'https://pbs.twimg.com/profile_images/2119834185896697857/RB0arcpy_200x200.jpg', net: 'zero' },
  { id: '0stocks', name: 'ZeroStocks', handle: '0Stocks_fun', site: 'https://0stocks.fun', kind: 'Tokenized stocks launchpad (stock-paired)', status: 'soon', followers: 119, avatar: 'https://pbs.twimg.com/profile_images/2112556101657108480/wnUvPawU_200x200.jpg', net: 'zero' },
  { id: 'zeromeme', name: 'ZeroMeme.Fun', handle: 'ZeromemeFun', site: 'https://zeromeme.fun', kind: 'Omnichain meme launchpad', status: 'soon', followers: 166, avatar: 'https://pbs.twimg.com/profile_images/2110434933017833472/_RJpoAMw_200x200.jpg', net: 'zero' },
  { id: 'gitzero', name: 'GitZero', handle: 'GitZero_', site: null, kind: 'GitHub repo → coin', status: 'soon', followers: 117, avatar: 'https://pbs.twimg.com/profile_images/2121413945827217408/XFhAg_Vj_200x200.jpg', net: 'zero' },
  { id: 'orpheus', name: 'Orpheus', handle: 'Orpheusfun', site: 'https://orpheusfun.com', kind: 'Fair launchpad · live day one', status: 'soon', followers: 77, avatar: 'https://pbs.twimg.com/profile_images/2122435083458002944/DH5vEuR8_200x200.jpg', net: 'zero' },
  { id: 'zerovo', name: 'Zerovo', handle: 'Zerovo_io', site: 'https://zerovo.io/', kind: 'Day-1 launchpad · auto spot market, migrate anytime', status: 'soon', followers: 88, avatar: 'https://pbs.twimg.com/profile_images/2122496318710902784/6v47wheS_200x200.png', net: 'zero' },
  { id: 'orez', name: 'Orez', handle: 'OrezDotFun', site: null, kind: 'Launchpad', status: 'soon', followers: 124, avatar: 'https://pbs.twimg.com/profile_images/2121299603702079488/7eki7iuy_200x200.jpg', net: 'zero' },
  { id: '0rigin', name: '0rigin', handle: '0rigindotfun', site: 'https://0rigin.fun', kind: 'Launchpad', status: 'soon', followers: 510, avatar: 'https://pbs.twimg.com/profile_images/2117331860053278720/1Tbbm_Vb_200x200.jpg', net: 'zero' },
  { id: 'addicted', name: 'Addicted', handle: 'Addictedfamily_', site: 'http://addicted.family', kind: 'Launchpad', status: 'soon', followers: 48, avatar: 'https://pbs.twimg.com/profile_images/2121440025640378368/uBGnWgC__200x200.png', net: 'zero' },
  // GIWA (Upbit) launchpads, profile data from their X accounts (22 Nov 2026)
  { id: 'deus', name: 'deuslaunch', handle: 'deuslaunch', site: 'https://testnet.deuslaunch.com/', kind: 'Launchpad on GIWA · mainnet day 1', status: 'testnet', followers: 3579, avatar: 'https://pbs.twimg.com/profile_images/2112562619911380992/kwJ5aHo-_200x200.jpg', net: 'giwa' },
  { id: 'gamapad', name: 'Gamapad', handle: 'gamapadcom', site: 'https://gamapad.com', kind: 'Day-1 token launchpad on GIWA', status: 'testnet', followers: 2175, avatar: 'https://pbs.twimg.com/profile_images/2106010799323881472/rfI54MAe_200x200.jpg', net: 'giwa' },
  { id: 'jakdu', name: 'JAKDU', handle: 'jakdupump', site: 'https://jakdupump.xyz', kind: 'GIWA tokens in one place: launch, discover, trade', status: 'soon', followers: 1213, avatar: 'https://pbs.twimg.com/profile_images/2104208917328785408/gWAscJDQ_200x200.jpg', net: 'giwa' },
  { id: 'gama', name: 'Gama', handle: 'GamaDotWin', site: 'https://gama.win', kind: 'Launchpad on GIWA', status: 'soon', followers: 239, avatar: 'https://pbs.twimg.com/profile_images/2103683089176162304/YaC8hpId_200x200.jpg', net: 'giwa' },
  { id: 'hanok', name: 'hanok', handle: 'hanokfun', site: 'https://hanok.fun', kind: 'Fair launches · graduate to a locked Uniswap V4 pool', status: 'testnet', followers: 131, avatar: 'https://pbs.twimg.com/profile_images/2105863077904429056/LoZ_bSnk_200x200.jpg', net: 'giwa' },
  { id: 'jangteo', name: 'Jangteo 장터', handle: 'jangteo_org', site: 'https://jangteo.org', kind: 'Korean markets: swap, Ppeongtwigi launchpad, NFTs', status: 'soon', followers: 114, avatar: 'https://pbs.twimg.com/profile_images/2103882811652685825/42m8JHb4_200x200.jpg', net: 'giwa' },
  { id: 'giwagmi', name: 'GIWAGMI', handle: 'giwagmi', site: 'https://giwagmi.fun', kind: 'Launchpad on GIWA, coming soon', status: 'soon', followers: 44, avatar: 'https://pbs.twimg.com/profile_images/2103885218763468800/9GIecWvH_200x200.jpg', net: 'giwa' },
  { id: 'gord', name: 'Gord', handle: 'gordpro_', site: 'https://docs.gord.pro/', kind: 'Centralized launchpad on GIWA', status: 'soon', followers: 186, avatar: 'https://pbs.twimg.com/profile_images/2092306064494780416/-5USxWVy_200x200.png', net: 'giwa' },
  { id: 'xpad', name: 'XPAD', handle: 'Xpad_Official', site: 'https://xpad.fun', kind: 'Multichain launchpad · had a GIWA Sepolia version', status: 'testnet', followers: 503, avatar: 'https://pbs.twimg.com/profile_images/1965363157603389440/5xVBa8_M_200x200.jpg', net: 'giwa' },
];
export const TERM_NETS = { zero: { label: 'Zero', by: 'LayerZero', mainnet: '30.11', native: 'ZRO' }, giwa: { label: 'GIWA', by: 'Upbit', mainnet: 'TBA', native: 'ETH' }, litvm: { label: 'LitVM', by: 'Litecoin', mainnet: 'TBA', native: 'zkLTC' } };

const hexAddr = (topic) => '0x' + topic.slice(26).toLowerCase();
function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  const b = hex.slice(2);
  try {
    if (b.length === 64) return Buffer.from(b, 'hex').toString('utf8').replace(/\0+$/g, '');      // bytes32 symbols
    const len = parseInt(b.slice(64, 128), 16);
    return new TextDecoder().decode(Uint8Array.from(b.slice(128, 128 + len * 2).match(/../g) || [], (x) => parseInt(x, 16)));
  } catch { return ''; }
}

export function installTerminal(Cls, H) {
  const { now } = H;
  const P = Cls.prototype;

  P.termInit = function () {
    if (this._termInit) return; this._termInit = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS term_tokens (addr TEXT PRIMARY KEY, pad TEXT, factory TEXT, creator TEXT, name TEXT, symbol TEXT,
      decimals INTEGER, supply TEXT, tx TEXT, block INTEGER, ts INTEGER, transfers INTEGER DEFAULT 0, last_activity INTEGER DEFAULT 0, chain TEXT DEFAULT 'zero')`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS term_pad ON term_tokens (pad, block)`);
    try { this.sql.exec('ALTER TABLE markets ADD COLUMN zero_token TEXT'); } catch { /* exists */ }
    for (const col of ['pool TEXT', 'holders INTEGER DEFAULT 0', 'top10 REAL DEFAULT 0', 'creator_pct REAL DEFAULT 0', "price_native TEXT DEFAULT '0'",
      'buys INTEGER DEFAULT 0', 'sells INTEGER DEFAULT 0', "vol_native TEXT DEFAULT '0'", 'last_trade INTEGER DEFAULT 0']) {
      try { this.sql.exec(`ALTER TABLE term_tokens ADD COLUMN ${col}`); } catch { /* exists */ }
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS term_bal (chain TEXT, token TEXT, holder TEXT, bal TEXT, PRIMARY KEY (chain, token, holder))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS term_tx (chain TEXT, token TEXT, tx TEXT, idx INTEGER, block INTEGER, ts INTEGER, kind TEXT, from_a TEXT, to_a TEXT,
      amount TEXT, value TEXT DEFAULT '0', PRIMARY KEY (chain, tx, idx))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS term_tx_tok ON term_tx (chain, token, block)`);
  };
  P.termFactories = function () { try { return JSON.parse(this.meta('term_factories') || '{}'); } catch { return {}; } };
  P.termPadStatus = function () { try { return JSON.parse(this.meta('term_pad_status') || '{}'); } catch { return {}; } };

  // one indexing pass over [from, to] on any EVM RPC (Zero in production, any chain in tests)
  P.termIndex = async function (rpc, { from, to, chain = 'zero', maxNew = 40 } = {}) {
    this.termInit();
    const fac = this.termFactories();
    const logs = await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER, ZERO_ADDR_TOPIC] }]);
    const seen = new Set(this.sql.exec('SELECT addr FROM term_tokens WHERE chain=?', chain).toArray().map(r => r.addr));
    const fresh = [];
    for (const l of logs || []) {
      const a = l.address.toLowerCase();
      if (seen.has(a) || fresh.some(f => f.addr === a) || l.topics.length !== 3) continue;   // ERC-20 Transfer has 3 topics (ERC-721 has 4)
      fresh.push({ addr: a, tx: l.transactionHash, block: parseInt(l.blockNumber, 16), firstTo: hexAddr(l.topics[2]) });
      if (fresh.length >= maxNew) break;
    }
    const call = (to2, data) => rpc('eth_call', [{ to: to2, data }, 'latest']).catch(() => '0x');
    for (const f of fresh) {
      const [tx, nm, sy, dc, ts, blk] = await Promise.all([
        rpc('eth_getTransactionByHash', [f.tx]).catch(() => null), call(f.addr, '0x06fdde03'), call(f.addr, '0x95d89b41'),
        call(f.addr, '0x313ce567'), call(f.addr, '0x18160ddd'), rpc('eth_getBlockByNumber', ['0x' + f.block.toString(16), false]).catch(() => null)]);
      const factory = (tx?.to || '').toLowerCase() || null;
      const firstTo = f.firstTo;
      let pool = factory;
      if (firstTo) { const code = await rpc('eth_getCode', [firstTo, 'latest']).catch(() => '0x'); if (code && code !== '0x') pool = firstTo; }
      const pad = (factory && fac[factory]) || (factory ? 'unknown' : 'direct');
      const dec = dc && dc !== '0x' ? Number(BigInt(dc)) : 18;
      if (dec > 36) continue;                                                             // not an ERC-20
      this.sql.exec(`INSERT OR IGNORE INTO term_tokens (addr,pad,factory,creator,name,symbol,decimals,supply,tx,block,ts,chain,pool) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.addr, pad, factory, (tx?.from || '').toLowerCase(), decodeString(nm).slice(0, 64), decodeString(sy).slice(0, 24), dec,
        ts && ts !== '0x' ? BigInt(ts).toString() : '0', f.tx, f.block, blk ? Number(BigInt(blk.timestamp)) * 1000 : now(), chain, pool);
    }
    // every Transfer of the tracked tokens: balances, trades (buy/sell/mint/burn/transfer), buy price from the native value paid
    const tracked = this.sql.exec('SELECT addr, pool, creator FROM term_tokens WHERE chain=? ORDER BY block DESC LIMIT 100', chain).toArray();
    let trades = 0;
    if (tracked.length) {
      const meta = Object.fromEntries(tracked.map(t => [t.addr, t]));
      const act = await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: tracked.map(t => t.addr), topics: [TRANSFER] }]).catch(() => []);
      // timestamps: interpolate inside the range (2 block reads instead of one per block)
      const [b0, b1] = await Promise.all([rpc('eth_getBlockByNumber', ['0x' + from.toString(16), false]).catch(() => null), rpc('eth_getBlockByNumber', ['0x' + to.toString(16), false]).catch(() => null)]);
      const t0 = b0 ? Number(BigInt(b0.timestamp)) * 1000 : now(), t1 = b1 ? Number(BigInt(b1.timestamp)) * 1000 : now();
      const tsOf = (bn) => (to === from ? t1 : Math.round(t0 + (t1 - t0) * (bn - from) / (to - from)));
      const DEAD = '0x000000000000000000000000000000000000dead', Z = '0x0000000000000000000000000000000000000000';
      const touched = new Set(), buys = [];
      const bal = (tok, h) => BigInt(this.sql.exec('SELECT bal FROM term_bal WHERE chain=? AND token=? AND holder=?', chain, tok, h).toArray()[0]?.bal || '0');
      const setBal = (tok, h, v) => this.sql.exec(`INSERT INTO term_bal (chain,token,holder,bal) VALUES (?,?,?,?) ON CONFLICT(chain,token,holder) DO UPDATE SET bal=excluded.bal`, chain, tok, h, v.toString());
      for (const l of (act || []).sort((x, y) => parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16) || parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16))) {
        if (l.topics.length !== 3) continue;
        const tok = l.address.toLowerCase(), m = meta[tok]; if (!m) continue;
        const fa = hexAddr(l.topics[1]), ta = hexAddr(l.topics[2]), amt = BigInt(l.data === '0x' ? 0 : l.data.slice(0, 66));
        const idx = parseInt(l.logIndex, 16), bn = parseInt(l.blockNumber, 16);
        if (this.sql.exec('SELECT 1 FROM term_tx WHERE chain=? AND tx=? AND idx=?', chain, l.transactionHash, idx).toArray().length) continue;   // already applied
        if (fa !== Z) setBal(tok, fa, bal(tok, fa) - amt);
        if (ta !== Z) setBal(tok, ta, bal(tok, ta) + amt);
        const pool = m.pool;
        const kind = fa === Z ? (ta === pool ? 'mint' : 'buy') : fa === pool ? 'buy' : ta === pool ? 'sell' : ta === Z ? 'sell' : ta === DEAD ? 'burn' : 'transfer';
        this.sql.exec(`INSERT INTO term_tx (chain,token,tx,idx,block,ts,kind,from_a,to_a,amount) VALUES (?,?,?,?,?,?,?,?,?,?)`, chain, tok, l.transactionHash, idx, bn, tsOf(bn), kind, fa, ta, amt.toString());
        if (kind === 'buy') buys.push({ tok, tx: l.transactionHash, idx, amt });
        if (kind === 'buy' || kind === 'sell') { trades++; this.sql.exec(`UPDATE term_tokens SET ${kind === 'buy' ? 'buys=buys+1' : 'sells=sells+1'}, last_trade=? WHERE chain=? AND addr=?`, tsOf(bn), chain, tok); }
        this.sql.exec('UPDATE term_tokens SET transfers=transfers+1, last_activity=? WHERE chain=? AND addr=?', tsOf(bn), chain, tok);
        touched.add(tok);
      }
      // what each buy paid (native coin sent with the transaction): price and volume, capped per pass
      const txv = {};
      for (const h of [...new Set(buys.map(x => x.tx))].slice(0, 40)) { const t = await rpc('eth_getTransactionByHash', [h]).catch(() => null); txv[h] = t ? BigInt(t.value || '0x0') : 0n; }
      for (const x of buys) {
        const v = txv[x.tx]; if (!v || !x.amt) continue;
        this.sql.exec('UPDATE term_tx SET value=? WHERE chain=? AND tx=? AND idx=?', v.toString(), chain, x.tx, x.idx);
        const tk = this.sql.exec('SELECT vol_native FROM term_tokens WHERE chain=? AND addr=?', chain, x.tok).one();
        this.sql.exec('UPDATE term_tokens SET price_native=?, vol_native=? WHERE chain=? AND addr=?', ((v * 10n ** 18n) / x.amt).toString(), (BigInt(tk.vol_native || '0') + v).toString(), chain, x.tok);
      }
      for (const tok of touched) this.termStats(chain, tok);
    }
    return { scanned: [from, to], newTokens: fresh.length, logs: (logs || []).length, trades };
  };

  // holders (without curve / pool, dead and zero), top-10 share and creator share of the supply
  P.termStats = function (chain, tok) {
    const t = this.sql.exec('SELECT * FROM term_tokens WHERE chain=? AND addr=?', chain, tok).toArray()[0]; if (!t) return;
    const skip = [t.pool, '0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000'].filter(Boolean);
    const rows = this.sql.exec(`SELECT holder, bal FROM term_bal WHERE chain=? AND token=? AND bal!='0'`, chain, tok).toArray()
      .filter(r => !skip.includes(r.holder) && BigInt(r.bal) > 0n).sort((x, y) => (BigInt(y.bal) > BigInt(x.bal) ? 1 : -1));
    const supply = BigInt(t.supply || '0') || rows.reduce((a, r) => a + BigInt(r.bal), 0n) || 1n;
    const pct = (v) => Number((v * 1000000n) / supply) / 10000;
    const top10 = pct(rows.slice(0, 10).reduce((a, r) => a + BigInt(r.bal), 0n));
    const cr = rows.find(r => r.holder === t.creator);
    this.sql.exec('UPDATE term_tokens SET holders=?, top10=?, creator_pct=? WHERE chain=? AND addr=?', rows.length, top10, cr ? pct(BigInt(cr.bal)) : 0, chain, tok);
  };

  P.termNativeUsd = function (net) { try { return net === 'giwa' ? this.ethUsd() : net === 'litvm' ? (this.ltcUsd?.() || 0) : this.zroUsd(); } catch { return 0; } };
  P.termRow = function (net, r, usd) {
    const px = Number(BigInt(r.price_native || '0')) / 1e18;           // native per whole token
    const sup = Number(BigInt(r.supply || '0')) / 10 ** (r.decimals ?? 18);
    return { address: r.addr, pad: r.pad, name: r.name, symbol: r.symbol, supply: r.supply, decimals: r.decimals, creator: r.creator, factory: r.factory, pool: r.pool,
      ts: r.ts, block: r.block, transfers: r.transfers, holders: r.holders, top10: r.top10, creatorPct: r.creator_pct, buys: r.buys, sells: r.sells,
      priceUsd: px ? px * usd : null, mcapUsd: px ? px * sup * usd : null, volumeUsd: Number(BigInt(r.vol_native || '0')) / 1e18 * usd || 0, lastTrade: r.last_trade, onchain: true, priceEstimated: true };
  };

  // token page payload for an on-chain token of any launchpad
  P.termToken = function (net, addr) {
    this.termInit();
    const a = String(addr || '').toLowerCase();
    const r = this.sql.exec('SELECT * FROM term_tokens WHERE chain=? AND addr=?', net, a).toArray()[0];
    if (!r) return null;
    const usd = this.termNativeUsd(net);
    const row = this.termRow(net, r, usd);
    const supply = BigInt(r.supply || '0') || 1n;
    const label = (h) => h === r.pool ? 'curve / pool' : h === r.creator ? 'creator' : h === '0x000000000000000000000000000000000000dead' ? 'burned' : h === r.factory ? 'launchpad' : '';
    const holders = this.sql.exec(`SELECT holder, bal FROM term_bal WHERE chain=? AND token=? AND bal!='0'`, net, a).toArray()
      .filter(x => BigInt(x.bal) > 0n).sort((x, y) => (BigInt(y.bal) > BigInt(x.bal) ? 1 : -1)).slice(0, 50)
      .map(x => ({ address: x.holder, amount: x.bal, pct: Number((BigInt(x.bal) * 1000000n) / supply) / 10000, tag: label(x.holder) }));
    const txs = this.sql.exec('SELECT tx, block, ts, kind, from_a, to_a, amount, value FROM term_tx WHERE chain=? AND token=? ORDER BY block DESC, idx DESC LIMIT 100', net, a).toArray()
      .map(x => ({ ...x, valueUsd: Number(BigInt(x.value || '0')) / 1e18 * usd }));
    const points = this.sql.exec(`SELECT ts, amount, value FROM term_tx WHERE chain=? AND token=? AND kind='buy' AND value!='0' ORDER BY block, idx LIMIT 3000`, net, a).toArray()
      .map(x => ({ ts: x.ts, priceUsd: Number((BigInt(x.value) * 10n ** 18n) / (BigInt(x.amount) || 1n)) / 1e18 * usd }));
    const pad = PADS.find(p => p.id === r.pad) || null;
    const zs = net === 'zero' ? (this.zwState?.() || {}) : {};
    const explorer = net === 'zero' ? (Object.entries(zs.explorers || {}).find(([, v]) => v.up)?.[0] || null) : (this.meta(net + '_explorer') || null);
    return { net, nets: TERM_NETS, token: row, pad, holders, txs, points, explorer, native: net === 'giwa' ? 'ETH' : 'ZRO', nativeUsd: usd };
  };

  // EXFIL-style intel: who is in profit, how much of the supply could sell into a buy, ATH, entry levels, net buyers
  P.termIntel = function (net, { market, addr } = {}) {
    this.termInit();
    const T = now(), H = T - 36e5;
    const usdNow = this.termNativeUsd(net);
    const book = {}, buyers1h = new Set(), sellers1h = new Set(), net1h = {};
    let holders = [], priceNow = 0, ath = 0, supply = 0;
    const add = (u) => (book[u] = book[u] || { tok: 0, cost: 0 });
    if (market) {
      const m = this.sql.exec('SELECT * FROM markets WHERE id=?', String(market)).toArray()[0]; if (!m) return null;
      let v = {}; try { v = this.view(m) || {}; } catch { /* */ }
      priceNow = v.priceUsd || 0; supply = 1e9;
      for (const t of this.sql.exec('SELECT user_id, side, zro, tokens, price, usd, ts FROM trades WHERE market=? ORDER BY id', m.id).toArray()) {
        const tok = Number(BigInt(t.tokens)) / 1e18, val = Number(BigInt(t.zro)) / 1e18 * (t.usd || usdNow), b = add(t.user_id);
        ath = Math.max(ath, Number(BigInt(t.price)) / 1e18 * (t.usd || usdNow));
        if (t.side === 'buy') { b.tok += tok; b.cost += val; } else if (b.tok > 0) { const f = Math.min(1, tok / b.tok); b.cost -= b.cost * f; b.tok = Math.max(0, b.tok - tok); }
        if (t.ts > H) { (t.side === 'buy' ? buyers1h : sellers1h).add(t.user_id); net1h[t.user_id] = (net1h[t.user_id] || 0) + (t.side === 'buy' ? val : -val); }
      }
      holders = this.sql.exec(`SELECT user_id h, amount FROM balances WHERE asset=? AND amount!='0'`, 't:' + m.id).toArray().map(r => ({ h: r.h, bal: Number(BigInt(r.amount)) / 1e18 }));
    } else {
      const a = String(addr || '').toLowerCase();
      const r = this.sql.exec('SELECT * FROM term_tokens WHERE chain=? AND addr=?', net, a).toArray()[0]; if (!r) return null;
      const dec = 10 ** (r.decimals ?? 18);
      priceNow = Number(BigInt(r.price_native || '0')) / 1e18 * usdNow; supply = Number(BigInt(r.supply || '0')) / dec;
      for (const t of this.sql.exec(`SELECT kind, from_a, to_a, amount, value, ts FROM term_tx WHERE chain=? AND token=? ORDER BY block, idx`, net, a).toArray()) {
        const tok = Number(BigInt(t.amount)) / dec, val = Number(BigInt(t.value || '0')) / 1e18 * usdNow;
        if (t.kind === 'buy') { const b = add(t.to_a); b.tok += tok; b.cost += val; if (val && tok) ath = Math.max(ath, val / tok); if (t.ts > H) { buyers1h.add(t.to_a); net1h[t.to_a] = (net1h[t.to_a] || 0) + val; } }
        else if (t.kind === 'sell') { const b = add(t.from_a); if (b.tok > 0) { const f = Math.min(1, tok / b.tok); b.cost -= b.cost * f; b.tok = Math.max(0, b.tok - tok); } if (t.ts > H) { sellers1h.add(t.from_a); net1h[t.from_a] = (net1h[t.from_a] || 0) - priceNow * tok; } }
      }
      const skip = [r.pool, '0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000'];
      holders = this.sql.exec(`SELECT holder h, bal FROM term_bal WHERE chain=? AND token=? AND bal!='0'`, net, a).toArray().filter(x => !skip.includes(x.h)).map(x => ({ h: x.h, bal: Number(BigInt(x.bal)) / dec }));
    }
    holders = holders.filter(x => x.bal > 0).sort((x, y) => y.bal - x.bal);
    const entry = (h) => { const b = book[h]; return b && b.tok > 0 ? b.cost / b.tok : null; };
    const inProfit = holders.filter(x => { const e = entry(x.h); return e != null && priceNow > e; });
    const tokP = inProfit.reduce((acc, x) => acc + x.bal, 0);
    const wAvg = (arr) => { let tt = 0, c = 0; for (const x of arr) { const e = entry(x.h); if (e != null) { tt += x.bal; c += x.bal * e; } } return tt ? c / tt : null; };
    const nb = Object.values(net1h);
    return {
      priceUsd: priceNow, athUsd: ath || null, fromAthPct: ath ? (priceNow / ath - 1) * 100 : null,
      holders: holders.length, inProfit: inProfit.length, inProfitPct: holders.length ? inProfit.length / holders.length * 100 : 0,
      supplyInProfitPct: supply ? tokP / supply * 100 : 0, valueInProfitUsd: tokP * priceNow,
      inProfitEntryUsd: wAvg(inProfit), top100EntryUsd: wAvg(holders.slice(0, 100)),
      traders1h: new Set([...buyers1h, ...sellers1h]).size, buyers1h: buyers1h.size, sellers1h: sellers1h.size,
      netBuyers1h: nb.filter(x => x > 0).length - nb.filter(x => x < 0).length,
      note: market ? 'From Rookery trades: entry = average cost of each account in USD at the time of each trade.' : `From on-chain buys: entry = ${TERM_NETS[net]?.native || 'native'} paid, at today's price; sells reduce the position.`,
    };
  };

  // called from the Zero watcher loop once a verified RPC exists: follow the chain from block 1, a capped range per pass
  P.termTick = async function (rpc, chain = 'zero') {
    this._termBusyBy = this._termBusyBy || {};
    if (this._termBusyBy[chain]) return null; this._termBusyBy[chain] = true;
    const ck = chain === 'zero' ? 'term_cursor' : 'term_cursor_' + chain;
    try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      let cur = Number(this.meta(ck) || 0);
      if (cur >= head) return { head, idle: true };
      const to = Math.min(head, cur + 500);
      const r = await this.termIndex(rpc, { from: cur + 1, to, chain });
      this.setMeta(ck, String(to));
      return { head, ...r };
    } catch (e) { this.setMeta('term_err', String(e.message || e).slice(0, 160)); return { error: String(e.message || e) }; }
    finally { this._termBusyBy[chain] = false; }
  };

  // public payload: launchpads + tokens (on-chain index + Rookery's own Zero tokens with reserved addresses)
  P.termView = function ({ net = 'zero', pad = 'all', sort = 'new', q = '', tab = '' } = {}) {
    this.termInit();
    if (!TERM_NETS[net]) net = 'zero';
    const st = this.termPadStatus();
    const fac = this.termFactories();
    const counts = Object.fromEntries(this.sql.exec(`SELECT pad, COUNT(*) c FROM term_tokens WHERE chain=? GROUP BY pad`, net).toArray().map(r => [r.pad, r.c]));
    const rook = this.sql.exec(`SELECT * FROM markets WHERE network=? ORDER BY created DESC LIMIT 300`, net).toArray();
    const usd = this.termNativeUsd(net);
    // momentum from the ledger trades: 24h volume, price 24h ago, traders in the last hour
    const T = now(), D = T - 864e5, H = T - 36e5;
    const mom = {};
    for (const r of this.sql.exec(`SELECT t.market, SUM(CAST(t.zro AS REAL) / 1e18 * t.usd) vol, COUNT(DISTINCT CASE WHEN t.ts>? THEN t.user_id END) tr1h
      FROM trades t JOIN markets m ON m.id=t.market WHERE m.network=? AND t.ts>? GROUP BY t.market`, H, net, D).toArray()) mom[r.market] = { vol24h: r.vol || 0, traders1h: r.tr1h || 0 };
    for (const r of this.sql.exec(`SELECT t.market, t.price, t.usd FROM trades t WHERE t.id IN (SELECT MAX(t2.id) FROM trades t2 JOIN markets m ON m.id=t2.market WHERE m.network=? AND t2.ts<? GROUP BY t2.market)`, net, D).toArray())
      (mom[r.market] = mom[r.market] || {}).p24 = Number(BigInt(r.price)) / 1e18 * (r.usd || usd);
    counts.rookery = rook.length;
    const pads = PADS.filter(p => p.net === net || p.net === 'both')
      .map(p => ({ ...p, status: st[p.id] || p.status, tokens: counts[p.id] || 0, factories: Object.entries(fac).filter(([, v]) => v === p.id).map(([k]) => k) }));
    const chainPad = pad !== 'all' && pad !== 'new' && pad !== 'rookery';
    const order = sort === 'active' ? 'transfers DESC, block DESC' : sort === 'holders' ? 'holders DESC, block DESC' : 'block DESC';
    const rows = this.sql.exec(`SELECT * FROM term_tokens WHERE chain=? ${chainPad ? 'AND pad=?' : ''} ORDER BY ${order} LIMIT 200`, ...(chainPad ? [net, pad] : [net])).toArray();
    const newDeploys24h = this.sql.exec(`SELECT COUNT(*) c FROM term_tokens WHERE chain=? AND ts>?`, net, now() - 864e5).one().c;
    const deploysTotal = this.sql.exec(`SELECT COUNT(*) c FROM term_tokens WHERE chain=?`, net).one().c;
    // "New deploys": every on-chain deployment on that chain, newest first (Rookery's pre-market tokens are not deployed yet)
    let tokens = pad === 'rookery' ? [] : rows.map(r => this.termRow(net, r, usd));
    if (pad === 'all' || pad === 'rookery') {
      const own = rook.map(m => {
        let address = m.zero_token;
        if (!address) { try { address = this.netTokenAddr(net, m.id); } catch { address = null; } }
        let v = {}; try { v = this.view(m) || {}; } catch { /* market view unavailable */ }
        // holder concentration from the ledger: top 10 accounts' share of the 1B supply (curve inventory is not an account)
        const bals = this.sql.exec(`SELECT amount FROM balances WHERE asset=? AND amount!='0'`, 't:' + m.id).toArray().map(x => BigInt(x.amount)).sort((x, y) => (y > x ? 1 : -1));
        const sup = 10n ** 27n;
        const top10 = Number((bals.slice(0, 10).reduce((x, y) => x + y, 0n) * 1000000n) / sup) / 10000;
        const cb = BigInt(this.sql.exec(`SELECT amount FROM balances WHERE user_id=? AND asset=?`, m.creator_id, 't:' + m.id).toArray()[0]?.amount || '0');
        const mo = mom[m.id] || {};
        const launch = (Number(m.v_wei ? BigInt(m.v_wei) : BigInt(m.v_zro || 0) * 10n ** 18n) / 1e18) / Number(m.v_tok || 1073000000) * usd;
        const p24 = mo.p24 || launch;
        return { address, pad: 'rookery', name: m.name, symbol: m.symbol, image: m.image, ts: m.created, transfers: m.trades, market: m.id, onchain: !!m.migrated, reserved: !m.migrated,
          change24h: v.priceUsd && p24 ? (v.priceUsd / p24 - 1) * 100 : null, x: v.priceUsd && launch ? v.priceUsd / launch : null, vol24h: mo.vol24h || 0, traders1h: mo.traders1h || 0,
          graduated: !!m.graduated, quote: m.quote, tradeable: !m.migrated && !m.rh_token,
          holders: bals.length, top10, creatorPct: Number((cb * 1000000n) / sup) / 10000, priceUsd: v.priceUsd ?? null, mcapUsd: v.mcapUsd ?? null, volumeUsd: v.volumeUsd ?? 0,
          liquidityUsd: v.liquidityUsd ?? null, progress: v.progress ?? null, buys: null, sells: null, lastTrade: m.last_trade };
      });
      const key = { active: 'transfers', holders: 'holders', mcap: 'mcapUsd', volume: 'volumeUsd', change: 'change24h', traders: 'traders1h', trending: 'vol24h' }[sort];
      tokens = (pad === 'rookery' ? own : [...tokens, ...own]).sort((x, y) => (key ? ((y[key] || 0) - (x[key] || 0)) : (y.ts - x.ts))).slice(0, 250);
    }
    if (pad !== 'all' && pad !== 'rookery' && (sort === 'mcap' || sort === 'volume')) { const k = sort === 'mcap' ? 'mcapUsd' : 'volumeUsd'; tokens.sort((x, y) => (y[k] || 0) - (x[k] || 0)); }
    if (tab === 'bonding') tokens = tokens.filter(t => t.progress != null && t.progress >= 50 && !t.graduated).sort((x, y) => y.progress - x.progress);
    const v24 = (t) => (t.vol24h != null ? t.vol24h : t.onchain && !t.market ? (t.volumeUsd || 0) : 0);
    if (tab === 'trending') tokens.sort((x, y) => (v24(y) - v24(x)) || ((y.traders1h || 0) - (x.traders1h || 0)) || ((y.mcapUsd || 0) - (x.mcapUsd || 0)));
    if (tab === 'new') tokens.sort((x, y) => y.ts - x.ts);
    if (q) { const s2 = q.toLowerCase(); tokens = tokens.filter(t => (t.name || '').toLowerCase().includes(s2) || (t.symbol || '').toLowerCase().includes(s2) || (t.address || '').toLowerCase() === s2); }
    let chainLive = false, explorer = null;
    if (net === 'zero') { const zs = this.zwState?.() || {}; chainLive = Object.values(zs.rpc || {}).some(v => v.live); explorer = Object.entries(zs.explorers || {}).find(([, v]) => v.up)?.[0] || null; }
    else { chainLive = !!this.meta(net + '_rpc'); explorer = this.meta(net + '_explorer') || null; }
    return { net, nets: TERM_NETS, chainLive, cursor: Number(this.meta(net === 'zero' ? 'term_cursor' : 'term_cursor_' + net) || 0), newDeploys24h, deploysTotal, pads, tokens, explorer };
  };

}
