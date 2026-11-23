// Independent on-chain check of the deployed ZroAutoBridge on every chain: same code everywhere, owner / fee sink /
// OFT / token / EID / fees / pause, the live answer from LayerZero (quote), and an empty pending list.
import { Interface, keccak256 } from 'ethers';
const ADDR = process.argv[2] || '0xa14171c3Fc1daa118f102Ecb41B4849c54E72299';
const CH = { eth: 'https://ethereum-rpc.publicnode.com', arb: 'https://arb1.arbitrum.io/rpc', base: 'https://mainnet.base.org', bsc: 'https://bsc-dataseed.bnbchain.org',
  op: 'https://mainnet.optimism.io', polygon: 'https://polygon-bor-rpc.publicnode.com', avax: 'https://api.avax.network/ext/bc/C/rpc' };
const I = new Interface(['function owner() view returns (address)', 'function feeSink() view returns (address)', 'function oft() view returns (address)', 'function zro() view returns (address)',
  'function dstEid() view returns (uint32)', 'function feeBps() view returns (uint16)', 'function manualFeeBps() view returns (uint16)', 'function paused() view returns (bool)',
  'function pending() view returns (address[])', 'function quote(address,uint256,bool) view returns (uint256,uint256,uint256)', 'error RouteClosed()']);
const hashes = new Set();
for (const [k, url] of Object.entries(CH)) {
  const call = async (m, p) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(20000) }); const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data }); return j.result; };
  try {
    const code = await call('eth_getCode', [ADDR, 'latest']);
    if (!code || code === '0x') { console.log(k.padEnd(8), 'not deployed'); continue; }
    hashes.add(keccak256(code));
    const r = async (fn, args = []) => I.decodeFunctionResult(fn, await call('eth_call', [{ to: ADDR, data: I.encodeFunctionData(fn, args) }, 'latest']));
    const [owner, sink, oft, zro, eid, fee, mfee, paused, pend] = await Promise.all(['owner', 'feeSink', 'oft', 'zro', 'dstEid', 'feeBps', 'manualFeeBps', 'paused', 'pending'].map(f => r(f)));
    let route = 'OPEN';
    try { await r('quote', ['0x000000000000000000000000000000000000cafe', 10n ** 18n, true]); } catch (e) { route = /0x[0-9a-f]{8}/i.test(String(e.data)) ? 'closed (' + (I.parseError(e.data)?.name || e.data.slice(0, 10)) + ')' : 'closed'; }
    console.log(k.padEnd(8), (code.length / 2 - 1) + 'B', '| owner', owner[0].slice(0, 10), '| sink', sink[0].slice(0, 10), '| oft', oft[0].slice(0, 10), '| zro', zro[0].slice(0, 10), '| eid', Number(eid[0]),
      '| fees', Number(fee[0]) / 100 + '%/' + Number(mfee[0]) / 100 + '%', '| paused', paused[0], '| pending', pend[0].length, '| route', route);
  } catch (e) { console.log(k.padEnd(8), 'err', String(e.message).slice(0, 80)); }
}
console.log('distinct runtime code hashes across deployed chains:', hashes.size);
process.exit(0);
