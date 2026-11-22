// Zero Terminal: every launchpad on Zero in one place (ArcTools-style tabs: All · New · one tab per launchpad).
// Before Zero mainnet it lists the launchpads and Rookery's own Zero tokens (with their reserved addresses).
// From the first Zero block it indexes every new token on-chain: the first mint (Transfer from 0x0) of a contract is
// its birth; the transaction's `to` is the factory, mapped to a launchpad (factories are learned at launch and can
// be mapped later, retroactively). Activity = Transfer count, refreshed in batches.
const ZERO_ADDR_TOPIC = '0x' + '0'.repeat(64);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// launchpads announced for Zero (profile data from their X accounts, 22 Nov 2026)
export const PADS = [
  { id: 'rookery', name: 'Rookery', handle: 'StinkyPenguinL0', site: 'https://rookery.stinkypenguin.xyz', kind: 'Pre-market launchpad · 1:1 to Zero', status: 'live', followers: null, ours: true },
  { id: 'tzero', name: 'Tzero', handle: 'T0dotfun', site: 'https://testnet.tzer0.fun/launch', kind: 'First launchpad on Zero (bonding curve)', status: 'testnet', followers: 3790, avatar: 'https://pbs.twimg.com/profile_images/2106911707251531776/8XoApRRl_200x200.jpg' },
  { id: '000', name: '000.fun', handle: '000dotfun', site: 'https://000.fun', kind: 'Token launchpad', status: 'soon', followers: 2238, avatar: 'https://pbs.twimg.com/profile_images/2110214996106137600/4zHcR0kq_200x200.jpg' },
  { id: 'zrofun', name: 'ZROfun', handle: 'ZROfun', site: 'https://ZRO.fun', kind: 'Meme launchpad (ZRO paired)', status: 'soon', followers: 406, avatar: 'https://pbs.twimg.com/profile_images/2120982327384010752/2DGpI4aG_200x200.jpg' },
  { id: 'nilly', name: 'nilly', handle: 'nillyfun', site: 'https://testnet.nilly.fun/', kind: 'Anti-rug focused launchpad', status: 'testnet', followers: 618, avatar: 'https://pbs.twimg.com/profile_images/2120972424397119489/27i5RPAg_200x200.jpg' },
  { id: 'zerolotl', name: 'Zerolotl', handle: 'zerolotl', site: 'https://zerolotl.fun/', kind: 'Launchpad · custom fee sharing (70% to whom you choose)', status: 'soon', followers: 169, avatar: 'https://pbs.twimg.com/profile_images/2121544389704962048/2IR2_C5G_200x200.jpg' },
  { id: 'peal', name: 'Peal', handle: 'pealhq', site: null, kind: 'Daily sealed-bid launchpad · LP locked 90 days', status: 'soon', followers: 130, avatar: 'https://pbs.twimg.com/profile_images/2121219918989295616/OxgiUWer_200x200.jpg' },
  { id: 'st0cks', name: 'st0cks', handle: 'St0cksfun', site: 'https://st0cks.fun', kind: 'Stock meme launchpad', status: 'soon', followers: 148, avatar: 'https://pbs.twimg.com/profile_images/2119834185896697857/RB0arcpy_200x200.jpg' },
  { id: '0stocks', name: 'ZeroStocks', handle: '0Stocks_fun', site: 'https://0stocks.fun', kind: 'Tokenized stocks launchpad (stock-paired)', status: 'soon', followers: 119, avatar: 'https://pbs.twimg.com/profile_images/2112556101657108480/wnUvPawU_200x200.jpg' },
  { id: 'zeromeme', name: 'ZeroMeme.Fun', handle: 'ZeromemeFun', site: 'https://zeromeme.fun', kind: 'Omnichain meme launchpad', status: 'soon', followers: 166, avatar: 'https://pbs.twimg.com/profile_images/2110434933017833472/_RJpoAMw_200x200.jpg' },
  { id: 'gitzero', name: 'GitZero', handle: 'GitZero_', site: null, kind: 'GitHub repo → coin', status: 'soon', followers: 117, avatar: 'https://pbs.twimg.com/profile_images/2121413945827217408/XFhAg_Vj_200x200.jpg' },
  { id: 'orpheus', name: 'Orpheus', handle: 'Orpheusfun', site: 'https://orpheusfun.com', kind: 'Fair launchpad · live day one', status: 'soon', followers: 77, avatar: 'https://pbs.twimg.com/profile_images/2122435083458002944/DH5vEuR8_200x200.jpg' },
  { id: 'zerovo', name: 'Zerovo', handle: 'Zerovo_io', site: 'https://zerovo.io/', kind: 'Day-1 launchpad · auto spot market, migrate anytime', status: 'soon', followers: 88, avatar: 'https://pbs.twimg.com/profile_images/2122496318710902784/6v47wheS_200x200.png' },
  { id: 'orez', name: 'Orez', handle: 'OrezDotFun', site: null, kind: 'Launchpad', status: 'soon', followers: 124, avatar: 'https://pbs.twimg.com/profile_images/2121299603702079488/7eki7iuy_200x200.jpg' },
  { id: '0rigin', name: '0rigin', handle: '0rigindotfun', site: 'https://0rigin.fun', kind: 'Launchpad', status: 'soon', followers: 510, avatar: 'https://pbs.twimg.com/profile_images/2117331860053278720/1Tbbm_Vb_200x200.jpg' },
  { id: 'addicted', name: 'Addicted', handle: 'Addictedfamily_', site: 'http://addicted.family', kind: 'Launchpad', status: 'soon', followers: 48, avatar: 'https://pbs.twimg.com/profile_images/2121440025640378368/uBGnWgC__200x200.png' },
];

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
      fresh.push({ addr: a, tx: l.transactionHash, block: parseInt(l.blockNumber, 16) });
      if (fresh.length >= maxNew) break;
    }
    const call = (to2, data) => rpc('eth_call', [{ to: to2, data }, 'latest']).catch(() => '0x');
    for (const f of fresh) {
      const [tx, nm, sy, dc, ts, blk] = await Promise.all([
        rpc('eth_getTransactionByHash', [f.tx]).catch(() => null), call(f.addr, '0x06fdde03'), call(f.addr, '0x95d89b41'),
        call(f.addr, '0x313ce567'), call(f.addr, '0x18160ddd'), rpc('eth_getBlockByNumber', ['0x' + f.block.toString(16), false]).catch(() => null)]);
      const factory = (tx?.to || '').toLowerCase() || null;
      const pad = (factory && fac[factory]) || (factory ? 'unknown' : 'direct');
      const dec = dc && dc !== '0x' ? Number(BigInt(dc)) : 18;
      if (dec > 36) continue;                                                             // not an ERC-20
      this.sql.exec(`INSERT OR IGNORE INTO term_tokens (addr,pad,factory,creator,name,symbol,decimals,supply,tx,block,ts,chain) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.addr, pad, factory, (tx?.from || '').toLowerCase(), decodeString(nm).slice(0, 64), decodeString(sy).slice(0, 24), dec,
        ts && ts !== '0x' ? BigInt(ts).toString() : '0', f.tx, f.block, blk ? Number(BigInt(blk.timestamp)) * 1000 : now(), chain);
    }
    // activity: Transfer counts for the newest tracked tokens (100 per pass)
    const tracked = this.sql.exec('SELECT addr FROM term_tokens WHERE chain=? ORDER BY block DESC LIMIT 100', chain).toArray().map(r => r.addr);
    if (tracked.length) {
      const act = await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: tracked, topics: [TRANSFER] }]).catch(() => []);
      const cnt = {};
      for (const l of act || []) { const a = l.address.toLowerCase(); cnt[a] = (cnt[a] || 0) + 1; }
      for (const [a, n] of Object.entries(cnt)) this.sql.exec('UPDATE term_tokens SET transfers=transfers+?, last_activity=? WHERE addr=?', n, now(), a);
    }
    return { scanned: [from, to], newTokens: fresh.length, logs: (logs || []).length };
  };

  // called from the Zero watcher loop once a verified RPC exists: follow the chain from block 1, a capped range per pass
  P.termTick = async function (rpc) {
    if (this._termBusy) return null; this._termBusy = true;
    try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      let cur = Number(this.meta('term_cursor') || 0);
      if (cur >= head) return { head, idle: true };
      const to = Math.min(head, cur + 500);
      const r = await this.termIndex(rpc, { from: cur + 1, to });
      this.setMeta('term_cursor', String(to));
      return { head, ...r };
    } catch (e) { this.setMeta('term_err', String(e.message || e).slice(0, 160)); return { error: String(e.message || e) }; }
    finally { this._termBusy = false; }
  };

  // public payload: launchpads + tokens (on-chain index + Rookery's own Zero tokens with reserved addresses)
  P.termView = function ({ pad = 'all', sort = 'new', q = '' } = {}) {
    this.termInit();
    const st = this.termPadStatus();
    const fac = this.termFactories();
    const counts = Object.fromEntries(this.sql.exec(`SELECT pad, COUNT(*) c FROM term_tokens WHERE chain='zero' GROUP BY pad`).toArray().map(r => [r.pad, r.c]));
    const rook = this.sql.exec(`SELECT id, name, symbol, image, created, trades, migrated, zero_token FROM markets WHERE network='zero' ORDER BY created DESC LIMIT 300`).toArray();
    counts.rookery = rook.length;
    const pads = PADS.map(p => ({ ...p, status: st[p.id] || p.status, tokens: counts[p.id] || 0, factories: Object.entries(fac).filter(([, v]) => v === p.id).map(([k]) => k) }));
    const order = sort === 'active' ? 'transfers DESC, block DESC' : 'block DESC';
    let rows = this.sql.exec(`SELECT * FROM term_tokens WHERE chain='zero' ${pad !== 'all' && pad !== 'new' && pad !== 'rookery' ? 'AND pad=?' : ''} ORDER BY ${order} LIMIT 200`,
      ...(pad !== 'all' && pad !== 'new' && pad !== 'rookery' ? [pad] : [])).toArray();
    if (pad === 'new') rows = rows.filter(r => now() - r.ts < 15 * 60e3);
    let tokens = pad === 'rookery' ? [] : rows.map(r => ({ address: r.addr, pad: r.pad, name: r.name, symbol: r.symbol, supply: r.supply, decimals: r.decimals,
      creator: r.creator, factory: r.factory, ts: r.ts, block: r.block, transfers: r.transfers, onchain: true }));
    if (pad === 'all' || pad === 'rookery') {
      const own = rook.map(m => {
        let address = m.zero_token;
        if (!address) { try { address = this.zeroTokenAddr(m.id); } catch { address = null; } }
        return { address, pad: 'rookery', name: m.name, symbol: m.symbol, image: m.image, ts: m.created, transfers: m.trades, market: m.id, onchain: !!m.migrated, reserved: !m.migrated };
      });
      tokens = pad === 'rookery' ? own : [...tokens, ...own].sort((a, b) => (sort === 'active' ? (b.transfers - a.transfers) : (b.ts - a.ts))).slice(0, 250);
    }
    if (q) { const s = q.toLowerCase(); tokens = tokens.filter(t => (t.name || '').toLowerCase().includes(s) || (t.symbol || '').toLowerCase().includes(s) || (t.address || '').toLowerCase() === s); }
    const zs = this.zwState?.() || {};
    const live = Object.values(zs.rpc || {}).some(v => v.live);
    return { chainLive: live, cursor: Number(this.meta('term_cursor') || 0), pads, tokens, explorer: Object.entries(zs.explorers || {}).find(([, v]) => v.up)?.[0] || null };
  };
}
