// Full distribution rehearsal on a copy of the live ledger (pseudonymous snapshot), local chain id 33002, the worker's own code:
// migrate -> finalize -> queue every linked holder -> send (with a simulated crash) -> verify EVERY balance on-chain ->
// late wallet link -> holders trade on the on-chain curve from their own wallets.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HDNodeWallet, Wallet, Interface } from 'ethers';
import { installZeroMig } from '../worker/zeromig.js';
import { installZeroDist } from '../worker/zerodist.js';

const NET = 'zero', CHAIN = 33002, PORT = 8630, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--chain-id', String(CHAIN), '--port', String(PORT), '--silent', '--gas-limit', '60000000'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rpc = async (m, p = []) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId'); break; } catch { await sleep(250); } }

const WEI = 10n ** 18n, B = (x) => BigInt(x || 0);
const db = new DatabaseSync(':memory:');
const sql = { exec: (q, ...a) => { const st = db.prepare(q); const isRead = /^\s*(SELECT|PRAGMA)|RETURNING/i.test(q); const rows = isRead ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows, one: () => rows[0] }; } };
db.exec(`CREATE TABLE markets (id TEXT PRIMARY KEY, network TEXT, symbol TEXT, name TEXT, reserve_zro TEXT, migrated INTEGER DEFAULT 0, creator_id INTEGER, v_wei TEXT, reserve_tok TEXT, graduated INTEGER DEFAULT 0);
  CREATE TABLE balances (user_id INTEGER, asset TEXT, amount TEXT, PRIMARY KEY (user_id, asset));
  CREATE TABLE users (id INTEGER PRIMARY KEY, wallet TEXT);
  CREATE TABLE zero_recipient_v1(uid INTEGER PRIMARY KEY, addr TEXT UNIQUE NOT NULL, confirmed INTEGER NOT NULL, message TEXT NOT NULL, signature TEXT NOT NULL);
  CREATE TABLE transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, kind TEXT, chain TEXT, amount TEXT, txid TEXT DEFAULT '', to_addr TEXT DEFAULT '', status TEXT, note TEXT DEFAULT '', ts INTEGER, asset TEXT);`);
const SNAPF = process.env.SNAP || '.rehearsal/snapshot.json';
const body = readFileSync(SNAPF, 'utf8'), snap = JSON.parse(body);
const users = new Set();
for (const m of snap.markets) {
  db.prepare('INSERT INTO markets (id,network,symbol,name,reserve_zro,creator_id,v_wei,reserve_tok) VALUES (?,?,?,?,?,?,?,?)').run(m.id, NET, m.symbol, m.name || m.symbol, m.curve.quoteReserve, Number(m.creator.slice(1)), m.curve.virtualQuote, m.curve.tokensSold);
  db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(Number(m.creator.slice(1)));
  for (const h of m.holders) { users.add(Number(h.u.slice(1))); db.prepare('INSERT OR REPLACE INTO balances VALUES (?,?,?)').run(Number(h.u.slice(1)), 't:' + m.id, h.amount); }
}
// who links a wallet: ~70% regular wallets, 3 contract addresses, the rest nothing (deterministic by id)
const ids = [...users].sort((a, b) => a - b), wallets = new Map(), contracts = new Set(), unlinked = [];
ids.forEach((u, i) => {
  if (i % 10 < 7) { const w = Wallet.createRandom(); wallets.set(u, w); db.prepare('INSERT INTO zero_recipient_v1 VALUES (?,?,?,?,?)').run(u, w.address, Date.now(), 'rehearsal', '0x'); }
  else if (contracts.size < 3) { const w = Wallet.createRandom(); contracts.add(u); wallets.set(u, w); db.prepare('INSERT INTO zero_recipient_v1 VALUES (?,?,?,?,?)').run(u, w.address, Date.now(), 'rehearsal', '0x'); }
  else unlinked.push(u);
});
for (const u of contracts) await rpc('anvil_setCode', [wallets.get(u).address, '0x6080604052600080fd']);

const meta = new Map(), r2 = new Map(), jobs = [];
const root = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, 'm');
class Books {
  constructor() { this.sql = sql; this.env = { BACKUPS: { get: async (k) => r2.has(k) ? { text: async () => r2.get(k) } : null } }; this.ctx = { waitUntil: (p) => jobs.push(p), storage: { transactionSync: (f) => { db.exec('BEGIN'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } } }; }
  meta(k) { return meta.get(k) || ''; } setMeta(k, v) { meta.set(k, v); } master() { return root; }
  netPaused(n) { return meta.get('net_paused_' + n) === '1'; }
  async migSnapshot(net) { meta.set('mig_snapshot_' + net, JSON.stringify({ key: 'snap.json', sha256: createHash('sha256').update(body).digest('hex') })); meta.set('net_paused_' + net, '1'); return { markets: snap.markets.length, issues: 0 }; }
  zwState() { return { rpc: { [RPC]: { live: true } }, explorers: {} }; }
  bal(u, a) { return B(sql.exec('SELECT amount FROM balances WHERE user_id=? AND asset=?', u, a).toArray()[0]?.amount); }
  addBal(u, a, d) { const v = this.bal(u, a) + d; if (v < 0n) throw new Error('Insufficient token balance'); sql.exec('INSERT INTO balances (user_id,asset,amount) VALUES (?,?,?) ON CONFLICT(user_id,asset) DO UPDATE SET amount=excluded.amount', u, a, v.toString()); return v; }
}
const harness = { netPaused: Books.prototype.netPaused, migSnapshot: Books.prototype.migSnapshot };
installZeroMig(Books, { B, WEI, now: () => Date.now(), vQuote: (m) => B(m.v_wei) });
for (const k of ['netPaused', 'migSnapshot']) Books.prototype[k] = harness[k];   // the harness versions (the real ones need the full ledger schema)
installZeroDist(Books, { B, now: () => Date.now() });
const bk = new Books();
r2.set('snap.json', body);
r2.set('rookery/migration/zero_artifacts.json', readFileSync('out/zero_artifacts.json', 'utf8'));
const K = bk.netKeys(NET);
const ERC = new Interface(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
const CURVE = new Interface(['function buy(address token,uint256 quoteIn,uint256 minTokensOut) payable returns (uint256)', 'function sell(address token,uint256 tokenAmount,uint256 minQuoteOut) returns (uint256)']);
const balOf = async (tok, a) => BigInt(await rpc('eth_call', [{ to: tok, data: ERC.encodeFunctionData('balanceOf', [a]) }, 'latest']));
const nonceOf = async (a) => Number(BigInt(await rpc('eth_getTransactionCount', [a, 'latest'])));
const out = {}, t0 = Date.now();
const fail = [];
const check = (name, ok, extra) => { if (!ok) fail.push(name + (extra ? ' ' + extra : '')); return ok; };
try {
  out.input = { snapshot: SNAPF, takenAt: snap.takenAt, tokens: snap.markets.length, holderRows: snap.markets.reduce((a, m) => a + m.holders.length, 0), profiles: ids.length,
    linkedWallets: wallets.size - contracts.size, linkedContracts: contracts.size, noWallet: unlinked.length };
  // 1 · migration (deploy + import of every curve) and finalize
  // 0 · the automatic trigger: RPC seen live twice. Without funds nothing may be paused.
  const zst = {};
  await bk.migOnZeroRpc(RPC, 1, zst);
  const a1 = await bk.migOnZeroRpc(RPC, 2, zst);
  out.autoUnfunded = { preflightOk: a1.preflight?.ok, tradingPaused: bk.netPaused(NET), snapshotTaken: !!meta.get('mig_snapshot_zero'), problems: a1.preflight?.problems.map(p => p.replace(/0x[0-9a-fA-F]{40}/, '0x…')) };
  check('autoUnfunded', a1.preflight?.ok === false && !bk.netPaused(NET) && !meta.get('mig_snapshot_zero'));
  const need = B(a1.preflight.info.reservesWei) + B(a1.preflight.info.deployGasWei);
  await rpc('anvil_setBalance', [K.deployer.address, '0x' + (need + WEI).toString(16)]);
  await rpc('anvil_setBalance', [K.dex.address, '0x' + (50n * WEI).toString(16)]);
  await rpc('anvil_setBalance', [K.custody.address, '0x' + (B(a1.preflight.info.distributionGasWei) + WEI).toString(16)]);
  const a2 = await bk.migOnZeroRpc(RPC, 3, zst);
  out.autoFunded = { paused: bk.netPaused(NET), snapshotTaken: !!meta.get('mig_snapshot_zero'), runStarted: !!a2.run?.started, runError: a2.runError, reservesZro: Number(B(a1.preflight.info.reservesWei)) / 1e18 };
  check('autoFunded', bk.netPaused(NET) && a2.run?.started === true);
  await Promise.all(jobs.splice(0));
  const st = JSON.parse(meta.get('zero_run_status'));
  out.migration = { state: st.state, error: st.error, checks: st.report?.checks?.failed === 0 ? 'all passed' : st.report?.checks, finalized: !!st.report?.finalized };
  check('migration', st.state === 'done' && !!st.report?.finalized, st.error);
  const run = JSON.parse(meta.get('zero_run'));
  out.migration.importTxs = Object.values(run.imports).filter(i => i.tx).length;

  // 2 · queue + send, with a crash between "hash stored" and "broadcast" on the second batch
  const q1 = await bk.distEnqueue(NET);
  out.enqueue = q1;
  const c0 = await nonceOf(K.custody.address);
  await bk.distDrain(NET, { batch: 20, rounds: 1 });                        // first batch signed + broadcast
  const crash = await bk.distDrain(NET, { batch: 20, rounds: 2, crashAfterStore: true });
  const stuck = sql.exec(`SELECT COUNT(*) c FROM zero_wd WHERE status='sending'`).one().c;
  const d = await bk.distDrain(NET, { batch: 25, rounds: 400 });
  const c1 = await nonceOf(K.custody.address);
  const sentRows = sql.exec(`SELECT COUNT(*) c FROM zero_wd WHERE kind='dist' AND status='sent'`).one().c;
  out.send = { crashSimulated: !!crash.crashed, rowsLeftSignedButNotBroadcast: stuck, resentWithSameNonce: d.resent, sent: sentRows, reverted: d.failed, needReview: d.review, left: d.left,
    custodyTxCount: c1 - c0, exactlyOneTxPerRow: c1 - c0 === sentRows,
    distinctHashes: sql.exec(`SELECT COUNT(DISTINCT txid) c FROM zero_wd WHERE kind='dist' AND status='sent'`).one().c === sentRows,
    distinctNonces: sql.exec(`SELECT COUNT(DISTINCT nonce) c FROM zero_wd WHERE kind='dist' AND status='sent'`).one().c === sentRows };
  check('send', out.send.exactlyOneTxPerRow && out.send.distinctHashes && out.send.distinctNonces && d.left === 0 && d.failed === 0 && d.review === 0 && crash.crashed && d.resent > 0);

  // 3 · every single balance, read back from the chain
  let rowsChecked = 0, walletExact = 0, contractKept = 0, unlinkedKept = 0, receiptsOk = 0, bad = [];
  const perToken = [];
  for (const m of snap.markets) {
    const tok = bk.netTokenAddr(NET, m.id);
    let toWallets = 0n, reserved = 0n;
    for (const h of m.holders) {
      const u = Number(h.u.slice(1)), amt = B(h.amount); rowsChecked++;
      if (wallets.has(u) && !contracts.has(u)) {
        const on = await balOf(tok, wallets.get(u).address);
        if (on === amt && bk.bal(u, 't:' + m.id) === 0n) walletExact++; else bad.push(`${m.symbol} u${u} chain ${on} want ${amt}`);
        toWallets += on;
      } else {
        const led = bk.bal(u, 't:' + m.id);
        if (led === amt) { contracts.has(u) ? contractKept++ : unlinkedKept++; } else bad.push(`${m.symbol} u${u} ledger ${led} want ${amt}`);
        if (contracts.has(u) && (await balOf(tok, wallets.get(u).address)) !== 0n) bad.push(`${m.symbol} u${u} contract got tokens`);
        reserved += led;
      }
    }
    const custody = await balOf(tok, K.custody.address);
    const ok = toWallets + reserved === B(m.heldByUsers) && custody === reserved;
    if (!ok) bad.push(`${m.symbol} wallets ${toWallets} + reserved ${reserved} != snapshot ${m.heldByUsers} (custody ${custody})`);
    perToken.push({ symbol: m.symbol, holders: m.holders.length, snapshotWei: m.heldByUsers, toWalletsWei: toWallets.toString(), reservedWei: reserved.toString(), custodyOnChainWei: custody.toString(), exact: ok });
  }
  for (const w of sql.exec(`SELECT txid FROM zero_wd WHERE kind='dist' AND status='sent' ORDER BY RANDOM() LIMIT 60`).toArray()) {
    const rc = await rpc('eth_getTransactionReceipt', [w.txid]); if (rc && Number(rc.status) === 1) receiptsOk++;
  }
  out.onchain = { holderRowsChecked: rowsChecked, walletsWithExactBalance: walletExact, contractDestinationsKeptReserved: contractKept, noWalletKeptReserved: unlinkedKept,
    tokensExactToTheWei: perToken.filter(t => t.exact).length + '/' + perToken.length, receiptsSampledOk: receiptsOk + '/60', mismatches: bad.slice(0, 8) };
  check('onchain', bad.length === 0 && receiptsOk === 60 && walletExact + contractKept + unlinkedKept === rowsChecked, bad[0]);

  // 4 · the worker's own proof (what the public page shows) agrees
  const rep = await bk.distReport(NET, { chain: true });
  out.report = { allOk: rep.allOk, tokens: rep.totals.tokens, migrated: rep.totals.migrated, sentRows: rep.totals.sentRows, everyTokenHasImportTx: rep.tokens.every(t => /^0x[0-9a-f]{64}$/.test(t.importTx || '')),
    supplyOk: rep.tokens.every(t => t.supplyOk), custodyCovers: rep.tokens.every(t => t.custodyCovers) };
  check('report', rep.allOk && out.report.everyTokenHasImportTx && out.report.supplyOk);

  // 5 · running it again sends nothing
  const q2 = await bk.distEnqueue(NET), d2 = await bk.distDrain(NET);
  out.rerun = { queued: q2.queued, sent: d2.sent, custodyTxCountUnchanged: (await nonceOf(K.custody.address)) === c1 };
  check('rerun', q2.queued === 0 && d2.sent === 0 && out.rerun.custodyTxCountUnchanged);

  // 6 · a holder links a wallet AFTER the migration: receives the reserved balance on the next pass
  const late = unlinked.find(u => snap.markets.some(m => m.holders.some(h => h.u === 'u' + u)));
  const lw = Wallet.createRandom();
  sql.exec('INSERT INTO zero_recipient_v1 VALUES (?,?,?,?,?)', late, lw.address, Date.now(), 'rehearsal', '0x');
  const tick = await bk.distTick(NET);
  let lateOk = true, lateRows = 0;
  for (const m of snap.markets) for (const h of m.holders) if (h.u === 'u' + late) { lateRows++; if ((await balOf(bk.netTokenAddr(NET, m.id), lw.address)) !== B(h.amount)) lateOk = false; }
  const mine = await bk.distMine(NET, late);
  out.lateLink = { profile: 'u' + late, tokens: lateRows, queued: tick.queued.queued, receivedExact: lateOk, myPageShowsTx: mine.rows.every(r => r.transfers.length === 1 && r.transfers[0].status === 'sent' && r.transfers[0].tx && r.reservedWei === '0') };
  check('lateLink', lateOk && lateRows > 0 && out.lateLink.myPageShowsTx);

  // 7 · trading is on-chain now: a holder sells half on the curve from their own wallet, another wallet buys
  const big = [...snap.markets].sort((a, b) => b.holders.length - a.holders.length)[0], tok = bk.netTokenAddr(NET, big.id), curve = bk.netAddrs(NET).curve;
  const seller = big.holders.map(h => ({ u: Number(h.u.slice(1)), amt: B(h.amount) })).filter(h => wallets.has(h.u) && !contracts.has(h.u)).sort((a, b) => (b.amt > a.amt ? 1 : -1))[3];
  const sw = wallets.get(seller.u);
  await rpc('anvil_setBalance', [sw.address, '0x' + (1n * WEI).toString(16)]);
  const send = async (w, tx) => { const nonce = await nonceOf(w.address); const raw = await w.signTransaction({ chainId: CHAIN, nonce, gasLimit: 900000n, gasPrice: BigInt(await rpc('eth_gasPrice')), value: 0n, ...tx }); const h = await rpc('eth_sendRawTransaction', [raw]); for (;;) { const rc = await rpc('eth_getTransactionReceipt', [h]); if (rc) return rc; await sleep(100); } };
  const half = seller.amt / 2n, n0 = BigInt(await rpc('eth_getBalance', [sw.address, 'latest']));
  await send(sw, { to: tok, data: ERC.encodeFunctionData('approve', [curve, half]) });
  const sellRc = await send(sw, { to: curve, data: CURVE.encodeFunctionData('sell', [tok, half, 0n]) });
  const n1 = BigInt(await rpc('eth_getBalance', [sw.address, 'latest']));
  const buyer = Wallet.createRandom(); await rpc('anvil_setBalance', [buyer.address, '0x' + (50n * WEI).toString(16)]);
  const buyRc = await send(buyer, { to: curve, value: 5n * WEI, data: CURVE.encodeFunctionData('buy', [tok, 5n * WEI, 0n]) });
  out.onchainTrading = { token: big.symbol, sellStatus: Number(sellRc.status), sellerTokensLeftExact: (await balOf(tok, sw.address)) === seller.amt - half, sellerReceivedNativeZro: n1 > n0 - WEI / 100n && n1 !== n0,
    buyStatus: Number(buyRc.status), buyerGotTokens: (await balOf(tok, buyer.address)) > 0n, ledgerNotInvolved: bk.bal(seller.u, 't:' + big.id) === 0n };
  check('trading', Number(sellRc.status) === 1 && Number(buyRc.status) === 1 && out.onchainTrading.sellerTokensLeftExact && out.onchainTrading.buyerGotTokens);
  writeFileSync('.rehearsal/dist_per_token.json', JSON.stringify(perToken, null, 1));
  writeFileSync('.rehearsal/dist_report.json', JSON.stringify({ report: await bk.distReport(NET, { chain: true }), mine: await bk.distMine(NET, late) }));
} catch (e) { out.error = String(e.stack || e).slice(0, 900); fail.push('exception'); }
out.seconds = Math.round((Date.now() - t0) / 1000);
out.RESULT = fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS';
console.log(JSON.stringify(out, null, 1));
anvil.kill(); process.exit(fail.length ? 1 : 0);
