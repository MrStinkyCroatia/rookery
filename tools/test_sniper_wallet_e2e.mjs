// RookerySniperBot wallet E2E on Stellar testnet: own wallet, contract lookup, on-chain buy/sell, export/import.
import { ethers } from 'ethers';
import * as S from '@stellar/stellar-sdk';
const API = 'http://127.0.0.1:8787/api', TG = 'http://127.0.0.1:8899';
const KEY = process.env.E2E_ADMIN_KEY;
const WEI = 10n ** 18n;
const hz = new S.Horizon.Server('https://horizon-testnet.stellar.org');
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, admin = false) {
    if (admin) body = { ...(body || {}), key: KEY };
    const url = API + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : '');
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    return r.json().catch(() => ({}));
  }
  async login(w) { const n = await this.req('POST', '/auth/wallet/nonce', { address: w.address }); return this.req('POST', '/auth/wallet/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) }); }
}
const admin = new Client();
const calls = async () => (await fetch(TG + '/calls')).json();
const reset = () => fetch(TG + '/reset', { method: 'POST' });
let HOOK, upd = 1;
const hook = (u) => fetch('http://127.0.0.1:8787' + HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': HOOK.split('/').pop() }, body: JSON.stringify({ update_id: upd++, ...u }) });
const from = (id) => ({ id, is_bot: false, first_name: 'T', username: 'w' + id });
const text = (id, t) => hook({ message: { message_id: 9000 + upd, from: from(id), chat: { id, type: 'private' }, date: 1, text: t } });
const tap = (id, data, msgId = 5000, msgText = '') => hook({ callback_query: { id: 'cb' + upd, from: from(id), data, message: { message_id: msgId, chat: { id, type: 'private' }, text: msgText } } });
const all = (cs) => cs.map(c => c.body?.text || '').join('\n');
const friendbot = async (pk) => { for (let i = 0; i < 5; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (r.ok) break; await sleep(2500); }
  for (let i = 0; i < 20; i++) { try { await hz.loadAccount(pk); return true; } catch { await sleep(1000); } } return false; };
const bal = async (pk, code, iss) => { try { const a = await hz.loadAccount(pk); const b = a.balances.find(x => code ? x.asset_code === code && x.asset_issuer === iss : x.asset_type === 'native'); return b ? Number(b.balance) : 0; } catch { return null; } };

console.log('== setup (testnet)');
await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(4000);
const stc = await admin.req('GET', '/admin/stellar', null, true);
ok('hot wallet funded on testnet', await friendbot(stc.hot), stc.hot);
await admin.req('POST', '/admin/stellar/send-now', { on: true }, true);
const s = await admin.req('POST', '/admin/snb', { setup: true, host: '127.0.0.1:8787', hook: true }, true);
HOOK = s.hook;
const creator = new Client(); await creator.login(ethers.Wallet.createRandom());
await admin.req('POST', '/admin/credit', { user: (await creator.req('GET', '/me')).username, asset: 'xlm', amount: (100n * WEI).toString() }, true);
const mk = await creator.req('POST', '/markets', { name: 'Wallet Test', symbol: 'WLT', network: 'stellar' });
let m;
for (let i = 0; i < 30; i++) { const d = await creator.req('GET', '/market/' + mk.id); m = d.market || d; if (m?.stellar?.issuer) break; await sleep(2000); }
const ISS = m?.stellar?.issuer, CODE = m?.stellar?.code;
ok('token issued on testnet', !!ISS, `${CODE}:${ISS}`);

console.log('== own wallet');
await reset();
await text(444, '/start');
let cs = await calls();
const W = (all(cs).match(/<code>(G[A-Z2-7]{55})<\/code>/) || [])[1];
ok('new user gets their own Stellar wallet', !!W, W);
ok('home shows the wallet line', /🔑 <b>Wallet<\/b>/.test(all(cs)));
ok('wallet funded (testnet faucet)', await friendbot(W));

console.log('== paste a contract');
for (const [label, q] of [['issuer G…', ISS], ['CODE:ISSUER', `${CODE}:${ISS}`], ['Soroban contract C…', new S.Asset(CODE, ISS).contractId(S.Networks.TESTNET)], ['stellar.expert link', `https://stellar.expert/explorer/testnet/asset/${CODE}-${ISS}`]]) {
  await reset(); await text(444, q); cs = await calls();
  ok(`${label} opens the token panel`, /\$WLT<\/b> · Wallet Test/.test(all(cs)) && /Contract/.test(all(cs)), q.slice(0, 20));
}

console.log('== buy and sell from the wallet (no Rookery balance)');
await reset();
await tap(444, `b:${mk.id}:50`);
cs = await calls();
ok('buy pays from the wallet', /Bought <b>.* \$WLT<\/b> for 50 XLM from your wallet/.test(all(cs)), all(cs).slice(-160).replace(/\n/g, ' '));
let tok = 0;
for (let i = 0; i < 12; i++) { await admin.req('POST', '/admin/stellar/send-now', { run: true, force: true }, true); tok = await bal(W, CODE, ISS); if (tok > 0) break; await sleep(3000); }
ok('tokens land in the user\'s own wallet', tok > 0, String(tok));
const xlmBefore = await bal(W);
await reset(); await sleep(4500);
await text(444, 'WLT'); cs = await calls();
ok('card shows the bag held in the wallet', /wallet [\d.,KM]+/.test(all(cs)));
await reset();
await tap(444, `s:${mk.id}:50`);
cs = await calls();
ok('sell 50% from the wallet shows the XLM received', /Sold 50% of \$WLT · you got <b>[\d.,]+ XLM<\/b>[\s\S]*sent to your wallet/.test(all(cs)), all(cs).slice(-160).replace(/\n/g, ' '));
let tok2 = tok, x2 = xlmBefore;
for (let i = 0; i < 10; i++) { await sleep(3000); tok2 = await bal(W, CODE, ISS); x2 = await bal(W); if (tok2 < tok * 0.6 && x2 > xlmBefore) break; }
ok('half the tokens left the wallet', Math.abs(tok2 / tok - 0.5) < 0.01, `${tok} → ${tok2}`);
ok('XLM came back to the wallet', x2 > xlmBefore, `${xlmBefore} → ${x2}`);

console.log('== no double buys');
{
  const tokA = await bal(W, CODE, ISS);
  const same = { update_id: 777001, callback_query: { id: 'dup1', from: from(444), data: `b:${mk.id}:10`, message: { message_id: 5000, chat: { id: 444, type: 'private' }, text: '' } } };
  const raw = (u) => fetch('http://127.0.0.1:8787' + HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': HOOK.split('/').pop() }, body: JSON.stringify(u) });
  await reset();
  // the same update delivered twice (Telegram retry) + a second tap while the first order runs
  const p1 = raw(same); await sleep(300); const p2 = raw(same);
  const p3 = raw({ update_id: 777002, callback_query: { id: 'dup2', from: from(444), data: `b:${mk.id}:10`, message: { message_id: 5000, chat: { id: 444, type: 'private' }, text: '' } } });
  const r2 = await (await p2).json(); await p1; await p3;
  const cs2 = await calls();
  ok('a re-delivered update is ignored', r2.dup === true);
  ok('a second tap while an order runs is refused', /previous order is still running/.test(JSON.stringify(cs2)));
  await sleep(3000);
  const xlmTrades = (all(cs2).match(/Bought <b>/g) || []).length;
  ok('exactly one buy went through', xlmTrades === 1, String(xlmTrades));
}

console.log('== export / import');
await reset(); await tap(444, 'wx2'); cs = await calls();
const sec = (all(cs).match(/<code>(S[A-Z2-7]{55})<\/code>/) || [])[1];
ok('export reveals the secret key (spoiler, protected)', sec && S.Keypair.fromSecret(sec).publicKey() === W && cs.some(c => c.body?.protect_content && /tg-spoiler/.test(c.body.text)));
const live = await admin.req('POST', '/admin/snb', {}, true);
await reset(); await text(444, sec);
cs = await calls();
ok('a secret pasted without Import is deleted at once', cs.some(c => c.method === 'deleteMessage') && /deleted it/.test(all(cs)));
const k2 = S.Keypair.random(); await friendbot(k2.publicKey());
await reset(); await tap(444, 'wi'); await text(444, k2.secret());
cs = await calls();
ok('import deletes the key message and switches the wallet', cs.some(c => c.method === 'deleteMessage') && new RegExp('Wallet imported: <code>' + k2.publicKey()).test(all(cs)));
await reset(); await tap(444, 'wal'); cs = await calls();
ok('wallet screen shows the imported address', new RegExp(k2.publicKey()).test(all(cs)) && /Export key/.test(JSON.stringify(cs)));
await reset(); await tap(444, `b:${mk.id}:20`); cs = await calls();
ok('buys now pay from the imported wallet', /from your wallet/.test(all(cs)) && (await bal(k2.publicKey())) < 10000 - 19, String(await bal(k2.publicKey())));

console.log('== books');
await sleep(2000);
const led = await admin.req('GET', '/admin/ledger', null, true);
ok('ledger exact after on-chain bot trades', Math.abs(led.xlm.diffUnits) < 1e-6, String(led.xlm.diffUnits));
const st = await admin.req('POST', '/admin/snb', {}, true);
ok('bot fee taken on wallet trades', st.fees.xlm > 0.6, JSON.stringify(st.fees));
console.log(`== sniper wallet E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
