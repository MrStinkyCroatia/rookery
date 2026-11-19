// Trading from a Stellar wallet with NO account and NO cookie: buy, add trustline, sell, all on testnet.
import { ethers } from 'ethers';
import * as S from '@stellar/stellar-sdk';
const API = 'http://127.0.0.1:8787/api', KEY = process.env.E2E_ADMIN_KEY;
const WEI = 10n ** 18n;
const hz = new S.Horizon.Server('https://horizon-testnet.stellar.org');
let pass = 0, fail = 0;
const ok = (n, v, x = '') => { v ? pass++ : fail++; console.log(`  ${v ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// a client that never keeps a cookie: exactly what an anonymous visitor is
const anon = (method, path, body) => fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-pl': '1' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const adm = (method, path, body) => anon(method, path + (method === 'GET' ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : ''), method === 'GET' ? undefined : { ...(body || {}), key: KEY });
class Client { constructor() { this.cookie = ''; }
  async req(m, p, b) { const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', 'x-pl': '1', cookie: this.cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0]; return r.json(); }
  async login(w) { const n = await this.req('POST', '/auth/wallet/nonce', { address: w.address }); return this.req('POST', '/auth/wallet/verify', { nonce: n.nonce, signature: await w.signMessage(n.message) }); } }
const friendbot = async (pk) => { for (let i = 0; i < 5; i++) { const r = await fetch(`https://friendbot.stellar.org?addr=${pk}`); if (r.ok) break; await sleep(2500); } for (let i = 0; i < 20; i++) { try { await hz.loadAccount(pk); return true; } catch { await sleep(1000); } } return false; };
const bal = async (pk, code, iss) => { try { const a = await hz.loadAccount(pk); const b = a.balances.find(x => code ? x.asset_code === code && x.asset_issuer === iss : x.asset_type === 'native'); return b ? Number(b.balance) : 0; } catch { return null; } };
const slug = async () => { await anon('POST', '/stellar/submit', {}).catch(() => {}); };
const signSubmit = async (w, xdr) => { const tx = S.TransactionBuilder.fromXDR(xdr, S.Networks.TESTNET); tx.sign(w); await hz.submitTransaction(tx); };

console.log('== setup');
await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(4000);
const stc = await adm('GET', '/admin/stellar'); await friendbot(stc.hot);
await adm('POST', '/admin/stellar/send-now', { on: true });
const creator = new Client(); await creator.login(ethers.Wallet.createRandom());
await adm('POST', '/admin/credit', { user: (await creator.req('GET', '/me')).username, asset: 'xlm', amount: (50n * WEI).toString() });
const mk = await creator.req('POST', '/markets', { name: 'No Login', symbol: 'NOLOG', network: 'stellar' });
let m; for (let i = 0; i < 30; i++) { const d = await creator.req('GET', '/market/' + mk.id); m = d.market || d; if (m?.stellar?.issuer) break; await sleep(2000); }
ok('market issued on testnet', !!m?.stellar?.issuer, m?.stellar?.code);

console.log('== anonymous buy from a wallet');
const W = S.Keypair.random(); await friendbot(W.publicKey());
const pre = await anon('POST', '/stellar/prep', { market: mk.id, amount: (20n * WEI).toString(), address: W.publicKey() });
ok('prep-buy works with no session', !!pre.xdr, pre.error || 'xdr ok');
await signSubmit(W, pre.xdr);
let tok = 0;
for (let i = 0; i < 12; i++) { await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await slug(); await adm('POST', '/admin/stellar/send-now', { run: true, force: true }); tok = await bal(W.publicKey(), m.stellar.code, m.stellar.issuer); if (tok > 0) break; await sleep(3000); }
ok('tokens landed in the wallet, still no account', tok > 0, String(tok));

console.log('== anonymous sell');
const x0 = await bal(W.publicKey());
const view = await anon('GET', `/stellar/wallet?market=${encodeURIComponent(mk.id)}&address=${W.publicKey()}`);
ok('wallet view needs no login', view.ok && Math.abs(Number(view.wallet) - tok) < 1 && view.trust === true, `${view.wallet} tokens, ${view.xlm} XLM`);
const sellTok = Math.floor(tok * 1e7 / 2) / 1e7;
const halfTok = BigInt(Math.floor(tok * 1e7 / 2)) * 100_000_000_000n;
const ps = await anon('POST', '/stellar/prep-sell', { market: mk.id, amount: halfTok.toString(), address: W.publicKey() });
ok('prep-sell works with no session', !!ps.xdr && /^s\d+$/.test(ps.memo || ''), ps.error || ps.memo);
await signSubmit(W, ps.xdr);
let tok2 = tok, x1 = x0;
for (let i = 0; i < 12; i++) { await fetch('http://127.0.0.1:8787/__scheduled').catch(() => {}); await sleep(3000); tok2 = await bal(W.publicKey(), m.stellar.code, m.stellar.issuer); x1 = await bal(W.publicKey()); if (tok2 < tok * 0.6 && x1 > x0) break; }
ok('half the tokens left the wallet', Math.abs(tok2 / tok - 0.5) < 0.02, `${tok} → ${tok2}`);
ok('the XLM came back to that same wallet', x1 > x0, `${x0} → ${x1}`);
ok('nobody was asked to log in', !/login|Log in/i.test(JSON.stringify([pre, ps, view])));

console.log('== guards');
const bad = await anon('POST', '/stellar/prep-sell', { market: mk.id, amount: String(WEI), address: 'GBAD' });
ok('bad address refused', !!bad.error, bad.error);
console.log(`== no-login trading E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
