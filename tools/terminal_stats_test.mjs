// Terminal token metrics on a local chain: launchpad factory creates tokens, 3 wallets buy, 1 sells, 1 transfers.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { JsonRpcProvider, Wallet, Interface, AbiCoder } from 'ethers';
import { installTerminal } from '../worker/terminal.js';
const db = new DatabaseSync(':memory:');
const sql = { exec: (q, ...a) => { const st = db.prepare(q); const rows = /^\s*SELECT|RETURNING/i.test(q) ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows, one: () => rows[0] }; } };
db.exec(`CREATE TABLE markets (id TEXT PRIMARY KEY, network TEXT, name TEXT, symbol TEXT, image TEXT, created INTEGER, trades INTEGER, migrated INTEGER DEFAULT 0, creator_id INTEGER, last_trade INTEGER)`);
db.exec(`CREATE TABLE balances (user_id INTEGER, asset TEXT, amount TEXT)`);
const meta = new Map();
class Books { constructor() { this.sql = sql; } meta(k) { return meta.get(k) || ''; } setMeta(k, v) { meta.set(k, v); } zroUsd() { return 1.2; } ethUsd() { return 3000; } netTokenAddr() { return null; } zwState() { return {}; } }
installTerminal(Books, { now: () => Date.now() });
const bk = new Books();
const PORT = 8640, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--chain-id', '33002', '--port', String(PORT), '--silent', '--gas-limit', '60000000'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rpc = async (m, p) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId', []); break; } catch { await sleep(250); } }
const out = {};
try {
  const provider = new JsonRpcProvider(RPC, 33002, { staticNetwork: true, cacheTimeout: -1 });
  const keys = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'];   // anvil public test keys
  const W = keys.map(k => new Wallet(k, provider)); const nonces = {};
  const send = async (w, tx) => { nonces[w.address] ??= await provider.getTransactionCount(w.address); const r = await w.sendTransaction({ ...tx, nonce: nonces[w.address]++, gasLimit: 15_000_000n }); return provider.waitForTransaction(r.hash); };
  const art = JSON.parse(readFileSync('out/zero_artifacts.json', 'utf8')); const c = AbiCoder.defaultAbiCoder();
  const b0 = await provider.getBlockNumber();
  const curve = (await send(W[0], { data: art.RookeryCurve2_cancun.bytecode + c.encode(['address', 'address', 'address', 'address', 'uint256'], [W[0].address, W[0].address, W[0].address, W[0].address, 3150n * 10n ** 18n]).slice(2) })).contractAddress.toLowerCase();
  const CI = new Interface(['function create(string,string,address,uint16,uint16,uint16,uint256,uint256) payable returns (address)', 'function buy(address,uint256,uint256) payable returns (uint256)', 'function sell(address,uint256,uint256) returns (uint256)', 'function allTokens(uint256) view returns (address)', 'function quoteBuy(address,uint256) view returns (uint256)']);
  const ERC = new Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
  await send(W[0], { to: curve, data: CI.encodeFunctionData('create', ['Penguin', 'PEN', '0x0000000000000000000000000000000000000000', 0, 0, 0, 0, 0]), value: 10n ** 18n });   // creator dev-buy 1 ZRO
  const tok = CI.decodeFunctionResult('allTokens', await provider.call({ to: curve, data: CI.encodeFunctionData('allTokens', [0]) }))[0].toLowerCase();
  await send(W[1], { to: curve, data: CI.encodeFunctionData('buy', [tok, 0, 0]), value: 5n * 10n ** 18n });
  await send(W[2], { to: curve, data: CI.encodeFunctionData('buy', [tok, 0, 0]), value: 2n * 10n ** 18n });
  const bal1 = ERC.decodeFunctionResult('balanceOf', await provider.call({ to: tok, data: ERC.encodeFunctionData('balanceOf', [W[1].address]) }))[0];
  await send(W[1], { to: curve, data: CI.encodeFunctionData('sell', [tok, bal1 / 2n, 0]) });
  await send(W[2], { to: tok, data: ERC.encodeFunctionData('transfer', [W[3].address, 1000n * 10n ** 18n]) });
  const b1 = await provider.getBlockNumber();
  meta.set('term_factories', JSON.stringify({ [curve]: 'tzero' }));
  out.pass = await bk.termIndex(rpc, { from: b0 + 1, to: b1, chain: 'zero' });
  const d = bk.termToken('zero', tok);
  const tq = CI.decodeFunctionResult('quoteBuy', await provider.call({ to: curve, data: CI.encodeFunctionData('quoteBuy', [tok, 10n ** 18n]) }))[0];
  const curvePriceUsd = (1 / (Number(tq) / 1e18)) * 1.2;   // ~price of the next buy, incl. 0.5% fee
  const t = d.token;
  out.metrics = { holders: t.holders, top10: t.top10, creatorPct: t.creatorPct, buys: t.buys, sells: t.sells, pool: t.pool === curve, priceUsd: t.priceUsd, mcapUsd: Math.round(t.mcapUsd), volumeUsd: t.volumeUsd, curveNextBuyUsd: curvePriceUsd };
  out.holdersList = d.holders.map(h => `${h.tag || h.address.slice(0, 8)}:${h.pct}%`);
  out.txKinds = d.txs.map(x => x.kind).reverse();
  out.chartPoints = d.points.length;
  const v = bk.termView({ net: 'zero', pad: 'tzero', sort: 'holders' });
  out.listRow = (({ symbol, holders, top10, buys, sells, mcapUsd }) => ({ symbol, holders, top10, buys, sells, mcapUsd: Math.round(mcapUsd) }))(v.tokens[0]);
  // re-running the same range must not double count
  await bk.termIndex(rpc, { from: b0 + 1, to: b1, chain: 'zero' });
  (await import('node:fs')).writeFileSync('.rehearsal/term_token_mock.json', JSON.stringify(bk.termToken('zero', tok)));
  out.idempotent = bk.termToken('zero', tok).token.buys === t.buys && bk.termToken('zero', tok).holders.length === d.holders.length;
} catch (e) { out.error = String(e.stack || e).slice(0, 600); }
console.log(JSON.stringify(out, null, 1)); anvil.kill(); process.exit(0);
