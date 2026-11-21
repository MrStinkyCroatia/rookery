// Universal Stellar trading for RookerySniperBot: any asset, best route across the Stellar DEX (order books),
// classic AMM pools and Aquarius, executed from the user's own wallet. Rookery curve tokens keep their own route.
import { Asset, Operation, TransactionBuilder, Memo, Address, xdr, nativeToScVal, Account } from '@stellar/stellar-sdk';
import { ST_NETS } from './stellar.js';

const AQ_API = 'https://amm-api.aqua.network/api/external/v1';
// Lumen (launchonlumen.fun): one curve contract runs every coin until it graduates into an Aquarius pool
const LUMEN = { curve: 'CDLXYTF3FA26BDZUFX7PGAIFG5VCGOEQZN4LRCB5Z5OUAKFHOEQUZH5T', board: 'https://launchonlumen.fun/api/board', site: 'https://launchonlumen.fun' };

export function installStx(Cls, H) {
  const { B, WEI, now } = H;
  const P = Cls.prototype;
  const f7 = (n) => (Math.floor(Number(n) * 1e7) / 1e7).toFixed(7);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const hzUrl = function () { return ST_NETS[this.stNet()].horizon; };
  const hz = async function (path) {
    const r = await fetch(hzUrl.call(this) + path, { signal: AbortSignal.timeout(12000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('Stellar network busy (' + r.status + ')');
    return r.json();
  };
  const assetQ = (pre, a) => a.code === 'XLM' && !a.issuer ? `${pre}_asset_type=native`
    : `${pre}_asset_type=${a.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'}&${pre}_asset_code=${a.code}&${pre}_asset_issuer=${a.issuer}`;
  const toAsset = (r) => r.asset_type === 'native' ? Asset.native() : new Asset(r.asset_code, r.asset_issuer);

  P.stxInit = function () {
    if (this._stxInit) return; this._stxInit = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snb_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, akey TEXT UNIQUE, code TEXT, issuer TEXT, contract TEXT, decimals INTEGER DEFAULT 7, name TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snb_ext (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, aid INTEGER, side TEXT, xlm REAL, tokens REAL, venue TEXT, hash TEXT, ts INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snb_owed (user_id INTEGER PRIMARY KEY, xlm REAL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snb_watch (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, aid INTEGER, xlm REAL, status TEXT, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snb_pools_seen (address TEXT PRIMARY KEY, ts INTEGER)`);
  };
  P.stxAid = function (a) {
    this.stxInit();
    const key = a.contract && !a.issuer ? 'c:' + a.contract : a.code + ':' + a.issuer;
    this.sql.exec('INSERT OR IGNORE INTO snb_assets (akey,code,issuer,contract,decimals,name) VALUES (?,?,?,?,?,?)', key, a.code, a.issuer || null, a.contract || null, a.decimals || 7, a.name || a.code);
    return this.sql.exec('SELECT id FROM snb_assets WHERE akey=?', key).one().id;
  };
  P.stxGet = function (aid) {
    this.stxInit();
    const r = this.sql.exec('SELECT * FROM snb_assets WHERE id=?', Number(aid)).toArray()[0];
    if (!r) throw new Error('Token not found');
    return { id: r.id, code: r.code, issuer: r.issuer, contract: r.contract || this.stxSac(r), decimals: r.decimals || 7, name: r.name, classic: !!r.issuer };
  };
  P.stxSac = function (a) { try { return new Asset(a.code, a.issuer).contractId(ST_NETS[this.stNet()].pass); } catch { return ''; } };
  P.stxXlmSac = function () { return Asset.native().contractId(ST_NETS[this.stNet()].pass); };

  // text → asset: CODE:ISSUER / CODE-ISSUER, G issuer, C contract (SAC or Soroban token), explorer links, bare code
  P.stxResolve = async function (text) {
    const t = String(text || '').trim();
    let m = t.match(/([A-Za-z0-9]{1,12})[:\-](G[A-Z2-7]{55})/);
    if (m) return { code: m[1], issuer: m[2] };
    m = t.match(/\b(G[A-Z2-7]{55})\b/);
    if (m) {
      const r = await hz.call(this, `/assets?asset_issuer=${m[1]}&limit=20`).catch(() => null);
      const recs = (r?._embedded?.records || []).sort((a, b) => b.accounts.authorized - a.accounts.authorized);
      if (recs[0]) return { code: recs[0].asset_code, issuer: m[1] };
      return null;
    }
    m = t.match(/\b(C[A-Z2-7]{55})\b/);
    if (m) {
      const st = await this.stellar();
      let name = null;
      try { name = String(await st.view(m[1], 'name', [])); } catch {
        // contract not deployed (a SAC nobody has touched yet): match it against every asset we know
        this.stxInit();
        const pass = ST_NETS[this.stNet()].pass;
        for (const r of this.sql.exec(`SELECT code, issuer FROM snb_assets WHERE issuer IS NOT NULL UNION SELECT st_code, st_issuer FROM markets WHERE st_issuer IS NOT NULL AND st_issuer!=''`).toArray()) {
          try { if (new Asset(r.code, r.issuer).contractId(pass) === m[1]) return { code: r.code, issuer: r.issuer }; } catch { /* skip */ }
        }
        return null;
      }
      const mm = name.match(/^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/);
      if (mm) return { code: mm[1], issuer: mm[2] };
      if (name === 'native') return null;
      let symbol = name, decimals = 7;
      try { symbol = String(await st.view(m[1], 'symbol', [])); } catch { /* keep name */ }
      try { decimals = Number(await st.view(m[1], 'decimals', [])); } catch { /* 7 */ }
      return { code: symbol.slice(0, 12), contract: m[1], decimals, name };
    }
    m = t.match(/^\$?([A-Za-z0-9/]{2,12})$/);
    if (m) {
      const b = (await this.lumenBoard()).filter(x => String(x.symbol).toUpperCase() === m[1].toUpperCase());
      if (b.length) {
        const x = b.sort((p, q) => (q.holders || 0) - (p.holders || 0))[0];
        return { code: String(x.symbol).slice(0, 12), contract: x.token, decimals: 7, name: x.name, guessed: b.length > 1 };
      }
    }
    if (m && /^[A-Za-z0-9]+$/.test(m[1])) {
      const r = await hz.call(this, `/assets?asset_code=${m[1].toUpperCase()}&limit=20`).catch(() => null);
      const recs = (r?._embedded?.records || []).filter(x => x.accounts.authorized > 2).sort((a, b) => b.accounts.authorized - a.accounts.authorized);
      if (recs[0]) return { code: recs[0].asset_code, issuer: recs[0].asset_issuer, guessed: recs.length > 1 };
    }
    return null;
  };

  /* ── Lumen launchpad ── */
  const i128 = (v) => nativeToScVal(BigInt(v), { type: 'i128' });
  P.lumenBoard = async function () {
    if (this.stNet() !== 'mainnet') return [];
    if (this._lumB && now() - this._lumB.t < 60000) return this._lumB.v;
    try {
      const j = await (await fetch(LUMEN.board, { signal: AbortSignal.timeout(10000) })).json();
      this._lumB = { t: now(), v: j.launches || [] };
    } catch { if (!this._lumB) this._lumB = { t: now() - 50000, v: [] }; }
    return this._lumB.v;
  };
  // Lumen meta + live state for a coin, or null when the token is not a Lumen curve coin
  P.lumen = async function (a) {
    if (this.stNet() !== 'mainnet' || !a?.contract || a.issuer) return null;
    this._lum = this._lum || new Map();
    const c = this._lum.get(a.contract);
    if (c && now() - c.t < 6000) return c.v;
    const st = await this.stellar();
    let meta = c?.v?.meta;
    if (!meta) { try { meta = await st.view(LUMEN.curve, 'get_meta', [new Address(a.contract).toScVal()]); } catch { this._lum.set(a.contract, { t: now() + 3600e3, v: null }); return null; } }
    let state;
    try { state = await st.view(LUMEN.curve, 'get_state', [new Address(a.contract).toScVal()]); } catch { state = c?.v?.state || {}; }
    const quote = String(meta.quote);
    const xlmPair = quote === this.stxXlmSac();
    let pair = c?.v?.pair;
    if (!pair) {
      if (xlmPair) pair = { code: 'XLM' };
      else { try { const n = String(await st.view(quote, 'name', [])); const mm = n.match(/^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/); pair = mm ? { code: mm[1], issuer: mm[2] } : { code: n.slice(0, 12), contract: quote }; } catch { pair = { code: '?', contract: quote }; } }
    }
    const curveTok = Number(meta.curve_tokens || 0), real = Number(state.real_tokens || 0);
    const v = { meta, state, pair, xlmPair, quote, graduated: !!state.graduated, pool: state.pool || null,
      progress: curveTok ? Math.max(0, Math.min(100, ((curveTok - real) / curveTok) * 100)) : 0,
      pricePair: Number(state.v_quote || 0) / Math.max(1, Number(state.v_token || 1)) };
    this._lum.set(a.contract, { t: now(), v });
    return v;
  };
  // XLM <-> the coin's pair asset on the classic DEX (only for coins not paired with XLM)
  P.lumenPairQuote = async function (pair, dir, amount) {
    if (!pair.issuer) return null;
    const r = await this.stxHorizon({ code: pair.code, issuer: pair.issuer }, dir === 'in' ? 'buy' : 'sell', amount);
    return r ? r.out : null;
  };
  P.lumenQuote = async function (a, L, side, amount) {
    const st = await this.stellar();
    const T = new Address(a.contract).toScVal();
    try {
      if (side === 'buy') {
        const pairIn = L.xlmPair ? amount : await this.lumenPairQuote(L.pair, 'in', amount);
        if (!(pairIn > 0)) return null;
        const [out] = await st.view(LUMEN.curve, 'quote_buy', [T, i128(Math.floor(pairIn * 1e7))]);
        const tokens = Number(out) / 10 ** (a.decimals || 7);
        return tokens > 0 ? { venue: 'Lumen curve', out: tokens, pairIn } : null;
      }
      const q = Number(await st.view(LUMEN.curve, 'quote_sell', [T, i128(Math.floor(amount * 10 ** (a.decimals || 7)))])) / 1e7;
      if (!(q > 0)) return null;
      const xlm = L.xlmPair ? q : await this.lumenPairQuote(L.pair, 'out', q);
      return xlm > 0 ? { venue: 'Lumen curve', out: xlm, pairOut: q } : null;
    } catch { return null; }
  };
  P.lumenDeadline = async function () {
    const st = await this.stellar();
    const l = await st.srpc('getLatestLedger', {});
    return Number(l.sequence) + 60;
  };

  /* ── quotes ── */
  P.stxHorizon = async function (a, side, amount) {
    if (!a.issuer) return null;
    const q = side === 'buy'
      ? `/paths/strict-send?source_asset_type=native&source_amount=${f7(amount)}&destination_assets=${a.code}:${a.issuer}`
      : `/paths/strict-send?${assetQ('source', a)}&source_amount=${f7(amount)}&destination_assets=native`;
    const r = await hz.call(this, q).catch(() => null);
    const recs = r?._embedded?.records || [];
    if (!recs.length) return null;
    const best = recs.reduce((x, y) => Number(y.destination_amount) > Number(x.destination_amount) ? y : x);
    return { venue: best.path.length ? 'SDEX/AMM route' : 'SDEX/AMM', out: Number(best.destination_amount), path: best.path };
  };
  P.stxAquarius = async function (a, side, amount) {
    if (this.stNet() !== 'mainnet') return null;
    const tok = a.contract || this.stxSac(a), xlm = this.stxXlmSac();
    const dIn = side === 'buy' ? 7 : (a.decimals || 7), dOut = side === 'buy' ? (a.decimals || 7) : 7;
    try {
      const r = await fetch(AQ_API + '/find-path/', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ token_in_address: side === 'buy' ? xlm : tok, token_out_address: side === 'buy' ? tok : xlm, amount: String(BigInt(Math.floor(amount * 10 ** dIn))) }) });
      const j = await r.json();
      if (!j.success || !j.swap_chain_xdr || !(Number(j.amount) > 0)) return null;
      return { venue: 'Aquarius', out: Number(j.amount) / 10 ** dOut, chain: j.swap_chain_xdr, inUnits: String(BigInt(Math.floor(amount * 10 ** dIn))), tokenIn: side === 'buy' ? xlm : tok };
    } catch { return null; }
  };
  P.stxQuote = async function (a, side, amount) {
    const L = await this.lumen(a).catch(() => null);
    if (L && !L.graduated) { const r = await this.lumenQuote(a, L, side, amount); return r ? { best: r, all: [r], lumen: L } : null; }
    const [h, q] = await Promise.all([this.stxHorizon(a, side, amount), this.stxAquarius(a, side, amount)]);
    const all = [h, q].filter(Boolean);
    if (!all.length) return null;
    return { best: all.reduce((x, y) => y.out > x.out ? y : x), all };
  };

  /* ── market data from the chain itself ── */
  P.stxInfo = async function (a) {
    this._stxInfo = this._stxInfo || new Map();
    const k = a.id + ':' + Math.floor(now() / 20000);
    if (this._stxInfo.has(k)) return this._stxInfo.get(k);
    const out = { supply: null, holders: null, pools: 0, flags: {}, locked: null, home: '', priceXlm: null };
    if (a.issuer) {
      const [as, iss] = await Promise.all([
        hz.call(this, `/assets?asset_code=${a.code}&asset_issuer=${a.issuer}`).catch(() => null),
        hz.call(this, `/accounts/${a.issuer}`).catch(() => null)]);
      const r = as?._embedded?.records?.[0];
      if (r) {
        out.supply = Number(r.balances.authorized) + Number(r.balances.authorized_to_maintain_liabilities || 0) + Number(r.liquidity_pools_amount || 0) + Number(r.contracts_amount || 0) + Number(r.claimable_balances_amount || 0);
        out.holders = r.accounts.authorized; out.pools = r.num_liquidity_pools || 0; out.flags = r.flags || {};
      }
      if (iss) { out.home = iss.home_domain || ''; out.locked = (iss.signers || []).reduce((s, x) => s + Number(x.weight || 0), 0) === 0; }
    }
    const L = await this.lumen(a).catch(() => null);
    if (L) {
      out.lumen = { progress: L.progress, graduated: L.graduated, pair: L.pair.code, buyTax: (Number(L.meta.buy_tax_bps || 0)) / 100, sellTax: (Number(L.meta.sell_tax_bps || 0)) / 100,
        trades: Number(L.state.trades || 0), creator: String(L.meta.creator || ''), image: L.meta.image_url || '' };
      out.supply = 1e9; out.holders = Number(L.state.holders || 0);
      if (L.xlmPair && L.pricePair) out.priceXlm = L.pricePair;
    }
    const probe = await this.stxQuote(a, 'buy', 10);
    if (probe && !(L && L.xlmPair && out.priceXlm)) out.priceXlm = 10 / probe.best.out;
    out.routes = probe?.all.map(r => r.venue) || [];
    this._stxInfo.set(k, out);
    return out;
  };
  P.stxBal = async function (pub, a) {
    if (a.issuer) {
      const ch = await this.snbChain(pub);
      const t = ch.tok?.[a.code + ':' + a.issuer];
      return { bal: t ? t.bal : 0, trust: !!t, exists: ch.exists };
    }
    const st = await this.stellar();
    try { const v = await st.view(a.contract, 'balance', [new Address(pub).toScVal()]); return { bal: Number(v) / 10 ** (a.decimals || 7), trust: true, exists: true }; }
    catch { return { bal: 0, trust: true, exists: true }; }
  };
  // what the position is worth right now: the XLM a full sell would return (cached a few seconds)
  P.stxValue = async function (a, tokens) {
    if (!(tokens > 0)) return 0;
    this._stxVal = this._stxVal || new Map();
    const k = a.id + ':' + tokens.toFixed(7);
    const c = this._stxVal.get(k);
    if (c && now() - c.t < 8000) return c.v;
    const q = await this.stxQuote(a, 'sell', tokens);
    const v = q ? q.best.out : 0;
    this._stxVal.set(k, { t: now(), v });
    return v;
  };
  P.stxPos = async function (uid, pub, a) {
    const b = pub ? await this.stxBal(pub, a) : { bal: 0 };
    const rows = this.sql.exec('SELECT side, xlm FROM snb_ext WHERE user_id=? AND aid=?', uid, a.id).toArray();
    const paid = rows.filter(r => r.side === 'buy').reduce((s, r) => s + r.xlm, 0), got = rows.filter(r => r.side === 'sell').reduce((s, r) => s + r.xlm, 0);
    const value = await this.stxValue(a, b.bal);
    const cost = paid - got;
    return { tokens: b.bal, value, cost, known: rows.length > 0, pnl: value - cost, pnlPct: cost > 0 ? ((value - cost) / cost) * 100 : null, paid, got };
  };

  /* ── execution from the user's wallet ── */
  P.stxFeeUid = function () {
    let id = Number(this.meta('snb_fee_uid') || 0);
    if (id && this.sql.exec('SELECT 1 FROM users WHERE id=?', id).toArray().length) return id;
    const idx = Number(this.meta('dep_counter')) + 1; this.setMeta('dep_counter', idx);
    this.sql.exec(`INSERT INTO users (email,username,pass_hash,salt,dep_index,dep_address,created) VALUES (?,?,?,?,?,?,?)`, 'fees@rookery.local', 'rookery_fees', '', '', idx, this.depositAddressFor(idx), now());
    id = this.sql.exec('SELECT last_insert_rowid() id').one().id;
    this.setMeta('snb_fee_uid', String(id));
    return id;
  };
  P.stxBuild = async function (pub, ops, memo) {
    const st = await this.stellar();
    const acc = await st.account(pub);
    if (!acc) throw new Error('Your wallet is not active yet: send it at least 2 XLM');
    const tb = new TransactionBuilder(new Account(pub, acc.sequence), { fee: '20000', networkPassphrase: ST_NETS[this.stNet()].pass });
    ops.forEach(o => tb.addOperation(o));
    if (memo) tb.addMemo(Memo.id(String(memo)));
    return tb.setTimeout(120).build().toXDR();
  };
  P.stxTrade = async function (row, user, a, side, amount, slipPct) {
    this.stxInit();
    const kpub = row.wpub;
    const feeBps = Number(this.snbFeeBps());
    const q = await this.stxQuote(a, side, side === 'buy' ? amount * (1 - feeBps / 10000) : amount);
    if (!q) throw new Error('No liquidity for this token on Stellar right now');
    const r = q.best;
    const min = r.out * (1 - slipPct / 100);
    if (side === 'buy') { const ch = await this.snbChainFresh(kpub); if (!ch.ok) throw new Error('Stellar network is busy, could not read your wallet. Try again in a few seconds.'); if (ch.avail < amount) throw new Error(`Not enough XLM in your wallet: ${ch.avail.toFixed(2)} spendable`); }
    const before = await this.stxBal(kpub, a);
    const xlmBefore = (await this.snbChain(kpub)).xlm;
    const fee = side === 'buy' ? amount * feeBps / 10000 : min * feeBps / 10000;
    const feeUid = this.stxFeeUid();
    const st = await this.stellar();
    let hash;
    if (r.venue === 'Lumen curve') {
      const L = q.lumen;
      const kp = await this.snbKp(row);
      const T = new Address(a.contract).toScVal(), U = new Address(kpub).toScVal();
      const pairA = L.pair.issuer ? new Asset(L.pair.code, L.pair.issuer) : null;
      if (side === 'buy') {
        let pairIn = amount - fee;
        if (!L.xlmPair) {
          if (!pairA) throw new Error('This coin is paired with an asset the bot cannot route to yet');
          const ch0 = await this.snbChain(kpub);
          const pb0 = ch0.tok?.[L.pair.code + ':' + L.pair.issuer]?.bal || 0;
          const pq = await this.stxHorizon({ code: L.pair.code, issuer: L.pair.issuer }, 'buy', amount - fee);
          if (!pq) throw new Error(`No route from XLM to ${L.pair.code}`);
          const ops = [];
          if (!ch0.tok?.[L.pair.code + ':' + L.pair.issuer]) ops.push(Operation.changeTrust({ asset: pairA }));
          ops.push(Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: f7(amount - fee), destination: kpub, destAsset: pairA, destMin: f7(pq.out * (1 - slipPct / 200)), path: pq.path.map(toAsset) }));
          await this.snbSignSubmit(row, await this.stxBuild(kpub, ops));
          this._snbCC?.delete(kpub);
          pairIn = ((await this.snbChain(kpub)).tok?.[L.pair.code + ':' + L.pair.issuer]?.bal || 0) - pb0;
          if (!(pairIn > 0)) throw new Error(`Could not get ${L.pair.code} for this coin`);
        }
        const [outQ] = await st.view(LUMEN.curve, 'quote_buy', [T, i128(Math.floor(pairIn * 1e7))]);
        const minOut = BigInt(Math.floor(Number(outQ) * (1 - slipPct / 100)));
        hash = (await st.invoke(kp, LUMEN.curve, 'buy', [U, T, i128(Math.floor(pairIn * 1e7)), i128(minOut), nativeToScVal(await this.lumenDeadline(), { type: 'u32' })])).hash;
      } else {
        const units = BigInt(Math.floor(amount * 10 ** (a.decimals || 7)));
        const outQ = Number(await st.view(LUMEN.curve, 'quote_sell', [T, i128(units)]));
        if (!(outQ > 0)) throw new Error('Sells are not possible on the curve right now');
        const ch0 = await this.snbChain(kpub);
        const pb0 = pairA ? (ch0.tok?.[L.pair.code + ':' + L.pair.issuer]?.bal || 0) : 0;
        hash = (await st.invoke(kp, LUMEN.curve, 'sell', [U, T, i128(units), i128(BigInt(Math.floor(outQ * (1 - slipPct / 100)))), nativeToScVal(await this.lumenDeadline(), { type: 'u32' })])).hash;
        if (!L.xlmPair && pairA) {
          // turn the pair asset back into XLM
          this._snbCC?.delete(kpub);
          const got = ((await this.snbChain(kpub)).tok?.[L.pair.code + ':' + L.pair.issuer]?.bal || 0) - pb0;
          const back = got > 0 ? await this.stxHorizon({ code: L.pair.code, issuer: L.pair.issuer }, 'sell', got) : null;
          if (back) await this.snbSignSubmit(row, await this.stxBuild(kpub, [Operation.pathPaymentStrictSend({ sendAsset: pairA, sendAmount: f7(got), destination: kpub, destAsset: Asset.native(), destMin: f7(back.out * (1 - slipPct / 100)), path: back.path.map(toAsset) })]));
        }
      }
      this._snbCC?.delete(kpub);
      if (fee >= 0.0000001) {
        try { await this.snbSignSubmit(row, await this.stxBuild(kpub, [Operation.payment({ destination: st.hotAddress, asset: Asset.native(), amount: f7(fee) })], feeUid)); }
        catch { this.sql.exec('INSERT INTO snb_owed (user_id,xlm) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET xlm=xlm+excluded.xlm', user.id, fee); }
      }
    } else if (r.venue.startsWith('SDEX')) {
      const ops = [];
      if (side === 'buy' && a.issuer && !before.trust) ops.push(Operation.changeTrust({ asset: new Asset(a.code, a.issuer) }));
      const path = r.path.map(toAsset);
      ops.push(Operation.pathPaymentStrictSend(side === 'buy'
        ? { sendAsset: Asset.native(), sendAmount: f7(amount - fee), destination: kpub, destAsset: new Asset(a.code, a.issuer), destMin: f7(min), path }
        : { sendAsset: new Asset(a.code, a.issuer), sendAmount: f7(amount), destination: kpub, destAsset: Asset.native(), destMin: f7(min), path }));
      if (fee >= 0.0000001) ops.push(Operation.payment({ destination: st.hotAddress, asset: Asset.native(), amount: f7(fee) }));
      hash = await this.snbSignSubmit(row, await this.stxBuild(kpub, ops, fee >= 0.0000001 ? feeUid : null));
    } else {
      if (side === 'buy' && a.issuer && !before.trust) await this.snbSignSubmit(row, await this.stxBuild(kpub, [Operation.changeTrust({ asset: new Asset(a.code, a.issuer) })]));
      const outMin = BigInt(Math.floor(min * 10 ** (side === 'buy' ? (a.decimals || 7) : 7)));
      const res = await st.invoke(await this.snbKp(row), ST_NETS[this.stNet()].router, 'swap_chained', [
        new Address(kpub).toScVal(), xdr.ScVal.fromXDR(r.chain, 'base64'), new Address(r.tokenIn).toScVal(),
        nativeToScVal(BigInt(r.inUnits), { type: 'u128' }), nativeToScVal(outMin, { type: 'u128' })]);
      hash = res.hash;
      this._snbCC?.delete(kpub);
      // Soroban calls cannot carry a second operation: the fee is collected right after in a plain payment
      if (fee >= 0.0000001) {
        try { await this.snbSignSubmit(row, await this.stxBuild(kpub, [Operation.payment({ destination: st.hotAddress, asset: Asset.native(), amount: f7(fee) })], feeUid)); }
        catch { this.sql.exec('INSERT INTO snb_owed (user_id,xlm) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET xlm=xlm+excluded.xlm', user.id, fee); }
      }
    }
    this._snbCC?.delete(kpub);
    await sleep(800);
    const after = await this.stxBal(kpub, a);
    const xlmAfter = (await this.snbChain(kpub)).xlm;
    const tokens = Math.abs(after.bal - before.bal);
    const xlm = side === 'buy' ? amount : Math.max(0, xlmAfter - xlmBefore);
    this.sql.exec('INSERT INTO snb_ext (user_id,aid,side,xlm,tokens,venue,hash,ts) VALUES (?,?,?,?,?,?,?,?)', user.id, a.id, side, xlm, tokens, r.venue, hash, now());
    if (fee >= 0.0000001) this.snbRefAccrue(user.id, BigInt(toWeiStr(fee)));
    this.sql.exec('INSERT INTO snb_log (user_id,market,side,quote,amount,fee,how,ts) VALUES (?,?,?,?,?,?,?,?)', user.id, 'x' + a.id, side, 'xlm', toWeiStr(xlm), toWeiStr(fee), 'route', now());
    // the fee payment reaches the hot wallet with the fees account memo: credit it right away
    this.ctx.waitUntil(this.wserial(() => this.stellarScan()).catch(() => {}));
    return { hash, venue: r.venue, tokens, xlm, fee, quoted: r.out };
  };
  const toWeiStr = (x) => (BigInt(Math.floor(Number(x) * 1e7)) * 100_000_000_000n).toString();

  // fees that could not ride along (Aquarius swaps) are swept from the wallet later
  P.stxSweepOwed = async function () {
    this.stxInit();
    const st = await this.stellar();
    for (const o of this.sql.exec('SELECT * FROM snb_owed WHERE xlm>=0.1').toArray()) {
      const row = this.sql.exec('SELECT * FROM snb_users WHERE user_id=? AND wsec IS NOT NULL', o.user_id).toArray()[0];
      if (!row) continue;
      try {
        const ch = await this.snbChain(row.wpub);
        const amt = Math.min(o.xlm, ch.avail);
        if (amt < 0.1) continue;
        await this.snbSignSubmit(row, await this.stxBuild(row.wpub, [Operation.payment({ destination: st.hotAddress, asset: Asset.native(), amount: f7(amt) })], this.stxFeeUid()));
        this.sql.exec('UPDATE snb_owed SET xlm=xlm-? WHERE user_id=?', amt, o.user_id);
      } catch { /* next round */ }
    }
  };

  // snipers that work for every launchpad: buy the moment a token gets liquidity, and new Aquarius pools
  P.stxWatchTick = async function () {
    this.stxInit();
    const rows = this.sql.exec(`SELECT * FROM snb_watch WHERE status='armed' ORDER BY id LIMIT 10`).toArray();
    for (const w of rows) {
      const a = this.stxGet(w.aid);
      const q = await this.stxQuote(a, 'buy', w.xlm).catch(() => null);
      if (!q) continue;
      const row = this.sql.exec('SELECT * FROM snb_users WHERE user_id=?', w.user_id).toArray()[0];
      const user = this.sql.exec('SELECT * FROM users WHERE id=?', w.user_id).toArray()[0];
      this.sql.exec(`UPDATE snb_watch SET status='firing' WHERE id=?`, w.id);
      try {
        const r = await this.stxTrade(row, user, a, 'buy', w.xlm, this.snbSettings(row).slip || 5);
        this.sql.exec(`UPDATE snb_watch SET status='done' WHERE id=?`, w.id);
        await this.tgS('sendMessage', { chat_id: row.chat_id, parse_mode: 'HTML', text: `🎯 <b>Sniped ${a.code}</b> the moment it became tradable\n${w.xlm} XLM → ${r.tokens.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${a.code} via ${r.venue}` });
        if (this.snbSettings(row).terminal) await this.snbOpenTerminal(row.chat_id, user.id, 'x' + a.id);
      } catch (e) {
        this.sql.exec(`UPDATE snb_watch SET status='failed' WHERE id=?`, w.id);
        await this.tgS('sendMessage', { chat_id: row.chat_id, parse_mode: 'HTML', text: `🎯 Snipe on ${a.code} failed: ${String(e.message).slice(0, 160)}` });
      }
    }
  };
  P.lumenNewLaunches = async function () {
    if (this.stNet() !== 'mainnet') return { skip: 'testnet' };
    this.stxInit();
    const subs = this.sql.exec('SELECT * FROM snb_users WHERE wsec IS NOT NULL').toArray().filter(r => { const s = this.snbSettings(r); return s.lumen?.on && s.lumen.amount > 0; });
    const st = await this.stellar();
    let n;
    try { n = Number(await st.view(LUMEN.curve, 'launch_count', [])); } catch { return { error: 'rpc' }; }
    const seen = Number(this.meta('lumen_seen') || 0);
    if (!seen) { this.setMeta('lumen_seen', String(n)); return { primed: n }; }
    if (n <= seen) return { n };
    this.setMeta('lumen_seen', String(n));
    for (let i = seen; i < n; i++) {
      let tok; try { tok = String(await st.view(LUMEN.curve, 'launch_by_index', [nativeToScVal(i, { type: 'u32' })])); } catch { continue; }
      const aid = this.stxAid({ code: 'NEW', contract: tok, decimals: 7 });
      const a = this.stxGet(aid);
      const L = await this.lumen(a).catch(() => null);
      if (!L) continue;
      this.sql.exec('UPDATE snb_assets SET code=?, name=? WHERE id=?', String(L.meta.symbol || 'NEW').slice(0, 12), String(L.meta.name || ''), aid);
      const a2 = this.stxGet(aid);
      for (const r of subs) {
        const s = this.snbSettings(r);
        if (String(L.meta.creator) === r.wpub) continue;
        const cnt = this.sql.exec(`SELECT COUNT(*) c FROM snb_ext WHERE user_id=? AND venue LIKE 'lumen-snipe%' AND ts>?`, r.user_id, now() - 864e5).one().c;
        if (cnt >= s.maxDay) continue;
        const user = this.sql.exec('SELECT * FROM users WHERE id=?', r.user_id).toArray()[0];
        try {
          const t = await this.stxTrade(r, user, a2, 'buy', s.lumen.amount, s.slip || 5);
          this.sql.exec(`UPDATE snb_ext SET venue='lumen-snipe · ' || venue WHERE hash=?`, t.hash);
          await this.tgS('sendMessage', { chat_id: r.chat_id, parse_mode: 'HTML', text: `🎯 <b>Sniped ${a2.code}</b> at launch on Lumen\n${s.lumen.amount} XLM → ${t.tokens.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${a2.code}` });
          if (s.terminal) await this.snbOpenTerminal(r.chat_id, user.id, 'x' + aid);
        } catch (e) { await this.tgS('sendMessage', { chat_id: r.chat_id, parse_mode: 'HTML', text: `🎯 Lumen snipe on ${a2.code} skipped: ${String(e.message).slice(0, 140)}` }); }
      }
    }
    return { n, new: n - seen };
  };
  P.stxNewPools = async function () {
    if (this.stNet() !== 'mainnet') return { skip: 'testnet' };
    this.stxInit();
    let j;
    try { j = await (await fetch(AQ_API + '/pools/?limit=20&sort=-created_at', { signal: AbortSignal.timeout(10000) })).json(); } catch { return { error: 'api' }; }
    const first = !this.meta('snb_pools_init');
    const fresh = [];
    for (const p of j.results || []) {
      if (this.sql.exec('SELECT 1 FROM snb_pools_seen WHERE address=?', p.address).toArray().length) continue;
      this.sql.exec('INSERT OR IGNORE INTO snb_pools_seen (address,ts) VALUES (?,?)', p.address, now());
      if (!first && (p.tokens_str || []).includes('native')) fresh.push(p);
    }
    if (first) { this.setMeta('snb_pools_init', '1'); return { primed: true }; }
    for (const p of fresh) {
      const other = p.tokens_str.find(t => t !== 'native');
      const mm = String(other || '').match(/^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/);
      if (!mm) continue;
      const aid = this.stxAid({ code: mm[1], issuer: mm[2] });
      const a = this.stxGet(aid);
      const info = await this.stxInfo(a).catch(() => ({ flags: {} }));
      if (info.flags?.auth_revocable || info.flags?.auth_clawback_enabled) continue;      // freeze/clawback risk: never auto-buy
      for (const r of this.sql.exec('SELECT * FROM snb_users WHERE wsec IS NOT NULL').toArray()) {
        const s = this.snbSettings(r);
        if (!s.pools?.on || !(s.pools.amount > 0)) continue;
        const n = this.sql.exec(`SELECT COUNT(*) c FROM snb_ext WHERE user_id=? AND venue LIKE 'pool-snipe%' AND ts>?`, r.user_id, now() - 864e5).one().c;
        if (n >= s.maxDay) continue;
        const user = this.sql.exec('SELECT * FROM users WHERE id=?', r.user_id).toArray()[0];
        try {
          const t = await this.stxTrade(r, user, a, 'buy', s.pools.amount, s.slip || 5);
          this.sql.exec(`UPDATE snb_ext SET venue='pool-snipe · ' || venue WHERE hash=?`, t.hash);
          await this.tgS('sendMessage', { chat_id: r.chat_id, parse_mode: 'HTML', text: `🎯 <b>New pool sniped: ${a.code}</b>\n${s.pools.amount} XLM → ${t.tokens.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${a.code} on Aquarius` });
          if (s.terminal) await this.snbOpenTerminal(r.chat_id, user.id, 'x' + a.id);
        } catch { /* skip */ }
      }
    }
    return { fresh: fresh.length };
  };
}
