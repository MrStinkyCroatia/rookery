import { ethers } from 'ethers';
const API = 'https://rookery.stinkypenguin.xyz/api', KEY = process.env.ADMIN_KEY;
let cookie = '';
const call = async (m, p, b, admin) => {
  if (admin) b = { ...(b || {}), key: KEY };
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return r.json().catch(() => ({ error: 'http ' + r.status }));
};
const w = ethers.Wallet.createRandom();
const n = await call('POST', '/auth/wallet/nonce', { address: w.address });
const lg = await call('POST', '/auth/wallet/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) });
console.log('user', lg.username || lg.error);
await call('POST', '/admin/credit', { user: lg.username, asset: 'ltc', amount: (2n * 10n ** 16n).toString() }, true);
const me = await call('GET', '/me');
console.log('LTC balance', (Number(BigInt(me.me?.ltc || 0)) / 1e18).toFixed(5));
const to = 'ltc1qjf0n0gug5m3pxa3thtl7rv9x2g2c2nzvpxqrdv';
const out = await call('POST', '/ltc/withdraw', { amount: '0.01', to });
console.log('withdraw:', out);
for (let i = 0; i < 10; i++) {
  await new Promise(r => setTimeout(r, 12000));
  const l = await call('GET', '/ltc/withdrawals');
  const row = (l.list || [])[0];
  console.log(i, row?.status, row?.tx?.slice(0, 12));
  if (row && ['sent', 'refunded'].includes(row.status)) break;
}
const me2 = await call('GET', '/me');
console.log('LTC after', (Number(BigInt(me2.me?.ltc || 0)) / 1e18).toFixed(5));
