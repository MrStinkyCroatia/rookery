// Fork rehearsal on Base: the on-chain half of a one-signature order.
// Impersonates a real ZRO holder on a local fork, sends the exact tagged amount, and checks that the
// credited delta (what the scanner would report) settles the order. No real funds, no deployment.
import { ethers } from 'ethers';
import { spawn } from 'node:child_process';
import { matchOrder } from '../worker/orders.js';

const WEI = 10n ** 18n;
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const FORK = 'https://base-rpc.publicnode.com';
const ZRO = '0x6985884C4392D348587B19cb9eAAf157F13271cd';
const HOLDER = '0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D'; // the Rookery hot wallet, a real ZRO holder
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const anvil = spawn('anvil', ['--fork-url', FORK, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
const stop = () => { try { anvil.kill('SIGKILL'); } catch {} };
process.on('exit', stop);

const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
for (let i = 0; i < 60; i++) { try { await p.getBlockNumber(); break; } catch { await sleep(1000); } }
try {
  const startBlock = await p.getBlockNumber();
  ok('fork is live on Base', startBlock > 50_000_000, 'block ' + startBlock);

  await p.send('anvil_impersonateAccount', [HOLDER]);
  await p.send('anvil_setBalance', [HOLDER, '0x56BC75E2D63100000']); // 100 ETH for gas
  const holder = await p.getSigner(HOLDER);
  const zro = new ethers.Contract(ZRO, [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
  ], holder);

  // ── ERC-20 (ZRO) path, the one used on Zero ──
  const buyer = ethers.Wallet.createRandom().address;         // the user's own wallet
  const deposit = ethers.Wallet.createRandom().address;       // stands in for the user's deposit address
  const amount = 50n * WEI;                                   // 50 ZRO requested
  const tag = 313n;                                           // unique order tag
  const before = await zro.balanceOf(deposit);
  const tx = await zro.transfer(deposit, amount + tag);
  await tx.wait();
  const delta = (await zro.balanceOf(deposit)) - before;
  ok('tagged transfer lands with no rounding', delta === amount + tag, `${delta} wei`);
  let r = matchOrder({ amount: amount.toString(), tagged: (amount + tag).toString() }, delta.toString());
  ok('scanner delta fills the order', r.action === 'fill' && r.amount === amount.toString() && r.exact, JSON.stringify(r));

  // a wallet that shaves one wei (some wallets do) still fills within tolerance
  const deposit2 = ethers.Wallet.createRandom().address;
  const b2 = await zro.balanceOf(deposit2);
  await (await zro.transfer(deposit2, amount + tag - 1n)).wait();
  const d2 = (await zro.balanceOf(deposit2)) - b2;
  r = matchOrder({ amount: amount.toString(), tagged: (amount + tag).toString() }, d2.toString());
  ok('one wei short still fills', r.action === 'fill' && r.exact === false && BigInt(r.amount) === amount, JSON.stringify(r));

  // two orders paid in the same block are told apart by the tag
  const deposit3 = ethers.Wallet.createRandom().address;
  const b3 = await zro.balanceOf(deposit3);
  await (await zro.transfer(deposit3, amount + tag)).wait();
  await (await zro.transfer(deposit3, amount + 999n)).wait();
  const d3 = (await zro.balanceOf(deposit3)) - b3;      // scanner sees one combined delta
  r = matchOrder({ amount: amount.toString(), tagged: (amount + tag).toString() }, d3.toString());
  ok('combined same-block payment is not mis-filled', r.action === 'none' && r.reason === 'over', JSON.stringify(r));

  // ── native path, the one used on GIWA ──
  const ethBuyer = ethers.Wallet.createRandom().connect(p);
  await p.send('anvil_setBalance', [ethBuyer.address, '0xDE0B6B3A7640000']); // 1 ETH
  const recipient = ethers.Wallet.createRandom().address;
  const beforeEth = await p.getBalance(recipient);
  await (await ethBuyer.sendTransaction({ to: recipient, value: 1_000_000_000_000_000n })).wait(); // 0.001 ETH
  const dEth = (await p.getBalance(recipient)) - beforeEth;
  ok('native ETH transfer arrives exactly', dEth === 1_000_000_000_000_000n, `${dEth} wei`);
  r = matchOrder({ amount: 1_000_000_000_000_000n.toString(), tagged: (1_000_000_000_000_000n + 5n).toString() }, dEth.toString());
  ok('native amount is matched with tolerance', r.action === 'fill' && r.exact === false, JSON.stringify(r));
} catch (e) {
  fail++;
  console.log('  FAIL exception:', e.message);
}
stop();
console.log(`== fork rehearsal (Base): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
