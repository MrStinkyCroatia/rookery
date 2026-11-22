// Zero mainnet migration, step 1: freeze one pre-market network and publish the 1:1 balance snapshot.
// Variant B (owner decision 2026-11-22): every curve moves to an on-chain RookeryCurve on Zero with exactly this
// state; holders stay custodial on Rookery and withdraw to their own Zero wallet (as the Docs promise).
// The snapshot is taken once the Zero RPC is verified live (chain id 33002 + LayerZero endpoint code + moving blocks).
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export function installZeroMig(Cls, H) {
  const { B, WEI, now } = H;
  const P = Cls.prototype;
  const LABEL = { zero: 'Zero', giwa: 'GIWA', litvm: 'LitVM' };

  P.netPaused = function (net) { return this.meta('net_paused_' + net) === '1'; };
  P.setNetPaused = function (net, on) { this.setMeta('net_paused_' + net, on ? '1' : '0'); };
  P.netPauseMsg = function (net) {
    return `${LABEL[net] || net} mainnet is live: trading is paused while every balance moves 1:1 on-chain. Your tokens are safe and stay in your account.`;
  };

  // pay out every pending holder reward first (in the quote asset), so nothing is lost when the curve moves
  P.migSettleAll = function (net) {
    let paid = 0;
    for (const m of this.sql.exec(`SELECT id FROM markets WHERE network=?`, net).toArray()) {
      for (const h of this.sql.exec(`SELECT user_id FROM balances WHERE asset=? AND amount!='0'`, 't:' + m.id).toArray()) {
        if (this.settle(h.user_id, this.market(m.id)) > 0n) paid++;
      }
    }
    return paid;
  };

  // one consistent point in time: everything below runs synchronously inside one storage transaction
  P.migBuild = function (net) {
    const supplyWei = 1_000_000_000n * WEI;
    const markets = [];
    const issues = [];
    let holderRows = 0, quoteReserve = 0n;
    for (const m of this.sql.exec(`SELECT * FROM markets WHERE network=? ORDER BY created`, net).toArray()) {
      const rows = this.sql.exec(`SELECT user_id, amount FROM balances WHERE asset=? AND amount!='0' ORDER BY user_id`, 't:' + m.id).toArray();
      const holders = rows.map(r => ({ u: 'u' + r.user_id, amount: B(r.amount).toString() })).filter(h => B(h.amount) > 0n);
      const held = holders.reduce((a, h) => a + B(h.amount), 0n);
      const sold = B(m.reserve_tok), burned = B(m.burned);
      const poolTok = B(m.pool_tok || 0);
      // tokens still owned by the curve/pool = supply - held by users - burned
      const curveLeft = supplyWei - held - burned;
      if (curveLeft < 0n) issues.push({ market: m.id, issue: 'holders + burned exceed supply' });
      // the curve's own accounting (sold minus burned) must equal what users hold
      const drift = sold - burned - held;
      if (!m.graduated && drift !== 0n && (drift > WEI || drift < -WEI)) issues.push({ market: m.id, issue: 'curve sold-burned differs from holder total', driftWei: drift.toString() });
      quoteReserve += B(m.graduated ? m.pool_zro : m.reserve_zro);
      holderRows += holders.length;
      markets.push({
        id: m.id, name: m.name, symbol: m.symbol, creator: 'u' + m.creator_id, quote: m.quote || 'ZRO',
        state: m.graduated ? 'bonded' : 'curve',
        curve: { virtualQuote: B(m.quote === 'ETH' ? (m.v_wei || 0) : (m.v_zro || 0)).toString(), virtualTokens: B(m.v_tok).toString(),
          quoteReserve: B(m.reserve_zro).toString(), tokensSold: sold.toString(), curveTokens: B(m.curve_tokens || 0).toString() },
        pool: m.graduated ? { quote: B(m.pool_zro).toString(), tokens: poolTok.toString() } : null,
        taxesBps: { marketing: m.tax_mkt || 0, burn: m.tax_burn || 0, rewards: m.tax_rew || 0 },
        supply: supplyWei.toString(), burned: burned.toString(), heldByUsers: held.toString(), curveLeft: curveLeft.toString(),
        lastPrice: B(m.last_price || 0).toString(), holders,
      });
    }
    return { markets, issues, holderRows, quoteReserve };
  };

  P.migSnapshot = async function (net = 'zero', { reason = 'manual', pause = true, force = false, rehearsal = false } = {}) {
    const prev = this.meta('mig_snapshot_' + net);
    if (rehearsal) pause = false;                // a rehearsal never freezes trading and never becomes the official file
    if (prev && !force && !rehearsal) return { ok: true, already: JSON.parse(prev) };
    let built, paid = 0;
    const ts = now();
    this.ctx.storage.transactionSync(() => {
      if (pause) this.setNetPaused(net, true);   // freeze first: no trade can land between settle and the dump
      paid = this.migSettleAll(net);
      built = this.migBuild(net);
    });
    const doc = {
      v: 1, network: net, chain: net === 'zero' ? { name: 'Zero by LayerZero', chainId: 33002 } : { name: net },
      takenAt: new Date(ts).toISOString(), reason, rule: 'every holder receives exactly this balance 1:1; burned tokens stay burned',
      units: 'all amounts in wei (18 decimals)', rewardsSettledBeforeSnapshot: paid,
      totals: { markets: built.markets.length, holderRows: built.holderRows, quoteReserveWei: built.quoteReserve.toString() },
      issues: built.issues, markets: built.markets,
    };
    const body = JSON.stringify(doc);
    const sha256 = hex(await crypto.subtle.digest('SHA-256', enc.encode(body)));
    const key = `rookery/migration/${rehearsal ? 'rehearsal-' : ''}${net}-snapshot-${new Date(ts).toISOString().replace(/[:.]/g, '-')}.json`;
    if (this.env.BACKUPS) await this.env.BACKUPS.put(key, body, { httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256 } });
    const metaRow = { key, sha256, ts, reason, markets: doc.totals.markets, holderRows: doc.totals.holderRows, quoteReserveWei: doc.totals.quoteReserveWei, issues: built.issues.length, paused: pause, bytes: body.length };
    if (rehearsal) this.setMeta('mig_snapshot_' + net + '_rehearsal', JSON.stringify(metaRow));
    else this.setMeta('mig_snapshot_' + net, JSON.stringify(metaRow));
    return { ok: true, ...metaRow, sample: built.markets.slice(0, 1).map(m => ({ ...m, holders: m.holders.slice(0, 3) })) };
  };

  P.migSnapshotDoc = async function (net = 'zero') {
    const meta = JSON.parse(this.meta('mig_snapshot_' + net) || 'null');
    if (!meta || !this.env.BACKUPS) return null;
    const obj = await this.env.BACKUPS.get(meta.key);
    return obj ? { meta, body: await obj.text() } : null;
  };

  // a user's own rows, to check against the published file
  P.migMine = async function (net, userId) {
    const d = await this.migSnapshotDoc(net);
    if (!d) return { taken: false };
    const doc = JSON.parse(d.body), me = 'u' + userId;
    const rows = [];
    for (const m of doc.markets) for (const h of m.holders) if (h.u === me) rows.push({ market: m.id, symbol: m.symbol, amount: h.amount });
    return { taken: true, you: me, sha256: d.meta.sha256, takenAt: doc.takenAt, rows };
  };

  // called by the Zero watcher when an RPC passes the identity check; needs two consecutive confirmations
  P.migOnZeroRpc = async function (url, block, st) {
    if (this.meta('mig_auto_zero') === '0') return null;
    if (this.meta('mig_snapshot_zero')) return null;
    st.migConfirm = (st.migConfirm || 0) + 1;
    if (st.migConfirm < 2) return { waiting: st.migConfirm };
    const r = await this.migSnapshot('zero', { reason: `Zero RPC verified live: ${url} block ${block}`, pause: true });
    const chat = this.meta('tg_owner_chat');
    if (chat && this.env.TG_BOT_TOKEN) {
      await this.tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `🧊 <b>Zero trading paused · 1:1 snapshot taken</b>\nRPC ${url} verified (block ${block}).\n${r.markets} markets · ${r.holderRows} holder rows · ${(Number(B(r.quoteReserveWei)) / 1e18).toFixed(2)} ZRO in reserves\nsha256 <code>${r.sha256}</code>${r.issues ? `\n⚠️ ${r.issues} issue(s) flagged, check /admin/migration` : ''}` }).catch(() => null);
    }
    return r;
  };
}
