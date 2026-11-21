// LTC deposits into the ledger: the user sends LTC to a one-time address issued by the bridge, the bridge swaps it
// to XLM on Stellar and pays our hot wallet. We credit the user in LTC at the value we actually received
// (XLM received × XLM price ÷ LTC price), so every credited LTC is fully backed by what landed in the hot wallet.
// Nothing here moves user funds on its own: deposits only ever credit the ledger after the bridge reports success.
import { xbQuote, xbStatus } from './xbridge.js';

const MIN_LTC = 0.005;
const MAX_LTC = 5;
const MAX_PENDING = 3;

export function installLtcdep(Cls, H) {
  const { B, WEI, now, randHex } = H;
  const P = Cls.prototype;

  P.ltcDepInit = function () {
    if (this._ltcInit) return; this._ltcInit = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ltc_dep (id TEXT PRIMARY KEY, user_id INTEGER, addr TEXT, memo TEXT DEFAULT '',
      amount TEXT, refund TEXT, status TEXT, credit TEXT DEFAULT '0', out_xlm TEXT DEFAULT '0', in_tx TEXT DEFAULT '', out_tx TEXT DEFAULT '',
      created INTEGER, updated INTEGER)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS ltc_dep_u ON ltc_dep (user_id, created)');
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
    // deposits that never got funded expire after an hour
    this.sql.exec("UPDATE ltc_dep SET status='expired', updated=? WHERE status='waiting' AND created < ?", now(), now() - 3600e3);
    return { checked: rows.length, done };
  };
}
