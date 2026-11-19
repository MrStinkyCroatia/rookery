// Local replica of Robinhood Chain for tests: a clean anvil (chainId 4663) with the REAL Uniswap v3 + WETH bytecode
// copied from mainnet at the same addresses, plus the storage they need. Public Robinhood RPCs refuse archive reads,
// so a normal fork goes stale within a minute; this replica is deterministic and still runs the production code.
import { ethers } from 'ethers';
const LIVE = new ethers.JsonRpcProvider(process.env.RH_LIVE || 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const LOCAL = new ethers.JsonRpcProvider(process.env.RH_LOCAL || 'http://127.0.0.1:8550', 4663, { staticNetwork: true });
const C = {
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  npm: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  router: '0xCaf681a66D020601342297493863E78C959E5cb2',
  factoryV2: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
};
const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const ZERO = '0x' + '0'.repeat(64);
const hex32 = (n) => ethers.toBeHex(n, 32);

async function copy(addr, slots) {
  await LOCAL.send('anvil_setCode', [addr, await LIVE.getCode(addr)]);
  let n = 0;
  for (const s of slots) {
    const v = await LIVE.getStorage(addr, s);
    if (v !== ZERO) { await LOCAL.send('anvil_setStorageAt', [addr, typeof s === 'string' && s.length === 66 ? s : hex32(s), v]); n++; }
  }
  return n;
}
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

const implAddr = ethers.getAddress('0x' + (await LIVE.getStorage(C.weth, IMPL)).slice(26));
const out = {};
out.wethProxy = await copy(C.weth, [...range(0, 64), IMPL, ADMIN]);
out.wethImpl = await copy(implAddr, range(0, 8));
// factory: owner (3), feeAmountTickSpacing (4) for every tier, nothing else needed
const tiers = [100, 500, 3000, 10000].map(f => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint24', 'uint256'], [f, 4])));
out.factory = await copy(C.factory, [...range(0, 8), ...tiers]);
out.npm = await copy(C.npm, range(0, 32));
out.router = await copy(C.router, range(0, 16));
out.factoryV2 = await copy(C.factoryV2, range(0, 4));
// sanity: the replica answers like mainnet
const f = new ethers.Contract(C.factory, ['function feeAmountTickSpacing(uint24) view returns (int24)'], LOCAL);
const w = new ethers.Contract(C.weth, ['function symbol() view returns (string)'], LOCAL);
console.log(JSON.stringify({ ...out, wethImpl: implAddr, spacing10000: Number(await f.feeAmountTickSpacing(10000)), weth: await w.symbol() }));
