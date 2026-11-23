// End-to-end test of worker/zbridge.js (the exact code the Rookery worker runs) on a local chain with chain id 1:
// deploy from the bot key at nonce 0, sign-ups through the prepared wallet transactions, closed route, the route opening
// and the 2-second tick firing every order in one batch, cancel, one-transaction manual bridge, and the Zero balance.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Interface, HDNodeWallet, getCreateAddress } from 'ethers';
import { installZBridge, ZB_CHAINS, ZB_ABI } from '../worker/zbridge.js';

const PORT = 8561, URL = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--port', String(PORT), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0;
const rpc = async (m, p) => { const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: m, params: p }) }); const j = await r.json(); if (j.error) throw Object.assign(new Error(j.error.message), { data: j.error.data }); return j.result; };
for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId', []); break; } catch { await sleep(300); } }
const results = []; const ok = (name, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', name, extra]);
const send = async (from, tx) => { const h = await rpc('eth_sendTransaction', [{ from, ...tx }]); let rc = null; for (let i = 0; i < 50 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await sleep(100); } if (!rc || rc.status !== '0x1') throw new Error('tx failed ' + h); return rc; };
const bal = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));

// scan API mock: every bridge we query is "DELIVERED" (the real API only knows mainnet transactions)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/messages/wallet/')) return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
  if (String(url).includes('scan.layerzero-api.com')) return new Response(JSON.stringify({ data: [{ status: { name: 'DELIVERED' }, destination: { tx: { txHash: '0x' + 'd'.repeat(64) } } }] }), { headers: { 'content-type': 'application/json' } });
  return realFetch(url, opts);
};

// a worker-shaped object: SQLite storage, meta, HD master, the bridge methods installed exactly as in production
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)');
class W {}
installZBridge(W, { now: () => Date.now() });
const w = new W();
w.sql = { exec: (q, ...ps) => { const st = db.prepare(q); const rows = /^\s*(SELECT|WITH)/i.test(q) ? st.all(...ps) : (st.run(...ps), []); return { toArray: () => rows, one: () => rows[0] }; } };
w.meta = (k) => db.prepare('SELECT v FROM meta WHERE k=?').get(k)?.v ?? null;
w.setMeta = (k, v) => db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
const root = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, 'm');
w.master = () => root; w.env = {}; w.zwState = () => ({}); w.zroUsd = () => 1.2; w.tg = async () => ({ ok: true });
const hot = root.deriveChild(7); w.hotWallet = () => hot;
ZB_CHAINS.eth.rpcs = [URL];

try {
  const accts = await rpc('eth_accounts', []);
  const [dev, u1, u2, u3] = accts;
  // mocks: ZRO token + OFT (route closed at first)
  const art = (f, c) => JSON.parse(readFileSync(`rhcurve/out/${f}/${c}.json`, 'utf8'));
  const ZA = art('ZroAutoBridge.t.sol', 'MockZro'), OA = art('ZroAutoBridge.t.sol', 'MockOFT');
  const ZI = new Interface(ZA.abi), OI = new Interface(OA.abi);
  const zroAddr = getCreateAddress({ from: dev, nonce: Number(BigInt(await rpc('eth_getTransactionCount', [dev, 'latest']))) });
  await send(dev, { data: ZA.bytecode.object });
  const oftAddr = getCreateAddress({ from: dev, nonce: Number(BigInt(await rpc('eth_getTransactionCount', [dev, 'latest']))) });
  await send(dev, { data: OA.bytecode.object + new Interface(['constructor(address)']).encodeDeploy([zroAddr]).slice(2) });
  await send(dev, { to: oftAddr, data: OI.encodeFunctionData('setClosed', [true]) });
  w.zbrZro = () => zroAddr; w.zbrOft = () => oftAddr;
  for (const u of [u1, u2, u3]) await send(dev, { to: zroAddr, data: ZI.encodeFunctionData('mint', [u, 1000n * 10n ** 18n]) });

  // 1 · deploy from the bot key at nonce 0 -> the reserved, same-on-every-chain address
  const a = w.zbrAddr();
  await rpc('anvil_setBalance', [a.bot, '0x56bc75e2d63100000']);
  const dep = await w.zbrDeploy('eth', { confirm: 'DEPLOY' });
  ok('deploy: contract at the reserved address (bot key, nonce 0)', dep.ok && dep.contract === a.contract && (await rpc('eth_getCode', [a.contract, 'latest'])).length > 10, a.contract);
  ok('deploy again: recognised, no second contract', (await w.zbrDeploy('eth', { confirm: 'DEPLOY' })).already === true);
  let refused = false; try { await w.zbrDeploy('eth', {}); } catch { refused = true; } ok('deploy needs confirm', refused);

  // 2 · sign up two users through the exact transactions the page asks the wallet to sign
  for (const [u, amt] of [[u1, 100n], [u2, 40n]]) {
    const p = await w.zbrPrep({ chain: 'eth', from: u, action: 'signup', amount: (amt * 10n ** 18n).toString() });
    ok(`prep signup ${amt} ZRO: approve exact amount + signUp with deposit`, p.txs.length === 2 && p.txs[0].label === 'Approve ZRO' && p.txs[1].value === '0x' + BigInt(ZB_CHAINS.eth.deposit).toString(16));
    for (const t of p.txs) await send(u, { to: t.to, data: t.data, value: t.value });
  }
  const allow = BigInt(await rpc('eth_call', [{ to: zroAddr, data: ZI.encodeFunctionData('allowance', [u1, a.contract]) }, 'latest']));
  ok('approval is exactly the amount, not unlimited', allow === 100n * 10n ** 18n, allow.toString());

  // 3 · closed route: the tick checks, nothing moves
  let live = await w.zbrTick();
  ok('closed route: tick sees 2 waiting, route closed, no fire', live.eth.pending.length === 2 && live.eth.open === false && !live.eth.lastFire, live.eth.why);
  const p0 = await w.zbrPrep({ chain: 'eth', from: u3, action: 'bridge', amount: (10n * 10n ** 18n).toString() });
  ok('manual bridge while closed: page gets "closed" before any signature', p0.closed === true && p0.reason === 'RouteClosed', p0.reason);

  // 4 · the route opens: the very next tick simulates fireMany and broadcasts one batch for everyone
  await send(dev, { to: oftAddr, data: OI.encodeFunctionData('setClosed', [false]) });
  const u1eth0 = await bal(u1);
  const t0 = Date.now();
  live = await w.zbrTick();
  const fired = live.eth.lastFire;
  ok('open route: the first tick fires the batch', !!fired?.hash && fired.users === 2, `${fired?.users} orders, tick ${Date.now() - t0} ms`);
  const rc = await w.zbrWait('eth', fired.hash);
  ok('batch transaction mined', rc && rc.status === '0x1');
  const lastTo = await rpc('eth_call', [{ to: oftAddr, data: OI.encodeFunctionData('lastTo', []) }, 'latest']);
  ok('each order bridged to its own address on Zero', [u1, u2].map(x => x.toLowerCase().slice(2)).includes(lastTo.slice(26).toLowerCase()));
  const z1 = BigInt(await rpc('eth_call', [{ to: zroAddr, data: ZI.encodeFunctionData('balanceOf', [u1]) }, 'latest']));
  ok('user 1: exactly 100 ZRO left the wallet', z1 === 900n * 10n ** 18n, (z1 / 10n ** 18n).toString());
  ok('user 1: deposit minus LayerZero fee refunded, no gas paid by the user', (await bal(u1)) - u1eth0 === BigInt(ZB_CHAINS.eth.deposit) - 10n ** 15n, ((await bal(u1)) - u1eth0).toString());
  live = await w.zbrTick();
  ok('no double fire: pending list empty after the batch', (live.eth.pending || []).length === 0);

  // 5 · cancel: deposit back, order gone
  const pc = await w.zbrPrep({ chain: 'eth', from: u3, action: 'signup', amount: (5n * 10n ** 18n).toString() });
  for (const t of pc.txs) await send(u3, { to: t.to, data: t.data, value: t.value });
  const u3b = await bal(u3);
  const cx = await w.zbrPrep({ chain: 'eth', from: u3, action: 'cancel' });
  const crc = await send(u3, { to: cx.txs[0].to, data: cx.txs[0].data, value: cx.txs[0].value });
  const gas = BigInt(crc.gasUsed) * BigInt(crc.effectiveGasPrice);
  ok('cancel returns the whole deposit', (await bal(u3)) + gas - u3b === BigInt(ZB_CHAINS.eth.deposit));
  const me3 = await w.zbrMe(u3);
  ok('cancelled order no longer listed', me3.chains.eth.order === null);

  // 6 · manual bridge in ONE transaction (after the one-time approval)
  const pm = await w.zbrPrep({ chain: 'eth', from: u3, action: 'bridge', amount: (20n * 10n ** 18n).toString() });
  ok('manual bridge prep: quote from the contract, approve + bridgeNow', !pm.closed && pm.txs.at(-1).label === 'Bridge to Zero' && pm.quote.bridged === (20n * 10n ** 18n * 9970n / 10000n).toString(), pm.quote?.bridged);
  for (const t of pm.txs) await send(u3, { to: t.to, data: t.data, value: t.value });
  const z3 = BigInt(await rpc('eth_call', [{ to: zroAddr, data: ZI.encodeFunctionData('balanceOf', [u3]) }, 'latest']));
  ok('manual bridge: 20 ZRO left, 0.3% fee', z3 === 980n * 10n ** 18n);

  // 7 · history, LayerZero status and the balance on Zero
  await w.zbrIndex();
  const kinds = db.prepare('SELECT kind, COUNT(*) c FROM zb_ev GROUP BY kind').all().map(r => `${r.kind}:${r.c}`).join(' ');
  ok('events indexed (sign-ups, fires, cancel, manual)', /Fired:2/.test(kinds) && /SignedUp:3/.test(kinds) && /Cancelled:1/.test(kinds) && /Bridged:1/.test(kinds), kinds);
  const me1 = await w.zbrMe(u1);
  ok('user 1 sees the bridge as DELIVERED on Zero', me1.history[0]?.status === 'DELIVERED', me1.history[0]?.status);
  ok('user 1 balance on Zero = 99.5 ZRO (100 minus the 0.5% fee)', me1.zero.delivered === (995n * 10n ** 17n).toString(), (Number(me1.zero.delivered) / 1e18) + ' ZRO');
  const me3b = await w.zbrMe(u3);
  ok('user 3 balance on Zero = 19.94 ZRO (manual, 0.3% fee)', me3b.zero.delivered === (1994n * 10n ** 16n).toString(), (Number(me3b.zero.delivered) / 1e18) + ' ZRO');
  const info = w.zbrInfo();
  ok('stats: 3 users bridged, 159.24 ZRO (99.5 + 39.8 + 19.94)', info.stats.users === 3 && Math.abs(info.stats.bridgedZro - 159.24) < 1e-9, JSON.stringify(info.stats));
} catch (e) { results.push(['FAIL', 'exception', e.stack?.split('\n').slice(0, 2).join(' ') || e.message]); }
anvil.kill();
for (const r of results) console.log(r[0], '·', r[1], r[2] ? '· ' + r[2] : '');
console.log(results.filter(r => r[0] === 'PASS').length + '/' + results.length + ' passed');
process.exit(0);
