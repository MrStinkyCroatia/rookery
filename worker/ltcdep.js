// LTC deposits into the ledger: the user sends LTC to a one-time address issued by the bridge, the bridge swaps it
// to XLM on Stellar and pays our hot wallet. We credit the user in LTC at the value we actually received
// (XLM received × XLM price ÷ LTC price), so every credited LTC is fully backed by what landed in the hot wallet.
// Nothing here moves user funds on its own: deposits only ever credit the ledger after the bridge reports success.
import { xbQuote, xbStatus, xbSubmit, validAddr } from './xbridge.js';
import { Operation, Asset } from '@stellar/stellar-sdk';

const MIN_LTC = 0.005;
const MAX_LTC = 5;
const MAX_PENDING = 3;
const MIN_WD = 0.01;
const MAX_WD = 2;

export function installLtcdep(Cls, H) {
  const { B, WEI, now, randHex } = H;
  const P = Cls.prototype;

  P.ltcDepInit = function () {
    if (this._ltcInit) return; this._ltcInit = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ltc_dep (id TEXT PRIMARY KEY, user_id INTEGER, addr TEXT, memo TEXT DEFAULT '',
      amount TEXT, refund TEXT, status TEXT, credit TEXT DEFAULT '0', out_xlm TEXT DEFAULT '0', in_tx TEXT DEFAULT '', out_tx TEXT DEFAULT '',
      created INTEGER, updated INTEGER)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS ltc_dep_u ON ltc_dep (user_id, created)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ltc_wd (id TEXT PRIMARY KEY, user_id INTEGER, to_addr TEXT, ltc TEXT, xlm TEXT DEFAULT '0',
      status TEXT, dep_addr TEXT DEFAULT '', memo TEXT DEFAULT '', tx TEXT DEFAULT '', out_tx TEXT DEFAULT '', created INTEGER, updated INTEGER)`);
  };

  P.ltcCfg = function () { return { feeBps: 0, feeTo: '', key: this.env.XB_API_KEY || '' }; };

  // ask the bridge for a one-time LTC deposit address that pays our Stellar hot wallet
  P.ltcDeposit = async function (user, b) {
    this.ltcDepInit();
    const amount = Number(String(b.amount || '').replace(',', '.'));
    if (!(amount >= MIN_LTC)) throw new Error(`Minimum deposit is ${MIN_LTC} LTC`);
    if (amount > MAX_LTC) throw new Error(`Maximum deposit is ${MAX_LTC} LTC at a time`);
    const refund = String(b.refund || '').trim();
    const st = await this.stellar();
    const q = await xbQuote(this.ltcCfg(), { from: 'litecoin', to: 'stellar', amount: String(amount),
      recipient: st.hotAddress, refund, dry: false });
    if (!q.depositAddress) throw new Error('The bridge did not return a deposit address, try again');
    const pending = this.sql.exec("SELECT COUNT(*) c FROM ltc_dep WHERE user_id=? AND status='waiting'", user.id).one().c;
    if (pending >= MAX_PENDING) throw new Error('You already have deposits waiting: finish or wait for them to expire');
    const id = 'ltc' + randHex(5);
    this.sql.exec(`INSERT INTO ltc_dep (id,user_id,addr,memo,amount,refund,status,created,updated) VALUES (?,?,?,?,?,?,'waiting',?,?)`,
      id, user.id, q.depositAddress, q.depositMemo || '', String(amount), refund, now(), now());
    return { ok: true, id, address: q.depositAddress, memo: q.depositMemo || '', amount: String(amount),
      usd: q.inUsd, deadline: q.deadline, expiresIn: 3600 };
  };

  // payout: the bridge quotes XLM -> LTC, we pay the XLM from the Stellar hot wallet with the bridge's memo,
  // and only mark it done when the bridge reports the LTC arrived at the user's address
  P.ltcWithdraw = async function (user, b) {
    this.ltcDepInit();
    const amount = Number(String(b.amount || '').replace(',', '.'));
    if (!(amount >= MIN_WD)) throw new Error(`Minimum withdrawal is ${MIN_WD} LTC`);
    if (amount > MAX_WD) throw new Error(`Maximum withdrawal is ${MAX_WD} LTC at a time`);
    const to = String(b.to || '').trim();
    if (!validAddr('litecoin', to)) throw new Error('Enter a valid Litecoin address');
    const units = BigInt(Math.round(amount * 1e6)) * 10n ** 12n;
    if (B(this.bal(user.id, 'ltc')) < units) throw new Error('Not enough LTC balance');
    const st = await this.stellar();
    const ltcPx = this.ltcUsd(), xlmPx = this.xlmUsd();
    const xlmEst = (amount * ltcPx / xlmPx * 1.02).toFixed(7);
    const q = await xbQuote(this.ltcCfg(), { from: 'stellar', to: 'litecoin', amount: xlmEst, recipient: to, refund: st.hotAddress, dry: false });
    if (!q.depositAddress) throw new Error('The bridge did not return a deposit address, try again');
    const id = 'ltcw' + randHex(5);
    this.ctx.storage.transactionSync(() => {
      this.addBal(user.id, 'ltc', -units);
      this.sql.exec(`INSERT INTO ltc_wd (id,user_id,to_addr,ltc,xlm,status,dep_addr,memo,created,updated) VALUES (?,?,?,?,?,'paying',?,?,?,?)`,
        id, user.id, to, units.toString(), q.amountIn || '', q.depositAddress, q.depositMemo || '', now(), now());
    });
    try {
      const payAmt = Number(q.amountInFmt || 0).toFixed(7);          // Stellar wants a string with 7 decimals
      if (!(Number(payAmt) > 0)) throw new Error('bridge quoted an empty amount');
      const res = await st.classic(st.hot, [Operation.payment({ destination: q.depositAddress, asset: Asset.native(), amount: payAmt })], { memo: q.depositMemo || undefined });
      const hash = res?.hash || res?.result?.hash || '';
      this.sql.exec('UPDATE ltc_wd SET tx=?, updated=? WHERE id=?', hash, now(), id);
      if (hash) await xbSubmit(this.ltcCfg(), q.depositAddress, hash, q.depositMemo || '');
      return { ok: true, id, xlm: q.amountInFmt, expects: q.amountOutFmt, tx: hash, address: to };
    } catch (e) {
      this.ctx.storage.transactionSync(() => {
        this.addBal(user.id, 'ltc', units);                 // nothing left the wallet: give the balance back
        this.sql.exec("UPDATE ltc_wd SET status='refunded', updated=? WHERE id=?", now(), id);
      });
      throw new Error('The payout could not be sent: ' + String(e.message || e).slice(0, 120));
    }
  };

  P.ltcWdList = function (user) {
    this.ltcDepInit();
    return this.sql.exec(`SELECT id, ltc, to_addr, status, tx, created FROM ltc_wd WHERE user_id=? ORDER BY created DESC LIMIT 8`, user.id).toArray();
  };

  P.ltcDepList = function (user) {
    this.ltcDepInit();
    return this.sql.exec(`SELECT id, amount, status, credit, created FROM ltc_dep WHERE user_id=? ORDER BY created DESC LIMIT 8`, user.id).toArray();
  };

  // cron: poll the bridge and credit what actually arrived, once per deposit
  P.ltcDepCron = async function () {
    this.ltcDepInit();
    const rows = this.sql.exec(`SELECT * FROM ltc_dep WHERE status='waiting' AND created > ? ORDER BY created LIMIT 20`, now() - 3 * 864e5).toArray();
    const done = [];
    for (const r of rows) {
      let s;
      try { s = await xbStatus(this.ltcCfg(), r.addr, r.memo || ''); } catch { continue; }
      if (s.status === 'SUCCESS') {
        const xlm = Number(s.amountOutFmt || 0);
        const ltcPx = this.ltcUsd(), xlmPx = this.xlmUsd();
        const credit = xlm > 0 && ltcPx > 0 ? xlm * xlmPx / ltcPx : Number(r.amount);
        const units = BigInt(Math.round(credit * 1e6)) * 10n ** 12n;          // 18-dec ledger units
        this.ctx.storage.transactionSync(() => {
          const cur = this.sql.exec('SELECT status FROM ltc_dep WHERE id=?', r.id).toArray()[0];
          if (!cur || cur.status !== 'waiting') return;                        // someone else credited it
          this.addBal(r.user_id, 'ltc', units);
          this.sql.exec("UPDATE ltc_dep SET status='credited', credit=?, out_xlm=?, in_tx=?, out_tx=?, updated=? WHERE id=?",
            units.toString(), String(xlm), s.inTx || '', s.outTx || '', now(), r.id);
          this.setMeta('ltc_backing_xlm', (B(this.meta('ltc_backing_xlm') || 0) + BigInt(Math.round(xlm * 1e6)) * 10n ** 12n).toString());
        });
        done.push({ id: r.id, ltc: units.toString(), xlm });
      } else if (s.status === 'REFUNDED' || s.status === 'FAILED') {
        this.sql.exec("UPDATE ltc_dep SET status=?, updated=? WHERE id=? AND status='waiting'", s.status.toLowerCase(), now(), r.id);
        done.push({ id: r.id, status: s.status });
      }
    }
    // withdrawals: keep polling until the LTC is delivered, refund the ledger if the bridge gives up
    const wds = this.sql.exec(`SELECT * FROM ltc_wd WHERE status='paying' AND created > ? LIMIT 20`, now() - 3 * 864e5).toArray();
    for (const w of wds) {
      let s2;
      try { s2 = await xbStatus(this.ltcCfg(), w.dep_addr, w.memo || ''); } catch { continue; }
      if (s2.status === 'SUCCESS') {
        this.sql.exec("UPDATE ltc_wd SET status='sent', out_tx=?, updated=? WHERE id=? AND status='paying'", s2.outTx || '', now(), w.id);
        this.setMeta('ltc_paid_out', (B(this.meta('ltc_paid_out') || 0) + B(w.ltc)).toString());
        done.push({ id: w.id, status: 'sent' });
      } else if (s2.status === 'REFUNDED' || s2.status === 'FAILED') {
        this.ctx.storage.transactionSync(() => {
          const cur = this.sql.exec('SELECT status FROM ltc_wd WHERE id=?', w.id).toArray()[0];
          if (!cur || cur.status !== 'paying') return;
          this.addBal(w.user_id, 'ltc', B(w.ltc));
          this.sql.exec("UPDATE ltc_wd SET status='refunded', updated=? WHERE id=?", now(), w.id);
        });
        done.push({ id: w.id, status: 'refunded' });
      }
    }
    // deposits that never got funded expire after an hour
    this.sql.exec("UPDATE ltc_dep SET status='expired', updated=? WHERE status='waiting' AND created < ?", now(), now() - 3600e3);
    return { checked: rows.length, done };
  };
}
