// 1:1 distribution after a network migration: every holder who confirmed a destination wallet receives exactly the
// balance the ledger holds for them, token by token, from the network's custody address. Holders without a confirmed
// wallet keep their balance reserved in custody and receive it the moment they link one.
//
// Safety rules:
//  · the ledger is debited in the same storage transaction that queues the transfer, so a token can never be both
//    sent on-chain and still spendable on the ledger;
//  · the transaction hash AND its nonce are stored before the transaction is broadcast; a retry always reuses the
//    same nonce, so at most one of the attempts can ever be mined (no double send after a crash);
//  · contract recipients are refused before bonding (the token itself rejects them): they stay reserved;
//  · proof: for every token  sent + in flight + reserved == holders' total in the official snapshot, to the wei.
import { Wallet, Interface, Transaction, getAddress } from 'ethers';

const ERC20 = new Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const hx = (n) => '0x' + BigInt(n).toString(16);

export function installZeroDist(Cls, H) {
  const { B, now } = H;
  const P = Cls.prototype;
  const K = (net) => (net === 'zero' ? 'zero' : net);

  P.distInit = function () {
    if (this._distInit) return; this._distInit = true;
    this.zwdInit();
    for (const c of ["kind TEXT DEFAULT 'wd'", 'nonce INTEGER', "txid_alt TEXT DEFAULT ''"]) { try { this.sql.exec(`ALTER TABLE zero_wd ADD COLUMN ${c}`); } catch { /* exists */ } }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS zero_dist_skip (net TEXT, market TEXT, user_id INTEGER, reason TEXT, ts INTEGER, PRIMARY KEY (net, market, user_id))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS zero_wd_dist ON zero_wd (net, kind, status)`);
  };
  // confirmed destination wallets (signed by the wallet itself, one per profile)
  P.distRecipients = function () {
    try { return new Map(this.sql.exec('SELECT uid, addr FROM zero_recipient_v1').toArray().map(r => [r.uid, r.addr])); } catch { return new Map(); }
  };

  // queue every holder with a confirmed wallet for exactly their ledger balance
  P.distEnqueue = async function (net, { max = 2000 } = {}) {
    this.distInit();
    if (!this.meta(K(net) + '_finalized')) throw new Error('migration is not finalized on ' + net);
    const rec = this.distRecipients();
    const rpc = this.netRpcFn(net);
    const rows = this.sql.exec(`SELECT b.user_id, b.amount, m.id market, m.zero_token token, m.symbol FROM balances b JOIN markets m ON m.id = substr(b.asset, 3)
      WHERE b.asset LIKE 't:%' AND b.amount != '0' AND m.network = ? AND m.migrated = 1 AND m.zero_token IS NOT NULL ORDER BY m.id, b.user_id`, net).toArray();
    const skip = new Set(this.sql.exec('SELECT market, user_id FROM zero_dist_skip WHERE net=?', net).toArray().map(r => r.market + '|' + r.user_id));
    const codeOf = new Map();
    const out = { queued: 0, noWallet: 0, contract: 0, skipped: 0 };
    for (const r of rows) {
      if (out.queued >= max) break;
      const to = rec.get(r.user_id);
      if (!to) { out.noWallet++; continue; }
      if (skip.has(r.market + '|' + r.user_id)) { out.skipped++; continue; }
      if (!codeOf.has(to)) codeOf.set(to, String(await rpc('eth_getCode', [to, 'latest']) || '0x').toLowerCase());
      const code = codeOf.get(to);
      if (code !== '0x' && !code.startsWith('0xef0100')) {            // the token refuses contracts before bonding
        this.sql.exec('INSERT OR REPLACE INTO zero_dist_skip VALUES (?,?,?,?,?)', net, r.market, r.user_id, 'destination is a contract: tokens stay reserved', now());
        out.contract++; continue;
      }
      const amt = B(r.amount); if (amt <= 0n) continue;
      this.ctx.storage.transactionSync(() => {
        this.addBal(r.user_id, 't:' + r.market, -amt);
        const tr = this.sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,note,ts,asset) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
          r.user_id, 'withdrawal', net, amt.toString(), to, 'pending', `$${r.symbol} migrated 1:1 to your wallet`, now(), 't:' + r.market).one().id;
        this.sql.exec(`INSERT INTO zero_wd (user_id,market,token,to_addr,amount,status,transfer_id,created,updated,net,kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          r.user_id, r.market, r.token, getAddress(to), amt.toString(), 'pending', tr, now(), now(), net, 'dist');
      });
      out.queued++;
    }
    return out;
  };

  // pipelined sender: sign a batch with consecutive nonces, store hash + nonce, broadcast, then settle receipts
  P.distDrain = async function (net, { batch = 20, rounds = 40, crashAfterStore = false } = {}) {
    this.distInit();
    if (this._distBusy) return { busy: true }; this._distBusy = true;
    const res = { sent: 0, failed: 0, resent: 0, review: 0, rounds: 0 };
    try {
      const rpc = this.netRpcFn(net);
      const w = new Wallet(this.netKeys(net).custody.privateKey);
      const chainId = Number(BigInt(await rpc('eth_chainId', [])));
      const want = this.netChainId(net);
      if (want && chainId !== want) throw new Error(`${net}: rpc answers chain id ${chainId}, expected ${want}`);
      const fees = async () => {
        const blk = await rpc('eth_getBlockByNumber', ['latest', false]);
        if (blk?.baseFeePerGas) { let tip = 0n; try { tip = BigInt(await rpc('eth_maxPriorityFeePerGas', [])); } catch { /* no tip market */ }
          return { type: 2, maxPriorityFeePerGas: tip, maxFeePerGas: BigInt(blk.baseFeePerGas) * 2n + tip }; }
        return { type: 0, gasPrice: BigInt(await rpc('eth_gasPrice', [])) };
      };
      const sign = async (row, nonce, fee, gasLimit) => {
        const raw = await w.signTransaction({ chainId, nonce, to: row.token, data: ERC20.encodeFunctionData('transfer', [row.to_addr, B(row.amount)]), value: 0n, gasLimit, ...fee });
        return { raw, hash: Transaction.from(raw).hash };
      };
      const settle = (row, rc) => {
        this.zeroWdSettle({ ...row, txid: rc.transactionHash }, rc);
        if (Number(rc.status) === 1) res.sent++;
        else { res.failed++; this.sql.exec('INSERT OR REPLACE INTO zero_dist_skip VALUES (?,?,?,?,?)', net, row.market, row.user_id, 'transfer reverted on-chain: reserved for review', now()); }
      };
      for (let round = 0; round < rounds; round++) {
        res.rounds++;
        // 1 · anything already signed: look it up; if it never reached the chain, send again with the SAME nonce
        const open = this.sql.exec(`SELECT * FROM zero_wd WHERE net=? AND kind='dist' AND status='sending' ORDER BY nonce, id`, net).toArray();
        let waiting = 0;
        if (open.length) {
          const latest = Number(BigInt(await rpc('eth_getTransactionCount', [w.address, 'latest'])));
          for (const row of open) {
            let rc = row.txid ? await rpc('eth_getTransactionReceipt', [row.txid]).catch(() => null) : null;
            if (!rc && row.txid_alt) rc = await rpc('eth_getTransactionReceipt', [row.txid_alt]).catch(() => null);
            if (rc) { settle(row, rc); continue; }
            if (row.nonce == null) { this.sql.exec(`UPDATE zero_wd SET status='pending', txid='', updated=? WHERE id=?`, now(), row.id); continue; }   // never signed
            if (latest > row.nonce) { this.sql.exec(`UPDATE zero_wd SET status='review', err=?, updated=? WHERE id=?`, 'nonce used but no receipt for the stored hash', now(), row.id); res.review++; continue; }
            const known = row.txid ? await rpc('eth_getTransactionByHash', [row.txid]).catch(() => null) : null;
            if (known) { waiting++; continue; }                                   // in the mempool: wait
            if (latest === row.nonce) {                                          // next in line and unknown to the node: same nonce again
              const fee = await fees(), s = await sign(row, row.nonce, fee, 400000n);
              this.sql.exec(`UPDATE zero_wd SET txid=?, txid_alt=?, updated=? WHERE id=?`, s.hash, row.txid || '', now(), row.id);
              await rpc('eth_sendRawTransaction', [s.raw]).catch(() => null);
              res.resent++;
            }
            waiting++;
          }
        }
        if (waiting) { await new Promise(r => setTimeout(r, 400)); continue; }
        // 2 · next batch
        const rows = this.sql.exec(`SELECT * FROM zero_wd WHERE net=? AND kind='dist' AND status='pending' ORDER BY id LIMIT ?`, net, batch).toArray();
        if (!rows.length) break;
        const nonce0 = Number(BigInt(await rpc('eth_getTransactionCount', [w.address, 'pending'])));
        const fee = await fees();
        let gasLimit = 400000n;
        try { gasLimit = (BigInt(await rpc('eth_estimateGas', [{ from: w.address, to: rows[0].token, data: ERC20.encodeFunctionData('transfer', [rows[0].to_addr, B(rows[0].amount)]) }])) * 2n) + 80000n; } catch { /* keep the default */ }
        const signed = [];
        for (let i = 0; i < rows.length; i++) signed.push(await sign(rows[i], nonce0 + i, fee, gasLimit));
        this.ctx.storage.transactionSync(() => {
          rows.forEach((row, i) => this.sql.exec(`UPDATE zero_wd SET status='sending', txid=?, nonce=?, updated=? WHERE id=?`, signed[i].hash, nonce0 + i, now(), row.id));
        });
        if (crashAfterStore) return { ...res, crashed: true };                    // test hook: die between "stored" and "broadcast"
        for (let i = 0; i < rows.length; i++) {
          try { await rpc('eth_sendRawTransaction', [signed[i].raw]); }
          catch (e) { if (!/known|already/i.test(String(e.message))) break; }     // the rest keeps its nonce and is re-sent in step 1
        }
      }
    } finally { this._distBusy = false; }
    res.left = this.sql.exec(`SELECT COUNT(*) c FROM zero_wd WHERE net=? AND kind='dist' AND status IN ('pending','sending')`, net).one().c;
    return res;
  };

  // proof for every token: sent + in flight + reserved == the holders' total of the official snapshot
  P.distReport = async function (net, { chain = false } = {}) {
    this.distInit();
    const doc = await this.migSnapshotDoc(net);
    const snap = doc ? JSON.parse(doc.body) : null;
    const run = JSON.parse(this.meta(K(net) + '_run') || 'null');
    const rec = this.distRecipients();
    let rpc = null; if (chain) { try { rpc = this.netRpcFn(net); } catch { /* no RPC yet */ } }
    const custody = this.netKeys(net).custody.address;
    const tokens = []; let allOk = !!snap;
    const sum = (q, ...a) => B(this.sql.exec(q, ...a).toArray().reduce((x, r) => x + B(r.amount), 0n));
    for (const m of snap?.markets || []) {
      const row = this.sql.exec('SELECT migrated, zero_token, symbol, name FROM markets WHERE id=?', m.id).toArray()[0];
      const snapHeld = B(m.heldByUsers);
      const sent = sum(`SELECT amount FROM zero_wd WHERE net=? AND market=? AND status='sent'`, net, m.id);
      const inflight = sum(`SELECT amount FROM zero_wd WHERE net=? AND market=? AND status IN ('pending','sending','review')`, net, m.id);
      const reserved = sum(`SELECT amount FROM balances WHERE asset=?`, 't:' + m.id);
      const holders = m.holders.length;
      const linked = m.holders.filter(h => rec.has(Number(h.u.slice(1)))).length;
      const t = { id: m.id, symbol: m.symbol, name: m.name, token: row?.zero_token || null, migrated: !!row?.migrated, importTx: run?.imports?.[m.id]?.tx || null,
        holders, holdersLinked: linked, snapshotWei: snapHeld.toString(), sentWei: sent.toString(), inFlightWei: inflight.toString(), reservedWei: reserved.toString(),
        ok: row?.migrated ? sent + inflight + reserved === snapHeld : null };
      if (rpc && row?.zero_token) {
        try {
          const [cb, ts] = await Promise.all([rpc('eth_call', [{ to: row.zero_token, data: ERC20.encodeFunctionData('balanceOf', [custody]) }, 'latest']), rpc('eth_call', [{ to: row.zero_token, data: ERC20.encodeFunctionData('totalSupply', []) }, 'latest'])]);
          t.custodyWei = BigInt(cb).toString(); t.totalSupplyWei = BigInt(ts).toString();
          t.custodyCovers = BigInt(cb) >= reserved + inflight;                    // custody may hold more: rewards accrued after the import
          t.supplyOk = BigInt(ts) === B(m.supply) - B(m.burned);
        } catch (e) { t.chainError = String(e.message || e).slice(0, 80); }
      }
      if (t.ok === false || t.custodyCovers === false || t.supplyOk === false) allOk = false;
      if (t.ok === null) allOk = false;
      tokens.push(t);
    }
    const zs = net === 'zero' ? (this.zwState?.() || {}) : {};
    const explorer = net === 'zero' ? (Object.entries(zs.explorers || {}).find(([, v]) => v.up)?.[0] || null) : (this.meta(net + '_explorer') || null);
    const addrs = (() => { try { return this.netAddrs(net); } catch { return null; } })();
    return { network: net, snapshot: doc ? { sha256: doc.meta.sha256, takenAt: snap.takenAt, markets: snap.markets.length } : null,
      finalized: JSON.parse(this.meta(K(net) + '_finalized') || 'null'), contracts: { curve: addrs?.curve || null, factory: addrs?.factory || null, custody, deployTx: run?.steps || {} },
      explorer, allOk, tokens, totals: { tokens: tokens.length, migrated: tokens.filter(t => t.migrated).length, holderRows: tokens.reduce((a, t) => a + t.holders, 0),
        linkedRows: tokens.reduce((a, t) => a + t.holdersLinked, 0), sentRows: this.sql.exec(`SELECT COUNT(*) c FROM zero_wd WHERE net=? AND kind='dist' AND status='sent'`, net).one().c,
        queuedRows: this.sql.exec(`SELECT COUNT(*) c FROM zero_wd WHERE net=? AND kind='dist' AND status IN ('pending','sending')`, net).one().c,
        reviewRows: this.sql.exec(`SELECT COUNT(*) c FROM zero_wd WHERE net=? AND status='review'`, net).one().c } };
  };

  // one profile: what the snapshot says, what was sent (with the transaction) and what is still reserved
  P.distMine = async function (net, userId) {
    this.distInit();
    const doc = await this.migSnapshotDoc(net);
    const snap = doc ? JSON.parse(doc.body) : null, me = 'u' + userId;
    const to = this.distRecipients().get(userId) || null;
    const rows = [];
    for (const m of snap?.markets || []) {
      const h = m.holders.find(x => x.u === me); if (!h) continue;
      const mk = this.sql.exec('SELECT zero_token, migrated FROM markets WHERE id=?', m.id).toArray()[0];
      const tx = this.sql.exec(`SELECT amount, status, txid, to_addr, kind FROM zero_wd WHERE net=? AND market=? AND user_id=? ORDER BY id`, net, m.id, userId).toArray();
      const reserved = B(this.sql.exec('SELECT amount FROM balances WHERE user_id=? AND asset=?', userId, 't:' + m.id).toArray()[0]?.amount);
      const why = this.sql.exec('SELECT reason FROM zero_dist_skip WHERE net=? AND market=? AND user_id=?', net, m.id, userId).toArray()[0]?.reason || null;
      rows.push({ market: m.id, symbol: m.symbol, token: mk?.zero_token || null, migrated: !!mk?.migrated, snapshotWei: h.amount, reservedWei: reserved.toString(), note: why,
        transfers: tx.map(x => ({ amountWei: x.amount, status: x.status, tx: x.txid || null, to: x.to_addr, auto: x.kind === 'dist' })) });
    }
    const zs = net === 'zero' ? (this.zwState?.() || {}) : {};
    return { network: net, taken: !!snap, you: me, destination: to, sha256: doc?.meta?.sha256 || null, rows,
      explorer: net === 'zero' ? (Object.entries(zs.explorers || {}).find(([, v]) => v.up)?.[0] || null) : (this.meta(net + '_explorer') || null) };
  };

  // background step (cron): queue newly linked wallets and keep sending until nothing is left
  P.distTick = async function (net = 'zero') {
    if (!this.meta(K(net) + '_finalized')) return { off: true };
    let rpcOk = true; try { this.netRpcFn(net); } catch { rpcOk = false; }
    if (!rpcOk) return { off: 'no rpc' };
    const q = await this.distEnqueue(net, { max: 400 });
    const d = await this.distDrain(net, { batch: 20, rounds: 25 });
    return { queued: q, drain: d };
  };
}
