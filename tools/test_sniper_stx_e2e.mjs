// Any Stellar token via the bot (testnet): external asset with a classic AMM pool, best-route buy/sell from the
// user's wallet, live terminal, fee to the fees account, and "snipe when tradable" for a token without liquidity yet.
import * as S from '@stellar/stellar-sdk';
const API = 'http://127.0.0.1:8787/api', TG = 'http://127.0.0.1:8899';
const KEY = process.env.E2E_ADMIN_KEY;
const hz = new S.Horizon.Server('https://horizon-testnet.stellar.org');
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const adm = async (method, path, body) => { const r = await fetch(API + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : ''), { method, headers: { 'content-type': 'application/json', 'x-pl': '1' }, body: method === 'GET' ? undefined : JSON.stringify({ ...(body || {}), key: KEY }) }); return r.json(); };
const calls = async () => (await fetch(TG + '/calls')).json();
const reset = () => fetch(TG + '/reset', { method: 'POST' });
let HOOK, upd = 1;
const hook = (u) => fetch('http://127.0.0.1:8787' + HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': HOOK.split('/').pop() }, body: JSON.stringify({ update_id: upd++, ...u }) });
const from = (id) => ({ id, is_bot: false, first_name: 'T', username: 'x' + id });
const text = (id, t) => hook({ message: { message_id: 9000 + upd, from: from(id), chat: { id, type: 'private' }, date: 1, text: t } });
const tap = (id, data, msgId = 5000, msgText = '') => hook({ callback_query: { id: 'cb' + upd, from: from(id), data, message: { message_id: msgId, chat: { id, type: 'private' }, text: msgText } } });
const all = (cs) => cs.map(c => c.body?.text || '').join('\n');
const friendbot = async (pk) => { for (let i = 0; i < 5; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (r.ok) break; await sleep(2500); }
  for (let i = 0; i < 20; i++) { try { await hz.loadAccount(pk); return true; } catch { await sleep(1000); } } return false; };
const bal = async (pk, code, iss) => { try { const a = await hz.loadAccount(pk); const b = a.balances.find(x => code ? x.asset_code === code && x.asset_issuer === iss : x.asset_type === 'native'); return b ? Number(b.balance) : 0; } catch { return null; } };
const submit = async (kp, ops) => { const acc = await hz.loadAccount(kp.publicKey()); const tb = new S.TransactionBuilder(acc, { fee: '10000', networkPassphrase: S.Networks.TESTNET }); ops.forEach(o => tb.addOperation(o)); const tx = tb.setTimeout(60).build(); tx.sign(kp); return hz.submitTransaction(tx); };
// an outside launchpad: issuer + distributor that seeds a classic XLM pool
async function launch(code, withPool) {
  const iss = S.Keypair.random(), dist = S.Keypair.random();
  await friendbot(iss.publicKey()); await friendbot(dist.publicKey());
  const asset = new S.Asset(code, iss.publicKey());
  await submit(dist, [S.Operation.changeTrust({ asset })]);
  await submit(iss, [S.Operation.payment({ destination: dist.publicKey(), asset, amount: '1000000' })]);
  const pool = async () => {
    const lp = new S.LiquidityPoolAsset(S.Asset.native(), asset, S.LiquidityPoolFeeV18);
    const id = Buffer.from(S.getLiquidityPoolId('constant_product', lp.getLiquidityPoolParameters())).toString('hex');
    await submit(dist, [S.Operation.changeTrust({ asset: lp }), S.Operation.liquidityPoolDeposit({ liquidityPoolId: id, maxAmountA: '2000', maxAmountB: '500000', minPrice: '0.003', maxPrice: '0.005' })]);
  };
  if (withPool) await pool();
  return { iss, dist, asset, code, pool };
}

console.log('== setup');
await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(4000);
const stc = await adm('GET', '/admin/stellar');
ok('hot wallet funded', await friendbot(stc.hot));
HOOK = (await adm('POST', '/admin/snb', { setup: true, host: '127.0.0.1:8787', hook: true })).hook;
const T1 = await launch('PUMPX', true);
ok('outside token with an XLM pool', (await bal(T1.dist.publicKey(), 'PUMPX', T1.iss.publicKey())) < 1000000);
await reset(); await text(555, '/start');
let cs = await calls();
const W = (all(cs).match(/<code>(G[A-Z2-7]{55})<\/code>/) || [])[1];
await friendbot(W);
ok('user wallet ready', !!W);

console.log('== open any token');
for (const [label, q] of [['CODE:ISSUER', `PUMPX:${T1.iss.publicKey()}`], ['issuer G…', T1.iss.publicKey()], ['contract C…', T1.asset.contractId(S.Networks.TESTNET)]]) {
  await reset(); await text(555, q); cs = await calls();
  ok(`${label} opens the token card`, /<b>PUMPX<\/b>/.test(all(cs)) && /Routes<\/b> SDEX\/AMM/.test(all(cs)), all(cs).slice(0, 60).replace(/\n/g, ' '));
}
ok('card shows price, supply, holders', /PRICE   \$/.test(all(cs)) && /SUPPLY  1.00M/.test(all(cs)) && /holders/.test(all(cs)));
ok('safety: issuer not locked is flagged', /Issuer not locked/.test(all(cs)));
const kb = JSON.stringify(cs.filter(c => c.method === 'sendMessage').pop()?.body?.reply_markup || {});
const aid = (kb.match(/xb:(\d+):10/) || [])[1];
ok('card has XLM buy buttons', !!aid);

console.log('== trade it from the wallet');
const x0 = await bal(W);
await reset(); await tap(555, `xb:${aid}:50`);
cs = await calls();
ok('buy via best route', /Bought <b>[\d.,KM]+ PUMPX<\/b> for 50 XLM via SDEX\/AMM/.test(all(cs)), all(cs).match(/✅.*|❌.*/)?.[0]);
const t1 = await bal(W, 'PUMPX', T1.iss.publicKey());
ok('tokens are in the wallet', t1 > 0, String(t1));
ok('wallet paid 50 XLM (incl. 1% fee)', Math.abs((x0 - (await bal(W))) - 50.5) < 1.0, `${x0} → ${await bal(W)}`);
ok('live terminal opened', cs.some(c => /POSITION TERMINAL · PUMPX/.test(c.body?.text || '') && /COST/.test(c.body.text)));
await reset(); await sleep(5000);
await adm('POST', '/admin/snb', { tick: true });
cs = await calls();
ok('terminal refreshes with full-sell value', cs.some(c => c.method === 'editMessageText' && /VALUE    [\d.]+ XLM/.test(c.body.text || '')));
await reset(); await tap(555, `xs:${aid}:50`, 7001, '📟 POSITION TERMINAL · PUMPX');
cs = await calls();
const t2 = await bal(W, 'PUMPX', T1.iss.publicKey());
ok('sell 50% via best route', /Sold 50% of PUMPX · got <b>[\d.]+ XLM<\/b>/.test(all(cs)) && Math.abs(t2 / t1 - 0.5) < 0.01, `${t1} → ${t2}`);
await reset(); await tap(555, 'pos'); cs = await calls();
ok('positions include outside tokens from the wallet', /PUMPX/.test(all(cs)));

console.log('== snipe when tradable');
const T2 = await launch('NEWX', false);
await reset(); await text(555, `NEWX:${T2.iss.publicKey()}`); cs = await calls();
ok('token without liquidity offers Snipe when tradable', /No liquidity yet/.test(all(cs)) && /xw:\d+/.test(JSON.stringify(cs)));
const aid2 = (JSON.stringify(cs).match(/xw:(\d+)/) || [])[1];
await reset(); await tap(555, `xw:${aid2}`); await text(555, '15');
cs = await calls();
ok('snipe armed', /Armed: I buy <b>15 XLM<\/b> of NEWX/.test(all(cs)));
await adm('POST', '/admin/snb', { tick: true }); await adm('POST', '/admin/snb', { tick: true });
ok('nothing bought before liquidity', (await bal(W, 'NEWX', T2.iss.publicKey())) === 0 || (await bal(W, 'NEWX', T2.iss.publicKey())) === null);
await T2.pool();
await reset();
let got = 0;
for (let i = 0; i < 6 && !got; i++) { await adm('POST', '/admin/snb', { tick: true }); await sleep(1500); got = await bal(W, 'NEWX', T2.iss.publicKey()); }
cs = await calls();
ok('bought the moment liquidity appeared', got > 0 && /Sniped NEWX/.test(all(cs)), String(got));

console.log('== books');
await sleep(3000);
await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(5000);
const led = await adm('GET', '/admin/ledger');
ok('ledger exact (fees land on the fees account)', Math.abs(led.xlm.diffUnits) < 1e-6, String(led.xlm.diffUnits));
console.log(`== sniper any-token E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
