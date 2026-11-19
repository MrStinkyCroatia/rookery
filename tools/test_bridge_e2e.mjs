// Bridge end-to-end against the real worker: EVM (Base fork) -> Stellar (testnet) and Stellar -> EVM,
// to someone else's wallet, 0.5% fee, liquidity pool limits, cancel/underpay paths, ledger conservation.
// Run with: E2E_SCRIPT=tools/test_bridge_e2e.mjs bash tools/run_wallet_e2e.sh
import { ethers } from 'ethers';
import * as S from '@stellar/stellar-sdk';

const API = 'http://127.0.0.1:8787/api';
const KEY = process.env.E2E_ADMIN_KEY;
const BASE = new ethers.JsonRpcProvider('http://127.0.0.1:8547', undefined, { staticNetwork: true });
const hz = new S.Horizon.Server('https://horizon-testnet.stellar.org');
const WEI = 10n ** 18n;
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (w, d = 6) => (Number(BigInt(w || 0)) / 1e18).toFixed(d);
class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, admin = false) {
    if (admin) body = { ...(body || {}), key: KEY };
    const url = API + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : '');
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return r.json().catch(() => ({ error: 'http ' + r.status }));
  }
  async login(w) { const n = await this.req('POST', '/auth/wallet/nonce', { address: w.address }); return this.req('POST', '/auth/wallet/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) }); }
}
const admin = new Client();
const friendbot = async (pk) => { for (let i = 0; i < 5; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (r.ok) break; await sleep(2500); }
  for (let i = 0; i < 20; i++) { try { await hz.loadAccount(pk); return; } catch { await sleep(1000); } } };
const xlmBal = async (pk) => { try { return Number((await hz.loadAccount(pk)).balances.find(b => b.asset_type === 'native').balance); } catch { return null; } };
const ledger = async () => { const l = await admin.req('GET', '/admin/ledger', null, true); return { xlm: l.xlm.diffUnits, eth: l.eth.diffUnits }; };
const bridgeAdmin = (b = {}) => admin.req('POST', '/admin/bridge', b, true);

console.log('== setup');
await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(4000);
const stc = await admin.req('GET', '/admin/stellar', null, true);
await friendbot(stc.hot);
ok('local Stellar hot wallet funded on testnet', (await xlmBal(stc.hot)) > 5000, stc.hot);

// a treasury account provides the pool: credited on the books, real funds on the chains
const T = new Client(); const tw = ethers.Wallet.createRandom(); await T.login(tw);
const tname = (await T.req('GET', '/me')).username;
await admin.req('POST', '/admin/credit', { user: tname, asset: 'xlm', amount: (3000n * WEI).toString(), note: 'pool funding' }, true);
await admin.req('POST', '/admin/credit', { user: tname, asset: 'eth', amount: (2n * WEI).toString(), note: 'pool funding' }, true);
// the platform hot wallet on the Base fork holds the matching ETH
const cfgPre = await admin.req('GET', '/bridge/config');
ok('bridge closed by default', cfgPre.on === false);
const r0 = await admin.req('POST', '/bridge/quote', { fromChain: 'base', fromAsset: 'eth', toChain: 'stellar', toAsset: 'xlm', amount: (WEI / 100n).toString() });
ok('closed bridge quotes but refuses', r0.quote && r0.quote.ok === false && /soon/i.test(r0.quote.reason), r0.quote?.reason);
const led0 = await ledger();
const f1 = await bridgeAdmin({ on: true, fund: { user: tname, asset: 'xlm', amount: (2000n * WEI).toString() } });
const f2 = await bridgeAdmin({ fund: { user: tname, asset: 'eth', amount: WEI.toString() } });
ok('pool funded from an account, not from users', f2.liquidity.xlm === 2000 && f2.liquidity.eth === 1, JSON.stringify(f2.liquidity));
ok('funding keeps the ledger exact', JSON.stringify(await ledger()) === JSON.stringify(led0));
const hotEvm = (await admin.req('GET', '/proofs')).hotWallet;
await BASE.send('anvil_setBalance', [hotEvm, '0x' + (5n * WEI).toString(16)]);
ok('platform hot wallet holds ETH on the Base fork', (await BASE.getBalance(hotEvm)) === 5n * WEI, hotEvm);

// validation
const bad = async (b, re, name) => { const r = await admin.req('POST', '/bridge/quote', b); ok(name, (r.error && re.test(r.error)) || (r.quote && !r.quote.ok && re.test(r.quote.reason)), r.error || r.quote?.reason); };
await bad({ fromChain: 'zero', fromAsset: 'zro', toChain: 'stellar', toAsset: 'xlm', amount: WEI.toString() }, /coming soon/i, 'Zero is coming soon');
await bad({ fromChain: 'stellar', fromAsset: 'xlm', toChain: 'giwa', toAsset: 'eth', amount: WEI.toString() }, /coming soon/i, 'GIWA is coming soon');
await bad({ fromChain: 'base', fromAsset: 'eth', toChain: 'arbitrum', toAsset: 'eth', amount: WEI.toString() }, /Stellar/i, 'one side must be Stellar');
await bad({ fromChain: 'base', fromAsset: 'eth', toChain: 'stellar', toAsset: 'xlm', amount: (WEI / 100000n).toString() }, /Minimum/i, 'minimum enforced');
await bad({ fromChain: 'base', fromAsset: 'eth', toChain: 'stellar', toAsset: 'xlm', amount: (2n * WEI).toString() }, /Maximum|liquidity/i, 'maximum / liquidity enforced');

// ── EVM -> Stellar, to someone else's wallet
console.log('== Base ETH -> Stellar XLM, to another wallet');
const buyer = ethers.Wallet.createRandom();
const A = new Client(); await A.login(buyer);
await BASE.send('anvil_setBalance', [buyer.address, '0x' + (2n * WEI).toString(16)]);
const friend = S.Keypair.random();                                   // a wallet that does not even exist yet
const q1 = (await A.req('POST', '/bridge/quote', { fromChain: 'base', fromAsset: 'eth', toChain: 'stellar', toAsset: 'xlm', amount: (WEI / 100n).toString() })).quote;
ok('quote takes exactly 0.5%', q1.ok && Math.abs(Number(q1.fee) / Number(q1.gross) - 0.005) < 1e-6, `${fmt(q1.fee)} of ${fmt(q1.gross)} XLM`);
const liqBefore = (await bridgeAdmin()).liquidity.xlm;
const o1 = (await A.req('POST', '/bridge/order', { fromChain: 'base', fromAsset: 'eth', toChain: 'stellar', toAsset: 'xlm', amount: (WEI / 100n).toString(), to: friend.publicKey() })).order;
ok('order created with a unique tagged amount', o1 && BigInt(o1.tagged) > WEI / 100n && o1.payTo && o1.chainId === 8453, o1 ? `${o1.tagged}` : '');
ok('liquidity reserved for the order', Math.abs((await bridgeAdmin()).liquidity.xlm - (liqBefore - Number(o1.credit) / 1e18)) < 1e-6);
await (await buyer.connect(BASE).sendTransaction({ to: o1.payTo, value: BigInt(o1.tagged) })).wait();
await BASE.send('anvil_mine', ['0x14']);
let s1;
for (let i = 0; i < 10; i++) {
  await admin.req('POST', '/admin/scan', {}, true); await bridgeAdmin({ run: true });
  s1 = ((await A.req('GET', '/bridge/orders')).orders || []).find(o => o.id === o1.id);
  if (s1 && ['sent', 'failed'].includes(s1.status)) break; await sleep(3000);
}
const fb = await xlmBal(friend.publicKey());
ok('delivered to the other wallet', s1?.status === 'sent', s1 ? `${s1.status} · ${s1.note}` : '');
ok('the friend received the quoted XLM', fb !== null && Math.abs(fb - Number(o1.out) / 1e18) < 0.0001, `${fb} vs ${fmt(o1.out, 7)}`);
ok('payer keeps nothing stuck on Rookery', BigInt((await A.req('GET', '/me')).eth) < 1000n);

// ── Stellar -> EVM, to someone else's address
console.log('== Stellar XLM -> Base ETH, to another address');
const sk = S.Keypair.random(); await friendbot(sk.publicKey());
const B2 = new Client(); await B2.login(ethers.Wallet.createRandom());
const evmFriend = ethers.Wallet.createRandom().address;
const o2 = (await B2.req('POST', '/bridge/order', { fromChain: 'stellar', fromAsset: 'xlm', toChain: 'base', toAsset: 'eth', amount: (150n * WEI).toString(), to: evmFriend, fromAddress: sk.publicKey() })).order;
ok('Stellar order has the address, memo and a ready-to-sign payment', o2 && o2.payTo === stc.hot && /^b\d+$/.test(o2.memo) && !!o2.xdr, o2?.memo || '');
const tx2 = S.TransactionBuilder.fromXDR(o2.xdr, S.Networks.TESTNET); tx2.sign(sk); await hz.submitTransaction(tx2);
let s2;
for (let i = 0; i < 12; i++) {
  await admin.req('POST', '/admin/stellar/run', {}, true); await bridgeAdmin({ run: true });
  s2 = ((await B2.req('GET', '/bridge/orders')).orders || []).find(o => o.id === o2.id);
  if (s2 && ['sent', 'failed'].includes(s2.status)) break; await sleep(4000);
}
const ethGot = await BASE.getBalance(evmFriend);
ok('delivered on Base', s2?.status === 'sent', s2 ? `${s2.status} · ${s2.note}` : '');
ok('the other address received the quoted ETH', Math.abs(Number(ethGot) - Number(o2.out)) / Number(o2.out) < 0.0001, `${fmt(ethGot)} vs ${fmt(o2.out)}`);

// ── cancel releases liquidity, underpayment is kept safe
console.log('== cancel and underpayment');
const liqC = (await bridgeAdmin()).liquidity.eth;
const o3 = (await B2.req('POST', '/bridge/order', { fromChain: 'stellar', fromAsset: 'xlm', toChain: 'base', toAsset: 'eth', amount: (60n * WEI).toString(), to: evmFriend })).order;
await B2.req('POST', '/bridge/cancel', { id: o3.id });
ok('cancel gives the reserved liquidity back', Math.abs((await bridgeAdmin()).liquidity.eth - liqC) < 1e-12);
const o4 = (await B2.req('POST', '/bridge/order', { fromChain: 'stellar', fromAsset: 'xlm', toChain: 'base', toAsset: 'eth', amount: (80n * WEI).toString(), to: evmFriend, fromAddress: sk.publicKey() })).order;
const a4 = await hz.loadAccount(sk.publicKey());
const t4 = new S.TransactionBuilder(a4, { fee: '1000', networkPassphrase: S.Networks.TESTNET })
  .addOperation(S.Operation.payment({ destination: stc.hot, asset: S.Asset.native(), amount: '20' })).addMemo(S.Memo.text(o4.memo)).setTimeout(60).build();
t4.sign(sk); await hz.submitTransaction(t4);
let s4;
for (let i = 0; i < 8; i++) { await admin.req('POST', '/admin/stellar/run', {}, true); s4 = ((await B2.req('GET', '/bridge/orders')).orders || []).find(o => o.id === o4.id); if (s4?.status !== 'open') break; await sleep(4000); }
ok('underpaid order is not executed', s4?.status === 'failed', s4 ? `${s4.status} · ${s4.note}` : '');
ok('underpayment stays on the payer\'s Rookery balance', Number(BigInt((await B2.req('GET', '/me')).xlm)) / 1e18 >= 19.99);

// ── books
const led1 = await ledger();
const fin = await bridgeAdmin();
ok('ledger exact after both bridges', Math.abs(led1.xlm - led0.xlm) < 1e-9 && Math.abs(led1.eth - led0.eth) < 1e-12, `${JSON.stringify(led0)} -> ${JSON.stringify(led1)}`);
ok('fees earned recorded (0.5%)', fin.feesEarned.xlm > 0 && fin.feesEarned.eth > 0, JSON.stringify(fin.feesEarned));
console.log(`== bridge E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
