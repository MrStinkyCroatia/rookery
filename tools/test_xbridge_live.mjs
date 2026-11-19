// Live check of the bridge layer against the real settlement network (no funds move).
// node tools/test_xbridge_live.mjs https://rookery-staging.stablepump-ops.workers.dev
import * as S from '@stellar/stellar-sdk';
const BASE = (process.argv[2] || 'http://127.0.0.1:8787') + '/api';
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const call = async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', 'x-pl': '1' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); return { j: JSON.parse(t || '{}'), raw: t }; };
const LEAK = /1\s*click|chaindefuser|defuse|intents|omft|nep1|nep2|\.near\b|omdep|hot\.tg/i;
const leaks = [];
const watch = (name, raw) => { if (LEAK.test(raw)) leaks.push(name + ': ' + raw.match(LEAK)[0]); };

console.log('== config');
const c = await call('GET', '/bridge/config'); watch('config', c.raw);
ok('config lists networks with Stellar and EVM', c.j.nets?.stellar && c.j.nets?.base && c.j.nets?.robinhood, Object.keys(c.j.nets || {}).join(','));
ok('Zero and GIWA are coming soon', JSON.stringify(c.j.soon) === '["zero","giwa"]');
ok('our fee shown as 0.5%', c.j.ourFeePct === 0.5, String(c.j.ourFeePct));

console.log('== quotes both ways');
const amt = { ethereum: '0.01', base: '0.01', arbitrum: '0.01', optimism: '0.01', robinhood: '0.01', bsc: '2', polygon: '200', avalanche: '3', solana: '0.3', bitcoin: '0.0003', tron: '400' };
for (const k of Object.keys(c.j.nets).filter(k => k !== 'stellar')) {
  const a = await call('POST', '/bridge/quote', { from: k, to: 'stellar', amount: amt[k] }); watch('q ' + k, a.raw);
  const b = await call('POST', '/bridge/quote', { from: 'stellar', to: k, amount: k === 'bsc' ? '8000' : '150' }); watch('q2 ' + k, b.raw);
  const qa = a.j.quote, qb = b.j.quote;
  ok(`${k} → Stellar`, qa && Number(qa.amountOutFmt) > 0 && qa.outUsd / qa.inUsd > 0.95, qa ? `${qa.amountInFmt} → ${qa.amountOutFmt} XLM ($${qa.inUsd.toFixed(2)}→$${qa.outUsd.toFixed(2)}, ${qa.seconds}s)` : a.j.error);
  ok(`Stellar → ${k}`, qb && Number(qb.amountOutFmt) > 0 && qb.outUsd / qb.inUsd > (k === 'bitcoin' ? 0.85 : 0.95), qb ? `150 XLM → ${qb.amountOutFmt} ($${qb.inUsd.toFixed(2)}→$${qb.outUsd.toFixed(2)})` : b.j.error);
}

console.log('== validation');
const v1 = await call('POST', '/bridge/quote', { from: 'zero', to: 'stellar', amount: '1' }); ok('Zero refused', /coming soon/i.test(v1.j.error || ''), v1.j.error);
const v2 = await call('POST', '/bridge/quote', { from: 'base', to: 'arbitrum', amount: '1' }); ok('EVM↔EVM refused', /Stellar/i.test(v2.j.error || ''), v2.j.error);
const v3 = await call('POST', '/bridge/order', { from: 'base', to: 'stellar', amount: '0.01', recipient: 'GBAD', refund: '0x408c3d3Fd36fdF84888f343417787D8710E76fE8' }); ok('bad destination refused', /destination/i.test(v3.j.error || ''), v3.j.error);
const v4 = await call('POST', '/bridge/order', { from: 'stellar', to: 'base', amount: '150', recipient: '0x408c3d3Fd36fdF84888f343417787D8710E76fE8', refund: '0x00' }); ok('missing refund refused', /refund/i.test(v4.j.error || ''), v4.j.error);
const v5 = await call('POST', '/bridge/quote', { from: 'base', to: 'stellar', amount: '0.0000001' }); watch('tiny', v5.raw); ok('dust amount gets a clean message', !!v5.j.error && !LEAK.test(v5.j.error), v5.j.error);

console.log('== orders (deposit address only, nothing is paid)');
const me = 'GD4WKVUCNONMMKS2SPFDYFH5FAYTBZ6FHZRGCHD2WGY3ECMWAFBFSDO2', evm = '0x408c3d3Fd36fdF84888f343417787D8710E76fE8';
const o1 = await call('POST', '/bridge/order', { from: 'base', to: 'stellar', amount: '0.01', recipient: me, refund: evm }); watch('o1', o1.raw);
ok('Base → Stellar order: EVM deposit address + exact wei', /^0x[0-9a-fA-F]{40}$/.test(o1.j.order?.depositAddress || '') && o1.j.order.amountInUnits === '10000000000000000', o1.j.order?.depositAddress || o1.j.error);
const o2 = await call('POST', '/bridge/order', { from: 'stellar', to: 'arbitrum', amount: '150', recipient: evm, refund: me, fromAddress: me }); watch('o2', o2.raw);
const ord = o2.j.order;
ok('Stellar → Arbitrum order: G address + memo', ord && /^G[A-Z2-7]{55}$/.test(ord.depositAddress) && /^\d+$/.test(ord.depositMemo), ord ? `${ord.depositAddress} memo ${ord.depositMemo}` : o2.j.error);
if (ord?.xdr) {
  const tx = S.TransactionBuilder.fromXDR(ord.xdr, S.Networks.PUBLIC);
  const op = tx.operations[0];
  ok('wallet payment is for mainnet, to the deposit address', op.type === 'payment' && op.destination === ord.depositAddress && op.asset.isNative());
  ok('amount is exactly 150 XLM', op.amount === '150.0000000', op.amount);
  ok('memo is the numeric memo id', tx.memo.type === 'id' && String(tx.memo.value) === ord.depositMemo, `${tx.memo.type} ${tx.memo.value}`);
  ok('signed by the payer', tx.source === me);
} else ok('wallet payment prepared', false, ord?.xdrError || 'no xdr');
const s1 = await call('GET', '/bridge/status?ref=' + o1.j.order?.ref); watch('status', s1.raw);
ok('status reads back as waiting for payment', s1.j.order?.status === 'PENDING_DEPOSIT', s1.j.order?.status || s1.j.error);
const h = await call('GET', '/bridge/orders?refs=' + [o1.j.order?.ref, ord?.ref].join(',')); watch('orders', h.raw);
ok('history by reference works without login', (h.j.orders || []).length === 2);
const bad = await call('POST', '/bridge/submit', { ref: o1.j.order?.ref, txHash: 'nope' }); ok('bad tx hash refused', /hash/i.test(bad.j.error || ''));

ok('no provider names anywhere in responses', leaks.length === 0, leaks.slice(0, 3).join(' | '));
console.log(`== bridge live: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
