// End-to-end: the worker's router module (worker/router.js) against a Robinhood Chain fork with real contracts.
// Deploys RookeryRouter from the worker's own init code, a launchpad curve (RookeryCurve2), one pre-bonding token and
// one graduated token (real Uniswap V2 pool via the official SwapRouter02), then lets buildTrade/probe build the
// transactions a user's wallet would sign.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, getCreateAddress } from 'ethers';
import { ROUTER_INITCODE } from '../worker/router_artifact.js';
import { buildTrade, probe, adapterSelectors, ROUTER_ABI } from '../worker/router.js';

const FORK = 'https://robinhood-rpc.publicnode.com';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', FV2 = '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f', SR02 = '0xCaf681a66D020601342297493863E78C959E5cb2';
const PORT = 8547, URL = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--fork-url', FORK, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0;
const rpc = async (method, params) => {
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.data = j.error.data; throw e; } return j.result;
};
for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId', []); break; } catch { await sleep(500); } }
const [owner, , alice] = (await rpc('eth_accounts', [])).slice(0, 3);
// anvil's own dev accounts keep a pinned balance on this fork, so the user and the fee sink are fresh addresses
const user = '0x000000000000000000000000000000000000cafe', sink = '0x000000000000000000000000000000000000b0b0';
await rpc('anvil_setBalance', [user, '0x56bc75e2d63100000']); await rpc('anvil_impersonateAccount', [user]);
const coder = AbiCoder.defaultAbiCoder();
const results = []; const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); };
async function send(from, tx) {
  const h = await rpc('eth_sendTransaction', [{ from, ...tx }]);
  let rc = null;
  for (let i = 0; i < 100 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await sleep(200); }
  if (!rc || rc.status !== '0x1') throw new Error('tx failed ' + h);
  return rc;
}
const bal = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const ERC = new Interface(['function balanceOf(address) view returns (uint256)']);
const tbal = async (t, a) => BigInt(await rpc('eth_call', [{ to: t, data: ERC.encodeFunctionData('balanceOf', [a]) }, 'latest']));

try {
  // 1. router from the worker's init code; owner = account 0, fee sink = account 3
  const routerAddr = getCreateAddress({ from: owner, nonce: Number(BigInt(await rpc('eth_getTransactionCount', [owner, 'latest']))) });
  await send(owner, { data: ROUTER_INITCODE.cancun + coder.encode(['address', 'address'], [owner, sink]).slice(2) });
  ok('router deployed from worker init code at the predicted address', (await rpc('eth_getCode', [routerAddr, 'latest'])).length > 10, routerAddr);

  // 2. a launchpad: RookeryCurve2 + one pre-bonding token + one graduated token
  const C = JSON.parse(readFileSync('rhcurve/out/RookeryCurve2.sol/RookeryCurve2.json', 'utf8'));
  const CI = new Interface(C.abi);
  const curve = getCreateAddress({ from: owner, nonce: Number(BigInt(await rpc('eth_getTransactionCount', [owner, 'latest']))) });
  await send(owner, { data: C.bytecode.object + CI.encodeDeploy([WETH, FV2, SR02, owner, 2_400_000_000_000_000_000n]).slice(2), gas: '0x1c9c380' });
  const mk = async (name) => {
    const rc = await send(alice, { to: curve, value: '0x16345785d8a0000', data: CI.encodeFunctionData('create', [name, name.slice(0, 4).toUpperCase(), '0x0000000000000000000000000000000000000000', 100, 50, 100, 0, 0]), gas: '0x989680' });
    const ev = rc.logs.map(l => { try { return CI.parseLog(l); } catch { return null; } }).find(x => x?.name === 'Created');
    return ev.args.token;
  };
  const pre = await mk('Early Bird'), grad = await mk('Graduate');
  await send(alice, { to: curve, value: '0xa688906bd8b00000', data: CI.encodeFunctionData('buy', [grad, 0, 0]), gas: '0x989680' });   // 12 ETH fills it
  await send(alice, { to: curve, data: CI.encodeFunctionData('graduate', [grad]), gas: '0x1c9c380' });
  ok('launchpad tokens ready (one pre-bonding, one graduated to Uniswap V2)', true, `pre ${pre} · graduated ${grad}`);

  // 3. adapters exactly as the admin panel stores them
  const padAdapter = { target: curve, buy: { sig: 'buy(address,uint256,uint256)', args: ['token', 'zero', 'zero'] }, sell: { sig: 'sell(address,uint256,uint256)', args: ['token', 'amount', 'zero'] }, enabled: true };
  const dexAdapter = { kind: 'swaprouter02', target: SR02, wnative: WETH, enabled: true };
  const sels = [...adapterSelectors(padAdapter), ...adapterSelectors(dexAdapter)];
  await send(owner, { to: routerAddr, data: ROUTER_ABI.encodeFunctionData('setAllowed', [sels.map(s => s.target), sels.map(s => s.selector), sels.map(s => s.side)]) });
  ok('adapters allowlisted on the router', sels.length === 4, sels.map(s => s.selector).join(' '));

  // 4. probes: the pre-bonding token blocks contracts, the graduated one routes through the DEX
  const p1 = await probe({ rpc, router: routerAddr, adapter: padAdapter, token: pre, from: user, wnative: WETH });
  ok('probe: launchpad that blocks contract buyers is detected', !p1.ok && /blocks contract buyers/.test(p1.reason), p1.reason);
  const p2 = await probe({ rpc, router: routerAddr, adapter: dexAdapter, token: grad, from: user, wnative: WETH });
  ok('probe: graduated token routes through the DEX', p2.ok, `simulated ${p2.out} tokens for 0.001 ETH`);

  // 5. buy 1 ETH through the router from the user's wallet
  const s0 = await bal(sink), t0 = await tbal(grad, user);
  const b = await buildTrade({ rpc, router: routerAddr, adapter: dexAdapter, side: 'buy', token: grad, amount: 10n ** 18n, from: user, wnative: WETH, slippageBps: 100 });
  ok('buildTrade(buy): simulation returns the exact amount', b.ok && BigInt(b.expectedOut) > 0n, `expected ${b.expectedOut}, min ${b.minOut}, fee ${b.fee}`);
  const uB = await bal(user);
  const brc = await send(user, { ...b.tx, gas: '0x7a1200' });
  if (process.env.DBG) {
    for (const l of brc.logs) { try { const e = ROUTER_ABI.parseLog(l); if (e) console.log('DBG event', e.name); } catch { /* */ } }
    const RA = new Interface(['event Bought(address indexed user, address indexed token, address indexed target, address to, uint256 nativeIn, uint256 fee, uint256 tokensOut)']);
    for (const l of brc.logs) { try { const e = RA.parseLog(l); if (e) console.log('DBG Bought nativeIn', e.args.nativeIn, 'fee', e.args.fee); } catch { /* */ } }
    console.log('DBG user spent', uB - await bal(user), 'gasUsed', BigInt(brc.gasUsed), 'price', BigInt(brc.effectiveGasPrice), 'block', brc.blockNumber,
      'sink@block', await rpc('eth_getBalance', [sink, brc.blockNumber]), 'sink@prev', await rpc('eth_getBalance', [sink, '0x' + (BigInt(brc.blockNumber) - 1n).toString(16)]));
  }
  const got = (await tbal(grad, user)) - t0;
  ok('buy executed: user got exactly the simulated amount', got === BigInt(b.expectedOut), String(got));
  if (process.env.DBG) { const fs = ROUTER_ABI.decodeFunctionResult('feeSink', await rpc('eth_call', [{ to: routerAddr, data: ROUTER_ABI.encodeFunctionData('feeSink', []) }, 'latest']))[0]; console.log('DBG sink', sink, 'router.feeSink', fs, 'before', s0, 'after', await bal(sink), 'block', await rpc('eth_blockNumber', []), 'getBalance raw', await rpc('eth_getBalance', [sink, 'latest']), await rpc('eth_getBalance', [sink, 'pending'])); }
  ok('buy fee: 0.5% of 1 ETH to the fee sink', (await bal(sink)) - s0 === 5n * 10n ** 15n, String((await bal(sink)) - s0));

  // 6. sell half: first the approval, then the trade
  const half = got / 2n;
  const a1 = await buildTrade({ rpc, router: routerAddr, adapter: dexAdapter, side: 'sell', token: grad, amount: half, from: user, wnative: WETH });
  ok('buildTrade(sell): asks for approval first', a1.ok && a1.needsApproval && a1.approve?.to?.toLowerCase() === grad.toLowerCase());
  await send(user, a1.approve);
  const sl = await buildTrade({ rpc, router: routerAddr, adapter: dexAdapter, side: 'sell', token: grad, amount: half, from: user, wnative: WETH, slippageBps: 100 });
  ok('buildTrade(sell): simulation after approval', sl.ok && !sl.needsApproval && BigInt(sl.expectedOut) > 0n, `expected ${sl.expectedOut} wei, fee ${sl.fee}`);
  const u0 = await bal(user), s1 = await bal(sink);
  const rc = await send(user, { ...sl.tx, gas: '0x7a1200' });
  const gasCost = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
  const recv = (await bal(user)) + gasCost - u0, fee = (await bal(sink)) - s1;
  ok('sell executed: user received the simulated native amount', recv === BigInt(sl.expectedOut), String(recv));
  ok('sell fee: 0.5% of the proceeds to the fee sink', fee === ((recv + fee) * 50n) / 10000n, `${fee} of ${recv + fee}`);
  ok('router keeps nothing', (await bal(routerAddr)) === 0n && (await tbal(grad, routerAddr)) === 0n);

  // 7. slippage guard: a stale quote fails instead of filling worse
  const st = await buildTrade({ rpc, router: routerAddr, adapter: dexAdapter, side: 'buy', token: grad, amount: 10n ** 18n, from: user, wnative: WETH, slippageBps: 10 });
  await send(alice, { ...((await buildTrade({ rpc, router: routerAddr, adapter: dexAdapter, side: 'buy', token: grad, amount: 3n * 10n ** 18n, from: alice, wnative: WETH })).tx), gas: '0x7a1200' });
  let reverted = false; try { await send(user, { ...st.tx, gas: '0x7a1200' }); } catch { reverted = true; }
  ok('slippage: a buy after the price moved past the limit reverts', reverted);
} catch (e) { results.push(['FAIL', 'exception', e.message]); }
anvil.kill();
for (const r of results) console.log(r[0], '·', r[1], r[2] ? '· ' + r[2] : '');
console.log(results.filter(r => r[0] === 'PASS').length + '/' + results.length + ' passed');
process.exit(0);
