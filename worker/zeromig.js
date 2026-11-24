// Zero mainnet migration, step 1: freeze one pre-market network and publish the 1:1 balance snapshot.
// Variant B (owner decision 2026-11-22): every curve moves to an on-chain RookeryCurve on Zero with exactly this
// state; holders stay custodial on Rookery and withdraw to their own Zero wallet (as the Docs promise).
// The snapshot is taken once the Zero RPC is verified live (chain id 33002 + LayerZero endpoint code + moving blocks).
import { getCreateAddress, getCreate2Address, keccak256, toUtf8Bytes, Wallet, Interface, getAddress, zeroPadValue, JsonRpcProvider } from 'ethers';
import { zeroRun, requiredReserve } from './zerorun.js';
import { zeroHdr, zeroKeyLoad } from './zerokey.js';
const enc = new TextEncoder();

// Reserved Zero addresses. A dedicated HD child signs ONLY the Zero deployment: its first transaction on Zero (nonce 0)
// deploys RookeryCurve2, whose constructor deploys RookeryTokenDeployer (curve nonce 1). Each pre-market token is then
// created through CREATE3 with salt keccak256(<Rookery token id>), so its address never depends on import order.
export const ZERO_DEPLOYER_INDEX = 2_000_033_002;
export const ZERO_DEX_INDEX = 2_000_033_003;       // deploys WZRO + Uniswap V2 factory/router at nonces 0, 1, 2
export const ZERO_CUSTODY_INDEX = 2_000_033_004;   // holds every user's migrated tokens 1:1, pays withdrawals
const ZRO_OFT = '0x6985884C4392D348587B19cb9eAAf157F13271cd';   // same address on every source chain; peer on Zero 0x1ced…5b31
const FUND = {
  eth: { eid: 30101, chainId: 1, rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'] },
  arb: { eid: 30110, chainId: 42161, rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'] },
  base: { eid: 30184, chainId: 8453, rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] },
  bsc: { eid: 30102, chainId: 56, rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'] },
};
const OFT = new Interface([
  'function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd),bool) view returns ((uint256 nativeFee,uint256 lzTokenFee))',
  'function send((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd),(uint256 nativeFee,uint256 lzTokenFee),address) payable returns ((bytes32,uint64,(uint256,uint256)),(uint256,uint256))',
  'function balanceOf(address) view returns (uint256)',
]);
const ERC20T = new Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
// keccak256 of the standard 16-byte CREATE3 proxy initcode 0x67363d3d37363d34f03d5260086018f3 (Solady / 0xSequence).
// Raw opcodes, so it never changes with compiler settings or EVM version: the token addresses below are final.
// The deploy script re-checks it against the deployed factory's STUB_HASH() before the first import.
export const ZERO_STUB_HASH = '0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f';
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export function installZeroMig(Cls, H) {
  const { B, WEI, now, vQuote } = H;
  const P = Cls.prototype;
  const LABEL = { zero: 'Zero', giwa: 'GIWA', litvm: 'LitVM' };

  // ───── per-network config: every network has its OWN deployer / dex / custody HD children, so a mistake on one
  //       chain can never touch another. Addresses depend only on the deployer key (not on the chain id).
  const MIGNET = {
    zero: { label: 'Zero', chainId: 33002, idx: [ZERO_DEPLOYER_INDEX, ZERO_DEX_INDEX, ZERO_CUSTODY_INDEX], pin: 'zero_addrs_v2', native: 'ZRO', reserveMeta: 'migrated_zro_reserve' },
    giwa: { label: 'GIWA', chainId: null, idx: [2_000_091_002, 2_000_091_003, 2_000_091_004], pin: 'giwa_addrs_v1', native: 'ETH', reserveMeta: 'giwa_onchain_reserve' },
  };
  P.MIGNET = MIGNET;
  const cfg = (net) => { const c = MIGNET[net]; if (!c) throw new Error('unknown migration network ' + net); return c; };
  const K = (net) => (net === 'zero' ? 'zero' : net);           // meta prefix (zero keeps its existing keys)

  P.netChainId = function (net) { return cfg(net).chainId || Number(this.meta(net + '_chainid') || 0) || null; };
  P.netKeys = function (net) {
    const [d, x, c] = cfg(net).idx, m = this.master();
    return { deployer: m.deriveChild(d), dex: m.deriveChild(x), custody: m.deriveChild(c) };
  };
  P.netAddrs = function (net) {
    this._netAddrs = this._netAddrs || {}; this._netTok = this._netTok || {};
    if (this._netAddrs[net]) return this._netAddrs[net];
    const deployer = this.master().deriveChild(cfg(net).idx[0]).address;
    const curve = getCreateAddress({ from: deployer, nonce: 0 });
    const factory = getCreateAddress({ from: curve, nonce: 1 });
    const a = { network: net, deployer, curve, factory, stubHash: ZERO_STUB_HASH, chainId: this.netChainId(net) };
    // pin the first computation: if derivation or constants ever change, refuse to show different addresses
    const pinned = this.meta(cfg(net).pin);
    if (!pinned) this.setMeta(cfg(net).pin, JSON.stringify({ ...a, chainId: undefined }));
    else { const q = JSON.parse(pinned); if (q.curve !== a.curve || q.factory !== a.factory || q.stubHash !== a.stubHash) throw new Error(`reserved ${net} addresses changed: refusing`); }
    this._netAddrs[net] = a; this._netTok[net] = new Map();
    return a;
  };
  P.netTokenAddr = function (net, id) {
    const a = this.netAddrs(net);
    let t = this._netTok[net].get(id);
    if (!t) { t = getCreateAddress({ from: getCreate2Address(a.factory, keccak256(toUtf8Bytes(String(id))), ZERO_STUB_HASH), nonce: 1 }); this._netTok[net].set(id, t); }
    return t;
  };

  // signed transaction through the network's RPC; EIP-1559 when the chain has a base fee, legacy otherwise
  P.netSend = async function (net, rpc, role, tx, onHash) {
    const k = this.netKeys(net)[role];
    if (!k) throw new Error('unknown signer ' + role);
    const chainId = Number(BigInt(await rpc('eth_chainId', [])));
    const want = this.netChainId(net);
    if (want && chainId !== want) throw new Error(`${net}: rpc answers chain id ${chainId}, expected ${want}`);
    const w = new Wallet(k.privateKey);
    const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [w.address, 'pending'])));
    const base = { chainId, nonce, to: tx.to || null, data: tx.data || '0x', value: tx.value || 0n };
    const est = BigInt(await rpc('eth_estimateGas', [{ from: w.address, to: tx.to || undefined, data: base.data, value: '0x' + BigInt(base.value).toString(16) }]));
    base.gasLimit = (est * 12n) / 10n + 50_000n;
    const blk = await rpc('eth_getBlockByNumber', ['latest', false]);
    if (blk?.baseFeePerGas) {
      let tip = 0n; try { tip = BigInt(await rpc('eth_maxPriorityFeePerGas', [])); } catch { /* chains without a tip market */ }
      Object.assign(base, { type: 2, maxPriorityFeePerGas: tip, maxFeePerGas: BigInt(blk.baseFeePerGas) * 2n + tip });
    } else Object.assign(base, { type: 0, gasPrice: BigInt(await rpc('eth_gasPrice', [])) });
    const raw = await w.signTransaction(base);
    const hash = await rpc('eth_sendRawTransaction', [raw]);
    if (onHash) onHash(hash);
    for (let i = 0; i < (tx.waitTries || 240); i++) {
      const rc = await rpc('eth_getTransactionReceipt', [hash]);
      if (rc) return rc;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('no receipt for ' + hash + ' (the chain did not include it: on Zero a refused transaction gets no receipt)');
  };

  // Zero: only an RPC the watcher verified (impostor chains exist). GIWA: the official RPC the owner sets (meta giwa_rpc).
  P.netRpcUrl = function (net, b = {}) {
    if (net === 'zero') {
      const st = this.zwState?.() || {};
      const live = Object.entries(st.rpc || {}).filter(([, v]) => v.live).map(([u]) => u);
      if (b.rpc && !live.includes(b.rpc) && !b.allowUnverified) throw new Error('rpc is not a verified Zero RPC (watcher)');
      return b.rpc || live[0] || null;
    }
    return b.rpc || this.meta(net + '_rpc') || null;
  };
  P.netRpcFn = function (net, b = {}) {
    const url = this.netRpcUrl(net, b);
    if (!url) throw new Error(`${cfg(net).label} RPC is not available yet`);
    if (net === 'zero') zeroKeyLoad(this);
    return async (method, params) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...zeroHdr(url) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc error'); return j.result;
    };
  };

  // run (or dry-run) the 1:1 migration of one network in the background; state persists after every transaction
  P.netMigrate = async function (net, b = {}) {
    const c = cfg(net);
    const url = this.netRpcUrl(net, b);
    if (!url) throw new Error(net === 'zero' ? 'no verified Zero RPC yet' : `set the official ${c.label} RPC first`);
    const chainId = Number(b.chainId || this.netChainId(net) || 0);
    if (!chainId) throw new Error(`${c.label}: pass the mainnet chainId (it is checked against the RPC)`);
    if (!c.chainId) this.setMeta(net + '_chainid', String(chainId));
    const snapMeta = JSON.parse(this.meta('mig_snapshot_' + net) || 'null');
    if (!snapMeta) throw new Error(`no official ${c.label} snapshot yet`);
    if (!this.netPaused(net)) throw new Error(`${c.label} trading must be paused`);
    if (!b.dex) throw new Error("choose the graduation DEX: dex 'own' or { weth, factoryV2, router }");
    const snapshot = JSON.parse(await (await this.env.BACKUPS.get(snapMeta.key)).text());
    const art = await this.env.BACKUPS.get('rookery/migration/zero_artifacts.json');
    if (!art) throw new Error('artifacts missing in R2');
    const artifacts = JSON.parse(await art.text());
    const creators = Object.fromEntries(this.sql.exec(`SELECT DISTINCT u.id, u.wallet FROM markets m JOIN users u ON u.id=m.creator_id WHERE m.network=?`, net).toArray()
      .map(r => ['u' + r.id, r.wallet && /^0x[0-9a-fA-F]{40}$/.test(r.wallet) ? r.wallet : null]));
    const rpc = this.netRpcFn(net, { ...b, rpc: url });
    const Kk = this.netKeys(net);
    const io = {
      rpc, send: (role, tx) => this.netSend(net, rpc, role, tx),
      addr: { deployer: Kk.deployer.address, dex: Kk.dex.address, custody: Kk.custody.address, feeTo: Kk.custody.address },
      load: async () => JSON.parse(this.meta(K(net) + '_run') || 'null'), save: async (st) => this.setMeta(K(net) + '_run', JSON.stringify(st)),
      log: () => {},
    };
    // virtual reserve for FUTURE native launches on that chain: same starting market cap as a ZRO launch (3,150 ZRO)
    const vNative = b.vNative ? String(b.vNative) : net === 'zero' ? (3150n * WEI).toString()
      : (BigInt(Math.round(3150 * this.zroUsd() / this.ethUsd() * 1e9)) * 1_000_000_000n).toString();
    const plan = { dex: b.dex, snapshot, artifacts, creators, chainId, vNative: b.vNative ? vNative : (this.meta(K(net) + '_vnative') || vNative), build: b.build || 'auto', dryRun: !!b.dryRun, recheck: !!b.recheck };
    if (plan.dryRun) return zeroRun(io, plan);
    this._netRunning = this._netRunning || {};
    if (this._netRunning[net]) return { running: true };
    this._netRunning[net] = true;
    const sk = K(net) + '_run_status';
    this.setMeta(sk, JSON.stringify({ started: now(), rpc: url, state: 'running' }));
    const job = zeroRun(io, plan).then(r => {
      if (!r.checks?.failed) { try { r.finalized = this.netFinalize(net); } catch (e) { r.finalizeError = String(e.message || e); } }
      this.setMeta(sk, JSON.stringify({ started: JSON.parse(this.meta(sk)).started, finished: now(), state: r.checks?.failed ? 'checks-failed' : 'done', report: { ...r, state: undefined } }));
      return r;
    }).catch(e => this.setMeta(sk, JSON.stringify({ state: 'error', error: String(e.message || e).slice(0, 400), at: now() })))
      .finally(() => { this._netRunning[net] = false; });
    this.ctx.waitUntil(job);
    return { started: true, rpc: url, network: net };
  };

  // ───── after a successful run: the ledger now points at the chain
  P.netFinalize = function (net, opts = {}) {
    const c = cfg(net);
    const run = JSON.parse(this.meta(K(net) + '_run') || 'null');
    if (!run?.finished && !opts.force) throw new Error('migration not finished with all checks passing');
    if (this.meta(K(net) + '_finalized') && !opts.force) return { already: JSON.parse(this.meta(K(net) + '_finalized')) };
    try { this.sql.exec('ALTER TABLE markets ADD COLUMN zero_token TEXT'); } catch { /* exists: the on-chain token address, any network */ }
    let moved = 0n, n = 0;
    this.ctx.storage.transactionSync(() => {
      for (const [id, imp] of Object.entries(run.imports || {})) {
        const m = this.sql.exec('SELECT * FROM markets WHERE id=?', id).toArray()[0];
        if (!m || m.network !== net || m.migrated) continue;
        moved += B(m.reserve_zro);
        this.sql.exec('UPDATE markets SET migrated=1, zero_token=? WHERE id=?', imp.token, id);
        n++;
      }
      // the curve reserves left our books for the on-chain curves: same amount out of "held" and out of "inflow"
      this.setMeta(c.reserveMeta, (B(this.meta(c.reserveMeta)) + moved).toString());
      if (net === 'zero') this.setMeta('zero_onchain_reserve', (B(this.meta('zero_onchain_reserve')) + moved).toString());
    });
    const fin = { ts: now(), markets: n, reserveWei: moved.toString(), asset: c.native };
    this.setMeta(K(net) + '_finalized', JSON.stringify(fin));
    return fin;
  };

  // ───── withdrawals of migrated tokens from the network's custody to the user's own wallet
  P.zwdInit = function () {
    if (this._zwdInit) return; this._zwdInit = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS zero_wd (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market TEXT, token TEXT, to_addr TEXT,
      amount TEXT, status TEXT, txid TEXT DEFAULT '', err TEXT DEFAULT '', transfer_id INTEGER, created INTEGER, updated INTEGER)`);
    try { this.sql.exec(`ALTER TABLE zero_wd ADD COLUMN net TEXT DEFAULT 'zero'`); } catch { /* exists */ }
  };
  P.netWithdraw = async function (user, b) {
    this.zwdInit();
    const m = this.sql.exec('SELECT * FROM markets WHERE id=?', String(b.market || '')).toArray()[0];
    if (!m || !MIGNET[m.network]) throw new Error('Unknown token');
    const c = cfg(m.network);
    if (!m.migrated || !m.zero_token) throw new Error(`This token is not on ${c.label} yet: withdrawals open right after the migration`);
    let to; try { to = getAddress(String(b.to || '').trim()); } catch { throw new Error('Enter a valid 0x… address'); }
    const amt = B(b.amount);
    if (amt <= 0n) throw new Error('Enter an amount');
    // tokens refuse contract recipients until the curve graduates (EIP-7702 wallets are fine)
    const code = await this.netRpcFn(m.network)('eth_getCode', [to, 'latest']);
    if (code && code !== '0x' && !String(code).toLowerCase().startsWith('0xef0100')) throw new Error('Send to a regular wallet address: this token does not accept contract addresses before it bonds');
    let id;
    this.ctx.storage.transactionSync(() => {
      this.addBal(user.id, 't:' + m.id, -amt);
      const tr = this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        user.id, 'withdrawal', m.network, amt.toString(), to, 'pending', `$${m.symbol} to ${c.label}`, now(), 't:' + m.id).one().id;
      id = this.sql.exec(`INSERT INTO zero_wd (user_id,market,token,to_addr,amount,status,transfer_id,created,updated,net) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        user.id, m.id, m.zero_token, to, amt.toString(), 'pending', tr, now(), now(), m.network).one().id;
    });
    this.ctx.waitUntil(this.zeroWdTick().catch(() => {}));
    return { ok: true, id, status: 'pending', to, amount: amt.toString(), token: m.zero_token, network: m.network };
  };
  // one at a time per custody (nonce); the hash is stored BEFORE waiting, so a crash never leads to a second send
  P.zeroWdTick = async function (max = 5) {
    this.zwdInit();
    if (this._zwdBusy) return { busy: true }; this._zwdBusy = true;
    const done = [];
    try {
      for (const w of this.sql.exec(`SELECT * FROM zero_wd WHERE status IN ('pending','sending') ORDER BY id LIMIT ?`, max).toArray()) {
        const net = w.net || 'zero';
        let rpc; try { rpc = this.netRpcFn(net); } catch { continue; }
        if (w.status === 'sending' && w.txid) {           // resume: only look the transaction up
          const rc = await rpc('eth_getTransactionReceipt', [w.txid]).catch(() => null);
          if (!rc) { if (now() - w.updated > 30 * 60e3) this.zeroWdFail(w, 'not mined after 30 min, check custody nonce'); continue; }
          this.zeroWdSettle(w, rc); done.push(w.id); continue;
        }
        this.sql.exec(`UPDATE zero_wd SET status='sending', updated=? WHERE id=?`, now(), w.id);
        try {
          const rc = await this.netSend(net, rpc, 'custody', { to: w.token, data: ERC20T.encodeFunctionData('transfer', [w.to_addr, B(w.amount)]) },
            (hash) => this.sql.exec('UPDATE zero_wd SET txid=?, updated=? WHERE id=?', hash, now(), w.id));
          this.zeroWdSettle({ ...w, txid: rc.transactionHash }, rc); done.push(w.id);
        } catch (e) {
          const row = this.sql.exec('SELECT txid FROM zero_wd WHERE id=?', w.id).one();
          if (!row.txid) this.zeroWdFail(w, String(e.message || e));            // never broadcast: safe to refund
          else this.sql.exec('UPDATE zero_wd SET err=?, updated=? WHERE id=?', String(e.message || e).slice(0, 200), now(), w.id); // broadcast: wait for receipt
        }
      }
    } finally { this._zwdBusy = false; }
    return { processed: done };
  };
  P.zeroWdSettle = function (w, rc) {
    if (Number(rc.status) === 1) {
      this.sql.exec(`UPDATE zero_wd SET status='sent', txid=?, updated=? WHERE id=?`, rc.transactionHash, now(), w.id);
      this.sql.exec(`UPDATE transfers SET status='sent', txid=? WHERE id=?`, rc.transactionHash, w.transfer_id);
    } else this.zeroWdFail({ ...w, txid: rc.transactionHash }, 'reverted on chain');
  };
  P.zeroWdFail = function (w, why) {
    this.ctx.storage.transactionSync(() => {
      this.addBal(w.user_id, 't:' + w.market, B(w.amount));
      this.sql.exec(`UPDATE zero_wd SET status='refunded', err=?, updated=? WHERE id=?`, String(why).slice(0, 200), now(), w.id);
      this.sql.exec(`UPDATE transfers SET status='failed', note=? WHERE id=?`, 'refunded: ' + String(why).slice(0, 120), w.transfer_id);
    });
  };

  // ───── Zero names kept as thin wrappers (everything already wired and tested keeps working)
  P.zeroAddrs = function () { return this.netAddrs('zero'); };
  P.zeroTokenAddr = function (id) { return this.netTokenAddr('zero', id); };
  P.zeroKeys = function () { return this.netKeys('zero'); };
  P.zeroSend = function (rpc, role, tx, onHash) { return this.netSend('zero', rpc, role, tx, onHash); };
  P.zeroRpcUrl = function (b = {}) { return this.netRpcUrl('zero', b); };
  P.zeroRpcFn = function () { return this.netRpcFn('zero'); };
  P.zeroMigrate = function (b = {}) { return this.netMigrate('zero', b); };
  P.zeroFinalize = function (opts = {}) { return this.netFinalize('zero', opts); };
  P.zeroWithdraw = function (user, b) { return this.netWithdraw(user, b); };

  // ───── ZRO to Zero through the ZRO OFT, from the hot wallet on one source chain (quote by default)
  P.zeroFund = async function (b = {}) {
    const c = FUND[b.chain || 'bsc'];
    if (!c) throw new Error('chain: eth | arb | base | bsc');
    const K = this.zeroKeys();
    const to = b.to === 'dex' ? K.dex.address : b.to === 'custody' ? K.custody.address : b.to && /^0x[0-9a-fA-F]{40}$/.test(b.to) ? getAddress(b.to) : K.deployer.address;
    const amount = (B(b.amountWei || 0) / 10n ** 12n) * 10n ** 12n;          // ZRO OFT shared decimals = 6: no dust
    if (amount <= 0n || amount > 3500n * WEI) throw new Error('amountWei between 0 and 3500 ZRO');
    const dstEid = Number(b.dstEid || 33002);
    const sp = { dstEid, to: zeroPadValue(to, 32), amountLD: amount, minAmountLD: amount, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' };
    const provider = new JsonRpcProvider(c.rpcs[0], c.chainId, { staticNetwork: true });
    const hot = new Wallet(this.hotWallet().privateKey, provider);
    const bal = OFT.decodeFunctionResult('balanceOf', await provider.call({ to: ZRO_OFT, data: OFT.encodeFunctionData('balanceOf', [hot.address]) }))[0];
    let fee;
    try { fee = OFT.decodeFunctionResult('quoteSend', await provider.call({ to: ZRO_OFT, data: OFT.encodeFunctionData('quoteSend', [sp, false]) }))[0]; }
    catch (e) { return { ok: false, route: 'closed', dstEid, why: String(e.shortMessage || e.message || e).slice(0, 160), hotZro: bal.toString() }; }
    const out = { ok: true, chain: b.chain || 'bsc', dstEid, to, amountWei: amount.toString(), nativeFeeWei: fee.nativeFee.toString(), hotZro: bal.toString() };
    if (b.confirm !== 'SEND') return { ...out, quoteOnly: true };
    if (bal < amount) throw new Error('hot wallet has not enough ZRO on this chain');
    const tx = await hot.sendTransaction({ to: ZRO_OFT, data: OFT.encodeFunctionData('send', [sp, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, hot.address]), value: fee.nativeFee });
    const log = JSON.parse(this.meta('zero_fund_log') || '[]'); log.push({ ts: now(), ...out, tx: tx.hash }); this.setMeta('zero_fund_log', JSON.stringify(log.slice(-30)));
    return { ...out, tx: tx.hash, track: 'https://layerzeroscan.com/tx/' + tx.hash };
  };

  // ── automatic ZRO funding: the ETH→Zero window lasts minutes, so the send has to run inside the watcher tick.
  //    The plan is armed once by the owner (explicit ARM), fires each leg in the first window where that chain is open,
  //    never repeats a leg, and disarms itself when every leg is done.
  P.zeroFundPlan = function (b = {}) {
    const cur = JSON.parse(this.meta('zero_fund_plan') || '{}');
    if (!b.act) return cur;
    if (b.act === 'disarm') { cur.armed = false; cur.disarmedAt = now(); this.setMeta('zero_fund_plan', JSON.stringify(cur)); return cur; }
    if (b.act !== 'arm') throw new Error('act: arm | disarm');
    if (b.confirm !== 'ARM') throw new Error('pass confirm: "ARM"');
    const legs = (b.legs || []).map(l => ({ chain: String(l.chain), amountWei: ((B(l.amountWei || 0) / 10n ** 12n) * 10n ** 12n).toString(), done: false }));
    if (!legs.length) throw new Error('legs required');
    let total = 0n;
    for (const l of legs) {
      if (!FUND[l.chain]) throw new Error('chain: eth | arb | base | bsc');
      if (BigInt(l.amountWei) <= 0n) throw new Error('leg amount must be positive');
      total += BigInt(l.amountWei);
    }
    if (total > 3500n * WEI) throw new Error('plan above the 3500 ZRO cap');
    const plan = { armed: true, dry: !!b.dry, to: b.to === 'custody' || b.to === 'dex' ? b.to : 'deployer', legs, totalWei: total.toString(), created: now(), tries: cur.tries || {} };
    this.setMeta('zero_fund_plan', JSON.stringify(plan));
    return plan;
  };
  P.zeroFundStatus = async function (plan) {
    plan = plan || this.zeroFundPlan();
    const out = { armed: !!plan.armed, dry: !!plan.dry, totalWei: plan.totalWei, legs: [] };
    for (const l of plan.legs || []) {
      const row = { chain: l.chain, amountWei: String(l.amountWei), done: !!l.done, tx: l.tx || null, sentAt: l.sentAt || null, dry: l.dry || null };
      if (l.tx) {
        try {
          const r = await fetch(`https://scan.layerzero-api.com/v1/messages/tx/${l.tx}`, { signal: AbortSignal.timeout(12000) });
          const j = await r.json();
          const m = (j.data || [])[0];
          row.delivered = m?.status?.name || m?.status || null;
          row.dstTx = m?.dstTxHash || null;
        } catch { row.delivered = 'check later'; }
      }
      out.legs.push(row);
    }
    return out;
  };
  P.zeroFundAuto = async function (st) {
    const plan = this.zeroFundPlan();
    if (!plan.armed) return null;
    const sent = [];
    for (const l of plan.legs) {
      if (l.done) continue;
      const br = st?.bridge?.[l.chain]?.state;
      if (br && br !== 'open') continue;                 // bsc is not in the bridge monitor: quote decides
      try {
        if (plan.dry) {                                  // dry run: quote only, never sends
          const q = await this.zeroFund({ chain: l.chain, amountWei: String(l.amountWei), to: plan.to });
          l.dry = { ok: !!q.ok, route: q.route || 'open', why: q.why || null, fee: q.nativeFeeWei || null, ts: now() };
          this.setMeta('zero_fund_plan', JSON.stringify(plan));
          continue;
        }
        const r = await this.zeroFund({ chain: l.chain, amountWei: String(l.amountWei), to: plan.to, confirm: 'SEND' });
        if (r.ok && r.tx) {
          l.done = true; l.tx = r.tx; l.sentAt = now(); l.fee = r.nativeFeeWei;
          this.setMeta('zero_fund_plan', JSON.stringify(plan));
          sent.push(r);
          if (this.zwSay) await this.zwSay(`💸 <b>ZRO reserves sent</b> · ${(Number(l.amountWei) / 1e18).toFixed(2)} ZRO from ${FUND[l.chain].eid ? l.chain.toUpperCase() : l.chain} → Zero (${plan.to})\n<a href="https://layerzeroscan.com/tx/${r.tx}">LayerZero Scan</a>`, st);
        } else if (r.route === 'closed') { /* the window closed between the check and the send: retry on the next open tick */ }
        else if (/not enough ZRO/i.test(r.why || r.error || '')) { l.done = true; l.error = 'not enough ZRO'; this.setMeta('zero_fund_plan', JSON.stringify(plan)); }
      } catch (e) { plan.tries = plan.tries || {}; plan.tries[l.chain] = (plan.tries[l.chain] || 0) + 1; this.setMeta('zero_fund_plan', JSON.stringify(plan)); }
    }
    if (plan.legs.length && plan.legs.every(l => l.done)) {
      plan.armed = false; plan.finished = now(); this.setMeta('zero_fund_plan', JSON.stringify(plan));
      if (this.zwSay) await this.zwSay(`✅ <b>All ZRO reserves sent</b> · ${(Number(plan.totalWei) / 1e18).toFixed(2)} ZRO on the way to Zero (${plan.to}).`, st);
    }
    return sent.length ? sent : null;
  };
  P.netPaused = function (net) { return this.meta('net_paused_' + net) === '1'; };
  P.setNetPaused = function (net, on) { this.setMeta('net_paused_' + net, on ? '1' : '0'); };
  P.netPauseMsg = function (net) {
    return `${LABEL[net] || net} mainnet is live: trading is paused while every balance moves 1:1 on-chain. Your tokens are safe and stay in your account.`;
  };

  // pay out every pending holder reward first (in the quote asset), so nothing is lost when the curve moves
  P.migSettleAll = function (net) {
    let paid = 0;
    for (const m of this.sql.exec(`SELECT id FROM markets WHERE network=?`, net).toArray()) {
      for (const h of this.sql.exec(`SELECT user_id FROM balances WHERE asset=? AND amount!='0'`, 't:' + m.id).toArray()) {
        if (this.settle(h.user_id, this.market(m.id)) > 0n) paid++;
      }
    }
    return paid;
  };

  // one consistent point in time: everything below runs synchronously inside one storage transaction
  P.migBuild = function (net) {
    const supplyWei = 1_000_000_000n * WEI;
    const markets = [];
    const issues = [];
    let holderRows = 0, quoteReserve = 0n;
    for (const m of this.sql.exec(`SELECT * FROM markets WHERE network=? ORDER BY created`, net).toArray()) {
      const rows = this.sql.exec(`SELECT user_id, amount FROM balances WHERE asset=? AND amount!='0' ORDER BY user_id`, 't:' + m.id).toArray();
      const holders = rows.map(r => ({ u: 'u' + r.user_id, amount: B(r.amount).toString() })).filter(h => B(h.amount) > 0n);
      const held = holders.reduce((a, h) => a + B(h.amount), 0n);
      const sold = B(m.reserve_tok), burned = B(m.burned);
      const poolTok = B(m.pool_tok || 0);
      // tokens still owned by the curve/pool = supply - held by users - burned
      const curveLeft = supplyWei - held - burned;
      if (curveLeft < 0n) issues.push({ market: m.id, issue: 'holders + burned exceed supply' });
      // the curve's own accounting (sold minus burned) must equal what users hold
      const drift = sold - burned - held;
      if (!m.graduated && drift !== 0n && (drift > WEI || drift < -WEI)) issues.push({ market: m.id, issue: 'curve sold-burned differs from holder total', driftWei: drift.toString() });
      quoteReserve += B(m.graduated ? m.pool_zro : m.reserve_zro);
      holderRows += holders.length;
      markets.push({
        id: m.id, name: m.name, symbol: m.symbol, creator: 'u' + m.creator_id, quote: m.quote || 'ZRO',
        state: m.graduated ? 'bonded' : 'curve',
        // every amount in wei: the ledger keeps v_zro / v_tok / curve_tokens in whole units
        curve: { virtualQuote: vQuote(m).toString(), virtualTokens: (B(m.v_tok) * WEI).toString(),
          quoteReserve: B(m.reserve_zro).toString(), tokensSold: sold.toString(), curveTokens: (B(m.curve_tokens || 0) * WEI).toString() },
        pool: m.graduated ? { quote: B(m.pool_zro).toString(), tokens: poolTok.toString() } : null,
        taxesBps: { marketing: m.tax_mkt || 0, burn: m.tax_burn || 0, rewards: m.tax_rew || 0 },
        supply: supplyWei.toString(), burned: burned.toString(), heldByUsers: held.toString(), curveLeft: curveLeft.toString(),
        lastPrice: B(m.last_price || 0).toString(), holders,
      });
    }
    return { markets, issues, holderRows, quoteReserve };
  };

  P.migSnapshot = async function (net = 'zero', { reason = 'manual', pause = true, force = false, rehearsal = false } = {}) {
    const prev = this.meta('mig_snapshot_' + net);
    if (rehearsal) pause = false;                // a rehearsal never freezes trading and never becomes the official file
    if (prev && !force && !rehearsal) return { ok: true, already: JSON.parse(prev) };
    let built, paid = 0;
    const ts = now();
    this.ctx.storage.transactionSync(() => {
      if (pause) this.setNetPaused(net, true);   // freeze first: no trade can land between settle and the dump
      paid = this.migSettleAll(net);
      built = this.migBuild(net);
    });
    const doc = {
      v: 2, network: net, chain: net === 'zero' ? { name: 'Zero by LayerZero', chainId: 33002 } : net === 'giwa' ? { name: 'GIWA by Upbit', chainId: this.netChainId('giwa') } : { name: net },
      takenAt: new Date(ts).toISOString(), reason, rule: 'every holder receives exactly this balance 1:1; burned tokens stay burned',
      units: 'all amounts in wei (18 decimals)', rewardsSettledBeforeSnapshot: paid,
      totals: { markets: built.markets.length, holderRows: built.holderRows, quoteReserveWei: built.quoteReserve.toString() },
      issues: built.issues, markets: built.markets,
    };
    const body = JSON.stringify(doc);
    const sha256 = hex(await crypto.subtle.digest('SHA-256', enc.encode(body)));
    const key = `rookery/migration/${rehearsal ? 'rehearsal-' : ''}${net}-snapshot-${new Date(ts).toISOString().replace(/[:.]/g, '-')}.json`;
    if (this.env.BACKUPS) await this.env.BACKUPS.put(key, body, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256 } });
    const metaRow = { key, sha256, ts, reason, markets: doc.totals.markets, holderRows: doc.totals.holderRows, quoteReserveWei: doc.totals.quoteReserveWei, issues: built.issues.length, paused: pause, bytes: body.length };
    if (rehearsal) this.setMeta('mig_snapshot_' + net + '_rehearsal', JSON.stringify(metaRow));
    else this.setMeta('mig_snapshot_' + net, JSON.stringify(metaRow));
    return { ok: true, ...metaRow, sample: built.markets.slice(0, 1).map(m => ({ ...m, holders: m.holders.slice(0, 3) })) };
  };

  P.migSnapshotDoc = async function (net = 'zero') {
    const meta = JSON.parse(this.meta('mig_snapshot_' + net) || 'null');
    if (!meta || !this.env.BACKUPS) return null;
    const obj = await this.env.BACKUPS.get(meta.key);
    return obj ? { meta, body: await obj.text() } : null;
  };

  // a user's own rows, to check against the published file
  P.migMine = async function (net, userId) {
    const d = await this.migSnapshotDoc(net);
    if (!d) return { taken: false };
    const doc = JSON.parse(d.body), me = 'u' + userId;
    const rows = [];
    for (const m of doc.markets) for (const h of m.holders) if (h.u === me) rows.push({ market: m.id, symbol: m.symbol, amount: h.amount });
    return { taken: true, you: me, sha256: d.meta.sha256, takenAt: doc.takenAt, rows };
  };

  // deploy the contracts (DEX if own, then the curve) BEFORE anything is paused: proves the chain really accepts our
  // deployments (allowlist), costs only gas, and changes nothing for users. Safe to call again: finished steps are skipped.
  P.netDeployFirst = async function (net, b = {}) {
    const url = this.netRpcUrl(net, b); if (!url) throw new Error('no rpc');
    const art = await this.env.BACKUPS.get('rookery/migration/zero_artifacts.json'); if (!art) throw new Error('artifacts missing in R2');
    const rpc = this.netRpcFn(net, { ...b, rpc: url }), Kk = this.netKeys(net);
    const vNative = this.meta(K(net) + '_vnative') || (net === 'zero' ? (3150n * WEI).toString() : (BigInt(Math.round(3150 * this.zroUsd() / this.ethUsd() * 1e9)) * 1_000_000_000n).toString());
    this.setMeta(K(net) + '_vnative', vNative);                         // the full run must use the very same constructor argument
    const io = { rpc, send: (role, tx) => this.netSend(net, rpc, role, { ...tx, waitTries: b.waitTries || 120 }),
      addr: { deployer: Kk.deployer.address, dex: Kk.dex.address, custody: Kk.custody.address, feeTo: Kk.custody.address },
      load: async () => JSON.parse(this.meta(K(net) + '_run') || 'null'), save: async (st) => this.setMeta(K(net) + '_run', JSON.stringify(st)), log: () => {} };
    return zeroRun(io, { dex: b.dex || 'own', snapshot: { v: 2, markets: [] }, artifacts: JSON.parse(await art.text()), creators: {}, chainId: this.netChainId(net), vNative, build: 'auto', deployOnly: true });
  };

  // can the whole migration be carried out right now? read-only; used before anything is paused
  P.migPreflight = async function (net, b = {}) {
    const c = cfg(net), problems = [], info = {};
    const rpc = this.netRpcFn(net, b), Kk = this.netKeys(net), A = this.netAddrs(net);
    const chainId = Number(BigInt(await rpc('eth_chainId', [])));
    if (c.chainId && chainId !== c.chainId) problems.push(`RPC answers chain id ${chainId}, expected ${c.chainId}`);
    const ms = this.sql.exec(`SELECT * FROM markets WHERE network=?`, net).toArray().filter(m => !m.migrated && !m.graduated);
    let need = 0n; for (const m of ms) need += requiredReserve(vQuote(m), B(m.reserve_tok)) + 1n;
    const rows = this.sql.exec(`SELECT COUNT(*) c FROM balances b JOIN markets m ON m.id = substr(b.asset, 3) WHERE b.asset LIKE 't:%' AND b.amount != '0' AND m.network = ?`, net).one().c;
    const [depBal, cusBal, depNonce, curveCode, gp] = await Promise.all([rpc('eth_getBalance', [Kk.deployer.address, 'latest']), rpc('eth_getBalance', [Kk.custody.address, 'latest']),
      rpc('eth_getTransactionCount', [Kk.deployer.address, 'latest']), rpc('eth_getCode', [A.curve, 'latest']), rpc('eth_gasPrice', []).catch(() => '0x0')]);
    const gasPrice = BigInt(gp) * 2n;
    const deployGas = gasPrice * (12_000_000n + 2_600_000n * BigInt(ms.length));          // contracts + one import per token, generous
    const distGas = gasPrice * 120_000n * BigInt(rows);
    info.markets = ms.length; info.holderRows = rows; info.reservesWei = need.toString(); info.deployGasWei = deployGas.toString(); info.distributionGasWei = distGas.toString();
    info.deployer = { address: Kk.deployer.address, balanceWei: BigInt(depBal).toString(), nonce: Number(BigInt(depNonce)) };
    info.custody = { address: Kk.custody.address, balanceWei: BigInt(cusBal).toString() };
    const f = (x) => (Number(x) / 1e18).toFixed(2);
    if (BigInt(depBal) < need + deployGas) problems.push(`deployer ${Kk.deployer.address} holds ${f(BigInt(depBal))} ${c.native}, needs ${f(need + deployGas)} (${f(need)} curve reserves + gas)`);
    if (BigInt(cusBal) < distGas) problems.push(`custody ${Kk.custody.address} holds ${f(BigInt(cusBal))} ${c.native} for gas, needs ${f(distGas)} to send ${rows} balances to holders`);
    const dexMode = JSON.parse(this.meta('mig_dex_' + net) || '"own"');
    if (dexMode === 'own') {
      const [dexBal, routerCode] = await Promise.all([rpc('eth_getBalance', [Kk.dex.address, 'latest']), rpc('eth_getCode', [getCreateAddress({ from: Kk.dex.address, nonce: 2 }), 'latest'])]);
      info.dex = { address: Kk.dex.address, balanceWei: BigInt(dexBal).toString() };
      if (routerCode === '0x' && BigInt(dexBal) < gasPrice * 9_000_000n) problems.push(`DEX deployer ${Kk.dex.address} holds ${f(BigInt(dexBal))} ${c.native}, needs ${f(gasPrice * 9_000_000n)} for gas to deploy the graduation DEX`);
    }
    if (net === 'zero') info.rpcKey = zeroKeyLoad(this);
    if (curveCode === '0x' && Number(BigInt(depNonce)) !== 0) problems.push(`deployer nonce is ${Number(BigInt(depNonce))}: the reserved addresses can no longer be met`);
    try { await rpc('eth_estimateGas', [{ from: Kk.deployer.address, data: '0x600a600c600039600a6000f3602a60005260206000f3' }]); }
    catch (e) { problems.push('the chain refuses a contract deployment from our deployer: ' + String(e.message || e).slice(0, 120)); }
    if (!(await this.env.BACKUPS?.get('rookery/migration/zero_artifacts.json'))) problems.push('contract artifacts are missing in storage');
    return { ok: problems.length === 0, network: net, chainId, problems, info };
  };

  // called by the Zero watcher when an RPC passes the identity check; needs two consecutive confirmations
  P.migOnZeroRpc = async function (url, block, st) {
    if (this.meta('mig_auto_zero') === '0') return null;
    if (this.meta('mig_snapshot_zero')) return null;
    st.migConfirm = (st.migConfirm || 0) + 1;
    if (st.migConfirm < 2) return { waiting: st.migConfirm };
    const chat = this.meta('tg_owner_chat');
    // nothing is paused unless the whole migration can actually be carried out right now
    const pf = await this.migPreflight('zero', { rpc: url, allowUnverified: true })   /* the watcher verified this URL a moment ago; its state is saved after this call */.catch(e => ({ ok: false, problems: ['preflight failed: ' + String(e.message || e).slice(0, 160)] }));
    if (!pf.ok) {
      if (chat && this.env.TG_BOT_TOKEN && Date.now() - Number(this.meta('mig_pf_alert') || 0) > 3 * 3600e3) {
        this.setMeta('mig_pf_alert', String(Date.now()));
        await this.tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
          text: `⚠️ <b>Zero RPC is live, migration NOT started</b>\nTrading stays open on the ledger until this is fixed:\n• ${pf.problems.join('\n• ')}\nRPC ${url} (block ${block})` }).catch(() => null);
      }
      return { preflight: pf };
    }
    // contracts first, while trading is still open: if Zero does not include our deployment (allowlist), nothing gets paused
    if (this.meta('mig_autorun_zero') !== '0') {
      if (Date.now() - Number(this.meta('mig_deploy_try') || 0) < 20 * 60e3) return { waiting: 'deploy retry window' };
      this.setMeta('mig_deploy_try', String(Date.now()));
      try { await this.netDeployFirst('zero', { rpc: url, allowUnverified: true, dex: JSON.parse(this.meta('mig_dex_zero') || '"own"'), waitTries: st.deployWaitTries }); this.setMeta('mig_deploy_try', '0'); }
      catch (e) {
        const why = String(e.message || e).slice(0, 260);
        if (chat && this.env.TG_BOT_TOKEN) await this.tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
          text: `⚠️ <b>Zero: contract deployment did not go through, migration NOT started</b>\nTrading stays open on the ledger. Most likely our deployer is not on LayerZero's contract-creation allowlist yet.\n<code>${why.replace(/[<>&]/g, '')}</code>\nNext try in 20 min.` }).catch(() => null);
        return { deployFailed: why };
      }
    }
    const r = await this.migSnapshot('zero', { reason: `Zero RPC verified live: ${url} block ${block}`, pause: true });
    if (this.meta('mig_autorun_zero') !== '0' && !r.issues) {
      try { r.run = await this.netMigrate('zero', { rpc: url, allowUnverified: true, dex: JSON.parse(this.meta('mig_dex_zero') || '"own"'), chainId: 33002 }); } catch (e) { r.runError = String(e.message || e).slice(0, 200); }
    }
    if (chat && this.env.TG_BOT_TOKEN) {
      await this.tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `🧊 <b>Zero trading paused · 1:1 snapshot taken</b>\nRPC ${url} verified (block ${block}).\n${r.markets} markets · ${r.holderRows} holder rows · ${(Number(B(r.quoteReserveWei)) / 1e18).toFixed(2)} ZRO in reserves\nsha256 <code>${r.sha256}</code>${r.issues ? `\n⚠️ ${r.issues} issue(s) flagged, check /admin/migration` : ''}` }).catch(() => null);
    }
    return r;
  };
}
