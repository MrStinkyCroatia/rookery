// Robinhood Chain launchpad: every token is a real ERC-20 from the first second, bought and sold from the user's own
// wallet against the RookeryCurve contract (pump-style), graduating into a Uniswap v3 pool with the LP burned.
// The worker never holds user funds here. It mirrors contract events into markets/trades so Explore, charts and
// token pages work like every other network, builds the transactions the wallet signs, and runs a keeper that
// graduates sold-out curves and collects the platform fee (0.5%) for the $臭企鹅 buy & burn.
import { Interface, JsonRpcProvider, Wallet, getAddress, AbiCoder } from 'ethers';

export const RHOPS_INDEX = 2_000_000_001;   // HD child for Robinhood Chain operations (deployer, keeper, fee address)
const RH_CHAIN_ID = 4663;
const RELAY_API = 'https://api.relay.link';
const V_TOKEN = 1_073_000_000n * 10n ** 18n;
const CURVE_TOKENS = 800_000_000n * 10n ** 18n;

export const CURVE_IFACE = new Interface([
  'function create(string name, string symbol, uint256 minTokensOut) payable returns (address)',
  'function buy(address token, uint256 minTokensOut) payable returns (uint256)',
  'function sell(address token, uint256 tokenAmount, uint256 minEthOut) returns (uint256)',
  'function graduate(address token) returns (address)',
  'function claimFees()',
  'function quoteBuy(address token, uint256 ethIn) view returns (uint256)',
  'function quoteSell(address token, uint256 tokenAmount) view returns (uint256)',
  'function curves(address) view returns (address creator, uint128 vEth, uint128 realEth, uint128 sold, uint64 createdAt, bool complete, bool graduated, address pool)',
  'function feeBps() view returns (uint16)',
  'function vEthNext() view returns (uint256)',
  'function feesAccrued() view returns (uint256)',
  'function feeTo() view returns (address)',
  'function owner() view returns (address)',
  'function launchesPaused() view returns (bool)',
  'event Created(address indexed token, address indexed creator, string name, string symbol, uint256 vEth)',
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEth, uint256 sold)',
  'event Complete(address indexed token)',
  'event Graduated(address indexed token, address pool, uint256 lpTokenId, uint256 ethToPool, uint256 tokensToPool, uint256 tokensBurned)',
  'event FeesClaimed(address to, uint256 amount)',
]);
const ERC20_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
]);
const T_TRANSFER = ERC20_IFACE.getEvent('Transfer').topicHash;

export function installRhpad(Cls, H) {
  const { B, WEI, now, randHex, CHAINS } = H;
  const P = Cls.prototype;
  const lc = (a) => String(a || '').toLowerCase();
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

  P.rhInit = function () {
    if (this._rhInit) return; this._rhInit = true;
    const q = (s) => this.sql.exec(s);
    for (const col of ['rh_token TEXT', 'rh_pool TEXT', 'rh_creator TEXT']) { try { q(`ALTER TABLE markets ADD COLUMN ${col}`); } catch { /* exists */ } }
    try { q('CREATE UNIQUE INDEX IF NOT EXISTS markets_rh_token ON markets (rh_token)'); } catch { /* exists */ }
    // exact on-chain balances, rebuilt from Transfer events (NOT ledger money: never withdrawable from us)
    q(`CREATE TABLE IF NOT EXISTS rh_holdings (token TEXT, address TEXT, bal TEXT DEFAULT '0', PRIMARY KEY (token, address))`);
    q(`CREATE TABLE IF NOT EXISTS rh_seen (k TEXT PRIMARY KEY, ts INTEGER)`);
    // metadata the creator typed in before sending the create transaction (image, description, links)
    q(`CREATE TABLE IF NOT EXISTS rh_drafts (id TEXT PRIMARY KEY, name TEXT, symbol TEXT, body TEXT, user_id INTEGER, created INTEGER, used TEXT DEFAULT '')`);
    try { q(`ALTER TABLE trades ADD COLUMN txid TEXT`); } catch { /* exists */ }
  };

  /* ───────────── chain access ───────────── */
  P.rhRpcs = function () { return CHAINS.robinhood?.rpcs || ['https://robinhood-rpc.publicnode.com']; };
  P.rhRpc = async function (method, params) {
    let last;
    for (const url of this.rhRpcs()) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
        if (!r.ok) { last = new Error('RPC ' + r.status); continue; }
        const j = await r.json();
        if (j.error) { last = new Error(j.error.message || 'RPC error'); if (/execution reverted|invalid/i.test(last.message)) throw last; continue; }
        return j.result;
      } catch (e) { last = e; if (/execution reverted/i.test(e.message)) throw e; }
    }
    throw last || new Error('Robinhood Chain RPC unavailable');
  };
  P.rhCall = async function (fn, args) {
    const data = CURVE_IFACE.encodeFunctionData(fn, args);
    const res = await this.rhRpc('eth_call', [{ to: this.rhCurve(), data }, 'latest']);
    return CURVE_IFACE.decodeFunctionResult(fn, res);
  };
  P.rhWait = async function (hash, rpcFn, tries = 60) {
    for (let i = 0; i < tries; i++) {
      try {
        const rc = await rpcFn('eth_getTransactionReceipt', [hash]);
        if (rc) { if (rc.status !== '0x1') throw new Error('transaction reverted: ' + hash); return rc; }
      } catch (e) { if (/reverted/.test(e.message)) throw e; }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('not confirmed yet: ' + hash);
  };
  P.rhOps = function () { return this.master().deriveChild(RHOPS_INDEX); };
  P.rhSigner = function () {
    const rpcs = this.rhRpcs();
    const prov = new JsonRpcProvider(rpcs.find(u => /publicnode/.test(u)) || rpcs[0], RH_CHAIN_ID, { staticNetwork: true });
    const w = new Wallet(this.rhOps().privateKey, prov);
    // Robinhood Chain (Arbitrum Orbit) charges the base fee only: send with no tip instead of ethers' 1 gwei default
    const send = w.sendTransaction.bind(w);
    w.sendTransaction = async (tx) => {
      const blk = await prov.getBlock('latest');
      const base = blk?.baseFeePerGas || 20_000_000n;
      return send({ maxPriorityFeePerGas: 0n, maxFeePerGas: base * 3n, ...tx });
    };
    return w;
  };
  P.rhCurve = function () { return this.meta('rh_curve') || ''; };
  P.rhLive = function () { return !!this.rhCurve() && this.meta('rh_onchain_off') !== '1'; };

  /* ───────────── public config ───────────── */
  P.rhConfig = async function () {
    const curve = this.rhCurve();
    const out = { live: this.rhLive(), chainId: RH_CHAIN_ID, curve, explorer: 'https://robinhoodchain.blockscout.com',
      supply: '1000000000', curveTokens: '800000000', vToken: '1073000000' };
    if (!curve) return out;
    try {
      const [fee] = await this.rhCall('feeBps', []); const [v] = await this.rhCall('vEthNext', []); const [p] = await this.rhCall('launchesPaused', []);
      Object.assign(out, { feeBps: Number(fee), vEth: v.toString(), paused: p });
    } catch (e) { out.error = String(e.message || e).slice(0, 120); }
    return out;
  };

  /* ───────────── transactions for the user's wallet ───────────── */
  const slipMin = (q, slipBps) => (B(q) * BigInt(10000 - Math.max(0, Math.min(5000, Number(slipBps) || 300)))) / 10000n;
  // the curve's own math (same as the contract), for the creator's first buy before the token exists
  const quoteNew = (vEth, feeBps, ethIn) => {
    const net = ethIn - (ethIn * BigInt(feeBps)) / 10000n;
    const k = vEth * V_TOKEN;
    let out = V_TOKEN - (k + (vEth + net) - 1n) / (vEth + net);
    if (out > CURVE_TOKENS) out = CURVE_TOKENS;
    return out;
  };

  P.rhPrepareCreate = async function (user, b) {
    this.rhInit();
    if (!this.rhLive()) throw new Error('Robinhood Chain launches open soon');
    const name = String(b.name || '').trim().slice(0, 32);
    const symbol = String(b.symbol || '').trim().replace(/^\$/, '').slice(0, 12);
    if (name.length < 2) throw new Error('Name is too short');
    if (!symbol) throw new Error('Ticker is required');
    const img = String(b.image || '');
    if (img && (!img.startsWith('data:image/') || img.length > 300_000)) throw new Error('Image must be under 200 KB');
    const cfg = await this.rhConfig();
    if (cfg.paused) throw new Error('Launches are paused for a moment');
    const dev = b.devBuy ? B(b.devBuy) : 0n;
    const minOut = dev > 0n ? slipMin(quoteNew(B(cfg.vEth), cfg.feeBps, dev), b.slipBps) : 0n;
    const id = randHex(12);
    const body = { description: String(b.description || '').slice(0, 600), image: img, x: b.x || '', tg: b.tg || '', web: b.web || '', hatchId: b.hatchId || '' };
    this.sql.exec('INSERT INTO rh_drafts (id,name,symbol,body,user_id,created) VALUES (?,?,?,?,?,?)', id, name, symbol, JSON.stringify(body), user?.id || null, now());
    this.sql.exec('DELETE FROM rh_drafts WHERE created < ? AND used = ?', now() - 7 * 86400e3, '');
    return { ok: true, draft: id, chainId: RH_CHAIN_ID,
      tx: { to: this.rhCurve(), data: CURVE_IFACE.encodeFunctionData('create', [name, symbol, minOut]), value: '0x' + dev.toString(16) },
      expectTokens: dev > 0n ? quoteNew(B(cfg.vEth), cfg.feeBps, dev).toString() : '0' };
  };

  P.rhPrepareTrade = async function (b) {
    this.rhInit();
    const m = this.market(String(b.market || ''));
    if (!m || !m.rh_token) throw new Error('Not a Robinhood Chain token');
    const token = getAddress(m.rh_token);
    if (m.graduated || m.migrated) throw new Error('This token graduated to Uniswap: trade it in any Robinhood Chain wallet or on Uniswap');
    if (b.side === 'sell') {
      const amt = B(b.amount);
      if (amt <= 0n) throw new Error('Enter an amount');
      const [q] = await this.rhCall('quoteSell', [token, amt]);
      if (q === 0n) throw new Error('Amount too small');
      return { ok: true, chainId: RH_CHAIN_ID, quote: q.toString(),
        tx: { to: this.rhCurve(), data: CURVE_IFACE.encodeFunctionData('sell', [token, amt, slipMin(q, b.slipBps)]), value: '0x0' } };
    }
    const eth = B(b.amount);
    if (eth < 50_000_000_000_000n) throw new Error('Minimum buy is 0.00005 ETH');
    const [q] = await this.rhCall('quoteBuy', [token, eth]);
    if (q === 0n) throw new Error('This curve is sold out: it graduates to Uniswap in a moment');
    return { ok: true, chainId: RH_CHAIN_ID, quote: q.toString(),
      tx: { to: this.rhCurve(), data: CURVE_IFACE.encodeFunctionData('buy', [token, slipMin(q, b.slipBps)]), value: '0x' + eth.toString(16) } };
  };

  /* ───────────── users for wallets (no account needed) ───────────── */
  P.rhWalletUser = function (address) {
    const a = getAddress(address);
    const u = this.sql.exec('SELECT * FROM users WHERE wallet=?', a).toArray()[0];
    if (u) return u;
    let uname = 'pengu_' + a.slice(2, 8).toLowerCase();
    while (this.sql.exec('SELECT 1 FROM users WHERE username=? COLLATE NOCASE', uname).toArray().length) uname = 'pengu_' + randHex(3);
    const idx = Number(this.meta('dep_counter')) + 1;
    this.setMeta('dep_counter', idx);
    this.sql.exec(`INSERT INTO users (email,username,pass_hash,salt,dep_index,dep_address,wallet,created) VALUES (NULL,?,?,?,?,?,?,?)`,
      uname, '', '', idx, this.depositAddressFor(idx), a, now());
    return this.sql.exec('SELECT * FROM users WHERE wallet=?', a).one();
  };

  /* ───────────── event mirror ───────────── */
  P.rhMarketByToken = function (token) { return this.sql.exec('SELECT * FROM markets WHERE rh_token=?', lc(token)).toArray()[0] || null; };

  P.rhApplyLog = function (log, ts) {
    const key = lc(log.transactionHash) + ':' + Number(log.logIndex);
    if (this.sql.exec('SELECT 1 FROM rh_seen WHERE k=?', key).toArray().length) return null;
    let ev = null;
    if (lc(log.address) === lc(this.rhCurve())) {
      try { ev = CURVE_IFACE.parseLog({ topics: log.topics, data: log.data }); } catch { return null; }
    } else if (log.topics[0] === T_TRANSFER) {
      const m = this.rhMarketByToken(log.address);
      if (!m) return null;
      const { args } = ERC20_IFACE.parseLog({ topics: log.topics, data: log.data });
      const move = (addr, d) => {
        const a = lc(addr);
        if (a === '0x0000000000000000000000000000000000000000') return;
        const cur = this.sql.exec('SELECT bal FROM rh_holdings WHERE token=? AND address=?', lc(log.address), a).toArray()[0];
        const nb = B(cur?.bal || 0) + d;
        this.sql.exec('INSERT INTO rh_holdings (token,address,bal) VALUES (?,?,?) ON CONFLICT(token,address) DO UPDATE SET bal=excluded.bal', lc(log.address), a, (nb < 0n ? 0n : nb).toString());
      };
      this.ctx.storage.transactionSync(() => {
        move(args.from, -B(args.value)); move(args.to, B(args.value));
        this.sql.exec('INSERT INTO rh_seen (k,ts) VALUES (?,?)', key, now());
      });
      return 'transfer';
    }
    if (!ev) return null;
    const a = ev.args;
    let res = ev.name, mid = null;
    this.ctx.storage.transactionSync(() => {
      if (ev.name === 'Created') {
        const token = lc(a.token);
        let m = this.rhMarketByToken(token);
        if (!m) {
          const creator = this.rhWalletUser(a.creator);
          // the creator's draft (image, description, links) is matched by name + ticker within the last day
          const d = this.sql.exec(`SELECT * FROM rh_drafts WHERE used='' AND name=? AND symbol=? AND created>? ORDER BY created DESC LIMIT 1`,
            a.name, a.symbol, now() - 86400e3).toArray()[0];
          const body = d ? JSON.parse(d.body) : {};
          const url = (u, re) => { u = String(u || '').trim(); if (!u) return ''; if (!/^https?:\/\//.test(u)) u = 'https://' + u; return re.test(u) ? u.slice(0, 200) : ''; };
          const id = (String(a.symbol).toLowerCase().replace(/[^a-z0-9]/g, '') || 'tkn').slice(0, 10) + '-' + randHex(3);
          this.sql.exec(`INSERT INTO markets (id,creator_id,name,symbol,description,image,network,quote,x,tg,web,
            supply,curve_tokens,v_zro,v_tok,created,v_wei,rh_token,rh_creator) VALUES (?,?,?,?,?,?,'robinhood','ETH',?,?,?,?,?,?,?,?,?,?,?)`,
            id, creator.id, String(a.name).slice(0, 32), String(a.symbol).slice(0, 12), body.description || '', body.image || '',
            url(body.x, /^https:\/\/(x|twitter)\.com\//), url(body.tg, /^https:\/\/t\.me\//), url(body.web, /^https:\/\//),
            '1000000000', '800000000', '0', '1073000000', ts || now(), B(a.vEth).toString(), token, lc(a.creator));
          if (d) this.sql.exec('UPDATE rh_drafts SET used=? WHERE id=?', id, d.id);
          if (body.hatchId) {
            const h = this.sql.exec('SELECT * FROM hatches WHERE id=? AND creator_id=? AND market_id=?', String(body.hatchId), d?.user_id || -1, '').toArray()[0];
            if (h) this.sql.exec('UPDATE hatches SET market_id=? WHERE id=?', id, h.id);
          }
          try { this.award(creator.id, 'hatch', 500, id); } catch { /* points are best effort */ }
          mid = id;
        } else mid = m.id;
      } else if (ev.name === 'Trade') {
        const m = this.rhMarketByToken(a.token);
        if (!m) { res = null; return; }
        const user = this.rhWalletUser(a.trader);
        const eth = B(a.ethAmount), tok = B(a.tokenAmount);
        this.sql.exec(`UPDATE markets SET reserve_zro=?, reserve_tok=?, volume=?, trades=trades+1, last_trade=? WHERE id=?`,
          B(a.realEth).toString(), B(a.sold).toString(), (B(m.volume) + eth).toString(), ts || now(), m.id);
        const mm = this.market(m.id);
        const price = Cls.price(mm);
        this.sql.exec('UPDATE markets SET last_price=? WHERE id=?', price.toString(), m.id);
        const usd = (Number(eth) / 1e18) * this.ethUsd();
        this.sql.exec('INSERT INTO trades (market,user_id,side,zro,tokens,price,usd,ts,quote,txid) VALUES (?,?,?,?,?,?,?,?,?,?)',
          m.id, user.id, a.isBuy ? 'buy' : 'sell', eth.toString(), tok.toString(), price.toString(), usd, ts || now(), 'ETH', lc(log.transactionHash));
        // platform fee is collected by the contract for the $臭企鹅 buy & burn: track it next to the other networks
        this.setMeta('rh_fees_wei', (B(this.meta('rh_fees_wei') || 0) + B(a.fee)).toString());
        mid = m.id;
        this._rhTicker = { side: a.isBuy ? 'buy' : 'sell', usd, user: user.username, symbol: m.symbol, id: m.id };
      } else if (ev.name === 'Complete') {
        const m = this.rhMarketByToken(a.token);
        if (m) { this.sql.exec('UPDATE markets SET graduated=1, grad_at=? WHERE id=?', ts || now(), m.id); mid = m.id; }
      } else if (ev.name === 'Graduated') {
        const m = this.rhMarketByToken(a.token);
        if (m) {
          this.sql.exec('UPDATE markets SET graduated=1, migrated=1, rh_pool=?, pool_zro=?, pool_tok=? WHERE id=?',
            lc(a.pool), B(a.ethToPool).toString(), B(a.tokensToPool).toString(), m.id);
          mid = m.id;
        }
      }
      this.sql.exec('INSERT INTO rh_seen (k,ts) VALUES (?,?)', key, now());
    });
    if (mid) { try { this.queuePush(mid, res === 'Created' ? 'launch' : 'trade', res === 'Trade' ? this._rhTicker : null); } catch { /* no sockets */ } }
    return res;
  };

  P.rhApplyLogs = function (logs, tsOf = {}) {
    const order = (l) => BigInt(l.blockNumber) * 100000n + BigInt(Number(l.logIndex));
    // curve events first in each block would break holdings order; apply strictly by chain order
    const sorted = [...logs].sort((x, y) => (order(x) < order(y) ? -1 : order(x) > order(y) ? 1 : 0));
    const out = [];
    for (const l of sorted) { const r = this.rhApplyLog(l, tsOf[l.blockNumber]); if (r) out.push(r); }
    return out;
  };

  // the creator's/trader's page calls this right after the wallet returns a tx hash, so the token shows up at once
  P.rhSyncTx = async function (hash) {
    this.rhInit();
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ''))) throw new Error('Bad transaction hash');
    let rc = null;
    for (let i = 0; i < 12 && !rc; i++) { rc = await this.rhRpc('eth_getTransactionReceipt', [hash]); if (!rc) await new Promise(r => setTimeout(r, 1000)); }
    if (!rc) return { ok: true, pending: true };
    if (rc.status !== '0x1') return { ok: false, error: 'Transaction failed on-chain' };
    const blk = await this.rhRpc('eth_getBlockByNumber', [rc.blockNumber, false]);
    const ts = blk ? Number(BigInt(blk.timestamp)) * 1000 : now();
    // new token addresses created in this tx must be known before their Transfer logs are applied
    const curveLogs = rc.logs.filter(l => lc(l.address) === lc(this.rhCurve()));
    const other = rc.logs.filter(l => lc(l.address) !== lc(this.rhCurve()));
    const applied = [...this.rhApplyLogs(curveLogs, { [rc.blockNumber]: ts }), ...this.rhApplyLogs(other, { [rc.blockNumber]: ts })];
    let market = null;
    for (const l of curveLogs) {
      try { const ev = CURVE_IFACE.parseLog(l); if (ev?.args?.token) { market = this.rhMarketByToken(ev.args.token)?.id || null; break; } } catch { /* other */ }
    }
    if (applied.includes('Complete')) this.ctx.waitUntil(this.rhKeeper().catch(() => {}));
    return { ok: true, applied, market };
  };

  // cron: catch every event (trades made outside our site included), then run the keeper
  P.rhScan = async function () {
    this.rhInit();
    const curve = this.rhCurve();
    if (!curve) return { off: true };
    const head = Number(BigInt(await this.rhRpc('eth_blockNumber', [])));
    let from = Number(this.meta('rh_block') || 0) || Number(this.meta('rh_deploy_block') || head);
    const STEP = 9000;
    let n = 0, loops = 0;
    while (from <= head && loops++ < 8) {
      const to = Math.min(head, from + STEP);
      const cl = await this.rhRpc('eth_getLogs', [{ address: curve, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
      n += this.rhApplyLogs(cl).length;           // creates markets first
      const tokens = this.sql.exec('SELECT rh_token FROM markets WHERE rh_token IS NOT NULL').toArray().map(r => r.rh_token);
      for (let i = 0; i < tokens.length; i += 50) {
        const tl = await this.rhRpc('eth_getLogs', [{ address: tokens.slice(i, i + 50), topics: [T_TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
        n += this.rhApplyLogs(tl).length;
      }
      this.setMeta('rh_block', String(to + 1));
      from = to + 1;
    }
    this.setMeta('rh_scan_ok', String(now()));
    const k = await this.rhKeeper().catch(e => ({ error: String(e.message || e).slice(0, 200) }));
    return { head, applied: n, keeper: k };
  };

  // graduate sold-out curves (anyone may, we pay the gas) and claim the fee pot once it is worth the gas
  P.rhKeeper = async function () {
    const due = this.sql.exec(`SELECT id, rh_token FROM markets WHERE rh_token IS NOT NULL AND graduated=1 AND migrated=0`).toArray();
    const done = [];
    const claimDue = now() - Number(this.meta('rh_claim_ts') || 0) > 3600e3;
    if (!due.length && !claimDue) return { done };
    const w = this.rhSigner();
    for (const m of due) {
      const c = await this.rhCall('curves', [getAddress(m.rh_token)]);
      if (c.graduated) continue;  // the Graduated event lands in the next scan
      try {
        const tx = await w.sendTransaction({ to: this.rhCurve(), data: CURVE_IFACE.encodeFunctionData('graduate', [getAddress(m.rh_token)]), gasLimit: 9_000_000n });
        await this.rhWait(tx.hash, (mm, pp) => this.rhRpc(mm, pp));
        await this.rhSyncTx(tx.hash);
        done.push({ market: m.id, tx: tx.hash });
        try { this.ownerAlert?.(`🎓 Robinhood Chain token graduated to Uniswap: ${m.id}\nhttps://robinhoodchain.blockscout.com/tx/${tx.hash}`); } catch { /* optional */ }
      } catch (e) { this.setMeta('rh_keeper_error', String(e.message || e).slice(0, 300)); }
    }
    if (!claimDue) return { done };
    this.setMeta('rh_claim_ts', String(now()));
    const [pot] = await this.rhCall('feesAccrued', []);
    if (pot >= 2_000_000_000_000_000n) {   // 0.002 ETH
      const tx = await w.sendTransaction({ to: this.rhCurve(), data: CURVE_IFACE.encodeFunctionData('claimFees', []) });
      await this.rhWait(tx.hash, (mm, pp) => this.rhRpc(mm, pp));
      done.push({ claimed: pot.toString(), tx: tx.hash });
    }
    return { done };
  };

  /* ───────────── views ───────────── */
  P.rhHolders = function (m, limit = 20) {
    if (!m?.rh_token) return [];
    const rows = this.sql.exec(`SELECT address, bal FROM rh_holdings WHERE token=? AND bal != '0'`, m.rh_token).toArray()
      .map(r => ({ address: r.address, bal: B(r.bal) })).sort((x, y) => (y.bal > x.bal ? 1 : y.bal < x.bal ? -1 : 0));
    const curve = lc(this.rhCurve()), pool = lc(m.rh_pool || ''), dead = '0x000000000000000000000000000000000000dead';
    return rows.slice(0, limit).map(r => {
      const u = this.sql.exec('SELECT username FROM users WHERE lower(wallet)=?', r.address).toArray()[0];
      const tag = r.address === curve ? 'bonding curve' : r.address === pool ? 'Uniswap pool' : r.address === dead ? 'burned' : '';
      return { address: r.address, username: u?.username || '', tag, amount: r.bal.toString(), pct: Number((r.bal * 10000n) / (10n ** 27n)) / 100 };
    });
  };
  P.rhWalletBalance = async function (m, address) {
    if (!m?.rh_token || !isAddr(address)) return '0';
    const res = await this.rhRpc('eth_call', [{ to: m.rh_token, data: ERC20_IFACE.encodeFunctionData('balanceOf', [address]) }, 'latest']);
    return BigInt(res === '0x' ? 0 : res).toString();
  };

  /* ───────────── admin: funding + deploy ───────────── */
  P.rhStatus = async function () {
    const ops = this.rhOps().address;
    const bal = BigInt(await this.rhRpc('eth_getBalance', [ops, 'latest']));
    const out = { ops, opsEth: Number(bal) / 1e18, curve: this.rhCurve(), block: this.meta('rh_block'), scanOk: this.meta('rh_scan_ok'),
      keeperError: this.meta('rh_keeper_error') || '', feesWei: this.meta('rh_fees_wei') || '0', fund: this.meta('rh_fund') || '' };
    if (out.curve) {
      try { const [o] = await this.rhCall('owner', []); const [f] = await this.rhCall('feesAccrued', []); out.owner = o; out.feesAccrued = f.toString(); } catch (e) { out.err = e.message; }
    }
    return out;
  };

  // one-off top-up of the ops wallet on Robinhood Chain from the hot wallet's own ETH on Base/Arbitrum (via Relay)
  P.rhFund = async function (b) {
    const from = b.from === 'arbitrum' ? 'arbitrum' : 'base';
    const src = CHAINS[from];
    const amount = B(b.amountWei);
    if (amount <= 0n || amount > 10_000_000_000_000_000n) throw new Error('amount must be between 0 and 0.01 ETH');
    const prov = new JsonRpcProvider(src.rpcs?.[0] || src.rpc, src.chainId, { staticNetwork: true });
    const hot = new Wallet(this.hotWallet().privateKey, prov);
    const ops = this.rhOps().address;
    const q = await (await fetch(`${RELAY_API}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: hot.address, recipient: ops, originChainId: src.chainId, destinationChainId: RH_CHAIN_ID,
        originCurrency: '0x0000000000000000000000000000000000000000', destinationCurrency: '0x0000000000000000000000000000000000000000',
        amount: amount.toString(), tradeType: 'EXACT_INPUT' }) })).json();
    if (!q.steps) throw new Error('Relay quote failed: ' + (q.message || 'no route'));
    if (b.dry) return { dry: true, out: q.details?.currencyOut?.amountFormatted, fees: q.fees, steps: q.steps.length };
    const sent = [];
    for (const step of q.steps) for (const it of step.items) {
      const d = it.data;
      if (Number(d.chainId) !== src.chainId) throw new Error('Unexpected Relay step chain');
      if (getAddress(d.from) !== hot.address) throw new Error('Unexpected Relay sender');
      if (B(d.value || 0) > amount) throw new Error('Relay asked for more than the amount');
      const tx = await hot.sendTransaction({ to: d.to, data: d.data, value: B(d.value || 0) });
      await tx.wait(1);
      sent.push({ step: step.id, tx: tx.hash, requestId: step.requestId || '' });
    }
    this.setMeta('rh_fund', JSON.stringify({ ts: now(), from, amount: amount.toString(), sent, out: q.details?.currencyOut?.amountFormatted }));
    return { ok: true, from, amount: amount.toString(), out: q.details?.currencyOut?.amountFormatted, sent };
  };

  // mainnet smoke test with the ops wallet: launch, check the mirror, sell everything back, check the mirror again
  P.rhSelfTest = async function (b) {
    const w = this.rhSigner(), rpc = (m2, p2) => this.rhRpc(m2, p2), report = {};
    const dev = B(b.devWei || '500000000000000');                  // 0.0005 ETH
    const name = 'Rookery Smoke Test', symbol = 'RSMOKE' + randHex(1).toUpperCase();
    const prep = await this.rhPrepareCreate(null, { name, symbol, description: 'self-test, removed after the check', devBuy: dev.toString() });
    const t1 = await w.sendTransaction({ to: prep.tx.to, data: prep.tx.data, value: B(prep.tx.value) });
    await this.rhWait(t1.hash, rpc);
    const s1 = await this.rhSyncTx(t1.hash);
    const m = this.market(s1.market);
    report.create = { tx: t1.hash, market: s1.market, token: m?.rh_token, applied: s1.applied };
    const bal = B(await this.rhWalletBalance(m, w.address));
    report.walletTokens = bal.toString();
    report.expectTokens = prep.expectTokens;
    report.mirrorOk = m && m.reserve_tok === bal.toString();
    const ps = await this.rhPrepareTrade({ market: m.id, side: 'sell', amount: bal.toString(), slipBps: 100 });
    const before = BigInt(await this.rhRpc('eth_getBalance', [w.address, 'latest']));
    const t2 = await w.sendTransaction({ to: ps.tx.to, data: ps.tx.data, value: 0n });
    const rc2 = await this.rhWait(t2.hash, rpc);
    await this.rhSyncTx(t2.hash);
    const after = BigInt(await this.rhRpc('eth_getBalance', [w.address, 'latest']));
    const gas = BigInt(rc2.gasUsed) * BigInt(rc2.effectiveGasPrice || 0);
    const m2 = this.market(m.id);
    report.sell = { tx: t2.hash, ethBack: (after - before + gas).toString(), quoted: ps.quote, gas: gas.toString() };
    report.afterSell = { sold: m2.reserve_tok, raised: m2.reserve_zro, trades: m2.trades, walletTokens: await this.rhWalletBalance(m2, w.address) };
    report.pass = !!(report.mirrorOk && bal.toString() === prep.expectTokens && report.sell.ethBack === ps.quote && m2.reserve_tok === '0' && m2.trades === 2);
    if (b.keep !== true) {
      this.sql.exec('DELETE FROM trades WHERE market=?', m.id); this.sql.exec('DELETE FROM markets WHERE id=?', m.id);
      this.sql.exec('DELETE FROM rh_holdings WHERE token=?', m.rh_token);
      report.removedFromLists = true;
    }
    return report;
  };

  // deploys RookeryCurve from the ops key (owner + keeper); creation bytecode comes from the audited build in rhcurve/
  P.rhDeploy = async function (b) {
    if (this.rhCurve() && !b.force) throw new Error('Curve already deployed at ' + this.rhCurve());
    if (this.meta('rh_deploy_tx') && !b.force) throw new Error('A deploy was already sent: ' + this.meta('rh_deploy_tx') + ' (check it, then set the curve)');
    const code = String(b.bytecode || '');
    if (!/^0x[0-9a-fA-F]+$/.test(code) || code.length < 2000) throw new Error('bytecode missing');
    const R = { weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', npm: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3' };
    const vEth = B(b.vEthWei || 0) || BigInt(Math.round(3150 * this.zroUsd() / this.ethUsd() * 1e9)) * 1_000_000_000n;
    const w = this.rhSigner();
    const args = AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'uint256'], [R.weth, R.factory, R.npm, w.address, vEth]);
    const tx = await w.sendTransaction({ data: code + args.slice(2) });
    this.setMeta('rh_deploy_tx', tx.hash);       // recorded before waiting: never deploy twice on a flaky RPC
    const rc = await this.rhWait(tx.hash, (mm, pp) => this.rhRpc(mm, pp));
    if (!rc.contractAddress) throw new Error('no contract address');
    const addr = getAddress(rc.contractAddress), blk = Number(BigInt(rc.blockNumber));
    this.setMeta('rh_curve', addr);
    this.setMeta('rh_deploy_block', String(blk));
    this.setMeta('rh_block', String(blk));
    return { ok: true, curve: addr, tx: tx.hash, block: blk, vEth: vEth.toString() };
  };
}
