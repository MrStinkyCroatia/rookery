#!/usr/bin/env node
/* Sweep native ETH/BNB accidentally sent to Rookery deposit addresses, to a chosen address.
   Usage: node sweep_native.mjs --to 0x... [--chain ethereum] [--dry] [--max 200] */
import { HDNodeWallet, Wallet, Interface, Transaction } from '../node_modules/ethers/lib.esm/index.js';
import fs from 'fs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const TO = arg('--to');
const ONLY = arg('--chain', null);
const DRY = args.includes('--dry');
const MAX = Number(arg('--max', 200));
if (!TO) { console.error('missing --to'); process.exit(1); }

const CH = {
  ethereum: { id: 1, rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth-mainnet.public.blastapi.io', 'https://ethereum.publicnode.com'], gas: 21000n, min: 500_000_000_000_000n },
  base: { id: 8453, rpcs: ['https://base-rpc.publicnode.com', 'https://1rpc.io/base', 'https://base-mainnet.public.blastapi.io'], gas: 21000n, min: 500_000_000_000_000n },
  arbitrum: { id: 42161, rpcs: ['https://arb1.arbitrum.io/rpc', 'https://1rpc.io/arb'], gas: 60000n, min: 1_000_000_000_000_000n },
  bsc: { id: 56, rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'], gas: 21000n, min: 10_000_000_000_000_000n },
  optimism: { id: 10, rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'], gas: 21000n, min: 1_000_000_000_000_000n },
};
const MC = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mc = new Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])']);
const getEth = new Interface(['function getEthBalance(address addr) view returns (uint256)']);

async function one(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function rpc(chain, method, params) {
  let err;
  for (const u of CH[chain].rpcs) { try { return await one(u, method, params); } catch (e) { err = e; } }
  throw err;
}
async function broadcast(chain, raw) {
  const res = await Promise.allSettled(CH[chain].rpcs.map(u => one(u, 'eth_sendRawTransaction', [raw])));
  const ok = res.find(r => r.status === 'fulfilled');
  if (ok) return ok.value;
  const msgs = res.map(r => String(r.reason?.message || r.reason));
  if (msgs.some(m => /already known|already imported|known transaction/i.test(m))) return null;
  throw new Error(msgs[0]);
}

const xprv = fs.readFileSync(process.env.MASTER_FILE || '../.master_xprv', 'utf8').trim();
const master = HDNodeWallet.fromExtendedKey(xprv);
const wallets = [];
for (let i = 1; i <= MAX; i++) wallets.push({ i, w: new Wallet(master.deriveChild(i).privateKey) });

const report = [];
for (const chain of Object.keys(CH).filter(c => !ONLY || c === ONLY)) {
  const C = CH[chain];
  const data = mc.encodeFunctionData('aggregate3', [wallets.map(x => ({ target: MC, allowFailure: true, callData: getEth.encodeFunctionData('getEthBalance', [x.w.address]) }))]);
  const res = await rpc(chain, 'eth_call', [{ to: MC, data }, 'latest']);
  const [rows] = mc.decodeFunctionResult('aggregate3', res);
  let gp;
  try { gp = BigInt(await rpc(chain, 'eth_gasPrice', [])); } catch { gp = 0n; }
  const price = (gp * 5n) / 4n + 1n;
  const fee = C.gas * price;
  const targets = [];
  rows.forEach((r, idx) => {
    if (!r.success) return;
    const bal = BigInt(r.returnData);
    if (bal > fee * 4n && bal - fee * 2n >= C.min) targets.push({ ...wallets[idx], bal, fee });
  });
  const gross = targets.reduce((a, t) => a + t.bal, 0n), costs = targets.reduce((a, t) => a + t.fee, 0n);
  console.log(`\n${chain}: ${targets.length} adresow do wyczyszczenia | saldo ${Number(gross) / 1e18} | gaz ${Number(costs) / 1e18} | do wyslania ${Number(gross - costs) / 1e18}`);
  if (DRY) { for (const t of targets) console.log(`   #${t.i} ${t.w.address} ${Number(t.bal) / 1e18} -> netto ${Number(t.bal - t.fee) / 1e18}`); continue; }
  for (const t of targets) {
    const value = t.bal - t.fee * 2n; // x2: headroom for L1 data fee on rollups and gas price drift
    try {
      const nonce = Number(BigInt(await rpc(chain, 'eth_getTransactionCount', [t.w.address, 'pending'])));
      const raw = await t.w.signTransaction({ type: 0, chainId: C.id, nonce, gasPrice: price, gasLimit: C.gas, to: TO, value });
      const hash = Transaction.from(raw).hash;
      await broadcast(chain, raw);
      report.push({ chain, index: t.i, from: t.w.address, value: Number(value) / 1e18, hash });
      console.log(`   wyslano #${t.i} ${Number(value) / 1e18} ${hash}`);
    } catch (e) { console.log(`   BLAD #${t.i} ${String(e.message).slice(0, 80)}`); }
  }
}
if (report.length) {
  console.log('\n=== podsumowanie ===');
  const byChain = {};
  for (const r of report) byChain[r.chain] = (byChain[r.chain] || 0) + r.value;
  for (const [c, v] of Object.entries(byChain)) console.log(`${c}: ${v} (${report.filter(r => r.chain === c).length} przelewow)`);
  fs.writeFileSync('sweep_native_result.json', JSON.stringify(report, null, 1));
}
