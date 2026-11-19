// RookerySniperBot E2E against the real worker and a fake Telegram API.
import { ethers } from 'ethers';
const API = 'http://127.0.0.1:8787/api', TG = 'http://127.0.0.1:8899';
const KEY = process.env.E2E_ADMIN_KEY;
const WEI = 10n ** 18n;
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body, admin = false) {
    if (admin) body = { ...(body || {}), key: KEY };
    const url = API + path + (admin && method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : '');
    const r = await fetch(url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const t = await r.text(); try { return { status: r.status, ...JSON.parse(t) }; } catch { return { status: r.status, text: t, location: r.headers.get('location'), setCookie: sc }; }
  }
  async login(w) { const n = await this.req('POST', '/auth/wallet/nonce', { address: w.address }); return this.req('POST', '/auth/wallet/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) }); }
}
const admin = new Client();
const calls = async () => (await fetch(TG + '/calls')).json();
const reset = () => fetch(TG + '/reset', { method: 'POST' });
let HOOK, upd = 1;
const hook = (u) => fetch('http://127.0.0.1:8787' + HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': HOOK.split('/').pop() }, body: JSON.stringify({ update_id: upd++, ...u }) }).then(r => r.status);
const from = (id, username) => ({ id, is_bot: false, first_name: 'T', username });
const text = (id, t, username = 'pengu_trader') => hook({ message: { message_id: upd, from: from(id, username), chat: { id, type: 'private' }, date: 1, text: t } });
const tap = (id, data, msgId = 5000, msgText = '') => hook({ callback_query: { id: 'cb' + upd, from: from(id, 'pengu_trader'), data, message: { message_id: msgId, chat: { id, type: 'private' }, text: msgText } } });
const lastText = (cs, method = 'sendMessage') => [...cs].reverse().find(c => c.method === method)?.body?.text || '';

console.log('== setup');
await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(4000);
const s = await admin.req('POST', '/admin/snb', { setup: true, host: '127.0.0.1:8787', hook: true }, true);
HOOK = s.hook;
ok('bot setup registers webhook, commands and profile', s.webhook?.ok && s.commands?.ok && s.bot === 'RookerySniperBot', JSON.stringify({ hook: !!HOOK, bot: s.bot }));
ok('webhook rejects a wrong secret', (await fetch('http://127.0.0.1:8787/api/snb/hook/nope', { method: 'POST', body: '{}' })).status === 403);

console.log('== first contact');
await reset();
await text(111, '/start');
let cs = await calls();
const home = lastText(cs);
const uname = (home.match(/· (tg_[a-z0-9_]+)/) || [])[1];
ok('/start creates an account and shows the terminal-style menu', /ROOKERY SNIPER/.test(home) && !!uname, uname);
ok('welcome explains the bot', cs.some(c => /Welcome to RookerySniperBot/.test(c.body?.text || '')));
await text(111, '/start');
ok('second /start does not create another account', (await admin.req('POST', '/admin/snb', {}, true)).users === 1);
await admin.req('POST', '/admin/credit', { user: uname, asset: 'xlm', amount: (500n * WEI).toString(), note: 'test' }, true);

console.log('== sniper arms, a creator launches');
await reset();
await tap(111, 'snp');
cs = await calls();
ok('sniper screen lists networks', /SNIPER/.test(lastText(cs, 'editMessageText')) && /STELLAR/.test(lastText(cs, 'editMessageText')));
await tap(111, 'sn:stellar');
cs = await calls();
ok('stellar sniping switched on', /🟢 <b>STELLAR<\/b>/.test(lastText(cs, 'editMessageText')));
await tap(111, 'sa:stellar'); await text(111, '20');
const creator = new Client(); const cw = ethers.Wallet.createRandom(); await creator.login(cw);
const cname = (await creator.req('GET', '/me')).username;
await admin.req('POST', '/admin/credit', { user: cname, asset: 'xlm', amount: (100n * WEI).toString(), note: 'test' }, true);
await reset();
const mk = await creator.req('POST', '/markets', { name: 'Sniper Test', symbol: 'SNPT', network: 'stellar', description: 'test' });
ok('creator launches a Stellar token', mk.ok && mk.id, mk.id || mk.error);
await sleep(2500);
cs = await calls();
const sniped = cs.find(c => /Sniped \$SNPT/.test(c.body?.text || ''));
ok('the bot sniped it at launch and told the user', !!sniped, sniped?.body?.text?.slice(0, 80));
ok('a live Position Terminal opened', cs.some(c => c.method === 'sendMessage' && /POSITION TERMINAL · \$SNPT/.test(c.body?.text || '') && /live · updated/.test(c.body.text)));
const me1 = (await admin.req('POST', '/admin/snb', {}, true));
ok('terminal registered as live', me1.live >= 1, String(me1.live));

console.log('== manual trading');
await reset();
await text(111, 'SNPT');
cs = await calls();
const card = lastText(cs);
ok('pasting a ticker opens the token card', /\$SNPT<\/b> · Sniper Test/.test(card) && /PRICE/.test(card) && /Your bag/.test(card));
const kb = cs.reverse().find(c => c.method === 'sendMessage')?.body?.reply_markup?.inline_keyboard || [];
ok('card has XLM buy presets and sell buttons', JSON.stringify(kb).includes(`b:${mk.id}:50`) && JSON.stringify(kb).includes(`s:${mk.id}:50`));
await reset();
await tap(111, `b:${mk.id}:50`);
cs = await calls();
ok('one tap buys', cs.some(c => c.method === 'answerCallbackQuery' && /Bought/.test(c.body.text || '')), cs.find(c => c.method === 'answerCallbackQuery')?.body?.text);
ok('previous terminal is paused, a new live one opens', cs.some(c => c.method === 'editMessageText' && /paused/.test(c.body.text || '')) && cs.some(c => c.method === 'sendMessage' && /live · updated/.test(c.body.text || '')));
const tmsg = cs.filter(c => c.method === 'sendMessage' && /POSITION TERMINAL/.test(c.body.text || '')).length;
await reset();
await sleep(5000);
const t1 = await admin.req('POST', '/admin/snb', { tick: true }, true);
cs = await calls();
ok('the terminal refreshes itself (edit with live clock)', cs.some(c => c.method === 'editMessageText' && /POSITION TERMINAL/.test(c.body.text) && /live · updated/.test(c.body.text)), JSON.stringify(t1.tick));
const term = lastText(cs, 'editMessageText');
ok('terminal shows bag, value, cost, PnL', /BAG/.test(term) && /VALUE/.test(term) && /COST/.test(term) && /PNL/.test(term), term.replace(/\n/g, ' | ').slice(0, 160));
// a whale buy moves the price: PnL in the terminal changes on the next tick
const whale = new Client(); await whale.login(ethers.Wallet.createRandom());
await admin.req('POST', '/admin/credit', { user: (await whale.req('GET', '/me')).username, asset: 'xlm', amount: (3000n * WEI).toString() }, true);
await whale.req('POST', '/trade', { market: mk.id, side: 'buy', amount: (2000n * WEI).toString() });
await reset();
await admin.req('POST', '/admin/snb', { tick: true }, true);
cs = await calls();
const term2 = lastText(cs, 'editMessageText');
ok('after a price move the terminal shows profit', /PNL   🟢 \+/.test(term2), (term2.match(/PNL.*\n.*\n/) || [''])[0].replace(/\n/g, ' '));
const balBefore = (await admin.req('GET', '/admin/pos?user=' + uname + '&market=' + mk.id, null, true)).position;
await reset();
await tap(111, `s:${mk.id}:50`, 7777, '📟 POSITION TERMINAL · $SNPT');
cs = await calls();
const balAfter = (await admin.req('GET', '/admin/pos?user=' + uname + '&market=' + mk.id, null, true)).position;
ok('sell 50% from the terminal', /Sold 50%/.test(cs.find(c => c.method === 'answerCallbackQuery')?.body?.text || '') && Math.abs(Number(BigInt(balAfter.tokens)) / Number(BigInt(balBefore.tokens)) - 0.5) < 0.001);
ok('terminal updates in place after the sell', cs.some(c => c.method === 'editMessageText' && c.body.message_id === 7777));
await reset();
await tap(111, `b:${mk.id}:999999`);
cs = await calls();
ok('buying more than the balance is refused clearly', /Not enough XLM/.test(cs.find(c => c.method === 'answerCallbackQuery')?.body?.text || ''));
await reset();
await tap(111, `bx:${mk.id}`); await text(111, '12.5');
cs = await calls();
ok('Buy X asks for an amount and buys it', cs.some(c => c.body?.reply_markup?.force_reply) && cs.some(c => /Bought/.test(c.body?.text || '')));

console.log('== views');
for (const [d, re] of [['pos', /POSITIONS/], ['new', /NEW TOKENS/], ['hot', /TRENDING/], ['dep', /DEPOSIT[\s\S]*Memo: <code>\d+/], ['set', /SETTINGS/], ['wd', /WITHDRAW/]]) {
  await reset(); await tap(111, d); cs = await calls();
  ok(`${d} screen`, re.test(lastText(cs, 'editMessageText')), lastText(cs, 'editMessageText').slice(0, 40).replace(/\n/g, ' '));
}

console.log('== web login and account linking');
await reset(); await tap(111, 'web'); cs = await calls();
const link = JSON.stringify(cs).match(/\/api\/snb\/login\/([0-9a-f]{32})/);
ok('one-time web login link', !!link);
const w1 = await new Client().req('GET', '/snb/login/' + link[1]);
ok('login link signs in and goes to the wallet', w1.status === 302 && /pl_s=/.test(w1.setCookie || '') && w1.location === '/#/wallet');
ok('login link works only once', (await new Client().req('GET', '/snb/login/' + link[1])).status === 410);
const site = new Client(); await site.login(ethers.Wallet.createRandom());
const sname = (await site.req('GET', '/me')).username;
const l = await site.req('POST', '/snb/link');
ok('site account gets a Telegram link', /t\.me\/RookerySniperBot\?start=L[0-9a-f]{24}/.test(l.url || ''), l.url);
await reset(); await text(222, '/start ' + l.url.split('start=')[1], 'webuser');
cs = await calls();
ok('fresh Telegram user links to the site account', cs.some(c => new RegExp('Linked to your Rookery account <b>' + sname).test(c.body?.text || '')));
await reset(); await text(111, '/start ' + (await site.req('POST', '/snb/link')).url.split('start=')[1]);
cs = await calls();
ok('a bot wallet with funds cannot be silently swapped', cs.some(c => /already holds funds/.test(c.body?.text || '')));

console.log('== hatch snipe');
await reset();
const at = Date.now() + 6 * 60e3;
const h = await creator.req('POST', '/hatch', { name: 'Hatch Snipe', symbol: 'HSNP', network: 'stellar', launchAt: at });
ok('hatch announced', h.ok || h.id, JSON.stringify(h).slice(0, 80));
const hid = h.id || h.hatch?.id;
await tap(111, 'sn:stellar');      // general sniping off: only the armed hatch should buy
await tap(111, 'ha:' + hid); await text(111, '15');
cs = await calls();
ok('hatch snipe armed', cs.some(c => /Armed/.test(c.body?.text || '')));
await reset();
const mk2 = await creator.req('POST', '/markets', { name: 'Hatch Snipe', symbol: 'HSNP', network: 'stellar', hatchId: hid });
await sleep(2500);
cs = await calls();
ok('armed hatch is bought the moment it launches', cs.some(c => /Sniped \$HSNP/.test(c.body?.text || '')), mk2.id);

console.log('== books');
const st = await admin.req('POST', '/admin/snb', {}, true);
ok('bot fees collected (1%) into the burn reserve', st.fees.xlm > 0.9 && st.fees.xlm < 1.6, JSON.stringify(st.fees));
const led = await admin.req('GET', '/admin/ledger', null, true);
ok('ledger exact after bot trading', Math.abs(led.xlm.diffUnits) < 1e-9, String(led.xlm.diffUnits));
await reset();
await hook({ message: { message_id: 1, from: from(333, 'grp'), chat: { id: -100, type: 'supergroup' }, date: 1, text: '/start' } });
cs = await calls();
ok('groups are refused politely', /private chat/.test(lastText(cs)));
console.log(`== sniper bot E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
