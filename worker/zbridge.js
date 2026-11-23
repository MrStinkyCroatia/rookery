// ZRO -> Zero bridge (ZroAutoBridge on 7 chains): one-transaction manual bridge, auto-bridge that fires inside
// LayerZero's short windows, cancel anytime, live route status, stats, alerts, and the user's balance on Zero.
//
// Speed: every 2 s (the watcher's fast loop) each chain with signed-up orders SIMULATES fireMany(pending) from the
// bot. The simulation is LayerZero's own answer (the contract calls quoteSend), so the first tick where it would
// bridge anything is the tick we broadcast, to every RPC of that chain at once, with a raised priority fee.
// The bot only pays gas: it can never move a user's ZRO anywhere but that user's own address on Zero.
import { Interface, getCreateAddress, Wallet, AbiCoder, getAddress } from 'ethers';
import { ZB_INITCODE } from './zbridge_artifact.js';

export const ZB_ZRO = '0x6985884C4392D348587B19cb9eAAf157F13271cd';        // ZRO is both the ERC-20 and the OFT
export const ZB_EID = 33002;
export const ZB_IDX = { bot: 2_000_330_200, fee: 2_000_330_201 };        // dedicated keys: deployer/owner/bot, fee sink
export const ZB_CHAINS = {
  eth: { name: 'Ethereum', chainId: 1, native: 'ETH', deposit: '4000000000000000', explorer: 'https://etherscan.io', eip1559: true,
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'] },
  arb: { name: 'Arbitrum', chainId: 42161, native: 'ETH', deposit: '4000000000000000', explorer: 'https://arbiscan.io', eip1559: true,
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'] },
  base: { name: 'Base', chainId: 8453, native: 'ETH', deposit: '4000000000000000', explorer: 'https://basescan.org', eip1559: true,
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'] },
  bsc: { name: 'BNB Chain', chainId: 56, native: 'BNB', deposit: '12000000000000000', explorer: 'https://bscscan.com', eip1559: false,
    rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org'] },
  op: { name: 'Optimism', chainId: 10, native: 'ETH', deposit: '4000000000000000', explorer: 'https://optimistic.etherscan.io', eip1559: true,
    rpcs: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'] },
  polygon: { name: 'Polygon', chainId: 137, native: 'POL', deposit: '30000000000000000000', explorer: 'https://polygonscan.com', eip1559: true,
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://polygon.drpc.org'] },
  avax: { name: 'Avalanche', chainId: 43114, native: 'AVAX', deposit: '300000000000000000', explorer: 'https://snowtrace.io', eip1559: true,
    rpcs: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc', 'https://avalanche.drpc.org'] },
};

export const ZB_ABI = new Interface([
  'function signUp(uint256 amount, uint256 maxGasPrice) payable',
  'function cancel()',
  'function fire(address user) returns (bytes32)',
  'function fireMany(address[] users) returns (uint256)',
  'function bridgeNow(uint256 amount) payable returns (bytes32)',
  'function quote(address user, uint256 amount, bool manual) view returns (uint256 nativeFee, uint256 bridged, uint256 fee)',
  'function pending() view returns (address[])',
  'function orderOf(address user) view returns ((uint256 amount, uint256 deposit, uint256 maxGasPrice, bool active, uint64 signedAt))',
  'function feeBps() view returns (uint16)', 'function manualFeeBps() view returns (uint16)', 'function paused() view returns (bool)',
  'function setPaused(bool on)', 'function setFees(uint16 autoBps, uint16 manualBps, address sink)',
  'event SignedUp(address indexed user, uint256 amount, uint256 deposit, uint256 maxGasPrice, bytes32 to)',
  'event Fired(address indexed user, uint256 bridged, uint256 fee, uint256 nativeFee, uint256 refund, bytes32 guid)',
  'event Bridged(address indexed user, uint256 bridged, uint256 fee, uint256 nativeFee, uint256 refund, bytes32 guid)',
  'event Cancelled(address indexed user, uint256 deposit)',
  'error NotOwner()', 'error IsPaused()', 'error NoOrder()', 'error Zero()', 'error RouteClosed()', 'error GasTooHigh()',
  'error NoAllowance()', 'error NotEnoughZro()', 'error DepositTooLow()', 'error SettlementFailed()', 'error Reentrancy()',
]);
const ERC20 = new Interface(['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const coder = AbiCoder.defaultAbiCoder();
const OFT_SEND = new Interface(['function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) p,(uint256 nativeFee,uint256 lzTokenFee) f,address r) payable']);
const LZH = { 'user-agent': 'Mozilla/5.0 (compatible; rookery-bridge/1.0)', accept: 'application/json', origin: 'https://layerzeroscan.com', referer: 'https://layerzeroscan.com/' };
const SRC_EID = { 30101: 'eth', 30110: 'arb', 30184: 'base', 30102: 'bsc', 30111: 'op', 30109: 'polygon', 30106: 'avax' };
const decWei = (v) => { const [a, b = ''] = String(v || '0').split('.'); return (BigInt(a || '0') * 10n ** 18n + BigInt((b + '0'.repeat(18)).slice(0, 18) || '0')).toString(); };
const T = Object.fromEntries(['SignedUp', 'Fired', 'Bridged', 'Cancelled'].map(n => [ZB_ABI.getEvent(n).topicHash, n]));
const hx = (n) => '0x' + BigInt(n).toString(16);

async function post(url, method, params, ms = 12000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { throw new Error('rpc ' + r.status); }
  if (j.error) {
    // only an execution revert is a final answer; rate limits and node trouble move on to the next RPC
    const revert = j.error.data != null || /revert/i.test(String(j.error.message));
    throw Object.assign(new Error(j.error.message || 'rpc error'), { answered: revert, data: j.error.data });
  }
  if (j.result === undefined) throw new Error('rpc returned no result');
  return j.result;
}
export function zbReason(e) {
  const d = typeof e?.data === 'string' ? e.data : e?.data?.data;
  if (typeof d === 'string' && d.length >= 10) { try { return ZB_ABI.parseError(d)?.name || d.slice(0, 10); } catch { return d.slice(0, 10); } }
  return String(e?.message || e).slice(0, 120);
}

export function installZBridge(Cls, H) {
  const { now } = H;
  const P = Cls.prototype;
  const chk = (c) => { if (!ZB_CHAINS[c]) throw new Error('chain: ' + Object.keys(ZB_CHAINS).join(' | ')); return c; };

  P.zbrInit = function () {
    if (this._zbrInit) return; this._zbrInit = true;      // own flag: the alerts bot already uses _zbInit
    this.sql.exec(`CREATE TABLE IF NOT EXISTS zb_ev (chain TEXT, tx TEXT, idx INTEGER, block INTEGER, ts INTEGER, kind TEXT, user TEXT,
      amount TEXT DEFAULT '0', bridged TEXT DEFAULT '0', fee TEXT DEFAULT '0', native TEXT DEFAULT '0', refund TEXT DEFAULT '0', guid TEXT,
      lz TEXT, dst_tx TEXT, lz_checked INTEGER DEFAULT 0, PRIMARY KEY (chain, tx, idx))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS zb_ev_user ON zb_ev (user, block)`);
  };
  P.zbrZro = function () { return ZB_ZRO; };
  P.zbrOft = function () { return ZB_ZRO; };
  P.zbrKeys = function () { const m = this.master(); return { bot: m.deriveChild(ZB_IDX.bot), fee: m.deriveChild(ZB_IDX.fee) }; };
  P.zbrAddr = function () {
    const k = this.zbrKeys();
    const a = { contract: getCreateAddress({ from: k.bot.address, nonce: 0 }), bot: k.bot.address, owner: k.bot.address, feeSink: k.fee.address };
    const pin = this.meta('zb_addrs_v1');
    if (!pin) this.setMeta('zb_addrs_v1', JSON.stringify(a));
    else if (JSON.parse(pin).contract !== a.contract) throw new Error('reserved bridge address changed: refusing');
    return a;
  };
  P.zbrCfg = function () { try { return JSON.parse(this.meta('zb_cfg') || '{}'); } catch { return {}; } };
  P.zbrSave = function (c) { this.setMeta('zb_cfg', JSON.stringify(c)); };

  // reads: first RPC that answers (a revert is an answer and is not retried); writes: broadcast to all at once
  P.zbrRpc = function (chain) {
    const urls = ZB_CHAINS[chk(chain)].rpcs;
    return async (method, params) => {
      let last;
      for (const u of urls) { try { return await post(u, method, params); } catch (e) { if (e.answered && method !== 'eth_getLogs') throw e; last = e; } }
      throw last || new Error('no rpc');
    };
  };
  P.zbrBroadcast = async function (chain, raw) {
    const urls = ZB_CHAINS[chain].rpcs;
    const res = await Promise.allSettled(urls.map(u => post(u, 'eth_sendRawTransaction', [raw], 8000)));
    const ok = res.find(r => r.status === 'fulfilled');
    if (ok) return ok.value;
    const known = res.find(r => /known|already|nonce too low/i.test(String(r.reason?.message)));
    if (known) return null;
    throw res[0].reason;
  };
  P.zbrSign = async function (chain, tx, { boost = 1, key, gas } = {}) {
    const c = ZB_CHAINS[chain], rpc = this.zbrRpc(chain), w = new Wallet(key || this.zbrKeys().bot.privateKey);
    const [nonceHex, gasHex] = await Promise.all([rpc('eth_getTransactionCount', [w.address, 'pending']),
      rpc('eth_estimateGas', [{ from: w.address, to: tx.to || undefined, data: tx.data, value: hx(tx.value || 0) }])]);
    // fireMany swallows a failing order, so eth_estimateGas finds a limit where the LAST orders silently run out of gas:
    // batches pass an explicit budget per order and never go below it
    let gasLimit = (BigInt(gasHex) * 13n) / 10n;
    if (gas && BigInt(gas) > gasLimit) gasLimit = BigInt(gas);
    const base = { chainId: c.chainId, nonce: Number(BigInt(nonceHex)), to: tx.to || null, data: tx.data, value: BigInt(tx.value || 0), gasLimit };
    if (c.eip1559) {
      const [blk, tip] = await Promise.all([rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_maxPriorityFeePerGas', []).catch(() => '0x3b9aca00')]);
      const prio = (BigInt(tip) * BigInt(Math.round(boost * 100))) / 100n + 1n;
      const maxFee = BigInt(blk.baseFeePerGas || 0) * 2n + prio;
      return { raw: await w.signTransaction({ ...base, type: 2, maxPriorityFeePerGas: prio, maxFeePerGas: maxFee }), nonce: base.nonce };
    }
    const gp = BigInt(await rpc('eth_gasPrice', []));
    return { raw: await w.signTransaction({ ...base, type: 0, gasPrice: (gp * BigInt(Math.round(boost * 100))) / 100n }), nonce: base.nonce };
  };
  P.zbrWait = async function (chain, hash, ms = 90000) {
    const rpc = this.zbrRpc(chain), t0 = Date.now();
    while (Date.now() - t0 < ms) { const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null); if (r) return r; await new Promise(x => setTimeout(x, 1500)); }
    return null;
  };

  // ── owner: deploy at nonce 0 (same address everywhere), pause, fees ──
  P.zbrDeploy = async function (chain, b = {}) {
    if (b.confirm !== 'DEPLOY') throw new Error('pass confirm: "DEPLOY"');
    const a = this.zbrAddr(), rpc = this.zbrRpc(chk(chain)), cfg = this.zbrCfg();
    const code = await rpc('eth_getCode', [a.contract, 'latest']);
    if (code && code !== '0x') { cfg[chain] = { ...(cfg[chain] || {}), deployed: true }; this.zbrSave(cfg); return { ok: true, already: true, contract: a.contract }; }
    const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [a.bot, 'pending'])));
    if (nonce !== 0) throw new Error(`bridge key nonce on ${chain} is ${nonce}, not 0: the reserved address would not match`);
    const args = coder.encode(['address', 'address', 'address', 'address', 'uint32'], [a.owner, a.feeSink, this.zbrOft(), this.zbrZro(), ZB_EID]).slice(2);
    let last;
    for (const evm of b.evm ? [b.evm] : ['cancun', 'paris']) {
      try {
        const s = await this.zbrSign(chain, { data: ZB_INITCODE[evm] + args });
        const hash = (await this.zbrBroadcast(chain, s.raw)) || null;
        const rc = hash ? await this.zbrWait(chain, hash, 180000) : null;
        if (!rc || rc.status !== '0x1') throw new Error('deploy failed ' + (hash || ''));
        cfg[chain] = { deployed: true, evm, tx: hash, block: parseInt(rc.blockNumber, 16) }; this.zbrSave(cfg);
        return { ok: true, chain, contract: a.contract, evm, tx: hash };
      } catch (e) { last = e; if (!/opcode|invalid|PUSH0|not supported/i.test(String(e.message))) break; }
    }
    throw last;
  };
  // top up the bot's gas on one chain from the platform hot wallet (explicit confirm)
  P.zbrFund = async function (chain, b = {}) {
    if (b.confirm !== 'SEND') throw new Error('pass confirm: "SEND"');
    const a = this.zbrAddr(); const v = BigInt(b.amountWei || 0); if (v <= 0n) throw new Error('amountWei required');
    const s = await this.zbrSign(chk(chain), { to: a.bot, data: '0x', value: v }, { key: this.hotWallet().privateKey });
    const h = await this.zbrBroadcast(chain, s.raw); return { ok: true, chain, to: a.bot, amountWei: v.toString(), hash: h, receipt: h ? !!(await this.zbrWait(chain, h)) : null };
  };
  P.zbrBalances = async function () {
    const a = this.zbrAddr(), hot = this.hotWallet().address, out = {};
    await Promise.all(Object.keys(ZB_CHAINS).map(async c => { const rpc = this.zbrRpc(c);
      try { const [b, h, n] = await Promise.all([rpc('eth_getBalance', [a.bot, 'latest']), rpc('eth_getBalance', [hot, 'latest']), rpc('eth_getTransactionCount', [a.bot, 'latest'])]);
        out[c] = { bot: BigInt(b).toString(), hot: BigInt(h).toString(), botNonce: Number(BigInt(n)), native: ZB_CHAINS[c].native }; } catch (e) { out[c] = { err: String(e.message).slice(0, 60) }; } }));
    return out;
  };
  P.zbrOwnerTx = async function (chain, data) {
    const a = this.zbrAddr(); const s = await this.zbrSign(chain, { to: a.contract, data });
    const h = await this.zbrBroadcast(chain, s.raw); return { hash: h, receipt: h ? await this.zbrWait(chain, h) : null };
  };

  // ── fast loop (every 2 s): route status + simulate fireMany, broadcast on the first tick it would bridge ──
  P.zbrTick = async function () {
    const cfg = this.zbrCfg(); const chains = Object.keys(ZB_CHAINS).filter(c => cfg[c]?.deployed);
    if (!chains.length) return null;
    this._zbrN = (this._zbrN || 0) + 1;
    this._zbrInflight = this._zbrInflight || {};
    const st = JSON.parse(this.meta('zb_live') || '{}');
    const a = this.zbrAddr();
    await Promise.all(chains.map(async (c) => {
      const rpc = this.zbrRpc(c), s = st[c] = st[c] || {};
      try {
        // pending list: refreshed every ~10 s or after a fire
        if (!s.pending || !s.pendingAt || now() - s.pendingAt > 10000) {
          const r = await rpc('eth_call', [{ to: a.contract, data: ZB_ABI.encodeFunctionData('pending', []) }, 'latest']);
          s.pending = ZB_ABI.decodeFunctionResult('pending', r)[0].map(x => x.toLowerCase()); s.pendingAt = now();
        }
        // route state for the page (every 3rd tick when nobody waits, every tick when someone does)
        if (s.pending.length || this._zbrN % 3 === 0) {
          try { await rpc('eth_call', [{ to: a.contract, data: ZB_ABI.encodeFunctionData('quote', [a.bot, 10n ** 18n, false]) }, 'latest']); s.open = true; s.why = ''; }
          catch (e) { if (e.answered) { s.open = false; s.why = zbReason(e); } }
          s.checked = now();
        }
        if (!s.pending.length || !s.open) return;
        const fl = this._zbrInflight[c];
        if (fl && now() - fl.ts < 60000) return;                     // one batch per chain in flight
        const data = ZB_ABI.encodeFunctionData('fireMany', [s.pending]);
        const sim = await rpc('eth_call', [{ from: a.bot, to: a.contract, data }, 'latest']).catch(() => null);
        const done = sim ? Number(ZB_ABI.decodeFunctionResult('fireMany', sim)[0]) : 0;
        if (!done) return;
        this._zbrInflight[c] = { ts: now() };
        const sg = await this.zbrSign(c, { to: a.contract, data }, { boost: 2, gas: 150000n + BigInt(s.pending.length) * 550000n });
        const hash = await this.zbrBroadcast(c, sg.raw);
        this._zbrInflight[c] = { ts: now(), hash };
        s.lastFire = { ts: now(), hash, users: done }; s.pendingAt = 0;
        await this.zbrAlert(`🚀 <b>Auto-bridge fired</b> on ${ZB_CHAINS[c].name}: ${done} order${done > 1 ? 's' : ''} → Zero\n<a href="${ZB_CHAINS[c].explorer}/tx/${hash}">tx</a>`);
      } catch (e) { s.err = String(e.message || e).slice(0, 120); }
    }));
    this.setMeta('zb_live', JSON.stringify(st));
    if (this._zbrN % 10 === 0) await this.zbrIndex().catch(() => null);
    return st;
  };
  P.zbrAlert = async function (text) {
    if (this.meta('zb_public') === '1' && this.zwSay) return this.zwSay(text, this.zwState?.() || {});
    const chat = this.meta('tg_owner_chat');                         // hidden phase: owner only
    if (chat && this.env.TG_BOT_TOKEN) return this.tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => null);
  };

  // ── events -> stats, history, balance on Zero ──
  P.zbrIndex = async function () {
    this.zbrInit();
    const cfg = this.zbrCfg(), a = this.zbrAddr(); let n = 0;
    for (const c of Object.keys(ZB_CHAINS).filter(x => cfg[x]?.deployed)) {
      const rpc = this.zbrRpc(c);
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      let cur = Number(this.meta('zb_cur_' + c) || cfg[c].block || head - 1000);
      let span = 2000;
      while (cur <= head) {
        const to = Math.min(head, cur + span - 1);
        let logs;
        try { logs = await rpc('eth_getLogs', [{ fromBlock: hx(cur), toBlock: hx(to), address: a.contract }]); }
        catch (e) { if (span > 50) { span = Math.floor(span / 4); continue; } throw e; }
        for (const l of logs) {
          const kind = T[l.topics[0]]; if (!kind) continue;
          const ev = ZB_ABI.parseLog(l); const v = ev.args;
          this.sql.exec(`INSERT OR IGNORE INTO zb_ev (chain,tx,idx,block,ts,kind,user,amount,bridged,fee,native,refund,guid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            c, l.transactionHash, parseInt(l.logIndex, 16), parseInt(l.blockNumber, 16), now(), kind, String(v.user).toLowerCase(),
            kind === 'SignedUp' ? v.amount.toString() : '0', kind === 'Fired' || kind === 'Bridged' ? v.bridged.toString() : '0',
            kind === 'Fired' || kind === 'Bridged' ? v.fee.toString() : '0', kind === 'Fired' || kind === 'Bridged' ? v.nativeFee.toString() : kind === 'Cancelled' ? v.deposit.toString() : v.deposit?.toString() || '0',
            kind === 'Fired' || kind === 'Bridged' ? v.refund.toString() : '0', kind === 'Fired' || kind === 'Bridged' ? v.guid : null);
          n++;
        }
        this.setMeta('zb_cur_' + c, String(to + 1)); cur = to + 1;
        if (span < 2000) span = Math.min(2000, span * 2);
      }
    }
    return { indexed: n };
  };
  // LayerZero Scan status for a bridge (cached; refreshed until delivered)
  P.zbrLz = async function (row) {
    if (row.lz === 'DELIVERED' || (row.lz_checked && now() - row.lz_checked < 20000)) return row;
    try {
      const r = await fetch(`https://scan.layerzero-api.com/v1/messages/tx/${row.tx}`, { headers: LZH, signal: AbortSignal.timeout(10000) });
      const j = await r.json(); const m = (j.data || []).find(x => !row.guid || x.guid === row.guid) || (j.data || [])[0];
      const status = m?.status?.name || (m ? 'INFLIGHT' : 'PENDING');
      const dst = m?.destination?.tx?.txHash || m?.dstTxHash || null;
      this.sql.exec('UPDATE zb_ev SET lz=?, dst_tx=?, lz_checked=? WHERE chain=? AND tx=? AND idx=?', status, dst, now(), row.chain, row.tx, row.idx);
      return { ...row, lz: status, dst_tx: dst };
    } catch { return row; }
  };

  P.zbrExternal = async function (u) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS zb_ext (addr TEXT, tx TEXT, chain TEXT, amount TEXT, status TEXT, mine INTEGER, recipient TEXT, checked INTEGER, PRIMARY KEY (addr, tx))`);
    const a = this.zbrAddr();
    const last = this.sql.exec('SELECT MAX(checked) m FROM zb_ext WHERE addr=?', u).one()?.m || 0;
    if (now() - last > 30000) {
      try {
        const r = await fetch(`https://scan.layerzero-api.com/v1/messages/wallet/${u}?limit=50`, { headers: LZH, signal: AbortSignal.timeout(10000) });
        const j = await r.json();
        for (const m of j.data || []) {
          if (m?.pathway?.dstEid !== ZB_EID) continue;
          const tx = String(m.source?.tx?.txHash || '').toLowerCase(), chain = SRC_EID[m.pathway.srcEid];
          if (!tx || !chain) continue;
          const tr = (m.transfers || []).find(x => String(x.token).toLowerCase() === ZB_ZRO.toLowerCase());
          const status = m.status?.name || 'INFLIGHT';
          const known = this.sql.exec('SELECT recipient, mine FROM zb_ext WHERE addr=? AND tx=?', u, tx).toArray()[0];
          let recipient = known?.recipient || null, mine = known ? known.mine : null;
          if (mine == null) {
            const t = await this.zbrRpc(chain)('eth_getTransactionByHash', [tx]).catch(() => null);
            const to = String(t?.to || '').toLowerCase();
            if (to === a.contract.toLowerCase()) { recipient = u; mine = 1; }                 // our bridgeNow: own address, enforced
            else if (to === ZB_ZRO.toLowerCase()) {
              try { const p = OFT_SEND.decodeFunctionData('send', t.input)[0]; recipient = '0x' + p.to.slice(26).toLowerCase(); mine = recipient === u ? 1 : 0; } catch { mine = 0; }
            } else mine = 0;                                                                 // another contract: recipient not provable here
          }
          this.sql.exec(`INSERT INTO zb_ext (addr,tx,chain,amount,status,mine,recipient,checked) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(addr,tx) DO UPDATE SET status=excluded.status, checked=excluded.checked`,
            u, tx, chain, decWei(tr?.amount || '0'), status, mine, recipient, now());
        }
      } catch { /* scan unavailable: keep what is cached */ }
    }
    return this.sql.exec('SELECT * FROM zb_ext WHERE addr=?', u).toArray();
  };

  // everything one wallet needs: ZRO per chain, open orders, history with LayerZero status, and its balance on Zero
  P.zbrMe = async function (addr) {
    this.zbrInit();
    const u = getAddress(addr).toLowerCase(), a = this.zbrAddr(), cfg = this.zbrCfg();
    const chains = {};
    await Promise.all(Object.keys(ZB_CHAINS).map(async (c) => {
      const rpc = this.zbrRpc(c), out = chains[c] = { deployed: !!cfg[c]?.deployed };
      try {
        const bal = await rpc('eth_call', [{ to: this.zbrZro(), data: ERC20.encodeFunctionData('balanceOf', [u]) }, 'latest']); out.zro = BigInt(bal).toString();
        if (!out.deployed) return;
        const [o, al] = await Promise.all([rpc('eth_call', [{ to: a.contract, data: ZB_ABI.encodeFunctionData('orderOf', [u]) }, 'latest']),
          rpc('eth_call', [{ to: this.zbrZro(), data: ERC20.encodeFunctionData('allowance', [u, a.contract]) }, 'latest'])]);
        const d = ZB_ABI.decodeFunctionResult('orderOf', o)[0];
        out.order = d.active ? { amount: d.amount.toString(), deposit: d.deposit.toString(), maxGasPrice: d.maxGasPrice.toString(), signedAt: Number(d.signedAt) * 1000 } : null;
        out.allowance = BigInt(al).toString();
      } catch (e) { out.err = String(e.message || e).slice(0, 80); }
    }));
    let rows = this.sql.exec(`SELECT * FROM zb_ev WHERE user=? AND kind IN ('Fired','Bridged') ORDER BY block DESC LIMIT 50`, u).toArray();
    let checks = 0;
    for (let i = 0; i < rows.length && checks < 6; i++) if (rows[i].lz !== 'DELIVERED') { rows[i] = await this.zbrLz(rows[i]); checks++; }
    let delivered = 0n, inflight = 0n, other = 0n;
    for (const r of rows) { if (r.lz === 'DELIVERED') delivered += BigInt(r.bridged); else inflight += BigInt(r.bridged); }
    const ours = new Set(rows.map(r => r.tx.toLowerCase()));
    const ext = (await this.zbrExternal(u).catch(() => [])).filter(x => !ours.has(x.tx));
    for (const x of ext) {
      if (!x.mine) { other += BigInt(x.amount); continue; }
      if (x.status === 'DELIVERED') delivered += BigInt(x.amount); else inflight += BigInt(x.amount);
    }
    // when Zero has a verified RPC, read the live native balance (ZRO is Zero's gas coin)
    let live = null;
    try {
      const zs = this.zwState?.() || {}; const url = Object.entries(zs.rpc || {}).find(([, v]) => v.live)?.[0];
      if (url) live = BigInt(await post(url, 'eth_getBalance', [u, 'latest'])).toString();
    } catch { /* not yet */ }
    return { address: u, chains, history: rows.map(r => ({ chain: r.chain, kind: r.kind, tx: r.tx, block: r.block, bridged: r.bridged, fee: r.fee, nativeFee: r.native, status: r.lz || 'PENDING', dstTx: r.dst_tx })),
      external: ext.map(x => ({ chain: x.chain, tx: x.tx, amount: x.amount, status: x.status, toSelf: !!x.mine, recipient: x.recipient })),
      zero: { delivered: delivered.toString(), inflight: inflight.toString(), otherAddresses: other.toString(), live, source: live != null ? 'Zero RPC (live balance)' : 'LayerZero Scan: delivered bridges to this address' } };
  };

  // public page payload
  P.zbrInfo = async function () {
    this.zbrInit();
    const a = this.zbrAddr(), cfg = this.zbrCfg(), live = JSON.parse(this.meta('zb_live') || '{}');
    const s = this.sql.exec(`SELECT COUNT(DISTINCT user) users, COUNT(*) n, COALESCE(SUM(CAST(bridged AS REAL)),0) b FROM zb_ev WHERE kind IN ('Fired','Bridged')`).one();
    const signed = this.sql.exec(`SELECT COUNT(DISTINCT user) c FROM zb_ev WHERE kind='SignedUp'`).one().c;
    const zw = this.zwState?.() || {};
    let zroUsd = 0; try { zroUsd = this.zroUsd(); } catch { /* */ }
    // a delivery status only changes on LayerZero's side, so refresh a few of the newest undelivered rows per call
    const stale = this.sql.exec(`SELECT * FROM zb_ev WHERE kind IN ('Fired','Bridged') AND COALESCE(lz,'')!='DELIVERED' ORDER BY block DESC LIMIT 4`).toArray();
    const fresh = {};
    for (const r of stale) { const u = await this.zbrLz(r); fresh[r.tx] = u.lz || r.lz; }
    const recent = this.sql.exec(`SELECT chain, kind, user, bridged, tx, block, lz FROM zb_ev WHERE kind IN ('Fired','Bridged') ORDER BY block DESC LIMIT 30`).toArray()
      .map(r => ({ ...r, lz: fresh[r.tx] || r.lz }));
    return {
      contract: a.contract, fees: { autoBps: 50, manualBps: 30 }, eid: ZB_EID, zeroRpcLive: Object.values(zw.rpc || {}).some(v => v.live),
      chains: Object.fromEntries(Object.entries(ZB_CHAINS).map(([k, c]) => [k, { name: c.name, chainId: c.chainId, native: c.native, deposit: c.deposit, explorer: c.explorer,
        deployed: !!cfg[k]?.deployed, open: live[k]?.open ?? (zw.bridge?.[k]?.state === 'open'), why: live[k]?.why || zw.bridge?.[k]?.why || '', waiting: live[k]?.pending?.length || 0, lastFire: live[k]?.lastFire || null }])),
      zroUsd,
      stats: { users: s.users, bridges: s.n, bridgedZro: s.b / 1e18, volumeUsd: (s.b / 1e18) * zroUsd, signedUp: signed },
      recent: recent.map(r => ({ chain: r.chain, kind: r.kind === 'Fired' ? 'auto' : 'manual', user: r.user, bridged: r.bridged, tx: r.tx, status: r.lz || 'PENDING' })),
    };
  };

  // transactions for the user's wallet (approve exactly the amount, never unlimited)
  P.zbrPrep = async function (b) {
    const c = chk(b.chain), cfg = this.zbrCfg(), a = this.zbrAddr();
    if (!cfg[c]?.deployed) throw new Error(`bridge not live on ${ZB_CHAINS[c].name} yet`);
    const from = getAddress(b.from).toLowerCase(), rpc = this.zbrRpc(c);
    const txs = [];
    const needAllow = async (amount) => {
      const al = BigInt(await rpc('eth_call', [{ to: this.zbrZro(), data: ERC20.encodeFunctionData('allowance', [from, a.contract]) }, 'latest']));
      if (al < amount) txs.push({ label: 'Approve ZRO', to: this.zbrZro(), data: ERC20.encodeFunctionData('approve', [a.contract, amount]), value: '0x0' });
    };
    if (b.action === 'cancel') { txs.push({ label: 'Cancel auto-bridge', to: a.contract, data: ZB_ABI.encodeFunctionData('cancel', []), value: '0x0' }); return { chainId: ZB_CHAINS[c].chainId, txs }; }
    if (b.action === 'fire') { txs.push({ label: 'Bridge my order now', to: a.contract, data: ZB_ABI.encodeFunctionData('fire', [from]), value: '0x0' }); return { chainId: ZB_CHAINS[c].chainId, txs }; }
    const amount = BigInt(b.amount || 0); if (amount <= 0n) throw new Error('amount required');
    const bal = BigInt(await rpc('eth_call', [{ to: this.zbrZro(), data: ERC20.encodeFunctionData('balanceOf', [from]) }, 'latest']));
    if (bal < amount) throw new Error(`not enough ZRO on ${ZB_CHAINS[c].name}`);
    if (b.action === 'signup') {
      await needAllow(amount);
      const dep = BigInt(b.deposit || ZB_CHAINS[c].deposit);
      txs.push({ label: 'Sign up', to: a.contract, data: ZB_ABI.encodeFunctionData('signUp', [amount, BigInt(b.maxGasPrice || 0)]), value: hx(dep) });
      return { chainId: ZB_CHAINS[c].chainId, txs, deposit: dep.toString() };
    }
    if (b.action === 'bridge') {
      let q;
      try { q = ZB_ABI.decodeFunctionResult('quote', await rpc('eth_call', [{ to: a.contract, data: ZB_ABI.encodeFunctionData('quote', [from, amount, true]) }, 'latest'])); }
      catch (e) { return { chainId: ZB_CHAINS[c].chainId, closed: true, reason: zbReason(e) }; }
      await needAllow(amount);
      const value = (BigInt(q.nativeFee) * 115n) / 100n;               // 15% headroom, unused part refunded in the same tx
      txs.push({ label: 'Bridge to Zero', to: a.contract, data: ZB_ABI.encodeFunctionData('bridgeNow', [amount]), value: hx(value) });
      return { chainId: ZB_CHAINS[c].chainId, txs, quote: { nativeFee: q.nativeFee.toString(), bridged: q.bridged.toString(), fee: q.fee.toString() } };
    }
    throw new Error('action: signup | bridge | cancel | fire');
  };

  P.zbrStatus = async function (chain, tx) {
    this.zbrInit();
    const row = this.sql.exec('SELECT * FROM zb_ev WHERE chain=? AND tx=? ORDER BY idx LIMIT 1', chk(chain), String(tx).toLowerCase()).toArray()[0];
    if (row) return this.zbrLz(row);
    try { const r = await fetch(`https://scan.layerzero-api.com/v1/messages/tx/${tx}`, { headers: LZH, signal: AbortSignal.timeout(10000) }); const j = await r.json(); const m = (j.data || [])[0];
      return { tx, lz: m?.status?.name || 'NOT FOUND', dst_tx: m?.destination?.tx?.txHash || null }; } catch { return { tx, lz: 'UNKNOWN' }; }
  };
}
