// Zero mainnet migration, step 1: freeze one pre-market network and publish the 1:1 balance snapshot.
// Variant B (owner decision 2026-11-22): every curve moves to an on-chain RookeryCurve on Zero with exactly this
// state; holders stay custodial on Rookery and withdraw to their own Zero wallet (as the Docs promise).
// The snapshot is taken once the Zero RPC is verified live (chain id 33002 + LayerZero endpoint code + moving blocks).
import { getCreateAddress, getCreate2Address, keccak256, toUtf8Bytes, Wallet, Interface, getAddress, zeroPadValue, JsonRpcProvider } from 'ethers';
import { zeroRun } from './zerorun.js';
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

  P.zeroAddrs = function () {
    if (this._zeroAddrs) return this._zeroAddrs;
    const deployer = this.master().deriveChild(ZERO_DEPLOYER_INDEX).address;
    const curve = getCreateAddress({ from: deployer, nonce: 0 });
    const factory = getCreateAddress({ from: curve, nonce: 1 });
    const a = { deployer, curve, factory, stubHash: ZERO_STUB_HASH, chainId: 33002 };
    // pin the first computation: if derivation or constants ever change, refuse to show different addresses
    const pinned = this.meta('zero_addrs_v2');            // v2 = standard CREATE3 proxy (v1 used a compiler-dependent stub)
    if (!pinned) this.setMeta('zero_addrs_v2', JSON.stringify(a));
    else { const p = JSON.parse(pinned); if (p.curve !== a.curve || p.factory !== a.factory || p.stubHash !== a.stubHash) throw new Error('reserved Zero addresses changed: refusing'); }
    this._zeroAddrs = a; this._zeroTok = new Map();
    return a;
  };
  P.zeroTokenAddr = function (id) {
    const a = this.zeroAddrs();
    let t = this._zeroTok.get(id);
    if (!t) {
      const stub = getCreate2Address(a.factory, keccak256(toUtf8Bytes(String(id))), ZERO_STUB_HASH);
      t = getCreateAddress({ from: stub, nonce: 1 });
      this._zeroTok.set(id, t);
    }
    return t;
  };

  P.zeroKeys = function () {
    const m = this.master();
    return { deployer: m.deriveChild(ZERO_DEPLOYER_INDEX), dex: m.deriveChild(ZERO_DEX_INDEX), custody: m.deriveChild(ZERO_CUSTODY_INDEX) };
  };

  // signed transaction on Zero through any verified RPC; EIP-1559 when the chain has a base fee, legacy otherwise
  P.zeroSend = async function (rpc, role, tx, onHash) {
    const k = this.zeroKeys()[role];
    if (!k) throw new Error('unknown signer ' + role);
    const w = new Wallet(k.privateKey);
    const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [w.address, 'pending'])));
    const base = { chainId: 33002, nonce, to: tx.to || null, data: tx.data || '0x', value: tx.value || 0n };
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
    for (let i = 0; i < 240; i++) {
      const rc = await rpc('eth_getTransactionReceipt', [hash]);
      if (rc) return rc;
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('no receipt for ' + hash);
  };

  P.zeroRpcUrl = function (b = {}) {
    const st = this.zwState?.() || {};
    const live = Object.entries(st.rpc || {}).filter(([, v]) => v.live).map(([u]) => u);
    if (b.rpc && !live.includes(b.rpc) && !b.allowUnverified) throw new Error('rpc is not a verified Zero RPC (watcher)');
    return b.rpc || live[0] || null;
  };

  // run (or dry-run) the 1:1 migration in the background; state persists after every transaction
  P.zeroMigrate = async function (b = {}) {
    const url = this.zeroRpcUrl(b);
    if (!url) throw new Error('no verified Zero RPC yet');
    const snapMeta = JSON.parse(this.meta('mig_snapshot_zero') || 'null');
    if (!snapMeta) throw new Error('no official snapshot yet (it is taken when the Zero RPC is verified)');
    if (!this.netPaused('zero')) throw new Error('Zero trading must be paused');
    const obj = await this.env.BACKUPS.get(snapMeta.key);
    const snapshot = JSON.parse(await obj.text());
    const art = await this.env.BACKUPS.get('rookery/migration/zero_artifacts.json');
    if (!art) throw new Error('artifacts missing in R2');
    const artifacts = JSON.parse(await art.text());
    const creators = Object.fromEntries(this.sql.exec(`SELECT DISTINCT u.id, u.wallet FROM markets m JOIN users u ON u.id=m.creator_id WHERE m.network='zero'`).toArray()
      .map(r => ['u' + r.id, r.wallet && /^0x[0-9a-fA-F]{40}$/.test(r.wallet) ? r.wallet : null]));
    const rpc = async (method, params) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      return j.result;
    };
    const K = this.zeroKeys();
    const io = {
      rpc, send: (role, tx) => this.zeroSend(rpc, role, tx),
      addr: { deployer: K.deployer.address, dex: K.dex.address, custody: K.custody.address, feeTo: K.custody.address },
      load: async () => JSON.parse(this.meta('zero_run') || 'null'), save: async (s) => this.setMeta('zero_run', JSON.stringify(s)),
      log: () => {},
    };
    const plan = { snapshot, artifacts, creators, chainId: Number(b.chainId || 33002), vNative: (3150n * WEI).toString(), build: b.build || 'auto', dryRun: !!b.dryRun, recheck: !!b.recheck };
    if (plan.dryRun) return zeroRun(io, plan);
    if (this._zeroRunning) return { running: true };
    this._zeroRunning = true;
    this.setMeta('zero_run_status', JSON.stringify({ started: now(), rpc: url, state: 'running' }));
    const job = zeroRun(io, plan).then(r => {
      if (!r.checks?.failed) { try { r.finalized = this.zeroFinalize(); } catch (e) { r.finalizeError = String(e.message || e); } }
      this.setMeta('zero_run_status', JSON.stringify({ started: JSON.parse(this.meta('zero_run_status')).started, finished: now(), state: r.checks?.failed ? 'checks-failed' : 'done', report: { ...r, state: undefined } }));
      return r;
    }).catch(e => this.setMeta('zero_run_status', JSON.stringify({ state: 'error', error: String(e.message || e).slice(0, 400), at: now() })))
      .finally(() => { this._zeroRunning = false; });
    this.ctx.waitUntil(job);
    return { started: true, rpc: url };
  };

  // ───── after a successful run: the ledger now points at the chain
  P.zeroFinalize = function (opts = {}) {
    const run = JSON.parse(this.meta('zero_run') || 'null');
    if (!run?.finished && !opts.force) throw new Error('migration not finished with all checks passing');
    if (this.meta('zero_finalized') && !opts.force) return { already: JSON.parse(this.meta('zero_finalized')) };
    try { this.sql.exec('ALTER TABLE markets ADD COLUMN zero_token TEXT'); } catch { /* exists */ }
    let moved = 0n, n = 0;
    this.ctx.storage.transactionSync(() => {
      for (const [id, imp] of Object.entries(run.imports || {})) {
        const m = this.sql.exec('SELECT * FROM markets WHERE id=?', id).toArray()[0];
        if (!m || m.network !== 'zero' || m.migrated) continue;
        moved += B(m.reserve_zro);
        this.sql.exec('UPDATE markets SET migrated=1, zero_token=? WHERE id=?', imp.token, id);
        n++;
      }
      // the curve reserves left our books for the on-chain curves: same amount out of "held" and out of "inflow"
      this.setMeta('migrated_zro_reserve', (B(this.meta('migrated_zro_reserve')) + moved).toString());
      this.setMeta('zero_onchain_reserve', (B(this.meta('zero_onchain_reserve')) + moved).toString());
    });
    const fin = { ts: now(), markets: n, reserveWei: moved.toString() };
    this.setMeta('zero_finalized', JSON.stringify(fin));
    return fin;
  };

  // ───── withdrawals of migrated tokens from custody to the user's own Zero wallet
  P.zwdInit = function () {
    if (this._zwdInit) return; this._zwdInit = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS zero_wd (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market TEXT, token TEXT, to_addr TEXT,
      amount TEXT, status TEXT, txid TEXT DEFAULT '', err TEXT DEFAULT '', transfer_id INTEGER, created INTEGER, updated INTEGER)`);
  };
  P.zeroRpcFn = function () {
    const url = this.zeroRpcUrl();
    if (!url) throw new Error('Zero RPC is not available yet');
    return async (method, params) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message || 'rpc error'); return j.result;
    };
  };
  P.zeroWithdraw = async function (user, b) {
    this.zwdInit();
    const m = this.sql.exec('SELECT * FROM markets WHERE id=?', String(b.market || '')).toArray()[0];
    if (!m || m.network !== 'zero') throw new Error('Unknown Zero token');
    if (!m.migrated || !m.zero_token) throw new Error('This token is not on Zero yet: withdrawals open right after the migration');
    let to; try { to = getAddress(String(b.to || '').trim()); } catch { throw new Error('Enter a valid 0x… address'); }
    const amt = B(b.amount);
    if (amt <= 0n) throw new Error('Enter an amount');
    // tokens refuse contract recipients until the curve graduates (EIP-7702 wallets are fine)
    const code = await this.zeroRpcFn()('eth_getCode', [to, 'latest']);
    if (code && code !== '0x' && !String(code).toLowerCase().startsWith('0xef0100')) throw new Error('Send to a regular wallet address: this token does not accept contract addresses before it bonds');
    let id;
    this.ctx.storage.transactionSync(() => {
      this.addBal(user.id, 't:' + m.id, -amt);
      const tr = this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        user.id, 'withdrawal', 'zero', amt.toString(), to, 'pending', `$${m.symbol} to Zero`, now(), 't:' + m.id).one().id;
      id = this.sql.exec(`INSERT INTO zero_wd (user_id,market,token,to_addr,amount,status,transfer_id,created,updated) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
        user.id, m.id, m.zero_token, to, amt.toString(), 'pending', tr, now(), now()).one().id;
    });
    this.ctx.waitUntil(this.zeroWdTick().catch(() => {}));
    return { ok: true, id, status: 'pending', to, amount: amt.toString(), token: m.zero_token };
  };
  // one at a time (custody nonce); the hash is stored BEFORE waiting, so a crash never leads to a second send
  P.zeroWdTick = async function (max = 5) {
    this.zwdInit();
    if (this._zwdBusy) return { busy: true }; this._zwdBusy = true;
    const done = [];
    try {
      const rpc = this.zeroRpcFn();
      for (const w of this.sql.exec(`SELECT * FROM zero_wd WHERE status IN ('pending','sending') ORDER BY id LIMIT ?`, max).toArray()) {
        if (w.status === 'sending' && w.txid) {           // resume: only look the transaction up
          const rc = await rpc('eth_getTransactionReceipt', [w.txid]).catch(() => null);
          if (!rc) { if (now() - w.updated > 30 * 60e3) this.zeroWdFail(w, 'not mined after 30 min, check custody nonce'); continue; }
          this.zeroWdSettle(w, rc); done.push(w.id); continue;
        }
        this.sql.exec(`UPDATE zero_wd SET status='sending', updated=? WHERE id=?`, now(), w.id);
        try {
          const rc = await this.zeroSend(rpc, 'custody', { to: w.token, data: ERC20T.encodeFunctionData('transfer', [w.to_addr, B(w.amount)]) },
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
    } else this.zeroWdFail({ ...w, txid: rc.transactionHash }, 'reverted on Zero');
  };
  P.zeroWdFail = function (w, why) {
    this.ctx.storage.transactionSync(() => {
      this.addBal(w.user_id, 't:' + w.market, B(w.amount));
      this.sql.exec(`UPDATE zero_wd SET status='refunded', err=?, updated=? WHERE id=?`, String(why).slice(0, 200), now(), w.id);
      this.sql.exec(`UPDATE transfers SET status='failed', note=? WHERE id=?`, 'refunded: ' + String(why).slice(0, 120), w.transfer_id);
    });
  };

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
      v: 2, network: net, chain: net === 'zero' ? { name: 'Zero by LayerZero', chainId: 33002 } : { name: net },
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

  // called by the Zero watcher when an RPC passes the identity check; needs two consecutive confirmations
  P.migOnZeroRpc = async function (url, block, st) {
    if (this.meta('mig_auto_zero') === '0') return null;
    if (this.meta('mig_snapshot_zero')) return null;
    st.migConfirm = (st.migConfirm || 0) + 1;
    if (st.migConfirm < 2) return { waiting: st.migConfirm };
    const r = await this.migSnapshot('zero', { reason: `Zero RPC verified live: ${url} block ${block}`, pause: true });
    const chat = this.meta('tg_owner_chat');
    if (chat && this.env.TG_BOT_TOKEN) {
      await this.tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `🧊 <b>Zero trading paused · 1:1 snapshot taken</b>\nRPC ${url} verified (block ${block}).\n${r.markets} markets · ${r.holderRows} holder rows · ${(Number(B(r.quoteReserveWei)) / 1e18).toFixed(2)} ZRO in reserves\nsha256 <code>${r.sha256}</code>${r.issues ? `\n⚠️ ${r.issues} issue(s) flagged, check /admin/migration` : ''}` }).catch(() => null);
    }
    return r;
  };
}
