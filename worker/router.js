// Rookery Router: buy and sell tokens of OTHER launchpads (and graduated tokens on DEXes) from the Terminal with the
// user's own wallet. Every trade goes through RookeryRouter (rhcurve/src/RookeryRouter.sol), which takes the
// platform fee (0.5%, both sides, hard cap 1%) and sends it to the network's fee sink: that balance funds the
// $臭企鹅 buy & burn.
//
// Launchpad contracts are only known at each mainnet, so every launchpad is an ADAPTER (config, not code):
//   { target, buy: { sig, args }, sell: { sig, args } }   args use the placeholders listed in ARG below.
// Before a launchpad is offered, the Terminal SIMULATES the exact router call (eth_call): this returns the real token
// amount and catches launchpads that refuse contract buyers (anti-bot), which then keep the "Trade on {pad}" link.
import { Interface, AbiCoder, getCreateAddress, Wallet, getAddress, id as keccakId } from 'ethers';
import { ROUTER_INITCODE } from './router_artifact.js';

export const ROUTER_FEE_BPS = 50;
// HD children (one pair per network, never shared): [deployer + owner of the router, fee sink]
export const ROUTER_IDX = { zero: [2_000_033_005, 2_000_033_006], giwa: [2_000_091_005, 2_000_091_006], litvm: [2_000_044_105, 2_000_044_106] };

export const ROUTER_ABI = new Interface([
  'function buy(address target, bytes data, address token, uint256 minOut, address to, uint256 deadline) payable returns (uint256)',
  'function sell(address target, bytes data, address token, uint256 amount, uint256 minOut, address to, uint256 deadline) returns (uint256)',
  'function setAllowed(address[] targets, bytes4[] selectors, uint8[] sides)',
  'function setFee(uint16 bps, address sink)',
  'function setPaused(bool on)',
  'function allowed(address, bytes4) view returns (uint8)',
  'function feeBps() view returns (uint16)',
  'function feeSink() view returns (address)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'error NotOwner()', 'error IsPaused()', 'error Expired()', 'error NotAllowed()', 'error BadTarget()', 'error Slippage()',
  'error CallFailed(bytes reason)', 'error TransferFailed()', 'error Zero()', 'error Reentrancy()',
]);
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)']);
const coder = AbiCoder.defaultAbiCoder();

// well-known reasons a launchpad / DEX refuses a router trade, shown to the user in plain words
const KNOWN = {
  [keccakId('NoContractsBeforeLaunch()').slice(0, 10)]: 'blocks contract buyers before bonding',
  [keccakId('CurveClosed()').slice(0, 10)]: 'curve is complete (bonded)',
  [keccakId('Slippage()').slice(0, 10)]: 'slippage',
};
export function explainRevert(data) {
  if (!data || data === '0x') return 'reverted';
  try {
    const e = ROUTER_ABI.parseError(data);
    if (e?.name === 'CallFailed') {
      const inner = e.args[0];
      if (inner && inner.length >= 10) {
        const k = KNOWN[inner.slice(0, 10)]; if (k) return k;
        if (inner.startsWith('0x08c379a0')) { try { return String(coder.decode(['string'], '0x' + inner.slice(10))[0]).slice(0, 120); } catch { /* */ } }
        return 'launchpad reverted (' + inner.slice(0, 10) + ')';
      }
      return 'launchpad reverted';
    }
    if (e) return { NotAllowed: 'launchpad not enabled on the router', IsPaused: 'router paused', Slippage: 'price moved (slippage)', Expired: 'deadline passed' }[e.name] || e.name;
  } catch { /* not a router error */ }
  if (data.startsWith('0x08c379a0')) { try { return String(coder.decode(['string'], '0x' + data.slice(10))[0]).slice(0, 120); } catch { /* */ } }
  return KNOWN[data.slice(0, 10)] || 'reverted (' + data.slice(0, 10) + ')';
}

// ── adapters ─────────────────────────────────────────────────────────────────────────────────────────────
// placeholders: token, amount (tokens sold), native (native spent after fee), zero, router, deadline, wnative,
//               pathBuy [wnative, token], pathSell [token, wnative], user; anything else is passed literally
const ARG = (a, c) => {
  switch (a) {
    case 'token': return c.token; case 'amount': return c.amount; case 'native': return c.native; case 'zero': return 0n;
    case 'router': return c.router; case 'deadline': return c.deadline; case 'wnative': return c.wnative; case 'user': return c.user;
    case 'pathBuy': return [c.wnative, c.token]; case 'pathSell': return [c.token, c.wnative];
    default: return a;
  }
};
export const BUILTIN = {
  // classic UniswapV2Router02 (and forks): pays native, recipient = router
  uniswapv2: {
    buy: { sig: 'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)', args: ['zero', 'pathBuy', 'router', 'deadline'] },
    sell: { sig: 'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)', args: ['amount', 'zero', 'pathSell', 'router', 'deadline'] },
  },
  // Uniswap SwapRouter02 V2 path: native is wrapped by the router; sells unwrap through multicall
  swaprouter02: {
    buy: { sig: 'swapExactTokensForTokens(uint256,uint256,address[],address)', args: ['native', 'zero', 'pathBuy', 'router'] },
    sell: { sig: 'multicall(uint256,bytes[])', special: 'sr02sell' },
  },
};
const selOf = (sig) => keccakId(sig).slice(0, 10);
const encodeSig = (sig, vals) => { const f = new Interface(['function ' + sig]); return f.encodeFunctionData(f.fragments[0].name, vals); };

export function legData(adapter, side, c) {
  const spec = (BUILTIN[adapter.kind] || {})[side] || adapter[side];
  if (!spec) throw new Error(`adapter has no ${side}`);
  if (spec.special === 'sr02sell') {
    const swap = encodeSig('swapExactTokensForTokens(uint256,uint256,address[],address)', [c.amount, 0n, [c.token, c.wnative], '0x0000000000000000000000000000000000000002']);
    const unwrap = encodeSig('unwrapWETH9(uint256,address)', [0n, c.router]);
    return encodeSig('multicall(uint256,bytes[])', [c.deadline, [swap, unwrap]]);
  }
  return encodeSig(spec.sig, spec.args.map(a => ARG(a, c)));
}
export function adapterSelectors(adapter) {
  const out = [];
  for (const side of ['buy', 'sell']) {
    const spec = (BUILTIN[adapter.kind] || {})[side] || adapter[side];
    if (spec) out.push({ target: getAddress(adapter.target), selector: selOf(spec.sig), side: side === 'buy' ? 1 : 2 });
  }
  return out;
}

// ── simulation + transaction building (pure: rpc is injected, so the same code runs in tests against a fork) ──
const hx = (n) => '0x' + BigInt(n).toString(16);
async function ethCall(rpc, call, override) {
  try { return { ok: true, data: await rpc('eth_call', override ? [call, 'latest', override] : [call, 'latest']) }; }
  catch (e) {
    const d = e?.data?.data || e?.data || (String(e?.message || '').match(/0x[0-9a-fA-F]{8,}/) || [])[0];
    return { ok: false, data: typeof d === 'string' ? d : null, message: e?.message };
  }
}

/** Build a router trade for the user's wallet.
 *  side 'buy': amount = native in (wei, fee included); side 'sell': amount = tokens to sell.
 *  Returns { ok, tx:{to,data,value}, approve?, expectedOut, minOut, fee, reason } */
export async function buildTrade({ rpc, router, adapter, side, token, amount, from, slippageBps = 300, wnative, feeBps = ROUTER_FEE_BPS, now = Math.floor(Date.now() / 1000) }) {
  amount = BigInt(amount); token = getAddress(token); from = getAddress(from); router = getAddress(router);
  if (amount <= 0n) return { ok: false, reason: 'amount must be positive' };
  const deadline = BigInt(now + 20 * 60);
  const c = { token, router, deadline, wnative, user: from, amount, native: amount - (amount * BigInt(feeBps)) / 10000n };
  const data = legData(adapter, side, c);
  const target = getAddress(adapter.target);
  if (side === 'buy') {
    const sim = await ethCall(rpc, { from, to: router, value: hx(amount), data: ROUTER_ABI.encodeFunctionData('buy', [target, data, token, 1n, from, deadline]) });
    if (!sim.ok) return { ok: false, reason: explainRevert(sim.data) || sim.message };
    const out = BigInt(ROUTER_ABI.decodeFunctionResult('buy', sim.data)[0]);
    const minOut = (out * BigInt(10000 - slippageBps)) / 10000n;
    return { ok: true, side, expectedOut: out.toString(), minOut: minOut.toString(), fee: ((amount * BigInt(feeBps)) / 10000n).toString(),
      tx: { to: router, value: hx(amount), data: ROUTER_ABI.encodeFunctionData('buy', [target, data, token, minOut, from, deadline]) } };
  }
  // sell: needs an allowance for the router first; the simulation runs once it is in place
  const al = await ethCall(rpc, { to: token, data: ERC20.encodeFunctionData('allowance', [from, router]) });
  const allowance = al.ok ? BigInt(al.data) : 0n;
  if (allowance < amount) {
    return { ok: true, side, needsApproval: true, approve: { to: token, data: ERC20.encodeFunctionData('approve', [router, amount]) } };
  }
  const sim = await ethCall(rpc, { from, to: router, data: ROUTER_ABI.encodeFunctionData('sell', [target, data, token, amount, 0n, from, deadline]) });
  if (!sim.ok) return { ok: false, reason: explainRevert(sim.data) || sim.message };
  const net = BigInt(ROUTER_ABI.decodeFunctionResult('sell', sim.data)[0]);
  const minOut = (net * BigInt(10000 - slippageBps)) / 10000n;
  const gross = (net * 10000n) / BigInt(10000 - feeBps);
  return { ok: true, side, expectedOut: net.toString(), minOut: minOut.toString(), fee: (gross - net).toString(),
    tx: { to: router, value: '0x0', data: ROUTER_ABI.encodeFunctionData('sell', [target, data, token, amount, minOut, from, deadline]) } };
}

/** Can this adapter trade this token through the router right now? Simulates a small buy from `from`
 *  (with a state override for the balance when the RPC supports it). */
export async function probe({ rpc, router, adapter, token, from, wnative, value = 10n ** 15n }) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const c = { token: getAddress(token), router: getAddress(router), deadline, wnative, user: from, amount: 0n, native: value - (value * BigInt(ROUTER_FEE_BPS)) / 10000n };
  const call = { from, to: router, value: hx(value), data: ROUTER_ABI.encodeFunctionData('buy', [getAddress(adapter.target), legData(adapter, 'buy', c), c.token, 1n, from, deadline]) };
  let r = await ethCall(rpc, call, { [from]: { balance: hx(10n ** 21n) } });
  if (!r.ok && /override|invalid params|argument/i.test(r.message || '')) r = await ethCall(rpc, call);
  if (r.ok) return { ok: true, out: BigInt(ROUTER_ABI.decodeFunctionResult('buy', r.data)[0]).toString() };
  return { ok: false, reason: explainRevert(r.data) || r.message };
}

export function installRouter(Cls) {
  const P = Cls.prototype;
  const NETS = Object.keys(ROUTER_IDX);
  const chk = (net) => { if (!NETS.includes(net)) throw new Error('unknown network ' + net); return net; };

  P.routerAddrs = function (net) {
    chk(net);
    const [d, s] = ROUTER_IDX[net], m = this.master();
    const deployer = m.deriveChild(d).address;
    const a = { network: net, router: getCreateAddress({ from: deployer, nonce: 0 }), owner: deployer, deployer, feeSink: m.deriveChild(s).address, feeBps: ROUTER_FEE_BPS };
    const all = JSON.parse(this.meta('router_addrs_v1') || '{}');
    if (!all[net]) { all[net] = a; this.setMeta('router_addrs_v1', JSON.stringify(all)); }
    else if (all[net].router !== a.router || all[net].feeSink !== a.feeSink) throw new Error(`reserved ${net} router addresses changed: refusing`);
    return a;
  };
  P.routerCfg = function (net) {
    const c = JSON.parse(this.meta('router_cfg_' + chk(net)) || '{}');
    c.pads = c.pads || {}; return c;
  };
  P.routerSaveCfg = function (net, c) { this.setMeta('router_cfg_' + net, JSON.stringify(c)); };
  P.routerRpc = function (net) {
    const url = this.netRpcUrl(net);
    if (!url) return null;
    return async (method, params) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.data = j.error.data; throw e; }
      return j.result;
    };
  };

  // what the Terminal shows for one token: can it be traded through Rookery, and through which adapter?
  P.routeInfo = async function (net, token) {
    chk(net);
    const a = this.routerAddrs(net), cfg = this.routerCfg(net);
    let chainId = Number(this.meta(net + '_chainid') || 0) || null;
    if (!chainId && net !== 'litvm') { try { chainId = this.netChainId(net); } catch { /* */ } }
    const base = { network: net, router: a.router, feeBps: ROUTER_FEE_BPS, feeTo: '$臭企鹅 buy & burn', chainId };
    const rpc = this.routerRpc(net);
    if (!rpc) return { ...base, available: false, reason: 'opens when the network RPC is live' };
    if (!cfg.deployed) return { ...base, available: false, reason: 'router not deployed on this network yet' };
    const row = this.sql.exec('SELECT pad FROM term_tokens WHERE chain=? AND addr=?', net, String(token).toLowerCase()).toArray()[0];
    const tries = [];
    if (row?.pad && cfg.pads[row.pad]?.enabled) tries.push({ id: row.pad, ad: cfg.pads[row.pad] });
    if (cfg.dex?.enabled) tries.push({ id: 'dex', ad: cfg.dex });
    if (!tries.length) return { ...base, available: false, pad: row?.pad || null, reason: row?.pad ? 'this launchpad is not connected to the router yet' : 'unknown token' };
    let last = null;
    const from = a.feeSink;   // any EOA; state override gives it a balance for the simulation
    for (const t of tries) {
      const r = await probe({ rpc, router: a.router, adapter: t.ad, token, from, wnative: cfg.dex?.wnative || cfg.wnative });
      if (r.ok) return { ...base, available: true, via: t.id };
      last = { via: t.id, reason: r.reason };
    }
    return { ...base, available: false, pad: row?.pad || null, ...last };
  };

  P.routeBuild = async function (net, b) {
    const info = await this.routeInfo(net, b.token);
    if (!info.available) throw new Error('Not tradeable through Rookery: ' + info.reason);
    const cfg = this.routerCfg(net), ad = info.via === 'dex' ? cfg.dex : cfg.pads[info.via];
    const r = await buildTrade({ rpc: this.routerRpc(net), router: info.router, adapter: ad, side: b.side === 'sell' ? 'sell' : 'buy', token: b.token,
      amount: BigInt(b.amount), from: b.from, slippageBps: Math.max(10, Math.min(5000, Number(b.slippageBps) || 300)), wnative: cfg.dex?.wnative || cfg.wnative });
    return { ...r, via: info.via, chainId: info.chainId, router: info.router, feeBps: ROUTER_FEE_BPS };
  };

  // ── owner operations (admin) ──
  P.routerSign = async function (net, tx, confirm) {
    const rpc = this.routerRpc(net); if (!rpc) throw new Error('no RPC for ' + net);
    const k = this.master().deriveChild(ROUTER_IDX[net][0]);
    const w = new Wallet(k.privateKey);
    const chainId = Number(BigInt(await rpc('eth_chainId', [])));
    const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [w.address, 'pending'])));
    if (confirm === 'DEPLOY' && nonce !== 0) throw new Error(`router deployer nonce is ${nonce}, not 0: refusing (the reserved address would not match)`);
    const est = BigInt(await rpc('eth_estimateGas', [{ from: w.address, to: tx.to || undefined, data: tx.data, value: '0x0' }]));
    const gp = BigInt(await rpc('eth_gasPrice', []));
    const raw = await w.signTransaction({ chainId, nonce, to: tx.to || null, data: tx.data, value: 0n, gasLimit: (est * 12n) / 10n, gasPrice: gp });
    const hash = await rpc('eth_sendRawTransaction', [raw]);
    for (let i = 0; i < 120; i++) { const rc = await rpc('eth_getTransactionReceipt', [hash]); if (rc) { if (rc.status !== '0x1') throw new Error('transaction failed ' + hash); return { hash, receipt: rc }; } await new Promise(r => setTimeout(r, 1000)); }
    throw new Error('no receipt for ' + hash);
  };
  P.routerDeploy = async function (net, b = {}) {
    if (b.confirm !== 'DEPLOY') throw new Error('pass confirm: "DEPLOY"');
    const a = this.routerAddrs(net), rpc = this.routerRpc(net); if (!rpc) throw new Error('no RPC for ' + net);
    const code = await rpc('eth_getCode', [a.router, 'latest']);
    const cfg = this.routerCfg(net);
    if (code && code !== '0x') { cfg.deployed = true; this.routerSaveCfg(net, cfg); return { ok: true, already: true, router: a.router }; }
    const args = coder.encode(['address', 'address'], [a.owner, a.feeSink]).slice(2);
    let evm = b.evm || 'cancun', last;
    for (const v of b.evm ? [evm] : ['cancun', 'paris']) {
      try { evm = v; const r = await this.routerSign(net, { data: ROUTER_INITCODE[v] + args }, 'DEPLOY'); cfg.deployed = true; cfg.evm = v; cfg.deployTx = r.hash; this.routerSaveCfg(net, cfg); return { ok: true, router: a.router, evm: v, hash: r.hash }; }
      catch (e) { last = e; if (!/invalid opcode|opcode|not supported|PUSH0/i.test(e.message)) break; }
    }
    throw last;
  };
  P.routerAllow = async function (net) {
    const a = this.routerAddrs(net), cfg = this.routerCfg(net);
    const sels = [];
    for (const ad of [cfg.dex, ...Object.values(cfg.pads)]) if (ad?.enabled) sels.push(...adapterSelectors(ad));
    if (!sels.length) throw new Error('no enabled adapters');
    const r = await this.routerSign(net, { to: a.router, data: ROUTER_ABI.encodeFunctionData('setAllowed', [sels.map(s => s.target), sels.map(s => s.selector), sels.map(s => s.side)]) });
    cfg.allowedAt = Date.now(); cfg.allowed = sels; this.routerSaveCfg(net, cfg);
    return { ok: true, hash: r.hash, allowed: sels };
  };
  P.routerFees = async function (net) {
    const a = this.routerAddrs(net), rpc = this.routerRpc(net);
    if (!rpc) return { network: net, feeSink: a.feeSink, balance: null, note: 'no RPC yet' };
    const bal = BigInt(await rpc('eth_getBalance', [a.feeSink, 'latest']));
    return { network: net, feeSink: a.feeSink, balance: bal.toString(), note: 'native fees waiting for the $臭企鹅 buy & burn' };
  };
}
