// Zero 1:1 migration runner. Environment-agnostic: the worker runs it with the real keys on Zero mainnet, and
// tools/zero_rehearsal.mjs runs the very same code against a local chain (chain id 33002) with the real snapshot.
// Every step is idempotent and resumable: state is saved after each transaction, and a step whose result is already
// on-chain (code at the predicted address, token already imported) is skipped.
import { AbiCoder, Interface, getAddress, getCreateAddress, getCreate2Address, keccak256, toUtf8Bytes } from 'ethers';

export const PROXY_HASH = '0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f';
const V_TOKEN = 1_073_000_000n * 10n ** 18n;
const SUPPLY = 1_000_000_000n * 10n ** 18n;
const CURVE_TOKENS = 800_000_000n * 10n ** 18n;
const coder = AbiCoder.defaultAbiCoder();
const CURVE = new Interface([
  'function importCurve(string name,string symbol,address creator,uint16 taxMkt,uint16 taxBurn,uint16 taxRew,uint256 vQuote,uint256 sold,uint256 burned,address custody,string ledgerId) payable returns (address)',
  'function curves(address) view returns (address creator,address quote,uint128 vQuote,uint128 realQuote,uint128 sold,uint64 createdAt,bool complete,bool graduated,address pair)',
  'function owner() view returns (address)', 'function deployer() view returns (address)', 'function predictImported(string) view returns (address)',
  'function weth() view returns (address)', 'function factoryV2() view returns (address)',
]);
const DEPLOYER = new Interface(['function STUB_HASH() view returns (bytes32)']);
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function creator() view returns (address)']);

const divUp = (a, b) => (a + b - 1n) / b;
export const requiredReserve = (vQuote, sold) => (sold === 0n ? 0n : divUp(vQuote * V_TOKEN, V_TOKEN - sold) - vQuote);

export function predictZero(deployer, dexDeployer) {
  const curve = getCreateAddress({ from: deployer, nonce: 0 });
  const factory = getCreateAddress({ from: curve, nonce: 1 });
  const dex = dexDeployer ? { weth: getCreateAddress({ from: dexDeployer, nonce: 0 }), factoryV2: getCreateAddress({ from: dexDeployer, nonce: 1 }), router: getCreateAddress({ from: dexDeployer, nonce: 2 }) } : null;
  return { curve, factory, dex, token: (id) => getCreateAddress({ from: getCreate2Address(factory, keccak256(toUtf8Bytes(String(id))), PROXY_HASH), nonce: 1 }) };
}

// on-chain limits: name <= 32 bytes, symbol <= 12 bytes (UTF-8); cut on a character boundary
export function fitBytes(s, max) {
  let out = '';
  for (const ch of String(s || '')) { if (new TextEncoder().encode(out + ch).length > max) break; out += ch; }
  return out;
}

/**
 * io: { rpc(method, params), send(role, {to?, data, value?}) -> receipt, addr: {deployer, dex, custody, feeTo}, load(), save(state), log(line) }
 * plan: { snapshot, artifacts, creators: {u<id>: address}, chainId, vNative (wei, virtual reserve for future native launches), build?: 'auto'|'cancun'|'paris', only?: [ids], dryRun?,
 *         dex: 'own' (deploy official Uniswap V2 + WZRO from the dex wallet) | { weth, factoryV2, router } (an existing V2-compatible DEX on Zero) }
 * The DEX is chosen on migration day on purpose: it is a constructor argument of the curve, so it never changes any reserved address.
 */
export async function zeroRun(io, plan) {
  const st = (await io.load()) || { v: 1, steps: {}, imports: {} };
  const save = async () => io.save(st);
  const log = (m) => { st.log = [...(st.log || []), `${new Date().toISOString().slice(11, 19)} ${m}`].slice(-200); io.log?.(m); };
  const code = async (a) => (await io.rpc('eth_getCode', [a, 'latest'])) || '0x';
  const nonce = async (a) => Number(BigInt(await io.rpc('eth_getTransactionCount', [a, 'latest'])));
  const call = async (to, iface, fn, args = []) => iface.decodeFunctionResult(fn, await io.rpc('eth_call', [{ to, data: iface.encodeFunctionData(fn, args) }, 'latest']));
  const P = predictZero(io.addr.deployer, io.addr.dex);
  const rep = { chainId: 0, predicted: { curve: P.curve, factory: P.factory, dex: P.dex }, steps: [] };

  // 0 · preflight
  if (!plan.dex) throw new Error("choose the graduation DEX first: dex 'own' or { weth, factoryV2, router }");
  rep.chainId = Number(BigInt(await io.rpc('eth_chainId', [])));
  if (plan.chainId && rep.chainId !== Number(plan.chainId)) throw new Error(`wrong chain id ${rep.chainId}, expected ${plan.chainId}`);
  const curveCode = await code(P.curve);
  const depNonce = await nonce(io.addr.deployer);
  if (curveCode === '0x' && depNonce !== 0) throw new Error(`ABORT: deployer nonce is ${depNonce} and the curve is not at ${P.curve}: reserved addresses can no longer be met`);
  if (Number(plan.snapshot.v || 1) < 2) throw new Error('snapshot v1 stores virtual reserves in whole units: take a v2 snapshot');
  const markets = plan.snapshot.markets.filter(m => m.state === 'curve' && (!plan.only || plan.only.includes(m.id)));
  const odd = markets.filter(m => BigInt(m.curve.virtualTokens) !== V_TOKEN || BigInt(m.curve.virtualQuote) < 10n ** 18n);
  if (odd.length) throw new Error('markets with a curve the contract cannot reproduce: ' + odd.map(m => m.id).join(', '));
  const need = markets.reduce((a, m) => a + requiredReserve(BigInt(m.curve.virtualQuote), BigInt(m.curve.tokensSold)), 0n);
  const ledger = markets.reduce((a, m) => a + BigInt(m.curve.quoteReserve), 0n);
  const bal = BigInt(await io.rpc('eth_getBalance', [io.addr.deployer, 'latest']));
  let zroErc20 = 0n;
  try { zroErc20 = BigInt(await io.rpc('eth_call', [{ to: '0x1ced7d571059a30db0fc9adc40346d2a1ce55b31', data: '0x70a08231' + io.addr.deployer.slice(2).toLowerCase().padStart(64, '0') }, 'latest'])); } catch { /* no OFT here */ }
  rep.funds = { reservesNeededWei: need.toString(), ledgerReservesWei: ledger.toString(), deployerBalanceWei: bal.toString(), deployerZroErc20Wei: zroErc20.toString(), markets: markets.length };
  if (!plan.dryRun && bal < need) throw new Error(`deployer holds ${Number(bal) / 1e18} native ZRO, needs ${Number(need) / 1e18} + gas${zroErc20 ? ` (it has ${Number(zroErc20) / 1e18} as the OFT ERC-20: unwrap first)` : ''}`);
  log(`preflight chain ${rep.chainId} · deployer nonce ${depNonce} · ${markets.length} markets · reserves ${Number(need) / 1e18} (ledger ${Number(ledger) / 1e18}) · balance ${Number(bal) / 1e18}`);
  if (plan.dryRun) return { ...rep, dryRun: true, state: st };

  // 1 · curve build that this EVM accepts (estimate only: no transaction, no nonce spent)
  let DEX = P.dex;
  if (plan.dex !== 'own') {
    DEX = { weth: getAddress(plan.dex.weth), factoryV2: getAddress(plan.dex.factoryV2), router: getAddress(plan.dex.router) };
    for (const [k, a] of Object.entries(DEX)) if ((await code(a)) === '0x') throw new Error(`dex ${k} has no code at ${a}`);
    // must be a Uniswap V2-style factory: allPairsLength() answers
    try { await io.rpc('eth_call', [{ to: DEX.factoryV2, data: '0x574f2ba3' }, 'latest']); } catch { throw new Error('factoryV2 is not Uniswap V2-compatible (allPairsLength)'); }
  }
  rep.dex = { mode: plan.dex === 'own' ? 'own' : 'external', ...DEX };
  const ctorArgs = (dex) => coder.encode(['address', 'address', 'address', 'address', 'uint256'], [dex.weth, dex.factoryV2, dex.router, io.addr.feeTo, BigInt(plan.vNative)]).slice(2);
  if (!st.build) {
    const tries = plan.build && plan.build !== 'auto' ? [plan.build] : ['cancun', 'paris'];
    for (const b of tries) {
      try { await io.rpc('eth_estimateGas', [{ from: io.addr.deployer, data: plan.artifacts['RookeryCurve2_' + b].bytecode + ctorArgs(DEX) }]); st.build = b; break; }
      catch (e) { log(`build ${b} rejected by this EVM: ${String(e.message || e).slice(0, 80)}`); }
    }
    if (!st.build) throw new Error('no curve build accepted by this EVM');
    await save();
  }
  rep.build = st.build;
  if (st.dex && JSON.stringify(st.dex) !== JSON.stringify(rep.dex)) throw new Error('this run already chose another DEX: ' + JSON.stringify(st.dex));
  st.dex = rep.dex; await save();

  // 2 · DEX: WZRO (WETH9), Uniswap V2 factory + router02, from the dedicated dex wallet at nonces 0, 1, 2 (own mode only)
  if (plan.dex === 'own') for (const [i, k, art, args] of [[0, 'weth', 'WETH9', ''], [1, 'factoryV2', 'UniswapV2Factory', coder.encode(['address'], [io.addr.custody]).slice(2)],
    [2, 'router', 'UniswapV2Router02', coder.encode(['address', 'address'], [P.dex.factoryV2, P.dex.weth]).slice(2)]]) {
    if ((await code(P.dex[k])) !== '0x') { st.steps[k] = 'ok'; continue; }
    const n = await nonce(io.addr.dex);
    if (n !== i) throw new Error(`ABORT: dex wallet nonce ${n}, expected ${i} for ${k}`);
    const rc = await io.send('dex', { data: plan.artifacts[art].bytecode + args });
    if (getAddress(rc.contractAddress) !== getAddress(P.dex[k])) throw new Error(`${k} landed at ${rc.contractAddress}, expected ${P.dex[k]}`);
    st.steps[k] = rc.transactionHash; log(`${art} → ${P.dex[k]}`); await save();
  }

  // 3 · curve: the deployer's FIRST transaction on this chain
  if ((await code(P.curve)) === '0x') {
    const rc = await io.send('deployer', { data: plan.artifacts['RookeryCurve2_' + st.build].bytecode + ctorArgs(DEX) });
    if (getAddress(rc.contractAddress) !== getAddress(P.curve)) throw new Error(`curve landed at ${rc.contractAddress}, expected ${P.curve}`);
    st.steps.curve = rc.transactionHash; log(`RookeryCurve2 (${st.build}) → ${P.curve}`); await save();
  }
  const [dep] = await call(P.curve, CURVE, 'deployer');
  if (getAddress(dep) !== getAddress(P.factory)) throw new Error(`token factory is ${dep}, expected ${P.factory}`);
  const [stub] = await call(P.factory, DEPLOYER, 'STUB_HASH');
  if (stub !== PROXY_HASH) throw new Error('CREATE3 proxy hash mismatch');
  const [owner] = await call(P.curve, CURVE, 'owner');
  if (getAddress(owner) !== getAddress(io.addr.deployer)) throw new Error('curve owner is not the deployer');

  // 4 · import every curve 1:1 at its reserved address
  let done = 0;
  for (const m of markets) {
    const want = P.token(m.id);
    const sold = BigInt(m.curve.tokensSold), burned = BigInt(m.burned), vq = BigInt(m.curve.virtualQuote);
    const row = st.imports[m.id] || {};
    if ((await code(want)) !== '0x') { st.imports[m.id] = { ...row, token: want, status: 'ok' }; done++; continue; }
    const creator = plan.creators?.[m.creator] || io.addr.custody;
    const name = fitBytes(m.name, 32) || fitBytes(m.symbol, 32) || 'Rookery token';
    const symbol = fitBytes(m.symbol, 12) || 'ROOK';
    const t = m.taxesBps;
    const data = CURVE.encodeFunctionData('importCurve', [name, symbol, creator, t.marketing, t.burn, t.rewards, vq, sold, burned, io.addr.custody, m.id]);
    const rc = await io.send('deployer', { to: P.curve, data, value: requiredReserve(vq, sold) });
    if (Number(rc.status) !== 1) throw new Error(`import ${m.id} reverted (${rc.transactionHash})`);
    if ((await code(want)) === '0x') throw new Error(`import ${m.id}: nothing at reserved address ${want}`);
    st.imports[m.id] = { token: want, tx: rc.transactionHash, status: 'ok', creator, name, symbol };
    done++; log(`import ${m.symbol} (${m.id}) → ${want}`); await save();
  }
  rep.imported = done;

  // 5 · checks: custody holds every user's balance 1:1, supply, curve state, price continuity.
  //     They describe the moment of import, so they run once; after that the tokens trade and state moves on.
  if (st.finished && !plan.recheck) { rep.checks = st.checks; return { ...rep, state: { build: st.build, steps: st.steps, imports: Object.keys(st.imports).length, finished: st.finished } }; }
  const bad = [];
  for (const m of markets) {
    const tok = P.token(m.id);
    const sold = BigInt(m.curve.tokensSold), burned = BigInt(m.burned), vq = BigInt(m.curve.virtualQuote);
    const [cb] = await call(tok, ERC20, 'balanceOf', [io.addr.custody]);
    const [ts] = await call(tok, ERC20, 'totalSupply');
    const c = await call(P.curve, CURVE, 'curves', [tok]);
    const real = requiredReserve(vq, sold);
    const held = BigInt(m.heldByUsers);
    const priceChain = ((vq + real) * 10n ** 18n) / (V_TOKEN - sold);
    const priceLedger = BigInt(m.lastPrice || 0);
    const drift = priceLedger ? Number(priceChain - priceLedger) / Number(priceLedger) : 0;
    const issues = [];
    if (cb !== held) issues.push(`custody ${cb} != held ${held}`);
    if (ts !== SUPPLY - burned) issues.push(`supply ${ts} != ${SUPPLY - burned}`);
    if (c.sold !== sold) issues.push(`sold ${c.sold} != ${sold}`);
    if (c.realQuote !== real) issues.push(`reserve ${c.realQuote} != ${real}`);
    if (Math.abs(drift) > 1e-6) issues.push(`price drift ${drift}`);
    if (sold > CURVE_TOKENS) issues.push('sold above curve');
    if (issues.length) bad.push({ id: m.id, issues });
  }
  rep.checks = { markets: markets.length, failed: bad.length, bad: bad.slice(0, 10) };
  st.checks = rep.checks;
  st.finished = bad.length ? null : new Date().toISOString();
  log(`checks: ${markets.length - bad.length}/${markets.length} OK`);
  await save();
  return { ...rep, state: { build: st.build, steps: st.steps, imports: Object.keys(st.imports).length, finished: st.finished } };
}
