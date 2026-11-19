// RookerySniperBot referrals: invite link, 25% of every bot fee to the inviter (curve trades and any-token routes), stats screen.
import { ethers } from 'ethers';
import * as S from '@stellar/stellar-sdk';
const API = 'http://127.0.0.1:8787/api', TG = 'http://127.0.0.1:8899', KEY = process.env.E2E_ADMIN_KEY;
const WEI = 10n ** 18n;
const hz = new S.Horizon.Server('https://horizon-testnet.stellar.org');
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const adm = async (method, path, body) => { const r = await fetch(API + path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : ''), { method, headers: { 'content-type': 'application/json', 'x-pl': '1' }, body: method === 'GET' ? undefined : JSON.stringify({ ...(body || {}), key: KEY }) }); return r.json(); };
class Client { constructor() { this.cookie = ''; }
  async req(method, path, body) { const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0]; return r.json(); }
  async login(w) { const n = await this.req('POST', '/auth/wallet/nonce', { address: w.address }); return this.req('POST', '/auth/wallet/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) }); } }
const calls = async () => (await fetch(TG + '/calls')).json();
const reset = () => fetch(TG + '/reset', { method: 'POST' });
let HOOK, upd = 1;
const hook = (u) => fetch('http://127.0.0.1:8787' + HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': HOOK.split('/').pop() }, body: JSON.stringify({ update_id: upd++, ...u }) });
const from = (id) => ({ id, is_bot: false, first_name: 'T', username: 'r' + id });
const text = (id, t) => hook({ message: { message_id: 9000 + upd, from: from(id), chat: { id, type: 'private' }, date: 1, text: t } });
const tap = (id, data) => hook({ callback_query: { id: 'cb' + upd, from: from(id), data, message: { message_id: 5000, chat: { id, type: 'private' }, text: '' } } });
const all = (cs) => cs.map(c => c.body?.text || '').join('\n');
const xlmOf = async (u) => { const d = await adm('GET', '/admin/user?q=' + u); return Number(BigInt(d.balances.find(b => b.asset === 'xlm')?.amount || '0')) / 1e18; };
const friendbot = async (pk) => { for (let i = 0; i < 5; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (r.ok) break; await sleep(2500); } for (let i = 0; i < 20; i++) { try { await hz.loadAccount(pk); return true; } catch { await sleep(1000); } } return false; };
const submit = async (kp, ops) => { const acc = await hz.loadAccount(kp.publicKey()); const tb = new S.TransactionBuilder(acc, { fee: '10000', networkPassphrase: S.Networks.TESTNET }); ops.forEach(o => tb.addOperation(o)); const tx = tb.setTimeout(60).build(); tx.sign(kp); return hz.submitTransaction(tx); };

console.log('== setup');
await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(4000);
const stc = await adm('GET', '/admin/stellar'); await friendbot(stc.hot);
HOOK = (await adm('POST', '/admin/snb', { setup: true, host: '127.0.0.1:8787', hook: true })).hook;

console.log('== invite link');
await reset(); await text(111, '/start');
let cs = await calls();
const A = (all(cs).match(/· (tg_[a-z0-9_]+)/) || [])[1];
ok('menu shows the invite offer at the top', /Invite friends, earn 25% of their fees/.test(all(cs)) && JSON.stringify(cs).includes('🎁 Invite & earn 25%'));
await reset(); await tap(111, 'ref'); cs = await calls();
const code = (all(cs).match(/start=R([0-9a-f]{8})/) || [])[1];
ok('referral screen with a personal link and stats', !!code && /INVITED   0 people/.test(all(cs)) && /t\.me\/share\/url/.test(JSON.stringify(cs)), code);
await reset(); await text(111, '/start R' + code); cs = await calls();
ok('nobody can invite themselves', !/invited by/.test(all(cs)));
await reset(); await text(222, '/start R' + code); cs = await calls();
const Bn = (all(cs).match(/· (tg_[a-z0-9_]+)/) || [])[1];
ok('friend is told who invited them', new RegExp('invited by <b>' + A).test(all(cs)));
ok('inviter gets a "joined" notice', cs.some(c => String(c.body?.chat_id) === '111' && /joined with your invite link/.test(c.body.text || '')));
await reset(); await text(222, '/start R' + code);
await text(333, '/start'); await text(333, '/start R' + code); cs = await calls();
ok('an existing user can still be attributed once before trading', cs.some(c => String(c.body?.chat_id) === '111' && /joined/.test(c.body.text || '')));

console.log('== 25% of curve-trade fees');
const creator = new Client(); await creator.login(ethers.Wallet.createRandom());
await adm('POST', '/admin/credit', { user: (await creator.req('GET', '/me')).username, asset: 'xlm', amount: (100n * WEI).toString() });
const mk = await creator.req('POST', '/markets', { name: 'Ref Test', symbol: 'REFT', network: 'stellar' });
await adm('POST', '/admin/credit', { user: Bn, asset: 'xlm', amount: (200n * WEI).toString() });
const a0 = await xlmOf(A);
const led0 = (await adm('GET', '/admin/ledger')).xlm.diffUnits;
await reset(); await tap(222, `b:${mk.id}:100`);
await sleep(500);
const a1 = await xlmOf(A);
ok('inviter earned 25% of the 1% bot fee on a 100 XLM buy', Math.abs((a1 - a0) - 0.25) < 1e-9, `${a0} → ${a1}`);
await reset(); await tap(222, `s:${mk.id}:100`);
await sleep(500);
const a2 = await xlmOf(A);
ok('and 25% of the fee on the sell', a2 > a1 && (a2 - a1) < 0.26, `${a1} → ${a2}`);
ok('ledger stays exact', Math.abs((await adm('GET', '/admin/ledger')).xlm.diffUnits - led0) < 1e-9);

console.log('== 25% of on-chain route fees');
const iss = S.Keypair.random(), dist = S.Keypair.random(); await friendbot(iss.publicKey()); await friendbot(dist.publicKey());
const asset = new S.Asset('REFX', iss.publicKey());
await submit(dist, [S.Operation.changeTrust({ asset })]);
await submit(iss, [S.Operation.payment({ destination: dist.publicKey(), asset, amount: '1000000' })]);
const lp = new S.LiquidityPoolAsset(S.Asset.native(), asset, S.LiquidityPoolFeeV18);
const lpid = Buffer.from(S.getLiquidityPoolId('constant_product', lp.getLiquidityPoolParameters())).toString('hex');
await submit(dist, [S.Operation.changeTrust({ asset: lp }), S.Operation.liquidityPoolDeposit({ liquidityPoolId: lpid, maxAmountA: '2000', maxAmountB: '500000', minPrice: '0.003', maxPrice: '0.005' })]);
await reset(); await text(222, '/start'); cs = await calls();
const WB = (all(cs).match(/<code>(G[A-Z2-7]{55})<\/code>/) || [])[1] || (await (async () => { await tap(222, 'wal'); return (all(await calls()).match(/<code>(G[A-Z2-7]{55})<\/code>/) || [])[1]; })());
await friendbot(WB);
await reset(); await text(222, `REFX:${iss.publicKey()}`); cs = await calls();
const aid = (JSON.stringify(cs).match(/xb:(\d+):10/) || [])[1];
const e0 = await xlmOf(A);
await reset(); await tap(222, `xb:${aid}:100`); cs = await calls();
ok('friend bought an outside token via the best route', /Bought <b>/.test(all(cs)), (all(cs).match(/✅.*|❌.*/) || [''])[0]);
let e1 = e0;
for (let i = 0; i < 8 && e1 - e0 < 0.24; i++) { await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(4000); e1 = await xlmOf(A); }
ok('inviter got 25% of that on-chain fee (settled by the cron)', Math.abs((e1 - e0) - 0.25) < 1e-6, `${e0} → ${e1}`);

console.log('== stats');
await reset(); await tap(111, 'ref'); cs = await calls();
const scr = all(cs);
ok('stats show invites, traders and earnings', /INVITED   2 people/.test(scr) && /1 trading/.test(scr) && /EARNED    0\.7\d+ XLM/.test(scr), (scr.match(/<pre>[\s\S]*?<\/pre>/) || [''])[0].replace(/\n/g, ' | '));
ok('top invites listed', new RegExp('1\\. ' + Bn).test(scr));
ok('ledger exact at the end', Math.abs((await adm('GET', '/admin/ledger')).xlm.diffUnits - led0) < 1e-6, String((await adm('GET', '/admin/ledger')).xlm.diffUnits));
console.log(`== sniper referral E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
