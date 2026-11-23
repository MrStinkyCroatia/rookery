// Independent on-chain balances of the platform hot wallet: ZRO and native on every chain the ledger uses.
const ZRO = '0x6985884C4392D348587B19cb9eAAf157F13271cd', HOT = process.argv[2] || '0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D';
const CH = { ethereum: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], arbitrum: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], bsc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'], optimism: ['https://mainnet.optimism.io'] };
const data = '0x70a08231' + HOT.slice(2).toLowerCase().padStart(64, '0');
let tot = 0;
for (const [k, urls] of Object.entries(CH)) {
  for (const u of urls) {
    try {
      const call = async (m, p) => { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(15000) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
      const [z, n, b] = await Promise.all([call('eth_call', [{ to: ZRO, data }, 'latest']), call('eth_getBalance', [HOT, 'latest']), call('eth_blockNumber', [])]);
      const zz = Number(BigInt(z)) / 1e18; tot += zz;
      console.log(k.padEnd(9), 'ZRO', zz.toFixed(2).padStart(10), '| native', (Number(BigInt(n)) / 1e18).toFixed(5), '| block', parseInt(b, 16), '|', u.split('/')[2]); break;
    } catch (e) { console.log(k.padEnd(9), 'err', String(e.message).slice(0, 60)); }
  }
}
console.log('total ZRO', tot.toFixed(2));
process.exit(0);
