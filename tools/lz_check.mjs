// Why the ZRO → Zero route is open or closed: reads the send library and executor config for EID 33002 on every source
// chain, then runs the same quoteSend the watcher uses and decodes the revert (0xc3baa0b7 = Executor_EidNotSupported(uint32)).
import { Interface, AbiCoder, JsonRpcProvider } from 'ethers';
const EP = '0x1a44076050125825900e736c501f859c50fE728c', OFT = '0x6985884C4392D348587B19cb9eAAf157F13271cd', EID = 33002;
const C = { eth: 'https://ethereum-rpc.publicnode.com', arb: 'https://arbitrum-one-rpc.publicnode.com', base: 'https://base-rpc.publicnode.com', bsc: 'https://bsc-dataseed.bnbchain.org' };
const I = new Interface(['function getSendLibrary(address,uint32) view returns (address)', 'function getConfig(address,address,uint32,uint32) view returns (bytes)']);
const Q = new Interface(['function quoteSend((uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd),bool) view returns ((uint256 nativeFee,uint256 lzTokenFee))']);
const coder = AbiCoder.defaultAbiCoder(), to32 = (a) => '0x' + a.slice(2).padStart(64, '0');
const legs = process.argv.includes('--json') ? null : 1;
for (const [k, url] of Object.entries(C)) {
  const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  try {
    const lib = I.decodeFunctionResult('getSendLibrary', await p.call({ to: EP, data: I.encodeFunctionData('getSendLibrary', [OFT, EID]) }))[0];
    const [maxMsg, executor] = coder.decode(['uint32', 'address'], I.decodeFunctionResult('getConfig', await p.call({ to: EP, data: I.encodeFunctionData('getConfig', [OFT, lib, EID, 1]) }))[0]);
    let state = 'OPEN', why = '';
    try { await p.call({ to: OFT, data: Q.encodeFunctionData('quoteSend', [{ dstEid: EID, to: to32('0x000000000000000000000000000000000000cafe'), amountLD: 10n ** 18n, minAmountLD: 10n ** 18n, extraOptions: '0x', composeMsg: '0x', oftCmd: '0x' }, false]) }); }
    catch (e) {
      state = 'CLOSED'; const d = String(e?.data || e?.info?.error?.data || '');
      why = d.startsWith('0xc3baa0b7') ? `Executor_EidNotSupported(${BigInt('0x' + d.slice(10, 74))})` : (d.slice(0, 10) || String(e.shortMessage || e.message).slice(0, 80));
    }
    console.log(k.padEnd(5), state.padEnd(7), why.padEnd(34), '| sendLib', lib, '| executor', executor, '| maxMsg', maxMsg);
  } catch (e) { console.log(k.padEnd(5), 'ERROR  ', String(e.shortMessage || e.message).slice(0, 90)); }
}
process.exit(0);
