// End to end on a local chain id 33002 with a real SQLite ledger (node:sqlite) and the worker's own zeromig.js:
// migrate -> finalize -> withdrawals (EOA ok, contract refused, pre-broadcast failure refunded, crash-resume no double send).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HDNodeWallet, Wallet, Interface } from 'ethers';
import { installZeroMig } from '../worker/zeromig.js';

const PORT = 8620, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--chain-id', '33002', '--port', String(PORT), '--silent', '--gas-limit', '60000000'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rpc = async (m, p = []) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId'); break; } catch { await sleep(250); } }

const WEI = 10n ** 18n, B = (x) => BigInt(x || 0);
const db = new DatabaseSync(':memory:');
const sql = { exec: (q, ...a) => { const st = db.prepare(q); const isRead = /^\s*(SELECT|PRAGMA)|RETURNING/i.test(q); const rows = isRead ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows, one: () => rows[0], raw: () => ({ toArray: () => rows.map(Object.values) }) }; } };
db.exec(`CREATE TABLE markets (id TEXT PRIMARY KEY, network TEXT, symbol TEXT, reserve_zro TEXT, migrated INTEGER DEFAULT 0, creator_id INTEGER);
  CREATE TABLE balances (user_id INTEGER, asset TEXT, amount TEXT, PRIMARY KEY (user_id, asset));
  CREATE TABLE users (id INTEGER PRIMARY KEY, wallet TEXT);
  CREATE TABLE transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, kind TEXT, chain TEXT, amount TEXT, txid TEXT DEFAULT '', to_addr TEXT DEFAULT '', status TEXT, note TEXT DEFAULT '', ts INTEGER, asset TEXT);`);
const snap = JSON.parse(readFileSync('.rehearsal/snapshot.json', 'utf8'));
for (const m of snap.markets) {
  db.prepare('INSERT INTO markets (id,network,symbol,reserve_zro,creator_id) VALUES (?,?,?,?,?)').run(m.id, 'zero', m.symbol, m.curve.quoteReserve, Number(m.creator.slice(1)));
  db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(Number(m.creator.slice(1)));
  for (const h of m.holders) db.prepare('INSERT OR REPLACE INTO balances VALUES (?,?,?)').run(Number(h.u.slice(1)), 't:' + m.id, h.amount);
}
const meta = new Map(), r2 = new Map(), jobs = [];
const root = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, 'm');
class Books {
  constructor() { this.sql = sql; this.env = { BACKUPS: { get: async (k) => r2.has(k) ? { text: async () => r2.get(k) } : null } }; this.ctx = { waitUntil: (p) => jobs.push(p), storage: { transactionSync: (f) => { db.exec('BEGIN'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } } }; }
  meta(k) { return meta.get(k) || ''; } setMeta(k, v) { meta.set(k, v); } master() { return root; }
  zwState() { return { rpc: { [RPC]: { live: true } } }; }
  bal(u, a) { return B(sql.exec('SELECT amount FROM balances WHERE user_id=? AND asset=?', u, a).toArray()[0]?.amount); }
  addBal(u, a, d) { const v = this.bal(u, a) + d; if (v < 0n) throw new Error('Insufficient token balance'); sql.exec('INSERT INTO balances (user_id,asset,amount) VALUES (?,?,?) ON CONFLICT(user_id,asset) DO UPDATE SET amount=excluded.amount', u, a, v.toString()); return v; }
}
installZeroMig(Books, { B, WEI, now: () => Date.now(), vQuote: () => 3150n * WEI });
const bk = new Books();
r2.set('snap.json', readFileSync('.rehearsal/snapshot.json', 'utf8'));
r2.set('rookery/migration/zero_artifacts.json', readFileSync('out/zero_artifacts.json', 'utf8'));
meta.set('mig_snapshot_zero', JSON.stringify({ key: 'snap.json' })); meta.set('net_paused_zero', '1');
const K = bk.zeroKeys();
for (const a of [K.deployer.address, K.dex.address, K.custody.address]) await rpc('anvil_setBalance', [a, '0x' + (5000n * WEI).toString(16)]);
const ERC = new Interface(['function balanceOf(address) view returns (uint256)']);
const balOf = async (tok, a) => BigInt(await rpc('eth_call', [{ to: tok, data: ERC.encodeFunctionData('balanceOf', [a]) }, 'latest']));
const out = {};
try {
  await bk.zeroMigrate({ rpc: RPC });
  await Promise.all(jobs.splice(0));
  const st = JSON.parse(meta.get('zero_run_status'));
  out.migration = { state: st.state, checks: st.report?.checks?.failed === 0 ? '60/60' : st.report?.checks, finalized: st.report?.finalized };
  out.ledgerAfter = { migratedMarkets: sql.exec('SELECT COUNT(*) c FROM markets WHERE migrated=1 AND zero_token IS NOT NULL').one().c,
    movedReserveEqualsLedger: B(meta.get('migrated_zro_reserve')) === snap.markets.reduce((a, m) => a + B(m.curve.quoteReserve), 0n) };

  const m = [...snap.markets].sort((a, b) => b.holders.length - a.holders.length)[0];
  const h = m.holders[0], uid = Number(h.u.slice(1)), tok = bk.zeroTokenAddr(m.id);
  const userWallet = Wallet.createRandom().address;
  const half = B(h.amount) / 2n;
  // 1 · EOA withdrawal
  const w1 = await bk.zeroWithdraw({ id: uid }, { market: m.id, amount: half.toString(), to: userWallet });
  await Promise.all(jobs.splice(0));
  const row1 = sql.exec('SELECT status, txid FROM zero_wd WHERE id=?', w1.id).one();
  out.withdrawEOA = { status: row1.status, onchain: (await balOf(tok, userWallet)) === half, ledgerLeft: bk.bal(uid, 't:' + m.id) === B(h.amount) - half,
    transferRow: sql.exec('SELECT status FROM transfers WHERE id=(SELECT transfer_id FROM zero_wd WHERE id=?)', w1.id).one().status };
  // 2 · contract recipient refused, nothing debited
  const before = bk.bal(uid, 't:' + m.id);
  try { await bk.zeroWithdraw({ id: uid }, { market: m.id, amount: '1', to: bk.zeroAddrs().curve }); out.withdrawContract = 'NOT REFUSED'; }
  catch (e) { out.withdrawContract = { refused: true, why: e.message.slice(0, 70), ledgerUntouched: bk.bal(uid, 't:' + m.id) === before }; }
  // 3 · failure before broadcast -> refund (point the row at a non-token address so estimateGas reverts)
  const recip0 = await balOf(tok, userWallet);
  bk.addBal(uid, 't:' + m.id, -1000n);                                   // same debit zeroWithdraw does
  const tr3 = sql.exec(`INSERT INTO transfers (user_id,kind,chain,amount,to_addr,status,ts,asset) VALUES (?,?,?,?,?,?,?,?) RETURNING id`, uid, 'withdrawal', 'zero', '1000', userWallet, 'pending', Date.now(), 't:' + m.id).one().id;
  const w3 = sql.exec(`INSERT INTO zero_wd (user_id,market,token,to_addr,amount,status,transfer_id,created,updated) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`, uid, m.id, bk.zeroAddrs().curve, userWallet, '1000', 'pending', tr3, Date.now(), Date.now()).one().id;
  await bk.zeroWdTick();
  out.preBroadcastFailure = { status: sql.exec('SELECT status FROM zero_wd WHERE id=?', w3).one().status, refunded: bk.bal(uid, 't:' + m.id) === before,
    transferRow: sql.exec('SELECT status FROM transfers WHERE id=?', tr3).one().status, recipientUnchanged: (await balOf(tok, userWallet)) === recip0 };
  // 4 · crash after broadcast: row left in 'sending' with its hash -> resume must only look it up
  const custodyNonce0 = Number(BigInt(await rpc('eth_getTransactionCount', [K.custody.address, 'latest'])));
  sql.exec(`UPDATE zero_wd SET status='sending' WHERE id=?`, w1.id);
  await bk.zeroWdTick();
  const custodyNonce1 = Number(BigInt(await rpc('eth_getTransactionCount', [K.custody.address, 'latest'])));
  out.crashResume = { status: sql.exec('SELECT status FROM zero_wd WHERE id=?', w1.id).one().status, secondSend: custodyNonce1 !== custodyNonce0, recipientUnchanged: (await balOf(tok, userWallet)) === half };
  // 5 · custody still covers every remaining ledger balance of that token
  const ledgerSum = sql.exec('SELECT amount FROM balances WHERE asset=?', 't:' + m.id).toArray().reduce((a, r) => a + B(r.amount), 0n);
  out.custodyCovers = (await balOf(tok, K.custody.address)) >= ledgerSum;
} catch (e) { out.error = String(e.stack || e).slice(0, 700); }
console.log(JSON.stringify(out, null, 1));
anvil.kill(); process.exit(0);
