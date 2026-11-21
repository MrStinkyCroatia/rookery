// RookerySniperBot: a Telegram trading terminal for every Rookery token.
// It trades on the user's Rookery account (the same ledger as the website), so buys and sells are instant
// and every launchpad token works: Stellar (XLM), Zero and GIWA (ZRO / ETH).
// Sniping runs through the exact same launch rules as everyone else (max-buy window, minimums): no hidden edge.
// After a buy a live Position Terminal message refreshes itself every few seconds.

import { Keypair, Asset, TransactionBuilder } from '@stellar/stellar-sdk';
import { ST_NETS } from './stellar.js';

export function installSniper(Cls, H) {
  const { B, WEI, now, escH, randHex, qa, burnKey } = H;
  const P = Cls.prototype;
  const LIVE_MS = 15 * 60e3;            // a terminal stays live this long after the last tap
  const TICK_MS = 5000;
  const PRESETS = { xlm: [10, 50, 100, 500], zro: [5, 10, 25, 100], eth: [0.005, 0.01, 0.05, 0.1] };
  const UNIT = { xlm: 'XLM', zro: 'ZRO', eth: 'ETH' };
  const NET = { stellar: 'STELLAR', zero: 'ZERO', giwa: 'GIWA' };
  const LINE = '━━━━━━━━━━━━━━━━━━━━━━';

  /* ── formatting ── */
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  const usd = (v) => {
    v = Number(v) || 0;
    const s = v < 0 ? '-' : ''; v = Math.abs(v);
    if (v >= 1e6) return s + '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e4) return s + '$' + (v / 1e3).toFixed(1) + 'K';
    if (v >= 1) return s + '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 0.01) return s + '$' + v.toFixed(4);
    if (v === 0) return '$0';
    const z = Math.floor(-Math.log10(v));                 // leading zeros after "0."
    const digits = Math.round(v * 10 ** (z + 3));
    return s + '$0.0' + String(z - 1).split('').map(d => SUB[d]).join('') + String(digits).slice(0, 4);
  };
  const num = (v, d = 2) => {
    v = Number(v) || 0; const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    return v.toLocaleString('en-US', { maximumFractionDigits: a < 1 ? 6 : d });
  };
  const amt = (wei, d = 4) => num(Number(B(wei)) / 1e18, d);
  const pct = (v) => (v == null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  const sign = (v) => (v >= 0 ? '🟢' : '🔴');
  const bar = (p) => { const n = Math.max(0, Math.min(10, Math.round((Number(p) || 0) / 10))); return '▰'.repeat(n) + '▱'.repeat(10 - n); };
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  const toWei = (s) => {
    const [i, f = ''] = String(s).trim().replace(',', '.').split('.');
    if (!/^\d*$/.test(i) || !/^\d*$/.test(f) || (!i && !f)) throw new Error('Enter a number');
    return BigInt(i || '0') * WEI + BigInt((f + '0'.repeat(18)).slice(0, 18));
  };
  const hhmmss = () => new Date().toISOString().slice(11, 19);

  /* ── storage ── */
  P.snbInit = function () {
    if (this._snbInit) return; this._snbInit = true;
    const q = (s) => this.sql.exec(s);
    q(`CREATE TABLE IF NOT EXISTS snb_users (tg_id TEXT PRIMARY KEY, user_id INTEGER, chat_id TEXT, settings TEXT DEFAULT '{}', pending TEXT DEFAULT '', created INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS snb_terms (chat_id TEXT, msg_id INTEGER, user_id INTEGER, market TEXT, until INTEGER, last TEXT DEFAULT '', edited INTEGER DEFAULT 0, PRIMARY KEY (chat_id, msg_id))`);
    q(`CREATE TABLE IF NOT EXISTS snb_snipes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, hatch TEXT, amount TEXT, status TEXT, created INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS snb_tokens (token TEXT PRIMARY KEY, kind TEXT, user_id INTEGER, expires INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS snb_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, market TEXT, side TEXT, quote TEXT, amount TEXT, fee TEXT, how TEXT, ts INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS snb_del (chat_id TEXT, msg_id INTEGER, at INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS snb_upd (id INTEGER PRIMARY KEY, ts INTEGER)`);
    q(`CREATE TABLE IF NOT EXISTS snb_ref (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer INTEGER, trader INTEGER, asset TEXT, amount TEXT, status TEXT, ts INTEGER)`);
    for (const c of ['ref_code TEXT', 'ref_by INTEGER', 'ref_at INTEGER']) { try { q(`ALTER TABLE snb_users ADD COLUMN ${c}`); } catch { /* exists */ } }
    for (const c of ['wpub TEXT', 'wsec TEXT', 'exported INTEGER DEFAULT 0']) { try { q(`ALTER TABLE snb_users ADD COLUMN ${c}`); } catch { /* exists */ } }
    try { q(`ALTER TABLE st_intents ADD COLUMN fee_bps INTEGER DEFAULT 0`); } catch { /* exists */ }
  };
  // bot fee: booked into the $臭企鹅 burn reserve, so the ledger stays exact
  P.snbRefBps = function () { return BigInt(Number(this.meta('snb_ref_bps') || 2500)); };
  P.snbReferrer = function (uid) {
    try { const r = this.sql.exec('SELECT ref_by FROM snb_users WHERE user_id=? AND ref_by IS NOT NULL', uid).toArray()[0]; return r?.ref_by && r.ref_by !== uid ? r.ref_by : null; } catch { return null; }
  };
  P.snbChargeFee = function (uid, q, fee) {
    if (fee <= 0n) return;
    this.snbInit();
    const ref = this.snbReferrer(uid);
    const cut = ref ? (fee * this.snbRefBps()) / 10000n : 0n;
    this.ctx.storage.transactionSync(() => {
      this.addBal(uid, q, -fee);
      if (cut > 0n) {
        this.addBal(ref, q, cut);
        this.sql.exec('INSERT INTO snb_ref (referrer,trader,asset,amount,status,ts) VALUES (?,?,?,?,?,?)', ref, uid, q, cut.toString(), 'paid', now());
      }
      this.setMeta(burnKey(q), (B(this.meta(burnKey(q))) + fee - cut).toString());
      this.setMeta('snb_fees_' + q, (B(this.meta('snb_fees_' + q)) + fee - cut).toString());
    });
  };
  // fees paid on-chain (any-token routes) reach the fees account first; the inviter's share is booked now and settled from there
  P.snbRefAccrue = function (uid, feeWei) {
    const ref = this.snbReferrer(uid);
    if (!ref || feeWei <= 0n) return;
    const cut = (feeWei * this.snbRefBps()) / 10000n;
    if (cut > 0n) this.sql.exec('INSERT INTO snb_ref (referrer,trader,asset,amount,status,ts) VALUES (?,?,?,?,?,?)', ref, uid, 'xlm', cut.toString(), 'pending', now());
  };
  P.snbRefSettle = function () {
    this.snbInit();
    const fu = Number(this.meta('snb_fee_uid') || 0);
    if (!fu) return 0;
    let n = 0;
    for (const r of this.sql.exec(`SELECT * FROM snb_ref WHERE status='pending' ORDER BY id LIMIT 50`).toArray()) {
      const amtW = B(r.amount);
      if (this.bal(fu, 'xlm') < amtW) break;                     // the fee payment has not landed yet: next minute
      this.ctx.storage.transactionSync(() => {
        this.addBal(fu, 'xlm', -amtW);
        this.addBal(r.referrer, 'xlm', amtW);
        this.sql.exec(`UPDATE snb_ref SET status='paid' WHERE id=?`, r.id);
      });
      n++;
    }
    return n;
  };
  P.snbRefCode = function (row) {
    if (row.ref_code) return row.ref_code;
    let c = randHex(4);
    while (this.sql.exec('SELECT 1 FROM snb_users WHERE ref_code=?', c).toArray().length) c = randHex(4);
    this.sql.exec('UPDATE snb_users SET ref_code=? WHERE tg_id=?', c, row.tg_id);
    return c;
  };
  P.snbRefStats = function (uid) {
    const inv = this.sql.exec('SELECT user_id FROM snb_users WHERE ref_by=?', uid).toArray().map(r => r.user_id);
    const active = inv.length ? this.sql.exec(`SELECT COUNT(DISTINCT user_id) c FROM snb_log WHERE user_id IN (${inv.map(() => '?').join(',')})`, ...inv).one().c : 0;
    const sum = (status, asset, since = 0) => this.sql.exec(`SELECT amount FROM snb_ref WHERE referrer=? AND status=? AND asset=? AND ts>=?`, uid, status, asset, since).toArray().reduce((a, r) => a + B(r.amount), 0n);
    const earned = {}, pending = {}, today = {};
    for (const a of ['xlm', 'zro', 'eth']) { earned[a] = sum('paid', a); pending[a] = sum('pending', a); today[a] = sum('paid', a, now() - 864e5) + sum('pending', a, now() - 864e5); }
    const trades = inv.length ? this.sql.exec(`SELECT COUNT(*) c FROM snb_log WHERE user_id IN (${inv.map(() => '?').join(',')})`, ...inv).one().c : 0;
    const top = this.sql.exec(`SELECT r.trader, u.username, SUM(CAST(r.amount AS REAL)) s FROM snb_ref r JOIN users u ON u.id=r.trader WHERE r.referrer=? AND r.asset='xlm' GROUP BY r.trader ORDER BY s DESC LIMIT 5`, uid).toArray();
    return { invited: inv.length, active, trades, earned, pending, today, top };
  };

  /* ── personal Stellar wallet: the user's own keypair, exportable / importable ── */
  P.snbAes = async function () {
    if (this._snbAes) return this._snbAes;
    if (!this.env.MASTER_XPRV) throw new Error('wallet service not configured');
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.env.MASTER_XPRV + ':snb-wallet-enc-v1'));
    this._snbAes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return this._snbAes;
  };
  P.snbSeal = async function (secret) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.snbAes(), new TextEncoder().encode(secret)));
    return Buffer.from([...iv, ...ct]).toString('base64');
  };
  P.snbOpen = async function (box) {
    const b = Buffer.from(String(box), 'base64');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, await this.snbAes(), b.subarray(12));
    return new TextDecoder().decode(pt);
  };
  // the wallet the bot can sign for (only when it is also the account's linked Stellar wallet)
  P.snbWallet = function (row, user) {
    if (row?.wsec && row.wpub && user?.stellar_wallet === row.wpub) return { pub: row.wpub, signer: true };
    if (user?.stellar_wallet) return { pub: user.stellar_wallet, signer: false };
    return null;
  };
  P.snbEnsureWallet = async function (row, user) {
    if (row.wsec || user.stellar_wallet) return;
    const kp = Keypair.random();
    if (this.sql.exec('SELECT 1 FROM users WHERE stellar_wallet=?', kp.publicKey()).toArray().length) return;
    const box = await this.snbSeal(kp.secret());
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE snb_users SET wpub=?, wsec=? WHERE tg_id=?', kp.publicKey(), box, row.tg_id);
      this.sql.exec('UPDATE users SET stellar_wallet=? WHERE id=?', kp.publicKey(), user.id);
    });
  };
  P.snbKp = async function (row) { return Keypair.fromSecret(await this.snbOpen(row.wsec)); };
  // on-chain view of a wallet (cached a few seconds: the live terminal reads it every tick)
  P.snbChain = async function (pub) {
    this._snbCC = this._snbCC || new Map();
    const c = this._snbCC.get(pub);
    if (c && now() - c.t < 4000) return c.v;
    const st = await this.stellar();
    let a = null, err = null;
    for (let i = 0; i < 3; i++) {
      try { a = await st.account(pub); err = null; break; } catch (e) { err = e; await new Promise(r => setTimeout(r, 700)); }
    }
    if (err) { if (c && c.v.exists) return c.v; return { ok: false, exists: false, xlm: 0, avail: 0, tok: {} }; }
    const v = { ok: true, exists: !!a, xlm: 0, avail: 0, tok: {} };
    if (a) {
      for (const b of a.balances) {
        if (b.asset_type === 'native') v.xlm = Number(b.balance);
        else if (b.asset_code) v.tok[b.asset_code + ':' + b.asset_issuer] = { bal: Number(b.balance), auth: !!b.is_authorized };
      }
      const reserve = (2 + Number(a.subentry_count || 0)) * 0.5;
      v.avail = Math.max(0, Math.floor((v.xlm - reserve - 0.6) * 1e7) / 1e7);      // keep reserves + a little for fees
    }
    this._snbCC.set(pub, { t: v.exists ? now() : now() - 3000, v });   // a missing account is re-checked right away
    return v;
  };
  // a fresh read for decisions that move money (never the cached one); a just-funded account may lag a moment
  P.snbChainFresh = async function (pub) {
    this._snbCC?.delete(pub);
    let v = await this.snbChain(pub);
    if (v.ok && !v.exists) { await new Promise(r => setTimeout(r, 1500)); this._snbCC?.delete(pub); v = await this.snbChain(pub); }
    return v;
  };
  P.snbChainTok = function (chain, m) { return m?.st_issuer && chain?.tok ? (chain.tok[m.st_code + ':' + m.st_issuer]?.bal || 0) : 0; };
  // position over the Rookery balance plus whatever sits in the user's own wallet
  P.snbPos = function (uid, m, chainTok = 0) {
    const p = this.position(uid, m);
    const price = Number(Cls.price(m)) / 1e18;
    const ledger = Number(B(p.tokens)) / 1e18;
    // tokens already taken off the Rookery balance but not yet landed in the wallet
    const flight = this.sql.exec(`SELECT amount FROM transfers WHERE user_id=? AND asset=? AND kind='withdrawal' AND status='pending'`, uid, 't:' + m.id).toArray()
      .reduce((a, r) => a + Number(B(r.amount)) / 1e18, 0);
    const tokens = ledger + (chainTok || 0) + flight;
    let fees = 0;
    try { fees = this.sql.exec('SELECT COALESCE(SUM(CAST(fee AS REAL)),0) f FROM snb_log WHERE user_id=? AND market=?', uid, m.id).one().f / 1e18; } catch { /* no bot trades */ }
    const value = tokens * price, cost = p.costZro + fees, pnl = value - cost;
    return { ...p, ledger, chain: chainTok || 0, flight, tokensNum: tokens, valueZro: value, costZro: cost, pnlZro: pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : null };
  };
  // wait for the hot-wallet scanner to pick up a payment we just submitted
  P.snbSettle = async function (intentId, tries = 6) {
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, i ? 1800 : 1200));
      try { await this.wserial(() => this.stellarScan()); } catch { /* retry */ }
      const it = this.sql.exec('SELECT status FROM st_intents WHERE id=?', intentId).toArray()[0];
      if (it && it.status !== 'open') return it.status;
    }
    return 'pending';
  };
  P.snbEnsureTrust = async function (row, m) {
    const ch = await this.snbChain(row.wpub);
    if (!ch.exists || ch.tok[m.st_code + ':' + m.st_issuer]) return;
    if (ch.xlm < 2) return;
    const st = await this.stellar();
    const x = await st.buildTrustXdr({ from: row.wpub, code: m.st_code, issuer: m.st_issuer });
    const tx = TransactionBuilder.fromXDR(x, ST_NETS[this.stNet()].pass);
    tx.sign(await this.snbKp(row));
    await st.submitXdr(tx.toXDR());
    this._snbCC?.delete(row.wpub);
  };
  P.snbSignSubmit = async function (row, xdr) {
    const st = await this.stellar();
    const tx = TransactionBuilder.fromXDR(xdr, ST_NETS[this.stNet()].pass);
    tx.sign(await this.snbKp(row));
    const r = await st.submitXdr(tx.toXDR());
    this._snbCC?.delete(row.wpub);
    return r.hash;
  };
  // buy straight from the user's own wallet: one signed payment with a memo, the curve fills, tokens come back on-chain
  P.snbChainBuy = async function (row, user, m, xlm) {
    const st = await this.stellar();
    this.sql.exec('INSERT INTO st_intents (user_id,market,amount,status,created,expires,fee_bps) VALUES (?,?,?,?,?,?,?)',
      user.id, m.id, toWei(String(xlm)).toString(), 'open', now(), now() + 30 * 60e3, Number(this.snbFeeBps()));
    const id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
    const xdr = await st.buildPaymentXdr({ from: row.wpub, to: st.hotAddress, amount: xlm, memo: 'r' + id, trust: { code: m.st_code, issuer: m.st_issuer } });
    const hash = await this.snbSignSubmit(row, xdr);
    const status = await this.snbSettle(id);
    return { hash, status };
  };
  P.snbChainSell = async function (row, user, m, tokens7) {
    const st = await this.stellar();
    this.sql.exec('INSERT INTO st_intents (user_id,market,amount,status,created,expires,side,address,fee_bps) VALUES (?,?,?,?,?,?,?,?,?)',
      user.id, m.id, toWei(String(tokens7)).toString(), 'open', now(), now() + 30 * 60e3, 'sell', row.wpub, Number(this.snbFeeBps()));
    const id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
    const xdr = await st.buildTokenPaymentXdr({ from: row.wpub, to: st.hotAddress, code: m.st_code, issuer: m.st_issuer, amount: tokens7, memo: 's' + id });
    const hash = await this.snbSignSubmit(row, xdr);
    const status = await this.snbSettle(id);
    return { hash, status };
  };

  /* ── contract / asset lookup: issuer G…, CODE:ISSUER, Soroban contract C…, links ── */
  P.snbResolve = function (text) {
    const t = String(text || '').trim();
    const byIssuer = (code, iss) => this.sql.exec(`SELECT id FROM markets WHERE st_issuer=?${code ? ' AND st_code=?' : ''} ORDER BY created DESC LIMIT 1`, ...(code ? [iss, code] : [iss])).toArray()[0]?.id;
    let mm = t.match(/([A-Za-z0-9]{1,12})[:\-](G[A-Z2-7]{55})/);
    if (mm) { const id = byIssuer(mm[1], mm[2]); if (id) return id; }
    mm = t.match(/\b(G[A-Z2-7]{55})\b/);
    if (mm) { const id = byIssuer(null, mm[1]); if (id) return id; }
    mm = t.match(/\b(C[A-Z2-7]{55})\b/);
    if (mm) {
      const pass = ST_NETS[this.stNet()].pass;
      this._snbSac = this._snbSac || new Map();
      for (const r of this.sql.exec(`SELECT id, st_code, st_issuer FROM markets WHERE st_issuer IS NOT NULL AND st_issuer!=''`).toArray()) {
        let c = this._snbSac.get(r.id);
        if (!c) { try { c = new Asset(r.st_code, r.st_issuer).contractId(pass); this._snbSac.set(r.id, c); } catch { continue; } }
        if (c === mm[1]) return r.id;
      }
    }
    return this.parseMarketRef(t);
  };
  P.snbSac = function (m) {
    try { return new Asset(m.st_code, m.st_issuer).contractId(ST_NETS[this.stNet()].pass); } catch { return ''; }
  };
  P.snbOn = function () { return !!this.env.SNIPER_BOT_TOKEN; };
  P.snbFeeBps = function () { return BigInt(Number(this.meta('snb_fee_bps') || 100)); };
  P.snbBot = function () { return this.meta('snb_bot') || 'RookerySniperBot'; };
  P.tgS = async function (method, body) {
    if (!this.env.SNIPER_BOT_TOKEN) return null;
    const r = await fetch(`${this.env.TG_API_BASE || 'https://api.telegram.org'}/bot${this.env.SNIPER_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => null);
  };
  P.snbSettings = function (row) {
    let s = {}; try { s = JSON.parse(row?.settings || '{}'); } catch { /* default */ }
    s.snipe = s.snipe || { stellar: { on: false, amount: 25 }, zero: { on: false, amount: 5 }, giwa: { on: false, amount: 0.005 } };
    s.maxDay = s.maxDay || 10;
    s.slip = s.slip || 5;
    s.pools = s.pools || { on: false, amount: 25 };
    s.lumen = s.lumen || { on: false, amount: 25 };
    s.terminal = s.terminal !== false;
    return s;
  };
  P.snbSave = function (tgId, s) { this.sql.exec('UPDATE snb_users SET settings=? WHERE tg_id=?', JSON.stringify(s), String(tgId)); };

  // the Rookery account behind a Telegram user; created on first contact
  P.snbAccount = function (from, chatId) {
    this.snbInit();
    const tgId = String(from.id);
    let row = this.sql.exec('SELECT * FROM snb_users WHERE tg_id=?', tgId).toArray()[0];
    if (!row) {
      let base = 'tg_' + String(from.username || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 14);
      if (base === 'tg_') base = 'tg_' + randHex(3);
      let uname = base;
      while (this.sql.exec('SELECT 1 FROM users WHERE username=? COLLATE NOCASE', uname).toArray().length) uname = base.slice(0, 12) + '_' + randHex(2);
      const idx = Number(this.meta('dep_counter')) + 1;
      this.setMeta('dep_counter', idx);
      this.sql.exec(`INSERT INTO users (email,username,pass_hash,salt,dep_index,dep_address,created) VALUES (?,?,?,?,?,?,?)`,
        `${tgId}@telegram.local`, uname, '', '', idx, this.depositAddressFor(idx), now());
      const uid = this.sql.exec('SELECT last_insert_rowid() id').one().id;
      this.sql.exec('INSERT INTO snb_users (tg_id,user_id,chat_id,created) VALUES (?,?,?,?)', tgId, uid, String(chatId), now());
      row = this.sql.exec('SELECT * FROM snb_users WHERE tg_id=?', tgId).one();
      row.fresh = true;
    } else if (String(row.chat_id) !== String(chatId)) this.sql.exec('UPDATE snb_users SET chat_id=? WHERE tg_id=?', String(chatId), tgId);
    const user = this.sql.exec('SELECT * FROM users WHERE id=?', row.user_id).one();
    return { row, user };
  };

  /* ── views ── */
  P.snbBalances = function (uid) {
    const o = {};
    for (const a of ['xlm', 'zro', 'eth']) o[a] = this.bal(uid, a);
    return o;
  };
  P.snbPositions = async function (uid, wal) {
    const chain = wal ? await this.snbChain(wal.pub) : null;
    const ids = new Set(this.sql.exec(`SELECT asset FROM balances WHERE user_id=? AND asset LIKE 't:%' AND amount!='0'`, uid).toArray().map(r => r.asset.slice(2)));
    if (chain?.tok) for (const k of Object.keys(chain.tok)) {
      if (!(chain.tok[k].bal > 0)) continue;
      const [code, iss] = k.split(':');
      const r = this.sql.exec('SELECT id FROM markets WHERE st_code=? AND st_issuer=?', code, iss).toArray()[0];
      if (r) ids.add(r.id);
    }
    const out = [];
    for (const id of ids) {
      const m = this.sql.exec('SELECT * FROM markets WHERE id=?', id).toArray()[0];
      if (!m) continue;
      const v = this.view(m), u = this.usdOf(qa(m));
      const p = this.snbPos(uid, m, this.snbChainTok(chain, m));
      if (p.tokensNum <= 0) continue;
      out.push({ m, v, p, usdValue: p.valueZro * u, usdPnl: p.pnlZro * u });
    }
    if (chain?.tok) {
      const xu = this.xlmUsd();
      let n = 0;
      for (const k of Object.keys(chain.tok)) {
        if (!(chain.tok[k].bal > 0) || n >= 8) continue;
        const [code, iss] = k.split(':');
        const mk = this.sql.exec('SELECT * FROM markets WHERE st_code=? AND st_issuer=?', code, iss).toArray()[0];
        if (mk && !mk.migrated) continue;                       // shown above as a curve position
        n++;
        const aid = this.stxAid({ code, issuer: iss });
        const a = this.stxGet(aid);
        const p = await this.stxPos(uid, wal.pub, a).catch(() => null);
        if (!p || !(p.tokens > 0)) continue;
        out.push({ ext: aid, v: { symbol: code }, p: { pnlZro: p.known ? p.pnl : 0, pnlPct: p.known ? p.pnlPct : null, chain: p.tokens }, usdValue: p.value * xu, usdPnl: p.known ? p.pnl * xu : 0 });
      }
    }
    return out.sort((a, b) => b.usdValue - a.usdValue);
  };
  P.snbHome = async function (user, row) {
    const b = this.snbBalances(user.id), wal = this.snbWallet(row, user);
    const ch = wal ? await this.snbChain(wal.pub) : null;
    const pos = await this.snbPositions(user.id, wal);
    const val = pos.reduce((s, x) => s + x.usdValue, 0), pnl = pos.reduce((s, x) => s + x.usdPnl, 0);
    const cost = val - pnl, xu = this.xlmUsd();
    const lines = [
      `<b>🐧 ROOKERY SNIPER</b>  <i>· ${escH(user.username)}</i>`, LINE,
      wal ? `🔑 <b>Wallet</b> <code>${wal.pub.slice(0, 5)}…${wal.pub.slice(-5)}</code>${wal.signer ? '' : ' <i>(watch-only)</i>'}` : '',
      `<pre>` +
      (wal ? `WALLET ${pad(num(ch?.xlm || 0, 2) + ' XLM', 15)}${usd((ch?.xlm || 0) * xu)}\n` : '') +
      `XLM    ${pad(amt(b.xlm, 2), 15)}${usd((Number(b.xlm) / 1e18) * xu)}\n` +
      `ZRO    ${pad(amt(b.zro, 3), 15)}${usd((Number(b.zro) / 1e18) * this.zroUsd())}\n` +
      `ETH    ${pad(amt(b.eth, 5), 15)}${usd((Number(b.eth) / 1e18) * this.ethUsd())}\n` +
      `BAGS   ${pad(pos.length + ' tokens', 15)}${usd(val)}\n` +
      `PNL    ${pad(pct(cost > 0 ? (pnl / cost) * 100 : 0), 15)}${usd(pnl)}</pre>`,
      wal ? `<i>WALLET = your own Stellar wallet · XLM/ZRO/ETH = Rookery balance</i>` : '',
      LINE,
      `Paste <b>any Stellar token</b>: ticker, CODE:ISSUER, G… issuer, C… contract or a link. Best route across SDEX, AMM pools, Aquarius, Lumen and the Rookery curve.`,
      `<i>Fees: 0.5% burn + ${Number(this.snbFeeBps()) / 100}% bot · same launch rules for everyone</i>`,
      `🎁 <b>Invite friends, earn ${Number(this.snbRefBps()) / 100}% of their fees</b>, paid to you in XLM on every trade.`,
    ].filter(Boolean);
    return { text: lines.join('\n'), kb: [
      [{ text: `🎁 Invite & earn ${Number(this.snbRefBps()) / 100}%`, callback_data: 'ref' }],
      [{ text: '🟢 Buy', callback_data: 'buy' }, { text: '🔴 Sell', callback_data: 'pos' }],
      [{ text: '📊 Positions', callback_data: 'pos' }, { text: '🎯 Sniper', callback_data: 'snp' }],
      [{ text: '🆕 New tokens', callback_data: 'new' }, { text: '🔥 Trending', callback_data: 'hot' }],
      [{ text: '🔑 Wallet', callback_data: 'wal' }, { text: '💰 Deposit', callback_data: 'dep' }, { text: '💸 Withdraw', callback_data: 'wd' }],
      [{ text: '⚙️ Settings', callback_data: 'set' }, { text: '🔄 Refresh', callback_data: 'm' }, { text: '🌐 Web', callback_data: 'web' }],
    ] };
  };
  P.snbCard = async function (user, mid, row) {
    const m = this.market(mid);
    const v = this.view(m), q = qa(m), U = UNIT[q], u = this.usdOf(q);
    const wal = this.snbWallet(row, user);
    const ch = wal && m.network === 'stellar' ? await this.snbChain(wal.pub) : null;
    const p = this.snbPos(user.id, m, this.snbChainTok(ch, m));
    const bal = this.bal(user.id, q);
    const held = p.tokensNum > 0;
    const host = this.meta('public_host') || 'rookery.stinkypenguin.xyz';
    const status = m.migrated ? (m.network === 'stellar' ? 'GRADUATED · on Aquarius' : 'MIGRATED to mainnet')
      : m.network === 'stellar' ? `${bar(v.progress)} ${v.progress.toFixed(1)}% → ${usd(v.stellar?.gradUsd || 46000)}`
      : v.graduated ? 'BONDED · pool live' : `${bar(v.progress)} ${v.progress.toFixed(1)}% bonded`;
    const contract = m.network === 'stellar' && m.st_issuer
      ? `<b>Asset</b> <code>${escH(m.st_code)}:${m.st_issuer}</code>\n<b>Contract</b> <code>${this.snbSac(m)}</code>`
      : m.network === 'stellar' ? `<b>Contract</b> <i>issuing on-chain…</i>` : `<b>Token id</b> <code>${m.id}</code> <i>· pre-market, contract at mainnet</i>`;
    const balLine = q === 'xlm' && wal?.signer
      ? `<b>Balance</b> wallet ${num(ch?.avail || 0, 2)} XLM · Rookery ${amt(bal, 2)} XLM`
      : `<b>Balance</b> ${amt(bal, q === 'eth' ? 5 : 2)} ${U}`;
    const text = [
      `<b>$${escH(v.symbol)}</b> · ${escH(v.name)}  <code>${NET[m.network] || m.network.toUpperCase()}</code>`, LINE,
      `<pre>` +
      `PRICE  ${pad(usd(v.priceUsd), 15)}5m ${pct(v.change5m)}\n` +
      `MCAP   ${pad(usd(v.mcapUsd), 15)}1h ${pct(v.change1h)}\n` +
      `LIQ    ${pad(usd(v.liquidityUsd), 15)}24h ${pct(v.change24h)}\n` +
      `VOL    ${pad(usd(v.volumeUsd), 15)}${v.holders} holders</pre>`,
      status,
      contract,
      held ? `\n<b>Your bag</b> ${num(p.tokensNum)}${p.chain > 0 ? ` <i>(wallet ${num(p.chain)})</i>` : ''} · ${usd(p.valueZro * u)} · ${sign(p.pnlZro)} ${pct(p.pnlPct)} (${usd(p.pnlZro * u)})` : '',
      balLine + (m.max_buy_bps > 0 && now() < m.max_buy_until ? `\n⚠️ Launch rule: max ${(m.max_buy_bps / 100).toFixed(2)}% of supply per wallet` : ''),
      `<a href="https://${host}/#/t/${m.id}">Chart ↗</a>`,
    ].filter(Boolean).join('\n');
    if (m.migrated) return { text: text + `\n\nThis token trades on-chain now.`, kb: [
      ...(m.network === 'stellar' && m.st_code ? [[{ text: '🌊 Trade on Aquarius', url: `https://aqua.network/swap/native/${m.st_code}:${m.st_issuer}` }]] : []),
      [{ text: '← Back', callback_data: 'm' }]] };
    const ps = PRESETS[q];
    return { text, kb: [
      ps.slice(0, 3).map(a => ({ text: `🟢 ${a} ${U}`, callback_data: `b:${m.id}:${a}` })),
      [{ text: `🟢 ${ps[3]} ${U}`, callback_data: `b:${m.id}:${ps[3]}` }, { text: '🟢 Buy X', callback_data: `bx:${m.id}` }],
      ...(held ? [[25, 50, 100].map(x => ({ text: `🔴 ${x}%`, callback_data: `s:${m.id}:${x}` })).concat([{ text: '🔴 X%', callback_data: `sx:${m.id}` }])] : []),
      [{ text: '📟 Terminal', callback_data: `tm:${m.id}` }, { text: '🔄 Refresh', callback_data: `t:${m.id}` }, { text: '← Back', callback_data: 'm' }],
    ] };
  };
  /* ── any Stellar token (outside the Rookery curve) ── */
  P.stxCard = async function (user, row, aid) {
    const a = this.stxGet(aid);
    const wal = this.snbWallet(row, user);
    const [info, pos, ch] = await Promise.all([this.stxInfo(a), wal ? this.stxPos(user.id, wal.pub, a) : null, wal ? this.snbChain(wal.pub) : null]);
    const xu = this.xlmUsd(), s = this.snbSettings(row);
    const pUsd = info.priceXlm ? info.priceXlm * xu : null;
    const rk = a.issuer ? this.sql.exec('SELECT id FROM markets WHERE st_code=? AND st_issuer=?', a.code, a.issuer).toArray()[0] : null;
    const warn = [];
    if (info.flags?.auth_clawback_enabled) warn.push('⚠️ Issuer can claw tokens back');
    if (info.flags?.auth_revocable) warn.push('⚠️ Issuer can freeze holders');
    if (a.issuer && info.locked === false) warn.push('⚠️ Issuer not locked: more supply can be minted');
    if (!info.routes.length) warn.push('⛔ No liquidity yet: use 🎯 Snipe when tradable');
    const held = pos && pos.tokens > 0;
    const text = [
      `<b>${escH(a.code)}</b> · ${escH(a.name && a.name !== a.code ? a.name : 'Stellar asset')}  <code>STELLAR</code>${rk ? '  <i>· Rookery graduate</i>' : ''}`, LINE,
      `<pre>` +
      `PRICE   ${pad(pUsd != null ? usd(pUsd) : '—', 15)}${info.priceXlm ? num(info.priceXlm, 7) + ' XLM' : ''}
` +
      `MCAP    ${pad(pUsd != null && info.supply ? usd(pUsd * info.supply) : '—', 15)}${info.holders != null ? info.holders + ' holders' : ''}
` +
      `SUPPLY  ${pad(info.supply != null ? num(info.supply) : '—', 15)}${info.pools} classic pools</pre>`,
      info.lumen ? (info.lumen.graduated ? `<b>Lumen</b> graduated · pair ${escH(info.lumen.pair)}` : `<b>Lumen curve</b> ${bar(info.lumen.progress)} ${info.lumen.progress.toFixed(1)}% · pair ${escH(info.lumen.pair)} · tax ${info.lumen.buyTax}/${info.lumen.sellTax}% · ${info.lumen.trades} trades`) : '',
      `<b>Routes</b> ${info.routes.length ? info.routes.join(' · ') : 'none yet'}`,
      a.issuer ? `<b>Asset</b> <code>${escH(a.code)}:${a.issuer}</code>${info.home ? ` · ${escH(info.home)}` : ''}` : '',
      `<b>Contract</b> <code>${a.contract}</code>`,
      ...warn,
      held ? `
<b>Your bag</b> ${num(pos.tokens)} · ${num(pos.value, 4)} XLM (${usd(pos.value * xu)})${pos.known ? ` · ${sign(pos.pnl)} ${pct(pos.pnlPct)}` : ''}` : '',
      wal?.signer ? `<b>Wallet</b> ${num(ch?.avail || 0, 2)} XLM spendable · slippage ${s.slip}%` : '<i>Create or import a wallet (🔑 Wallet) to trade this token.</i>',
    ].filter(Boolean).join('\n');
    const kb = [];
    if (info.routes.length) {
      kb.push([10, 50, 100].map(x => ({ text: `🟢 ${x} XLM`, callback_data: `xb:${aid}:${x}` })));
      kb.push([{ text: '🟢 500 XLM', callback_data: `xb:${aid}:500` }, { text: '🟢 Buy X', callback_data: `xbx:${aid}` }]);
      if (held) kb.push([25, 50, 100].map(x => ({ text: `🔴 ${x}%`, callback_data: `xs:${aid}:${x}` })).concat([{ text: '🔴 X%', callback_data: `xsx:${aid}` }]));
    } else kb.push([{ text: '🎯 Snipe when tradable', callback_data: `xw:${aid}` }]);
    kb.push([{ text: '📟 Terminal', callback_data: `tm:x${aid}` }, { text: `⚙️ Slippage ${s.slip}%`, callback_data: `sp:${aid}` }, { text: '🔄', callback_data: `xc:${aid}` }]);
    kb.push([{ text: '🔍 Explorer', url: a.issuer ? `${ST_NETS[this.stNet()].explorer}/asset/${a.code}-${a.issuer}` : `${ST_NETS[this.stNet()].explorer}/contract/${a.contract}` },
      ...(info.lumen ? [{ text: '🌙 Lumen', url: `https://launchonlumen.fun/coin/${a.contract}` }] : []), { text: '← Back', callback_data: 'm' }]);
    return { text, kb };
  };
  P.stxTerminalText = async function (uid, aid, live) {
    const a = this.stxGet(aid);
    const row = this.sql.exec('SELECT * FROM snb_users WHERE user_id=?', uid).toArray()[0];
    const usr = this.sql.exec('SELECT * FROM users WHERE id=?', uid).toArray()[0];
    const wal = this.snbWallet(row, usr);
    const p = wal ? await this.stxPos(uid, wal.pub, a) : { tokens: 0, value: 0, cost: 0, pnl: 0, pnlPct: null, known: false, got: 0, paid: 0 };
    const xu = this.xlmUsd();
    const price = p.tokens > 0 ? p.value / p.tokens : (await this.stxInfo(a)).priceXlm;
    const body = p.tokens <= 0
      ? `BAG      0 ${escH(a.code)}  (closed)
RESULT   ${sign(p.got - p.paid)} ${num(p.got - p.paid, 4)} XLM  ${usd((p.got - p.paid) * xu)}
`
      : `BAG      ${num(p.tokens)} ${escH(a.code)}
` +
        `VALUE    ${pad(num(p.value, 4) + ' XLM', 16)}${usd(p.value * xu)}
` +
        (p.known ? `COST     ${pad(num(p.cost, 4) + ' XLM', 16)}${usd(p.cost * xu)}
` +
          `PNL   ${sign(p.pnl)} ${pad((p.pnl >= 0 ? '+' : '') + num(p.pnl, 4) + ' XLM', 16)}${pct(p.pnlPct)}
         ${p.pnl >= 0 ? '+' : ''}${usd(p.pnl * xu)}
`
          : `PNL      bought outside the bot
`);
    return [
      `<b>📟 POSITION TERMINAL · ${escH(a.code)}</b>`, LINE,
      `<pre>${body}PRICE    ${price ? usd(price * xu) + '  ' + num(price, 7) + ' XLM' : '—'}
VALUE BY full-sell quote, best route</pre>`,
      LINE,
      live ? `🟢 <i>live · updated ${hhmmss()} UTC</i>` : `⏸ <i>paused · ${hhmmss()} UTC · tap Refresh</i>`,
    ].join('\n');
  };
  P.stxTerminalKb = function (aid, live) {
    return [
      [25, 50, 100].map(x => ({ text: `🔴 Sell ${x}%`, callback_data: `xs:${aid}:${x}` })),
      [{ text: '🟢 +10 XLM', callback_data: `xb:${aid}:10` }, { text: '🟢 +50 XLM', callback_data: `xb:${aid}:50` }, { text: '🟢 Buy X', callback_data: `xbx:${aid}` }],
      [{ text: '🔄 Refresh', callback_data: `rf:x${aid}` }, live ? { text: '⏸ Pause', callback_data: `ps:x${aid}` } : { text: '▶️ Live', callback_data: `rf:x${aid}` }, { text: '🪙 Token', callback_data: `xc:${aid}` }],
    ];
  };
  // the live position view
  P.snbTerminalText = async function (uid, mid, live) {
    if (String(mid).startsWith('x')) return this.stxTerminalText(uid, Number(String(mid).slice(1)), live);
    const m = this.market(mid);
    const v = this.view(m), q = qa(m), U = UNIT[q], u = this.usdOf(q);
    let chainTok = 0;
    if (m.network === 'stellar' && m.st_issuer) {
      const row = this.sql.exec('SELECT * FROM snb_users WHERE user_id=?', uid).toArray()[0];
      const usr = this.sql.exec('SELECT * FROM users WHERE id=?', uid).toArray()[0];
      const wal = this.snbWallet(row, usr);
      if (wal) chainTok = this.snbChainTok(await this.snbChain(wal.pub), m);
    }
    const p = this.snbPos(uid, m, chainTok);
    const tok = p.tokensNum;
    const closed = tok <= 0;
    const realised = p.receivedZro - p.paidZro;
    const body = closed
      ? `BAG      0 ${escH(v.symbol)}  (closed)\nRESULT   ${sign(realised)} ${num(realised, 4)} ${U}  ${usd(realised * u)}\n`
      : `BAG      ${num(tok)} ${escH(v.symbol)}\n` +
        (p.chain > 0 ? `         wallet ${num(p.chain)} · rookery ${num(p.ledger)}\n` : '') +
        `VALUE    ${pad(num(p.valueZro, 4) + ' ' + U, 16)}${usd(p.valueZro * u)}\n` +
        `COST     ${pad(num(p.costZro, 4) + ' ' + U, 16)}${usd(p.costZro * u)}\n` +
        `PNL   ${sign(p.pnlZro)} ${pad((p.pnlZro >= 0 ? '+' : '') + num(p.pnlZro, 4) + ' ' + U, 16)}${pct(p.pnlPct)}\n` +
        `         ${p.pnlZro >= 0 ? '+' : ''}${usd(p.pnlZro * u)}\n`;
    const prog = m.migrated ? 'graduated' : `${bar(v.progress)} ${v.progress.toFixed(1)}%`;
    return [
      `<b>📟 POSITION TERMINAL · $${escH(v.symbol)}</b>`, LINE,
      `<pre>${body}` +
      `PRICE    ${pad(usd(v.priceUsd), 16)}5m ${pct(v.change5m)}\n` +
      `MCAP     ${pad(usd(v.mcapUsd), 16)}1h ${pct(v.change1h)}\n` +
      `BOND     ${prog}</pre>`,
      LINE,
      live ? `🟢 <i>live · updated ${hhmmss()} UTC</i>` : `⏸ <i>paused · ${hhmmss()} UTC · tap Refresh</i>`,
    ].join('\n');
  };
  P.snbTerminalKb = function (mid, live) {
    if (String(mid).startsWith('x')) return this.stxTerminalKb(Number(String(mid).slice(1)), live);
    const m = this.market(mid), q = qa(m), U = UNIT[q], ps = PRESETS[q];
    return [
      [25, 50, 100].map(x => ({ text: `🔴 Sell ${x}%`, callback_data: `s:${mid}:${x}` })),
      [{ text: `🟢 +${ps[0]} ${U}`, callback_data: `b:${mid}:${ps[0]}` }, { text: `🟢 +${ps[1]} ${U}`, callback_data: `b:${mid}:${ps[1]}` }, { text: '🟢 Buy X', callback_data: `bx:${mid}` }],
      [{ text: '🔄 Refresh', callback_data: `rf:${mid}` }, live ? { text: '⏸ Pause', callback_data: `ps:${mid}` } : { text: '▶️ Live', callback_data: `rf:${mid}` }, { text: '🪙 Token', callback_data: `t:${mid}` }],
    ];
  };
  P.snbOpenTerminal = async function (chatId, uid, mid) {
    // one live terminal per user and token: the previous one is paused
    for (const t of this.sql.exec('SELECT * FROM snb_terms WHERE user_id=? AND market=?', uid, mid).toArray()) {
      this.sql.exec('DELETE FROM snb_terms WHERE chat_id=? AND msg_id=?', t.chat_id, t.msg_id);
      await this.tgS('editMessageText', { chat_id: t.chat_id, message_id: t.msg_id, text: await this.snbTerminalText(uid, mid, false), parse_mode: 'HTML',
        reply_markup: { inline_keyboard: this.snbTerminalKb(mid, false) } }).catch(() => null);
    }
    const text = await this.snbTerminalText(uid, mid, true);
    const r = await this.tgS('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: this.snbTerminalKb(mid, true) } });
    if (r?.ok) {
      this.sql.exec('INSERT OR REPLACE INTO snb_terms (chat_id,msg_id,user_id,market,until,last,edited) VALUES (?,?,?,?,?,?,?)', String(chatId), r.result.message_id, uid, mid, now() + LIVE_MS, text.replace(/updated .* UTC/, ''), now());
      await this.snbArm();
    }
  };
  P.snbArm = async function () {
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || cur > now() + TICK_MS * 2) await this.ctx.storage.setAlarm(now() + TICK_MS);
  };
  // refresh every live terminal (called from the Durable Object alarm); also deletes timed messages (exported keys)
  P.snbTick = async function () {
    this.snbInit();
    const t0 = now();
    for (const d of this.sql.exec('SELECT * FROM snb_del WHERE at<=?', t0).toArray()) {
      this.sql.exec('DELETE FROM snb_del WHERE chat_id=? AND msg_id=?', d.chat_id, d.msg_id);
      await this.tgS('deleteMessage', { chat_id: d.chat_id, message_id: d.msg_id }).catch(() => null);
    }
    for (const t of this.sql.exec('SELECT * FROM snb_terms WHERE until<?', t0).toArray()) {
      this.sql.exec('DELETE FROM snb_terms WHERE chat_id=? AND msg_id=?', t.chat_id, t.msg_id);
      await this.tgS('editMessageText', { chat_id: t.chat_id, message_id: t.msg_id, text: await this.snbTerminalText(t.user_id, t.market, false), parse_mode: 'HTML',
        reply_markup: { inline_keyboard: this.snbTerminalKb(t.market, false) } }).catch(() => null);
    }
    const live = this.sql.exec('SELECT * FROM snb_terms ORDER BY until DESC LIMIT 25').toArray();
    for (const t of live) {
      let text;
      try { text = await this.snbTerminalText(t.user_id, t.market, true); } catch { this.sql.exec('DELETE FROM snb_terms WHERE chat_id=? AND msg_id=?', t.chat_id, t.msg_id); continue; }
      const key = text.replace(/updated .* UTC/, '');
      if (key === t.last && now() - Number(t.edited || 0) < 4500) continue;
      const r = await this.tgS('editMessageText', { chat_id: t.chat_id, message_id: t.msg_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: this.snbTerminalKb(t.market, true) } });
      if (r && !r.ok && /message to edit not found|chat not found|blocked/i.test(r.description || '')) this.sql.exec('DELETE FROM snb_terms WHERE chat_id=? AND msg_id=?', t.chat_id, t.msg_id);
      else this.sql.exec('UPDATE snb_terms SET last=?, edited=? WHERE chat_id=? AND msg_id=?', key, now(), t.chat_id, t.msg_id);
    }
    this._snbTicks = (this._snbTicks || 0) + 1;
    let watches = 0;
    try { this.stxInit(); watches = this.sql.exec(`SELECT COUNT(*) c FROM snb_watch WHERE status='armed'`).one().c; if (watches && this._snbTicks % 2 === 0) await this.stxWatchTick(); } catch { /* next tick */ }
    let lumenSnipers = 0;
    try { lumenSnipers = this.sql.exec('SELECT settings FROM snb_users WHERE wsec IS NOT NULL').toArray().filter(r => { try { return JSON.parse(r.settings || '{}').lumen?.on; } catch { return false; } }).length; } catch { /* none */ }
    if (lumenSnipers && this._snbTicks % 2 === 0) await this.lumenNewLaunches().catch(() => null);
    const more = this.sql.exec('SELECT COUNT(*) c FROM snb_terms').one().c + this.sql.exec('SELECT COUNT(*) c FROM snb_del').one().c + watches + lumenSnipers;
    if (more) await this.ctx.storage.setAlarm(now() + TICK_MS);
    return { live: this.sql.exec('SELECT COUNT(*) c FROM snb_terms').one().c };
  };

  /* ── trading ── */
  P.snbBuy = function (user, mid, amountWei, how = 'manual') {
    const m = this.market(mid), q = qa(m);
    if (m.migrated) throw new Error('This token trades on-chain now');
    const fee = (amountWei * this.snbFeeBps()) / 10000n;
    if (this.bal(user.id, q) < amountWei) throw new Error(`Not enough ${UNIT[q]}: you have ${amt(this.bal(user.id, q), 4)}. Tap Deposit to top up.`);
    const r = this.trade(user, { market: mid, side: 'buy', amount: (amountWei - fee).toString() });
    this.snbChargeFee(user.id, q, fee);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO snb_log (user_id,market,side,quote,amount,fee,how,ts) VALUES (?,?,?,?,?,?,?,?)', user.id, mid, 'buy', q, amountWei.toString(), fee.toString(), how, now());
    });
    this.snbFeed(user, m, 'buy', r);
    return { ...r, fee, q };
  };
  P.snbSell = function (user, mid, pctNum, exact = null) {
    const m = this.market(mid), q = qa(m);
    if (m.migrated) throw new Error('This token trades on-chain now');
    const bal = this.bal(user.id, 't:' + m.id);
    if (bal <= 0n) throw new Error('You hold none of this token');
    const tokens = exact != null ? (exact > bal ? bal : exact) : pctNum >= 100 ? bal : (bal * BigInt(Math.round(pctNum * 100))) / 10000n;
    if (tokens <= 0n) throw new Error('Amount too small');
    const before = this.bal(user.id, q);
    const r = this.trade(user, { market: mid, side: 'sell', amount: tokens.toString() });
    const got = this.bal(user.id, q) - before;
    const fee = got > 0n ? (got * this.snbFeeBps()) / 10000n : 0n;
    this.snbChargeFee(user.id, q, fee);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO snb_log (user_id,market,side,quote,amount,fee,how,ts) VALUES (?,?,?,?,?,?,?,?)', user.id, mid, 'sell', q, got.toString(), fee.toString(), 'manual', now());
    });
    this.snbFeed(user, m, 'sell', r);
    return { ...r, got: got - fee, tokens, q };
  };

  // a bot trade that settled on-chain through the scanner: log it and show it in the feeds
  P.snbAfterChain = function (user, mid, side, r, amount, fee) {
    try {
      this.snbInit();
      this.sql.exec('INSERT INTO snb_log (user_id,market,side,quote,amount,fee,how,ts) VALUES (?,?,?,?,?,?,?,?)', user.id, mid, side, 'xlm', B(amount).toString(), B(fee).toString(), 'wallet', now());
      this.snbFeed(user, this.market(mid), side, r);
    } catch { /* best effort */ }
  };
  // bot trades show up like any other: live ticker on the site and buy posts in Telegram groups
  P.snbFeed = function (user, m, side, r) {
    try {
      const q = qa(m), host = this.meta('public_host') || 'rookery.stinkypenguin.xyz';
      this.queuePush(m.id, 'trade', { side, usd: (Number(B(r.zro)) / 1e18) * this.usdOf(q), user: user.username, symbol: m.symbol, id: m.id });
      if (side === 'buy') this.ctx.waitUntil(this.notifyBuy(m.id, { zro: r.zro, tokens: r.tokens }, user.username, host).catch(() => {}));
    } catch { /* feed is best effort */ }
  };
  // a new token went live: run everyone's snipes (same rules as any buyer)
  P.snbOnLaunch = async function (mid) {
    if (!this.snbOn()) return;
    this.snbInit();
    const m = this.market(mid);
    const day = now() - 864e5;
    const hatch = this.sql.exec('SELECT id FROM hatches WHERE market_id=?', mid).toArray()[0]?.id;
    const jobs = [];
    if (hatch) for (const s of this.sql.exec(`SELECT * FROM snb_snipes WHERE hatch=? AND status='armed'`, hatch).toArray())
      jobs.push({ uid: s.user_id, amount: B(s.amount), how: 'hatch', snipeId: s.id });
    for (const r of this.sql.exec('SELECT * FROM snb_users').toArray()) {
      const s = this.snbSettings(r).snipe[m.network];
      if (!s?.on || !(Number(s.amount) > 0) || jobs.some(j => j.uid === r.user_id)) continue;
      const n = this.sql.exec(`SELECT COUNT(*) c FROM snb_log WHERE user_id=? AND how='snipe' AND ts>?`, r.user_id, day).one().c;
      if (n >= this.snbSettings(r).maxDay) continue;
      jobs.push({ uid: r.user_id, amount: toWei(String(s.amount)), how: 'snipe' });
    }
    for (const j of jobs) {
      const u = this.sql.exec('SELECT * FROM users WHERE id=?', j.uid).toArray()[0];
      const tg = this.sql.exec('SELECT * FROM snb_users WHERE user_id=?', j.uid).toArray()[0];
      if (!u || !tg || u.id === m.creator_id) continue;
      let msg;
      try {
        let r;
        const q = qa(m), wal = this.snbWallet(tg, u);
        if (this.bal(u.id, q) >= j.amount || m.network !== 'stellar' || !wal?.signer) r = this.snbBuy(u, mid, j.amount, j.how);
        else {
          // pay from the user's own wallet: wait for the asset to exist on-chain first (it is issued right after creation)
          let mk = this.market(mid);
          for (let i = 0; i < 15 && !mk.st_issuer; i++) { await new Promise(res => setTimeout(res, 2000)); mk = this.market(mid); }
          if (!mk.st_issuer) throw new Error('the token is still being issued on Stellar');
          const cr = await this.snbChainBuy(tg, u, mk, Number(j.amount) / 1e18);
          if (cr.status !== 'done') throw new Error('wallet payment ' + cr.status);
          r = { q, tokens: this.sql.exec(`SELECT tokens FROM trades WHERE user_id=? AND market=? AND side='buy' ORDER BY id DESC LIMIT 1`, u.id, mid).toArray()[0]?.tokens || '0' };
        }
        msg = `🎯 <b>Sniped $${escH(m.symbol)}</b> at launch\n${amt(j.amount, 4)} ${UNIT[r.q]} → ${num(Number(B(r.tokens)) / 1e18)} $${escH(m.symbol)}`;
        if (j.snipeId) this.sql.exec(`UPDATE snb_snipes SET status='done' WHERE id=?`, j.snipeId);
        await this.tgS('sendMessage', { chat_id: tg.chat_id, text: msg, parse_mode: 'HTML' });
        if (this.snbSettings(tg).terminal) await this.snbOpenTerminal(tg.chat_id, u.id, mid);
      } catch (e) {
        if (j.snipeId) this.sql.exec(`UPDATE snb_snipes SET status='failed' WHERE id=?`, j.snipeId);
        await this.tgS('sendMessage', { chat_id: tg.chat_id, text: `🎯 Snipe on <b>$${escH(m.symbol)}</b> skipped: ${escH(e.message)}`, parse_mode: 'HTML' });
      }
    }
  };

  /* ── Telegram update handler ── */
  P.snbUpdate = async function (u, host) {
    this.snbInit();
    const cq = u.callback_query, msg = u.message || cq?.message;
    const from = u.message?.from || cq?.from;
    if (!msg || !from || msg.chat.type !== 'private') {
      if (u.message && msg?.chat?.type !== 'private') await this.tgS('sendMessage', { chat_id: msg.chat.id, text: 'RookerySniperBot works in a private chat: open @' + this.snbBot() });
      return;
    }
    const chatId = msg.chat.id;
    let { row, user } = this.snbAccount(from, chatId);
    const fresh = !!row.fresh;
    const reload = () => { ({ row, user } = this.snbAccount(from, chatId)); };
    if (!row.wsec && !user.stellar_wallet) { await this.snbEnsureWallet(row, user).catch(() => {}); reload(); }
    const send = (text, kb, extra = {}) => this.tgS('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}), ...extra });
    const show = async (view) => {
      if (cq && msg.message_id) {
        const r = await this.tgS('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: view.text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: view.kb } });
        if (r?.ok || /not modified/.test(r?.description || '')) return;
      }
      return send(view.text, view.kb);
    };
    let answered = false;
    const toast = (text, alert = false) => { if (!cq?.id || answered) return; answered = true; return this.tgS('answerCallbackQuery', { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: alert }); };
    const pend = (p) => this.sql.exec('UPDATE snb_users SET pending=? WHERE tg_id=?', p, String(from.id));
    const back = [[{ text: '← Back', callback_data: 'm' }]];
    const say = async (t, alert) => { if (cq && !answered) await toast(t.replace(/<[^>]+>/g, ''), alert); else await send(t); };
    const txl = (h) => h ? ` · <a href="${ST_NETS[this.stNet()].explorer}/tx/${h}">tx ↗</a>` : '';
    const terminalAfter = async (mid) => {
      if (this.snbSettings(row).terminal) await this.snbOpenTerminal(chatId, user.id, mid);
      else await show(await this.snbCard(user, mid, row));
    };

    this._snbBusy = this._snbBusy || new Map();
    const busy = () => { const t = this._snbBusy.get(user.id); return t && now() - t < 90000; };
    const lock = async () => { if (busy()) { await say('⏳ Your previous order is still running. Wait a few seconds.', true); return false; } this._snbBusy.set(user.id, now()); return true; };
    const unlock = () => this._snbBusy.delete(user.id);
    const doBuy = async (mid, a) => {
      if (!(await lock())) return;
      try {
        const m = this.market(mid), q = qa(m);
        const wal = this.snbWallet(row, user);
        const onchain = m.network === 'stellar' && !m.migrated && m.st_issuer && wal?.signer && this.bal(user.id, 'xlm') < a;
        if (onchain) {
          const x = Number(a) / 1e18, ch = await this.snbChainFresh(wal.pub);
          if (!ch.ok) throw new Error('Stellar network is busy, could not read your wallet. Try again in a few seconds.');
          if (ch.avail < x) throw new Error(`Not enough XLM: wallet ${num(ch.avail, 2)} spendable, Rookery ${amt(this.bal(user.id, 'xlm'), 2)}. Tap Deposit to top up.`);
          await toast('⏳ Paying from your wallet…');
          const r = await this.snbChainBuy(row, user, m, x);
          if (r.status === 'done') {
            const last = this.sql.exec(`SELECT tokens FROM trades WHERE user_id=? AND market=? AND side='buy' ORDER BY id DESC LIMIT 1`, user.id, mid).toArray()[0];
            await send(`✅ Bought <b>${num(Number(B(last?.tokens || 0)) / 1e18)} $${escH(m.symbol)}</b> for ${num(x, 4)} XLM from your wallet${txl(r.hash)}\n<i>Tokens arrive in your wallet in a few seconds.</i>`);
            return terminalAfter(mid);
          }
          if (r.status === 'paid') return send(`⚠️ Your ${num(x, 4)} XLM arrived${txl(r.hash)} but the buy did not go through, so it sits on your Rookery balance. Try again.`);
          return send(`⏳ Payment sent${txl(r.hash)}. The buy runs as soon as it confirms (usually under a minute).`);
        }
        if (m.network === 'stellar' && m.st_issuer && wal?.signer) await this.snbEnsureTrust(row, m).catch(() => {});
        const r = this.snbBuy(user, mid, a);
        await say(`✅ Bought ${num(Number(B(r.tokens)) / 1e18)} $${escH(m.symbol)} for ${amt(a, 4)} ${UNIT[q]}`);
        await terminalAfter(mid);
      } catch (e) { await say('❌ ' + e.message, true); } finally { unlock(); }
    };
    const doSell = async (mid, pctNum) => {
      if (!(await lock())) return;
      try {
        const m = this.market(mid), q = qa(m);
        if (m.migrated) throw new Error('This token trades on-chain now');
        const wal = this.snbWallet(row, user);
        const ch = m.network === 'stellar' && m.st_issuer && wal?.signer ? await this.snbChain(wal.pub) : null;
        const W = this.snbChainTok(ch, m);
        const ledgerWei = this.bal(user.id, 't:' + m.id), L = Number(ledgerWei) / 1e18;
        if (L + W <= 0) throw new Error('You hold none of this token');
        const S = (L + W) * Math.min(100, pctNum) / 100;
        let got = 0n, note = '', walletXlm = 0;
        const t0 = now();
        if (L > 0) {
          const exact = pctNum >= 100 || S >= L ? ledgerWei : toWei(S.toFixed(18));
          const r = this.snbSell(user, mid, 100, exact);
          got += r.got;
        }
        const rest = Math.floor((S - Math.min(S, L)) * 1e7) / 1e7;
        if (rest >= 0.0000001 && W > 0) {
          await toast('⏳ Selling from your wallet…');
          const r = await this.snbChainSell(row, user, m, Math.min(rest, Math.floor(W * 1e7) / 1e7));
          // the XLM the curve paid back to the wallet for this sell
          let pay = null;
          for (let i = 0; i < 6 && !pay; i++) {
            pay = this.sql.exec(`SELECT amount, status, txid FROM transfers WHERE user_id=? AND kind='withdrawal' AND asset='xlm' AND note LIKE 'proceeds of a sell%' AND ts>=? ORDER BY id DESC LIMIT 1`, user.id, t0 - 5000).toArray()[0];
            if (!pay || pay.status === 'pending') { pay = pay?.status === 'pending' ? null : pay; if (!pay) await new Promise(res => setTimeout(res, 1500)); }
          }
          if (pay && pay.status === 'sent') { walletXlm = Number(B(pay.amount)) / 1e18; note = ` · <b>${num(walletXlm, 4)} XLM</b> sent to your wallet${txl(pay.txid)}`; }
          else note = ` · tokens sent${txl(r.hash)}, your XLM lands in your wallet in a few seconds`;
        }
        const ledgerPart = Number(got) / 1e18 >= 0.0001 ? ` · ${amt(got, 4)} ${UNIT[q]} to your Rookery balance` : '';
        const total = walletXlm + (ledgerPart ? Number(got) / 1e18 : 0);
        const txt = `✅ Sold ${pctNum}% of $${escH(m.symbol)}${total > 0 ? ` · you got <b>${num(total, 4)} ${UNIT[q]}</b>` : ''}${ledgerPart}${note}`;
        if (note) await send(txt); else await say(txt);
        if (cq && /POSITION TERMINAL/.test(msg.text || '')) {
          await this.tgS('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: await this.snbTerminalText(user.id, mid, true), parse_mode: 'HTML', reply_markup: { inline_keyboard: this.snbTerminalKb(mid, true) } });
          this.sql.exec('INSERT OR REPLACE INTO snb_terms (chat_id,msg_id,user_id,market,until,last,edited) VALUES (?,?,?,?,?,?,?)', String(chatId), msg.message_id, user.id, mid, now() + LIVE_MS, '', now());
          await this.snbArm();
        } else await show(await this.snbCard(user, m.id, row));
      } catch (e) { await say('❌ ' + e.message, true); } finally { unlock(); }
    };
    const doX = async (aid, side, amount) => {
      if (!(await lock())) return;
      try {
        const wal = this.snbWallet(row, user);
        if (!wal?.signer) throw new Error('Create or import a wallet first (🔑 Wallet)');
        const a = this.stxGet(aid);
        let amt = amount;
        if (side === 'sell') {
          const b = await this.stxBal(wal.pub, a);
          if (!(b.bal > 0)) throw new Error('You hold none of this token');
          amt = Math.floor(b.bal * Math.min(100, amount) / 100 * 1e7) / 1e7;
        }
        await toast(side === 'buy' ? '⏳ Finding the best route…' : '⏳ Selling…');
        const r = await this.stxTrade(row, user, a, side, amt, this.snbSettings(row).slip);
        await send(side === 'buy'
          ? `✅ Bought <b>${num(r.tokens)} ${escH(a.code)}</b> for ${num(amt, 4)} XLM via ${r.venue}${txl(r.hash)}`
          : `✅ Sold ${amount}% of ${escH(a.code)} · got <b>${num(r.xlm, 4)} XLM</b> via ${r.venue}${txl(r.hash)}`);
        if (side === 'buy') return terminalAfter('x' + aid);
        if (cq && /POSITION TERMINAL/.test(msg.text || '')) {
          await this.tgS('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: await this.snbTerminalText(user.id, 'x' + aid, true), parse_mode: 'HTML', reply_markup: { inline_keyboard: this.snbTerminalKb('x' + aid, true) } });
        }
      } catch (e) { await say('❌ ' + String(e.message).replace(/^.*op_under_dest_min.*$/, 'Price moved more than your slippage: try again or raise slippage'), true); } finally { unlock(); }
    };
    const walletView = async () => {
      const wal = this.snbWallet(row, user);
      const b = this.snbBalances(user.id);
      if (!wal) return { text: `<b>🔑 WALLET</b>\n${LINE}\nNo Stellar wallet yet. Import one with its secret key.`, kb: [[{ text: '📥 Import key', callback_data: 'wi' }], ...back] };
      const ch = await this.snbChain(wal.pub);
      const toks = Object.values(ch.tok || {}).filter(t => t.bal > 0).length;
      return { text: [`<b>🔑 WALLET</b>`, LINE,
        `<b>Stellar address</b>\n<code>${wal.pub}</code>`,
        `<pre>ON-CHAIN  ${pad(num(ch.xlm, 4) + ' XLM', 18)}${usd(ch.xlm * this.xlmUsd())}\nSPENDABLE ${pad(num(ch.avail, 4) + ' XLM', 18)}${toks} tokens\nROOKERY   ${pad(amt(b.xlm, 4) + ' XLM', 18)}${amt(b.zro, 3)} ZRO · ${amt(b.eth, 5)} ETH</pre>`,
        wal.signer
          ? `This wallet is <b>yours</b>: export its secret key into Freighter, Lobstr or xBull any time. Buys pay from it and tokens land in it.`
          : `<i>Watch-only: this is the wallet linked on the website. Import its secret key to trade from it here.</i>`,
        ch.exists ? '' : `\n⚠️ Not active on Stellar yet: send at least <b>2 XLM</b> to the address above (no memo needed).`,
        `<i>Zero & GIWA tokens are pre-market: they stay on your Rookery balance until mainnet.</i>`].filter(Boolean).join('\n'),
        kb: [
          [...(wal.signer ? [{ text: '📤 Export key', callback_data: 'wx' }] : []), { text: '📥 Import key', callback_data: 'wi' }],
          ...(wal.signer ? [[{ text: '⬆️ Rookery → wallet', callback_data: 'r2w' }, { text: '⬇️ Wallet → Rookery', callback_data: 'w2r' }]] : []),
          [{ text: '🔍 View on explorer', url: `${ST_NETS[this.stNet()].explorer}/account/${wal.pub}` }],
          [{ text: '🔄 Refresh', callback_data: 'wal' }, { text: '← Back', callback_data: 'm' }]] };
    };

    /* text messages */
    if (u.message) {
      const text = String(u.message.text || '').trim();
      // a secret key pasted anywhere: never leave it in the chat
      if (/^S[A-Z2-7]{55}$/.test(text)) {
        await this.tgS('deleteMessage', { chat_id: chatId, message_id: u.message.message_id }).catch(() => null);
        if ((row.pending || '') !== 'imp') { pend(''); return send('🛡 That looked like a secret key, so I deleted it. To use it here tap 🔑 Wallet → Import key.'); }
        pend('');
        let kp; try { kp = Keypair.fromSecret(text); } catch { return send('❌ Not a valid Stellar secret key.'); }
        const pub = kp.publicKey();
        if (pub === row.wpub && row.wsec) return send('This wallet is already your bot wallet.');
        const other = this.sql.exec('SELECT id FROM users WHERE stellar_wallet=? AND id!=?', pub, user.id).toArray()[0];
        if (other) return send('❌ This wallet is linked to another Rookery account.');
        if (row.wsec && user.stellar_wallet === row.wpub && !row.exported) {
          const ch = await this.snbChain(row.wpub);
          if (ch.xlm > 2.1 || Object.values(ch.tok).some(t => t.bal > 0)) return send('❌ Your current bot wallet holds funds. Export its key first (🔑 Wallet → Export key) so nothing is lost, then import again.');
        }
        const box = await this.snbSeal(kp.secret());
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('UPDATE snb_users SET wpub=?, wsec=?, exported=0 WHERE tg_id=?', pub, box, String(from.id));
          this.sql.exec('UPDATE users SET stellar_wallet=? WHERE id=?', pub, user.id);
        });
        reload();
        await send(`✅ Wallet imported: <code>${pub}</code>\nBuys pay from it and tokens land in it. Your message with the key was deleted.`);
        return show(await walletView());
      }
      if (text.startsWith('/start')) {
        const arg = text.split(/\s+/)[1] || '';
        pend('');
        if (/^X\d+$/.test(arg)) { reload(); return show(await this.stxCard(user, row, Number(arg.slice(1)))); }
        if (/^R[0-9a-f]{8}$/.test(arg)) {
          const inv = this.sql.exec('SELECT * FROM snb_users WHERE ref_code=?', arg.slice(1)).toArray()[0];
          const traded = this.sql.exec('SELECT 1 FROM snb_log WHERE user_id=? LIMIT 1', user.id).toArray().length;
          if (inv && inv.user_id !== user.id && !row.ref_by && (fresh || !traded)) {
            this.sql.exec('UPDATE snb_users SET ref_by=?, ref_at=? WHERE tg_id=?', inv.user_id, now(), String(from.id));
            reload();
            const name = this.sql.exec('SELECT username FROM users WHERE id=?', inv.user_id).toArray()[0]?.username || 'a friend';
            await send(`🎁 You were invited by <b>${escH(name)}</b>. Welcome to RookerySniperBot!`);
            if (inv.chat_id) await this.tgS('sendMessage', { chat_id: inv.chat_id, parse_mode: 'HTML', text: `🎉 <b>${escH(user.username)}</b> joined with your invite link. You earn ${Number(this.snbRefBps()) / 100}% of their bot fees from now on.` });
          }
        }
      if (/^L[0-9a-f]{24}$/.test(arg)) {
          const tk = this.sql.exec(`SELECT * FROM snb_tokens WHERE token=? AND kind='link' AND expires>?`, arg.slice(1), now()).toArray()[0];
          if (!tk) await send('This link expired. Open Rookery → Wallet → Connect Telegram again.');
          else {
            this.sql.exec('DELETE FROM snb_tokens WHERE token=?', arg.slice(1));
            const empty = !this.sql.exec(`SELECT 1 FROM balances WHERE user_id=? AND amount!='0'`, user.id).toArray().length
              && !this.sql.exec('SELECT 1 FROM trades WHERE user_id=? LIMIT 1', user.id).toArray().length;
            const walFunds = row.wsec && !row.exported ? await this.snbChain(row.wpub).then(c => c.xlm > 2.1 || Object.values(c.tok).some(t => t.bal > 0)).catch(() => false) : false;
            if (tk.user_id !== user.id && (!empty || walFunds)) await send('Your bot wallet already holds funds. Withdraw or export them first, then link your Rookery account.');
            else {
              const target = this.sql.exec('SELECT * FROM users WHERE id=?', tk.user_id).one();
              // the site account keeps its own Stellar wallet; otherwise it adopts the bot wallet
              this.ctx.storage.transactionSync(() => {
                if (user.id !== target.id && user.stellar_wallet === row.wpub) this.sql.exec('UPDATE users SET stellar_wallet=NULL WHERE id=?', user.id);
                if (!target.stellar_wallet && row.wpub && row.wsec) this.sql.exec('UPDATE users SET stellar_wallet=? WHERE id=?', row.wpub, target.id);
                this.sql.exec('UPDATE snb_users SET user_id=? WHERE tg_id=?', tk.user_id, String(from.id));
              });
              reload();
              await send(`🔗 Linked to your Rookery account <b>${escH(user.username)}</b>. Same balance, same tokens, on web and in Telegram.`);
            }
          }
        } else if (fresh) {
          const wal = this.snbWallet(row, user);
          await send(`<b>Welcome to RookerySniperBot</b> 🐧\nYour account <b>${escH(user.username)}</b> is ready${wal?.signer ? ` with your own Stellar wallet:\n<code>${wal.pub}</code>` : '.'}\n\n` +
            `• Trade every Rookery token: Stellar, Zero and GIWA\n• Paste a ticker or contract to open a token\n• Snipe new launches automatically\n• Live Position Terminal after every buy\n• Export or import your wallet any time (🔑 Wallet)\n\n` +
            `Top up with <b>Deposit</b>. Already have a Rookery account? Website → Wallet → <i>Connect Telegram</i>.`);
        }
        return show(await this.snbHome(user, row));
      }
      const fake = (data) => this.snbUpdate({ callback_query: { id: '', from, message: { ...msg, message_id: 0 }, data } }, host);
      if (text === '/menu' || text === '/home') { pend(''); return show(await this.snbHome(user, row)); }
      if (text === '/positions') { pend(''); return fake('pos'); }
      if (text === '/sniper') { pend(''); return fake('snp'); }
      if (text === '/deposit') { pend(''); return fake('dep'); }
      if (text === '/wallet') { pend(''); return fake('wal'); }
      if (text === '/referral' || text === '/invite') { pend(''); return fake('ref'); }
      if (text === '/help') return send(`<b>RookerySniperBot</b>\n/start · main menu\n/positions · your bags\n/sniper · auto-buy new launches\n/wallet · export / import your wallet\n/referral · invite friends, earn 25% of their fees\n/deposit · top up\n/withdraw 25 G… · send XLM out\n\nPaste a ticker (e.g. <code>STROOPY</code>), a contract (G… issuer, C… contract or CODE:ISSUER) or a Rookery link to open a token.`);
      if (text.startsWith('/withdraw')) {
        const [, a, to] = text.split(/\s+/);
        if (!a || !to) return send('Usage: <code>/withdraw 25 GABC…</code> sends XLM from your Rookery balance to a Stellar address.\nZRO and ETH: tap 🌐 Web → Wallet.');
        try {
          const r = await this.wserial(() => this.withdraw(user, { chain: 'stellar', to: to.trim(), amount: toWei(a).toString(), asset: 'xlm' }));
          return send(`✅ Sent ${escH(a)} XLM to <code>${escH(to.slice(0, 6))}…${escH(to.slice(-4))}</code>${txl(r?.txid)}`);
        } catch (e) { return send('❌ ' + escH(e.message)); }
      }
      // a pending amount (Buy X / Sell X% / sniper amounts / wallet moves)
      const p = row.pending || '';
      if (p && !text.startsWith('/')) {
        pend('');
        const [kind, a1] = p.split(':');
        try {
          if (kind === 'bx') return doBuy(a1, toWei(text));
          if (kind === 'sx') { const v = Number(text.replace('%', '')); if (!(v > 0 && v <= 100)) throw new Error('Enter a percentage from 1 to 100'); return doSell(a1, v); }
          if (kind === 'sa') {
            const v = Number(text.replace(',', '.')); if (!(v > 0)) throw new Error('Enter a positive amount');
            const s = this.snbSettings(row); s.snipe[a1].amount = v; this.snbSave(from.id, s); reload();
            await send(`🎯 Snipe amount for ${NET[a1]} set to <b>${v} ${a1 === 'stellar' ? 'XLM' : a1 === 'giwa' ? 'ETH' : 'ZRO'}</b>.`);
            return fake('snp');
          }
          if (kind === 'ha') {
            const a = toWei(text);
            this.sql.exec(`INSERT INTO snb_snipes (user_id,hatch,amount,status,created) VALUES (?,?,?,?,?)`, user.id, a1, a.toString(), 'armed', now());
            return send(`🎯 Armed: buying <b>${escH(text)}</b> the second this hatch goes live.`, back);
          }
          if (kind === 'xbx') return doX(Number(a1), 'buy', Number(text.replace(',', '.')));
          if (kind === 'xsx') { const v = Number(text.replace('%', '')); if (!(v > 0 && v <= 100)) throw new Error('Enter a percentage from 1 to 100'); return doX(Number(a1), 'sell', v); }
          if (kind === 'xw') {
            const v = Number(text.replace(',', '.')); if (!(v > 0)) throw new Error('Enter a positive amount');
            this.stxInit();
            this.sql.exec(`INSERT INTO snb_watch (user_id,aid,xlm,status,created) VALUES (?,?,?,?,?)`, user.id, Number(a1), v, 'armed', now());
            await this.snbArm();
            return send(`🎯 Armed: I buy <b>${v} XLM</b> of ${escH(this.stxGet(a1).code)} the moment it gets liquidity anywhere on Stellar.`, back);
          }
          if (kind === 'lua') {
            const v = Number(text.replace(',', '.')); if (!(v > 0)) throw new Error('Enter a positive amount');
            const s = this.snbSettings(row); s.lumen.amount = v; this.snbSave(from.id, s); reload();
            return fake('snp');
          }
          if (kind === 'pla') {
            const v = Number(text.replace(',', '.')); if (!(v > 0)) throw new Error('Enter a positive amount');
            const s = this.snbSettings(row); s.pools.amount = v; this.snbSave(from.id, s); reload();
            return fake('snp');
          }
          if (kind === 'r2w') {
            const r = await this.wserial(() => this.withdraw(user, { chain: 'stellar', to: row.wpub, amount: toWei(text).toString(), asset: 'xlm' }));
            this._snbCC?.delete(row.wpub);
            return send(`✅ Moved ${escH(text)} XLM to your wallet${txl(r?.txid)}`, [[{ text: '🔑 Wallet', callback_data: 'wal' }]]);
          }
          if (kind === 'w2r') {
            const x = Number(text.replace(',', '.'));
            const ch = await this.snbChain(row.wpub);
            if (!(x > 0) || x > ch.avail) throw new Error(`Enter up to ${num(ch.avail, 4)} XLM (the rest is the Stellar reserve)`);
            const st = await this.stellar();
            const hash = await this.snbSignSubmit(row, await st.buildPaymentXdr({ from: row.wpub, to: st.hotAddress, amount: x, memo: String(user.id) }));
            await new Promise(r => setTimeout(r, 2500));
            await this.wserial(() => this.stellarScan()).catch(() => {});
            return send(`✅ Sent ${num(x, 4)} XLM to your Rookery balance${txl(hash)}`, [[{ text: '🔑 Wallet', callback_data: 'wal' }]]);
          }
        } catch (e) { return send('❌ ' + escH(e.message)); }
      }
      // anything else: a ticker, a contract or a link
      const mid = this.snbResolve(text);
      if (mid) {
        const mk = this.market(mid);
        if (mk.migrated && mk.network === 'stellar' && mk.st_issuer) return show(await this.stxCard(user, row, this.stxAid({ code: mk.st_code, issuer: mk.st_issuer })));
        return show(await this.snbCard(user, mid, row));
      }
      const ext = await this.stxResolve(text).catch(() => null);
      if (ext) {
        const v = await this.stxCard(user, row, this.stxAid(ext));
        if (ext.guessed) v.text = `<i>Several assets use this code: showing the one with the most holders. Paste CODE:ISSUER for another.</i>\n` + v.text;
        return show(v);
      }
      return send('Token not found. Paste a ticker (e.g. <code>STROOPY</code>), a contract (G… / C… / CODE:ISSUER), a Rookery link, or tap 🆕 New tokens.', [[{ text: '🆕 New tokens', callback_data: 'new' }, { text: '🏠 Menu', callback_data: 'm' }]]);
    }

    /* buttons */
    const d = String(cq.data || '');
    const [k, a1, a2] = d.split(':');
    const re = (data) => this.snbUpdate({ callback_query: { ...cq, id: '', data } }, host);
    if (!['b', 's'].includes(k)) toast('');
    if (k === 'm') return show(await this.snbHome(user, row));
    if (k === 't') return show(await this.snbCard(user, a1, row));
    if (k === 'b') return doBuy(a1, toWei(a2));
    if (k === 'xc') return show(await this.stxCard(user, row, Number(a1)));
    if (k === 'xb') return doX(Number(a1), 'buy', Number(a2));
    if (k === 'xs') return doX(Number(a1), 'sell', Number(a2));
    if (k === 'xbx' || k === 'xsx' || k === 'xw') {
      pend(`${k}:${a1}`);
      const a = this.stxGet(a1);
      return send(k === 'xbx' ? `Send the amount of <b>XLM</b> to spend on ${escH(a.code)}:` : k === 'xsx' ? `Send the <b>percentage</b> of your ${escH(a.code)} to sell (1–100):` : `How much <b>XLM</b> to buy the moment ${escH(a.code)} becomes tradable?`,
        null, { reply_markup: { force_reply: true, input_field_placeholder: k === 'xsx' ? 'e.g. 33' : 'e.g. 50' } });
    }
    if (k === 'sp') { const s = this.snbSettings(row); s.slip = { 1: 3, 3: 5, 5: 10, 10: 20, 20: 1 }[s.slip] || 5; this.snbSave(from.id, s); reload(); return show(await this.stxCard(user, row, Number(a1))); }
    if (k === 'lu') { const s = this.snbSettings(row); s.lumen.on = !s.lumen.on; this.snbSave(from.id, s); if (s.lumen.on) await this.snbArm(); return re('snp'); }
    if (k === 'lua') { pend('lua'); return send('XLM to spend on each <b>new Lumen launch</b>:', null, { reply_markup: { force_reply: true, input_field_placeholder: 'e.g. 25' } }); }
    if (k === 'pl') { const s = this.snbSettings(row); s.pools.on = !s.pools.on; this.snbSave(from.id, s); return re('snp'); }
    if (k === 'pla') { pend('pla'); return send('XLM to spend on each <b>new Aquarius pool</b>:', null, { reply_markup: { force_reply: true, input_field_placeholder: 'e.g. 25' } }); }
    if (k === 's') return doSell(a1, Number(a2));
    if (k === 'bx' || k === 'sx') {
      pend(`${k}:${a1}`);
      const m = this.market(a1);
      return send(k === 'bx' ? `Send the amount of <b>${UNIT[qa(m)]}</b> to spend on $${escH(m.symbol)}:` : `Send the <b>percentage</b> of your $${escH(m.symbol)} to sell (1–100):`,
        null, { reply_markup: { force_reply: true, input_field_placeholder: k === 'bx' ? 'e.g. 75' : 'e.g. 33' } });
    }
    if (k === 'tm' || k === 'rf') {
      if (k === 'rf' && /POSITION TERMINAL/.test(msg.text || '') && msg.message_id) {
        this.sql.exec('INSERT OR REPLACE INTO snb_terms (chat_id,msg_id,user_id,market,until,last,edited) VALUES (?,?,?,?,?,?,?)', String(chatId), msg.message_id, user.id, a1, now() + LIVE_MS, '', now());
        await this.tgS('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: await this.snbTerminalText(user.id, a1, true), parse_mode: 'HTML', reply_markup: { inline_keyboard: this.snbTerminalKb(a1, true) } });
        return this.snbArm();
      }
      return this.snbOpenTerminal(chatId, user.id, a1);
    }
    if (k === 'ps') {
      this.sql.exec('DELETE FROM snb_terms WHERE chat_id=? AND msg_id=?', String(chatId), msg.message_id);
      return this.tgS('editMessageText', { chat_id: chatId, message_id: msg.message_id, text: await this.snbTerminalText(user.id, a1, false), parse_mode: 'HTML', reply_markup: { inline_keyboard: this.snbTerminalKb(a1, false) } });
    }
    if (k === 'pos') {
      const pos = (await this.snbPositions(user.id, this.snbWallet(row, user))).slice(0, 12);
      if (!pos.length) return show({ text: '<b>📊 POSITIONS</b>\n' + LINE + '\nNo bags yet. Paste a ticker or open 🆕 New tokens.', kb: [[{ text: '🆕 New tokens', callback_data: 'new' }, { text: '← Back', callback_data: 'm' }]] });
      const lines = pos.map(x => `${sign(x.p.pnlZro)} <b>$${escH(x.v.symbol)}</b> ${usd(x.usdValue)} · ${pct(x.p.pnlPct)} (${usd(x.usdPnl)})${x.p.chain > 0 ? ' 🔑' : ''}`);
      const kb = []; for (let i = 0; i < pos.length; i += 3) kb.push(pos.slice(i, i + 3).map(x => ({ text: (x.ext ? '' : '$') + x.v.symbol, callback_data: x.ext ? `xc:${x.ext}` : `t:${x.m.id}` })));
      kb.push([{ text: '🔄 Refresh', callback_data: 'pos' }, { text: '← Back', callback_data: 'm' }]);
      return show({ text: `<b>📊 POSITIONS</b>\n${LINE}\n${lines.join('\n')}\n${LINE}\n<i>🔑 = held in your own wallet. Tap a token to trade it.</i>`, kb });
    }
    if (k === 'new' || k === 'hot' || k === 'buy') {
      const rows = k === 'hot'
        ? this.sql.exec(`SELECT m.* FROM markets m WHERE m.migrated=0 ORDER BY (SELECT COALESCE(SUM(usd),0) FROM trades t WHERE t.market=m.id AND t.ts>?) DESC LIMIT 9`, now() - 864e5).toArray()
        : this.sql.exec('SELECT * FROM markets WHERE migrated=0 ORDER BY created DESC LIMIT 9').toArray();
      const lines = rows.map(m => { const v = this.view(m); return `<code>${pad(NET[m.network] || '', 8)}</code><b>$${escH(v.symbol)}</b> ${usd(v.mcapUsd)} · ${v.progress.toFixed(0)}%`; });
      const kb = []; for (let i = 0; i < rows.length; i += 3) kb.push(rows.slice(i, i + 3).map(m => ({ text: '$' + m.symbol, callback_data: `t:${m.id}` })));
      kb.push([{ text: k === 'hot' ? '🆕 New' : '🔥 Trending', callback_data: k === 'hot' ? 'new' : 'hot' }, { text: '← Back', callback_data: 'm' }]);
      return show({ text: `<b>${k === 'hot' ? '🔥 TRENDING · 24H' : '🆕 NEW TOKENS'}</b>\n${LINE}\n${lines.join('\n')}\n${LINE}\n<i>Or paste any ticker or contract.</i>`, kb });
    }
    if (k === 'snp') {
      const s = this.snbSettings(row);
      const hs = this.sql.exec(`SELECT * FROM hatches WHERE cancelled=0 AND market_id='' AND launch_at>? ORDER BY launch_at LIMIT 5`, now()).toArray();
      const armed = this.sql.exec(`SELECT hatch FROM snb_snipes WHERE user_id=? AND status='armed'`, user.id).toArray().map(r => r.hatch);
      const nets = [['stellar', 'XLM'], ['zero', 'ZRO'], ['giwa', 'ETH']];
      const text = [`<b>🎯 SNIPER</b>`, LINE,
        `Auto-buy new launches. Rookery launches run under the same launch rules as every buyer; for any other Stellar token paste it and tap <i>Snipe when tradable</i>.`, '',
        ...nets.map(([n, U]) => `${s.snipe[n].on ? '🟢' : '⚪️'} <b>${NET[n]}</b> · ${s.snipe[n].amount} ${U} per launch`),
        `Daily limit: ${s.maxDay} snipes`, '',
        `${s.lumen.on ? '🟢' : '⚪️'} <b>LUMEN LAUNCHES</b> · ${s.lumen.amount} XLM per launch`,
        `${s.pools.on ? '🟢' : '⚪️'} <b>NEW STELLAR POOLS</b> (Aquarius) · ${s.pools.amount} XLM each · skips freezable / clawback tokens`,
        (() => { this.stxInit(); const w = this.sql.exec(`SELECT w.*, a.code FROM snb_watch w JOIN snb_assets a ON a.id=w.aid WHERE w.user_id=? AND w.status='armed'`, user.id).toArray(); return w.length ? '<b>Waiting for liquidity</b>\n' + w.map(x => `🎯 ${escH(x.code)} · ${x.xlm} XLM`).join('\n') : ''; })(),
        '',
        hs.length ? '<b>Hatching soon</b>\n' + hs.map(h => `${armed.includes(h.id) ? '🎯' : '🥚'} $${escH(h.symbol)} · ${NET[h.network] || ''} · ${new Date(h.launch_at).toISOString().slice(5, 16).replace('T', ' ')} UTC`).join('\n') : '<i>No hatches announced right now.</i>',
      ].join('\n');
      const kb = nets.map(([n, U]) => [{ text: `${s.snipe[n].on ? '🟢 ON' : '⚪️ OFF'} · ${NET[n]}`, callback_data: `sn:${n}` }, { text: `✏️ ${s.snipe[n].amount} ${U}`, callback_data: `sa:${n}` }]);
      kb.push([{ text: `${s.lumen.on ? '🟢 ON' : '⚪️ OFF'} · LUMEN`, callback_data: 'lu' }, { text: `✏️ ${s.lumen.amount} XLM`, callback_data: 'lua' }]);
      kb.push([{ text: `${s.pools.on ? '🟢 ON' : '⚪️ OFF'} · NEW POOLS`, callback_data: 'pl' }, { text: `✏️ ${s.pools.amount} XLM`, callback_data: 'pla' }]);
      for (const h of hs) if (!armed.includes(h.id)) kb.push([{ text: `🎯 Snipe $${h.symbol} at launch`, callback_data: `ha:${h.id}` }]);
      kb.push([{ text: `Limit: ${s.maxDay}/day`, callback_data: 'sl' }, { text: '← Back', callback_data: 'm' }]);
      return show({ text, kb });
    }
    if (k === 'sn') { const s = this.snbSettings(row); s.snipe[a1].on = !s.snipe[a1].on; this.snbSave(from.id, s); return re('snp'); }
    if (k === 'sl') { const s = this.snbSettings(row); s.maxDay = { 3: 5, 5: 10, 10: 25, 25: 3 }[s.maxDay] || 10; this.snbSave(from.id, s); return re('snp'); }
    if (k === 'sa') { pend(`sa:${a1}`); return send(`Send the amount per launch for <b>${NET[a1]}</b> (in ${a1 === 'stellar' ? 'XLM' : a1 === 'giwa' ? 'ETH' : 'ZRO'}):`, null, { reply_markup: { force_reply: true } }); }
    if (k === 'ha') {
      const h = this.sql.exec('SELECT * FROM hatches WHERE id=?', a1).toArray()[0];
      if (!h) return toast('Hatch not found', true);
      pend(`ha:${a1}`);
      return send(`How much to buy the moment <b>$${escH(h.symbol)}</b> launches? (in ${h.network === 'stellar' ? 'XLM' : h.network === 'giwa' ? 'ETH' : 'ZRO'})`, null, { reply_markup: { force_reply: true } });
    }
    if (k === 'ref') {
      const code = this.snbRefCode(row);
      const link = `https://t.me/${this.snbBot()}?start=R${code}`;
      const st = this.snbRefStats(user.id);
      const xu = this.xlmUsd(), f = (w) => Number(w) / 1e18;
      const earnedUsd = f(st.earned.xlm) * xu + f(st.earned.zro) * this.zroUsd() + f(st.earned.eth) * this.ethUsd();
      const text = [`<b>🎁 INVITE & EARN</b>`, LINE,
        `Share your link. Every trade your friends make in the bot pays you <b>${Number(this.snbRefBps()) / 100}% of the bot fee</b>, straight to your Rookery balance. Forever.`, '',
        `<b>Your link</b>\n<code>${link}</code>`, '',
        `<pre>INVITED   ${pad(st.invited + ' people', 14)}${st.active} trading\n` +
        `TRADES    ${pad(String(st.trades), 14)}by your invites\n` +
        `EARNED    ${pad(num(f(st.earned.xlm), 4) + ' XLM', 14)}${usd(earnedUsd)}\n` +
        (st.earned.zro > 0n || st.earned.eth > 0n ? `          ${num(f(st.earned.zro), 4)} ZRO · ${num(f(st.earned.eth), 6)} ETH\n` : '') +
        `PENDING   ${pad(num(f(st.pending.xlm), 4) + ' XLM', 14)}lands within a minute\n` +
        `LAST 24H  ${num(f(st.today.xlm), 4)} XLM</pre>`,
        st.top.length ? '<b>Top invites</b>\n' + st.top.map((t, i) => `${i + 1}. ${escH(t.username)} · ${num(t.s / 1e18, 4)} XLM`).join('\n') : '<i>No invites yet: share your link to start earning.</i>',
        '', `<i>Earnings sit on your Rookery balance: move them to your wallet (🔑 Wallet) or withdraw any time.</i>`].join('\n');
      return show({ text, kb: [
        [{ text: '📤 Share my link', url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Snipe any Stellar token from Telegram with RookerySniperBot 🐧🎯')}` }],
        [{ text: '🔄 Refresh', callback_data: 'ref' }, { text: '← Back', callback_data: 'm' }]] });
    }
    if (k === 'wal') return show(await walletView());
    if (k === 'wx') {
      if (!row.wsec) return toast('No bot wallet to export', true);
      return show({ text: `<b>📤 EXPORT KEY</b>\n${LINE}\nYour secret key gives <b>full control</b> of this wallet. Anyone who sees it can take everything.\n\n• Never share it, never paste it on a website\n• Rookery and its team will never ask for it\n• The message deletes itself after 60 seconds\n\nImport it into Freighter, Lobstr or xBull to use the same wallet there.`,
        kb: [[{ text: '⚠️ Show my secret key', callback_data: 'wx2' }], [{ text: '← Back', callback_data: 'wal' }]] });
    }
    if (k === 'wx2') {
      if (!row.wsec) return toast('No bot wallet to export', true);
      const sec = await this.snbOpen(row.wsec);
      const r = await this.tgS('sendMessage', { chat_id: chatId, parse_mode: 'HTML', protect_content: true,
        text: `🔑 <b>Secret key</b> for <code>${row.wpub.slice(0, 5)}…${row.wpub.slice(-5)}</code>\n<tg-spoiler><code>${sec}</code></tg-spoiler>\n\n<i>Tap to reveal, copy it somewhere safe. This message deletes itself in 60 seconds.</i>` });
      if (r?.ok) { this.sql.exec('INSERT INTO snb_del (chat_id,msg_id,at) VALUES (?,?,?)', String(chatId), r.result.message_id, now() + 60e3); await this.snbArm(); }
      this.sql.exec('UPDATE snb_users SET exported=1 WHERE tg_id=?', String(from.id));
      return;
    }
    if (k === 'wi') {
      pend('imp');
      return send(`<b>📥 IMPORT WALLET</b>\n${LINE}\nSend the <b>secret key</b> (starts with S) of the Stellar wallet you want to use. I delete your message right away and store the key encrypted.\n\nAfter import, buys pay from that wallet and tokens land in it.${row.wsec && !row.exported ? '\n\n⚠️ Export your current bot wallet first if it holds anything.' : ''}`,
        null, { reply_markup: { force_reply: true, input_field_placeholder: 'S…' } });
    }
    if (k === 'r2w' || k === 'w2r') {
      if (!row.wsec) return toast('Import or create a wallet first', true);
      pend(k);
      return send(k === 'r2w' ? `How much XLM to move from your Rookery balance (${amt(this.bal(user.id, 'xlm'), 4)}) to your wallet?` : `How much XLM to move from your wallet to your Rookery balance?`,
        null, { reply_markup: { force_reply: true, input_field_placeholder: 'e.g. 50' } });
    }
    if (k === 'dep') {
      if (!user.eth_dep_address) { try { this.ensureEthAddresses(); user = this.sql.exec('SELECT * FROM users WHERE id=?', user.id).one(); } catch { /* later */ } }
      let st = ''; try { st = (await this.stellar()).hotAddress; } catch { /* not configured */ }
      const wal = this.snbWallet(row, user);
      return show({ text: [`<b>💰 DEPOSIT</b>`, LINE,
        wal?.signer ? `<b>XLM · your wallet</b> (no memo)\n<code>${wal.pub}</code>` : '',
        st ? `\n<b>XLM · Rookery balance</b> (memo required)\nAddress: <code>${st}</code>\nMemo: <code>${user.id}</code>` : '',
        user.dep_address ? `\n<b>ZRO</b> · Ethereum, Base, Arbitrum, BNB, Optimism\n<code>${user.dep_address}</code>` : '',
        user.eth_dep_address ? `\n<b>ETH</b> · Ethereum, Base, Arbitrum\n<code>${user.eth_dep_address}</code>` : '',
        LINE, `<i>Deposits land in about a minute. Tap Refresh on the menu to see them.</i>`].filter(Boolean).join('\n'), kb: back });
    }
    if (k === 'wd') return show({ text: `<b>💸 WITHDRAW</b>\n${LINE}\n<b>Your wallet</b> is yours: export the key (🔑 Wallet) and send from any Stellar app.\n<b>Rookery XLM</b>: <code>/withdraw 25 GABC…</code> or move it to your wallet.\n<b>ZRO / ETH</b>: 🌐 Web → Wallet.`, kb: [[{ text: '🔑 Wallet', callback_data: 'wal' }, { text: '🌐 Web', callback_data: 'web' }], ...back] });
    if (k === 'set') {
      const s = this.snbSettings(row);
      return show({ text: `<b>⚙️ SETTINGS</b>\n${LINE}\nAccount: <b>${escH(user.username)}</b>\nPosition Terminal after each buy: <b>${s.terminal ? 'ON' : 'OFF'}</b>\nBot fee: ${Number(this.snbFeeBps()) / 100}% per trade, it buys &amp; burns $臭企鹅\n\nUse this account on the web: tap 🌐 Web.`,
        kb: [[{ text: `📟 Terminal: ${s.terminal ? 'ON' : 'OFF'}`, callback_data: 'st' }], ...back] });
    }
    if (k === 'st') { const s = this.snbSettings(row); s.terminal = !s.terminal; this.snbSave(from.id, s); return re('set'); }
    if (k === 'web') {
      const tok = randHex(16);
      this.sql.exec('INSERT INTO snb_tokens (token,kind,user_id,expires) VALUES (?,?,?,?)', tok, 'login', user.id, now() + 10 * 60e3);
      return show({ text: `<b>🌐 OPEN ROOKERY</b>\n${LINE}\nOne-time login link for <b>${escH(user.username)}</b>, valid 10 minutes. Do not share it.`,
        kb: [[{ text: '🔐 Log in on Rookery', url: `https://${host}/api/snb/login/${tok}` }], ...back] });
    }
  };

  // DO alarm drives the live terminals
  const prevAlarm = P.alarm;
  P.alarm = async function () {
    if (prevAlarm) await prevAlarm.call(this).catch(() => {});
    if (this.snbOn()) await this.snbTick().catch(() => {});
  };
}
