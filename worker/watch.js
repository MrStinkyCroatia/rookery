// Chain watchdog: probes the RPC endpoints of the chains we care about and pings Telegram when one comes alive
// (or dies). Built for the Zero launch: nobody knows the RPC until LayerZero publishes it, so the target list is
// editable from the admin API without a deploy. A probe asks for the chain id, then for the block number twice a
// few seconds apart: a chain is "live" only when it answers both and the block actually advanced.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function installWatch(Cls, H) {
  const { now } = H;
  const P = Cls.prototype;

  P.watchInit = function () {
    if (this._watchInit) return; this._watchInit = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chain_watch (name TEXT, url TEXT, status TEXT DEFAULT 'unknown', chain_id TEXT DEFAULT '',
      block TEXT DEFAULT '', latency INTEGER DEFAULT 0, last_ok INTEGER DEFAULT 0, last_err TEXT DEFAULT '', updated INTEGER,
      PRIMARY KEY (name, url))`);
    // targets: [{ name, chainId (optional), urls: [], alertDown: bool }]
    if (!this.meta('watch_targets')) {
      this.setMeta('watch_targets', JSON.stringify([
        { name: 'Zero', chainId: null, urls: [], alertDown: true, note: 'waiting for LayerZero to publish an RPC' },
        { name: 'Robinhood Chain', chainId: 4663, alertDown: true,
          urls: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com', 'https://4663.rpc.thirdweb.com'] },
        { name: 'LitVM testnet', chainId: 4441, alertDown: false, urls: ['https://rpc.testnet.liteforge.zeeve.net/'] },
      ]));
    }
  };

  P.watchTargets = function () { try { return JSON.parse(this.meta('watch_targets') || '[]'); } catch { return []; } };
  P.watchRows = function () { this.watchInit(); return this.sql.exec('SELECT * FROM chain_watch ORDER BY name, url').toArray(); };

  const rpcOnce = async (url, method, params) => {
    const t0 = Date.now();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    const ms = Date.now() - t0;
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status, ms });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw Object.assign(new Error(String(j.error.message || 'rpc error').slice(0, 80)), { ms });
    return { result: j.result, ms };
  };

  // one probe: chain id + two block heights, so "answers" never passes for "produces blocks"
  const httpOnce = async (url) => {
    const t0 = Date.now();
    const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'rookery-watch/1.0' }, signal: AbortSignal.timeout(9000) });
    const body = await r.text().catch(() => '');
    return { status: r.status, ms: Date.now() - t0, body };
  };

  P.watchProbe = async function (target, url) {
    const out = { name: target.name, url, ok: false, status: 'down', chainId: '', block: '', latency: 0, err: '' };
    if (target.kind === 'http') {
      try {
        const h = await httpOnce(url);
        out.latency = h.ms; out.block = 'HTTP ' + h.status;
        if (h.status >= 400) throw new Error('HTTP ' + h.status);
        if (target.contains && !h.body.toLowerCase().includes(String(target.contains).toLowerCase())) throw new Error('page up, marker missing');
        out.ok = true; out.status = 'live';
      } catch (e) { out.err = String(e.message || e).slice(0, 120); out.status = /429/.test(out.err) ? 'rate-limited' : 'down'; }
      return out;
    }
    try {
      const id = await rpcOnce(url, 'eth_chainId', []);
      out.chainId = String(Number(BigInt(id.result)));
      out.latency = id.ms;
      if (target.chainId && Number(out.chainId) !== Number(target.chainId)) throw new Error('wrong chain id ' + out.chainId);
      const b1 = await rpcOnce(url, 'eth_blockNumber', []);
      const h1 = BigInt(b1.result);
      await sleep(2500);
      const b2 = await rpcOnce(url, 'eth_blockNumber', []);
      const h2 = BigInt(b2.result);
      out.block = h2.toString();
      if (h1 === 0n && h2 === 0n) throw new Error('no blocks yet');
      if (h2 < h1) throw new Error('block went backwards');
      // blocks must move (or the head must be non-zero on a chain that just started)
      out.ok = h2 > 0n;
      out.status = out.ok ? 'live' : 'down';
      if (h2 === h1) out.status = 'live-stalled';
    } catch (e) {
      out.err = String(e.message || e).slice(0, 120);
      if (e.status === 429) out.status = 'rate-limited';
    }
    return out;
  };

  // probe every configured endpoint, record state, alert on transitions
  P.watchRun = async function (opts = {}) {
    this.watchInit();
    const targets = this.watchTargets();
    const prev = new Map(this.watchRows().map(r => [r.name + '|' + r.url, r]));
    const results = [];
    for (const t of targets) {
      for (const url of (t.urls || [])) {
        const r = await this.watchProbe(t, url);
        results.push(r);
        const key = t.name + '|' + url;
        const before = prev.get(key);
        this.sql.exec(`INSERT INTO chain_watch (name,url,status,chain_id,block,latency,last_ok,last_err,updated) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(name,url) DO UPDATE SET status=excluded.status, chain_id=excluded.chain_id, block=excluded.block,
          latency=excluded.latency, last_ok=excluded.last_ok, last_err=excluded.last_err, updated=excluded.updated`,
          t.name, url, r.status, r.chainId, r.block, r.latency, r.ok ? now() : (before?.last_ok || 0), r.err, now());
        const was = before?.status || 'unknown';
        const becameLive = r.ok && was !== 'live' && was !== 'live-stalled';
        const died = !r.ok && (was === 'live' || was === 'live-stalled');
        const wants = t.alert !== false;
        if (wants && becameLive) await this.watchAlert(t, r, 'live');
        else if (wants && died && t.alertDown !== false) await this.watchAlert(t, r, 'down');
      }
    }
    return results;
  };

  P.watchAlert = async function (target, r, kind) {
    const chat = this.meta('tg_owner_chat') || this.meta('watch_chat');
    const line = kind === 'live'
      ? (target.kind === 'http'
        ? `🟢 <b>${target.name} is up</b>\n${r.url}\n${r.block} · ${r.latency} ms`
        : `🟢 <b>${target.name} RPC is live</b>\n<code>${r.url}</code>\nchain id ${r.chainId} · block ${r.block} · ${r.latency} ms`)
      : `🔴 <b>${target.name} RPC down</b>\n<code>${r.url}</code>\n${r.err || r.status}`;
    const log = JSON.parse(this.meta('watch_log') || '[]');
    log.push({ ts: now(), kind, name: target.name, url: r.url, block: r.block, err: r.err || '' });
    this.setMeta('watch_log', JSON.stringify(log.slice(-40)));
    if (chat && this.env.TG_BOT_TOKEN) await this.tg('sendMessage', { chat_id: chat, text: line, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => null);
    return { kind, sent: !!chat };
  };
}
