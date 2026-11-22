// Full 1:1 migration rehearsal on a local chain with chain id 33002, using the REAL production snapshot and the same
// runner (worker/zerorun.js) the worker uses on migration day. Test keys stand in for the HD children.
// node tools/zero_rehearsal.mjs [hardfork]      e.g. cancun (default) or paris
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, HDNodeWallet, Interface, getAddress } from 'ethers';
import { zeroRun, predictZero, requiredReserve } from '../worker/zerorun.js';

const HF = process.argv[2] || 'cancun';
const PORT = 8600 + (HF === 'paris' ? 1 : 0);
const RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--chain-id', '33002', '--port', String(PORT), '--hardfork', HF, '--silent', '--gas-limit', '60000000', '--code-size-limit', '24576'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const provider = new JsonRpcProvider(RPC, 33002, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
for (let i = 0; i < 60; i++) { try { await provider.send('eth_chainId', []); break; } catch { await sleep(250); } }

const snapshot = JSON.parse(readFileSync('.rehearsal/snapshot.json', 'utf8'));
const creators = JSON.parse(readFileSync('.rehearsal/creators.json', 'utf8')).creators;
const artifacts = JSON.parse(readFileSync('out/zero_artifacts.json', 'utf8'));
const root = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, 'm');
const key = (i) => new Wallet(root.deriveChild(i).privateKey, provider);
const W = { deployer: key(2_000_033_002), dex: key(2_000_033_003), custody: key(2_000_033_004) };
for (const w of Object.values(W)) await provider.send('anvil_setBalance', [w.address, '0x' + (10_000n * 10n ** 18n).toString(16)]);

const sent = [];
let state = null;
const io = {
  rpc: (m, p) => provider.send(m, p),
  send: async (role, tx) => {
    const w = W[role];
    const nonce = Number(BigInt(await provider.send('eth_getTransactionCount', [w.address, 'pending'])));
    const r = await w.sendTransaction({ to: tx.to || null, data: tx.data, value: tx.value || 0n, gasLimit: 30_000_000n, nonce });
    let rc = null;
    for (let i = 0; i < 200 && !rc; i++) { rc = await provider.send('eth_getTransactionReceipt', [r.hash]); if (!rc) await sleep(30); }
    sent.push(role); return rc;
  },
  addr: { deployer: W.deployer.address, dex: W.dex.address, custody: W.custody.address, feeTo: W.custody.address },
  load: async () => state, save: async (s) => { state = JSON.parse(JSON.stringify(s)); }, log: () => {},
};
const plan = { snapshot, artifacts, creators, chainId: 33002, vNative: (3150n * 10n ** 18n).toString(), build: 'auto' };
const out = { hardfork: HF };
const t0 = Date.now();
try {
  out.dry = (await zeroRun(io, { ...plan, dryRun: true })).funds;
  const r = await zeroRun(io, plan);
  out.run = { build: r.build, imported: r.imported, checks: r.checks, txs: sent.length, seconds: ((Date.now() - t0) / 1000).toFixed(1) };
  const P = predictZero(W.deployer.address, W.dex.address);
  out.addresses = { curve: P.curve, factory: P.factory, sampleToken: { id: snapshot.markets[0].id, reserved: P.token(snapshot.markets[0].id) } };
  // all 60 reserved addresses really have code
  let withCode = 0;
  for (const m of snapshot.markets) if ((await provider.send('eth_getCode', [P.token(m.id), 'latest'])) !== '0x') withCode++;
  out.reservedWithCode = `${withCode}/${snapshot.markets.length}`;

  // a holder withdraws from custody and sells on the curve; a newcomer buys
  const CURVE = new Interface(['function sell(address,uint256,uint256) returns (uint256)', 'function buy(address,uint256,uint256) payable returns (uint256)', 'function quoteBuy(address,uint256) view returns (uint256)', 'function curves(address) view returns (address,address,uint128,uint128 realQuote,uint128 sold,uint64,bool,bool,address)']);
  const ERC = new Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
  const top = [...snapshot.markets].sort((a, b) => b.holders.length - a.holders.length)[0];
  const tok = P.token(top.id), h = top.holders[0];
  const user = Wallet.createRandom().connect(provider), newbie = Wallet.createRandom().connect(provider);
  await provider.send('anvil_setBalance', [user.address, '0x' + (10n ** 18n).toString(16)]);
  await provider.send('anvil_setBalance', [newbie.address, '0x' + (100n * 10n ** 18n).toString(16)]);
  await (await W.custody.sendTransaction({ to: tok, data: ERC.encodeFunctionData('transfer', [user.address, BigInt(h.amount)]) })).wait();
  const b0 = await provider.getBalance(user.address);
  await (await user.sendTransaction({ to: P.curve, data: CURVE.encodeFunctionData('sell', [tok, BigInt(h.amount), 0n]) })).wait();
  const b1 = await provider.getBalance(user.address);
  const q = CURVE.decodeFunctionResult('quoteBuy', await provider.call({ to: P.curve, data: CURVE.encodeFunctionData('quoteBuy', [tok, 10n ** 18n]) }))[0];
  await (await newbie.sendTransaction({ to: P.curve, data: CURVE.encodeFunctionData('buy', [tok, 0n, q]), value: 10n ** 18n })).wait();
  const nb = ERC.decodeFunctionResult('balanceOf', await provider.call({ to: tok, data: ERC.encodeFunctionData('balanceOf', [newbie.address]) }))[0];
  out.liveTrading = { token: top.symbol, withdrawn: Number(BigInt(h.amount)) / 1e18, soldForZRO: Number(b1 - b0) / 1e18, newbieBought: Number(nb) / 1e18, quoted: Number(q) / 1e18 };

  // resume: running again must do nothing and still pass
  const n0 = sent.length;
  const again = await zeroRun(io, plan);
  out.rerun = { newTxs: sent.length - n0, checksFailed: again.checks.failed };
} catch (e) { out.error = String(e.stack || e).slice(0, 600); }
console.log(JSON.stringify(out, null, 1));
anvil.kill();
process.exit(0);
