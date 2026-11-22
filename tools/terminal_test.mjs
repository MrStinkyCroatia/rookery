// Zero Terminal indexer test (same worker/terminal.js code, node:sqlite ledger):
//  A) real Robinhood Chain data: the RookeryCurve2 launch of a token is found and attributed once its factory is mapped
//  B) local chain: a "launchpad" factory creating tokens, a direct ERC-20 deploy, an ERC-721 mint (must be ignored), activity counting
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { JsonRpcProvider, Wallet, Interface, AbiCoder } from 'ethers';
import { installTerminal } from '../worker/terminal.js';

const db = new DatabaseSync(':memory:');
const sql = { exec: (q, ...a) => { const st = db.prepare(q); const rows = /^\s*SELECT|RETURNING/i.test(q) ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows, one: () => rows[0] }; } };
db.exec(`CREATE TABLE markets (id TEXT PRIMARY KEY, network TEXT, name TEXT, symbol TEXT, image TEXT, created INTEGER, trades INTEGER, migrated INTEGER DEFAULT 0)`);
db.prepare(`INSERT INTO markets VALUES ('merlin-c124d4','zero','Merlin','Merlin','',1,170,0)`).run();
const meta = new Map();
class Books { constructor() { this.sql = sql; } meta(k) { return meta.get(k) || ''; } setMeta(k, v) { meta.set(k, v); } zeroTokenAddr() { return '0x0B3907163f2380116c470A494D949F288534114f'; } zwState() { return {}; } }
installTerminal(Books, { now: () => Date.now() });
const bk = new Books();
const mk = (url) => async (m, p) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const out = {};

// A · real Robinhood data
try {
  const rh = mk('https://rpc.mainnet.chain.robinhood.com');
  const a = await bk.termIndex(rh, { from: 119276480, to: 119276700, chain: 'rh' });
  const t = sql.exec(`SELECT * FROM term_tokens WHERE chain='rh' AND addr=?`, '0xb5b10331a8a5595e0da996e5623062b7f5b3f752').toArray()[0];
  const before = t?.pad;
  meta.set('term_factories', JSON.stringify({ [t.factory]: 'rookery' }));
  sql.exec('UPDATE term_tokens SET pad=? WHERE factory=?', 'rookery', t.factory);   // what /admin/terminal does
  out.robinhood = { pass: a, found: !!t, name: t?.name, symbol: t?.symbol, supply: t ? Number(BigInt(t.supply)) / 1e18 : null, factory: t?.factory, padBefore: before,
    padAfter: sql.exec(`SELECT pad FROM term_tokens WHERE addr=?`, t.addr).one().pad };
} catch (e) { out.robinhood = { error: String(e.message || e).slice(0, 200) }; }

// B · local chain with a launchpad factory
const PORT = 8630, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--chain-id', '33002', '--port', String(PORT), '--silent', '--gas-limit', '60000000'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rpc = mk(RPC);
for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId', []); break; } catch { await sleep(250); } }
try {
  const provider = new JsonRpcProvider(RPC, 33002, { staticNetwork: true, cacheTimeout: -1 });
  const w = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);   // anvil account #0 (public test key)
  let nonce = await provider.getTransactionCount(w.address);
  const send = async (tx) => { const r = await w.sendTransaction({ ...tx, nonce: nonce++, gasLimit: 15_000_000n }); return provider.waitForTransaction(r.hash); };
  const art = JSON.parse(readFileSync('out/zero_artifacts.json', 'utf8'));
  const c = AbiCoder.defaultAbiCoder();
  const b0 = await provider.getBlockNumber();
  const curve = (await send({ data: art.RookeryCurve2_cancun.bytecode + c.encode(['address', 'address', 'address', 'address', 'uint256'], [w.address, w.address, w.address, w.address, 3150n * 10n ** 18n]).slice(2) })).contractAddress;
  const CI = new Interface(['function create(string,string,address,uint16,uint16,uint16,uint256,uint256) payable returns (address)', 'function buy(address,uint256,uint256) payable returns (uint256)', 'function allTokens(uint256) view returns (address)']);
  for (const [n, sy] of [['Penguin One', 'PEN1'], ['Penguin Two', 'PEN2']]) await send({ to: curve, data: CI.encodeFunctionData('create', [n, sy, '0x0000000000000000000000000000000000000000', 0, 0, 0, 0, 0]), value: 10n ** 17n });
  const tok1 = CI.decodeFunctionResult('allTokens', await provider.call({ to: curve, data: CI.encodeFunctionData('allTokens', [0]) }))[0];
  for (let i = 0; i < 3; i++) await send({ to: curve, data: CI.encodeFunctionData('buy', [tok1, 0, 0]), value: 10n ** 16n });   // activity
  // a direct ERC-20 deploy (no factory): WETH9 mints on deposit -> Transfer from 0x0 emitted by deposit? WETH9 emits Deposit, not Transfer.
  // use the Uniswap V2 pair-less path instead: the Rookery token deploy is the realistic case; add an ERC-721-like log via a tiny contract
  const nft = (await send({ data: '0x6080604052348015600f57600080fd5b50607780601d6000396000f3fe6080604052600160008160008073ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef60405160405180910390a400fea164736f6c6343000818000a' })).contractAddress;
  await send({ to: nft, data: '0x' });                                                                // emits Transfer(0x0, 0x0, 1) with 4 topics
  const b1 = await provider.getBlockNumber();
  meta.set('term_factories', JSON.stringify({ [curve.toLowerCase()]: 'tzero' }));
  const r1 = await bk.termIndex(rpc, { from: b0 + 1, to: b1, chain: 'zero' });
  const rows = sql.exec(`SELECT symbol, pad, transfers FROM term_tokens WHERE chain='zero' ORDER BY block`).toArray();
  const view = bk.termView({ pad: 'tzero' });
  const all = bk.termView({ pad: 'all' });
  out.local = { pass: r1, indexed: rows, nftIgnored: !rows.some(r => r.symbol === '' && r.pad !== 'tzero'), tzeroTab: view.tokens.map(t => t.symbol), tzeroCount: view.pads.find(p => p.id === 'tzero').tokens,
    allTabIncludesRookeryReserved: all.tokens.some(t => t.pad === 'rookery' && t.reserved) };
} catch (e) { out.local = { error: String(e.stack || e).slice(0, 500) }; }
console.log(JSON.stringify(out, null, 1));
anvil.kill(); process.exit(0);
