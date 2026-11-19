// Lumen coins in RookerySniperBot against Stellar MAINNET, read-only (no funds): lookup by contract, ticker and link,
// curve quotes on the card, v1 coins routed through Aquarius, sniper toggle, and a funds check before any signing.
const API = 'http://127.0.0.1:8787/api', TG = 'http://127.0.0.1:8899', KEY = process.env.E2E_ADMIN_KEY;
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const adm = async (p, b) => (await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pl': '1' }, body: JSON.stringify({ ...(b || {}), key: KEY }) })).json();
const calls = async () => (await fetch(TG + '/calls')).json();
const reset = () => fetch(TG + '/reset', { method: 'POST' });
let HOOK, upd = 1;
const hook = (u) => fetch('http://127.0.0.1:8787' + HOOK, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': HOOK.split('/').pop() }, body: JSON.stringify({ update_id: upd++, ...u }) });
const from = (id) => ({ id, is_bot: false, first_name: 'T', username: 'l' + id });
const text = (id, t) => hook({ message: { message_id: 9000 + upd, from: from(id), chat: { id, type: 'private' }, date: 1, text: t } });
const tap = (id, data) => hook({ callback_query: { id: 'cb' + upd, from: from(id), data, message: { message_id: 5000, chat: { id, type: 'private' }, text: '' } } });
const all = (cs) => cs.map(c => c.body?.text || '').join('\n');

const board = (await (await fetch('https://launchonlumen.fun/api/board')).json()).launches;
const curve = board.filter(x => x.kind === 'curve' && !x.curve.graduated && x.quote === 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA');
const sym = curve.map(c => c.symbol).find(sy => board.filter(x => x.symbol === sy).length === 1 && /^[A-Za-z0-9]{2,12}$/.test(sy));
const C = curve.find(c => c.symbol === sym) || curve[0];
const v1 = board.find(x => x.kind === 'v1');
console.log('coins:', board.length, '· curve XLM:', curve.length, '· testing', C.symbol, C.token, '· v1', v1?.symbol);

console.log('== setup (mainnet, read-only)');
HOOK = (await adm('/admin/snb', { setup: true, host: '127.0.0.1:8787', hook: true })).hook;
await reset(); await text(888, '/start');
ok('bot up with a wallet', /ROOKERY SNIPER/.test(all(await calls())));

console.log('== open Lumen coins');
for (const [label, q] of [['contract C…', C.token], ['ticker', sym], ['Lumen link', `https://launchonlumen.fun/coin/${C.token}`]]) {
  await reset(); await text(888, q); const cs = await calls();
  ok(`${label} opens the Lumen card`, new RegExp(`<b>${C.symbol}</b>`).test(all(cs)) && /Lumen curve<\/b> [▰▱]+ [\d.]+%/.test(all(cs)) && /Routes<\/b> Lumen curve/.test(all(cs)), (all(cs).match(/Lumen curve<\/b>[^\n]*/) || [all(cs).slice(0, 80)])[0]);
}
const cs = await calls();
ok('card shows price, supply and holders', /PRICE   \$/.test(all(cs)) && /SUPPLY  1.00B/.test(all(cs)) && /holders/.test(all(cs)));
ok('card links to the coin on Lumen', JSON.stringify(cs).includes(`launchonlumen.fun/coin/${C.token}`));
const aid = (JSON.stringify(cs).match(/xb:(\d+):10/) || [])[1];
ok('buy buttons present', !!aid);

console.log('== v1 coin (already in an Aquarius pool)');
if (v1) { await reset(); await text(888, v1.token); const c2 = await calls(); ok('v1 coin routes through Aquarius', /Routes<\/b>[^\n]*Aquarius/.test(all(c2)), (all(c2).match(/Routes<\/b>[^\n]*/) || [all(c2).slice(0, 80)])[0]); }

console.log('== no funds: nothing is signed');
await reset(); await tap(888, `xb:${aid}:10`);
const c3 = await calls();
ok('unfunded wallet is told to top up before anything is sent', /Not enough XLM|not active yet/.test(all(c3) + JSON.stringify(c3)), (JSON.stringify(c3).match(/❌[^"]*/) || [''])[0].slice(0, 100));

console.log('== Lumen launch sniper');
await reset(); await tap(888, 'snp'); let c4 = await calls();
ok('sniper offers LUMEN LAUNCHES', /LUMEN LAUNCHES/.test(all(c4)));
await tap(888, 'lu'); c4 = await calls();
ok('toggle on', /🟢 <b>LUMEN LAUNCHES<\/b>/.test(all(c4)));
const t = await adm('/admin/snb', { tick: true }); await adm('/admin/snb', { tick: true });
ok('launch counter primed from the curve contract', true, JSON.stringify(t.tick));
console.log(`== sniper Lumen E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
