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
    await this.zwArm?.().catch(() => {});
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

  // ───────────── Zero (LayerZero L1, EID / chain id 33002) fast watcher ─────────────
  // Signals, all verified against the 21 Nov one-hour window (9 ETH transfers, DELIVERED on "zerointerop"):
  //  · bridge open  : ZRO OFT quoteSend(dstEid 33002) succeeds; while closed it reverts Executor_EidNotSupported
  //  · transfers    : OFTSent logs on the ZRO OFT whose dstEid word == 33002
  //  · delivered    : LayerZero Scan API status for the source tx == DELIVERED
  //  · rpc live     : chain id 33002 + LayerZero endpoint code present + blocks advancing (filters impostor "zero" chains)
  //  · official rpc : LayerZero metadata lists an rpc for chainKey "zerointerop"
  const ZW = {
    eid: 33002, tick: 2000,
    zro: '0x6985884C4392D348587B19cb9eAAf157F13271cd',
    zeroZro: '0x1ced7d571059a30db0fc9adc40346d2a1ce55b31',
    zeroEndpoint: '0xc8cb2dfb4e970e66cc1566703cdcd25a3e7cb9c0',
    oftSent: '0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a',
    quote: '0x3b6f743b0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080ea0000000000000000000000002fc334db3b68995ca29ba752d47b4d88c025990d0000000000000000000000000000000000000000000000000de0b6b3a7640000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    peers: '0xbb0b6a5300000000000000000000000000000000000000000000000000000000000080ea',
    chains: {
      eth: { name: 'Ethereum', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'], tx: 'https://etherscan.io/tx/', quote: true, maxRange: 50 },
      arb: { name: 'Arbitrum', rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.llamarpc.com', 'https://arbitrum.drpc.org'], tx: 'https://arbiscan.io/tx/', quote: true, maxRange: 90 },
      base: { name: 'Base', rpcs: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'], tx: 'https://basescan.org/tx/', quote: true, maxRange: 90 },
      bsc: { name: 'BNB Chain', rpcs: ['https://bsc-dataseed.bnbchain.org', 'https://bsc.drpc.org', 'https://bsc-rpc.publicnode.com'], tx: 'https://bscscan.com/tx/', quote: false, maxRange: 90 },
    },
    // LayerZero's testnet explorer lives at explorer.testnet.zero.layerzero.network; explorer.zero.network is Zerion's
    // sunset "ZERϴ" chain and must never be treated as Zero
    explorerCandidates: ['https://explorer.zero.layerzero.network', 'https://zero-explorer.layerzero.network', 'https://scan.zero.layerzero.network'],
    explorerDeny: /(^|\.)zero\.network$/i,
    rpcCandidates: ['https://mainnet.zero.layerzero.network', 'https://rpc.zero.layerzero.network', 'https://zero.layerzero.network', 'https://rpc.zerointerop.layerzero.network'],
  };
  P.ZW = ZW;

  const zwRpc = async (urls, method, params, i0 = 0) => {
    let last;
    for (let k = 0; k < urls.length; k++) {
      const url = urls[(i0 + k) % urls.length];
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(6000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.error) { const e = new Error(String(j.error.message || 'rpc error')); e.rpc = j.error; e.reverted = /revert/i.test(e.message) || j.error.code === 3; throw e; }
        return j.result;
      } catch (e) { last = e; if (e.reverted) throw e; }
    }
    throw last || new Error('no rpc');
  };

  P.zwState = function () { try { return JSON.parse(this.meta('zw') || '{}'); } catch { return {}; } };
  P.zwSave = function (st) { this.setMeta('zw', JSON.stringify(st)); };

  P.zwSay = async function (text, st, opts = {}) {
    const chat = this.meta('tg_owner_chat') || this.meta('watch_chat');
    if (!opts.heartbeat) st.log = (st.log || []).concat([{ ts: now(), text: text.replace(/<[^>]+>/g, '').slice(0, 200) }]).slice(-50);
    if (this.env.ZW_BOT_TOKEN) {
      this.zbInit();
      const where = opts.heartbeat ? 'active=1 AND COALESCE(hb,1)=1' : 'active=1';
      const n = this.sql.exec(`SELECT COUNT(*) c FROM zw_subs WHERE ${where}`).one().c;
      if (n) {
        this.sql.exec(`INSERT INTO zw_outbox (chat_id,text,tries,created) SELECT chat_id, ?, 0, ? FROM zw_subs WHERE ${where}`, text, now());
        await this.zbDrain().catch(() => {});
        return true;
      }
      if (opts.heartbeat) return false;
    }
    if (opts.heartbeat) return false;
    if (chat && this.env.TG_BOT_TOKEN) {
      const r = await this.tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => null);
      return !!(r && r.ok);
    }
    return false;
  };

  // is the bridge route open on this source chain? 'open' | 'closed' | 'unknown' (rpc trouble never flips state)
  P.zwQuote = async function (key, i0 = 0) {
    const c = ZW.chains[key];
    try { await zwRpc(c.rpcs, 'eth_call', [{ to: ZW.zro, data: ZW.quote }, 'latest'], i0); return { state: 'open' }; }
    catch (e) {
      if (e.reverted) {
        const data = String(e.rpc?.data || '');
        return { state: 'closed', why: /c3baa0b7/i.test(data) || /EidNotSupported/i.test(e.message) ? 'Executor_EidNotSupported' : e.message.slice(0, 80) };
      }
      return { state: 'unknown', why: String(e.message || e).slice(0, 80) };
    }
  };

  // new OFTSent → 33002 since the stored cursor on one chain
  P.zwLogs = async function (key, st, range) {
    const c = ZW.chains[key];
    st.cur = st.cur || {};
    const head = parseInt(await zwRpc(c.rpcs, 'eth_blockNumber', []), 16);
    let from = range ? range.from : (st.cur[key] ? st.cur[key] + 1 : head - 2);
    const to = range ? range.to : head;
    if (!range && to - from > c.maxRange) { st.gaps = (st.gaps || 0) + 1; from = to - c.maxRange; }
    const found = [];
    const step = range?.step || c.maxRange;
    for (let a = from; a <= to; a += step) {
      const b = Math.min(to, a + step - 1);
      const logs = await zwRpc(range?.rpcs || c.rpcs, 'eth_getLogs', [{ address: ZW.zro, topics: [ZW.oftSent], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]);
      for (const l of logs || []) {
        if (parseInt(l.data.slice(2, 66), 16) !== ZW.eid) continue;
        found.push({ chain: key, tx: l.transactionHash, block: parseInt(l.blockNumber, 16), from: '0x' + l.topics[2].slice(26),
          amount: Number(BigInt('0x' + l.data.slice(66, 130))) / 1e18 });
      }
    }
    if (!range) st.cur[key] = to;
    return found;
  };

  P.zwScan = async function (tx) {
    try {
      const r = await fetch('https://scan.layerzero-api.com/v1/messages/tx/' + tx, { signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; rookery-watch/1.0)', accept: 'application/json', origin: 'https://layerzeroscan.com', referer: 'https://layerzeroscan.com/' } });
      if (!r.ok) return { status: 'unknown', http: r.status };
      const j = await r.json();
      const m = (j.data || []).find(x => x.pathway?.dstEid === ZW.eid) || (j.data || [])[0];
      if (!m) return { status: 'NOT_INDEXED' };
      return { status: m.status?.name || 'unknown', dstTx: m.destination?.tx?.txHash || '', dstStatus: m.destination?.status || '' };
    } catch (e) { return { status: 'unknown', err: String(e.message || e).slice(0, 60) }; }
  };

  // a candidate counts only if it really is LayerZero's Zero: chain id 33002 + LZ endpoint code + moving blocks
  P.zwRpcCheck = async function (url, st) {
    try {
      const id = parseInt(await zwRpc([url], 'eth_chainId', []), 16);
      if (id !== ZW.eid) return { url, live: false, why: 'chain id ' + id };
      const code = await zwRpc([url], 'eth_getCode', [ZW.zeroEndpoint, 'latest']);
      if (!code || code === '0x') return { url, live: false, why: 'no LayerZero endpoint code' };
      const block = parseInt(await zwRpc([url], 'eth_blockNumber', []), 16);
      const prev = st.rpcBlock?.[url] || 0;
      st.rpcBlock = { ...(st.rpcBlock || {}), [url]: block };
      if (block <= prev && prev) return { url, live: false, why: 'blocks stalled at ' + block, block };
      let supply = 0;
      try { supply = Number(BigInt(await zwRpc([url], 'eth_call', [{ to: ZW.zeroZro, data: '0x18160ddd' }, 'latest']))) / 1e18; } catch { /* optional */ }
      return { url, live: block > 0, block, supply };
    } catch (e) { return { url, live: false, why: String(e.message || e).slice(0, 60) }; }
  };

  P.zwMeta = async function () {
    const r = await fetch('https://metadata.layerzero-api.com/v1/metadata', { signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; rookery-watch/1.0)', accept: 'application/json', origin: 'https://layerzeroscan.com', referer: 'https://layerzeroscan.com/' } });
    if (!r.ok) throw new Error('metadata HTTP ' + r.status);
    const j = await r.json();
    const z = j.zerointerop || {};
    return { rpcs: (z.rpcs || []).map(x => x.url).filter(Boolean), status: z.chainDetails?.chainStatus || '', explorers: (z.blockExplorers || []).map(x => x.url) };
  };

  const short = (h) => h.slice(0, 10) + '…' + h.slice(-6);
  const LZH = { 'user-agent': 'Mozilla/5.0 (compatible; rookery-watch/1.0)', accept: 'application/json', origin: 'https://layerzeroscan.com', referer: 'https://layerzeroscan.com/' };
  const seenAdd = (st, key, list = 'seenTx', cap = 400) => { st[list] = (st[list] || []); if (st[list].includes(key)) return false; st[list].push(key); if (st[list].length > cap) st[list] = st[list].slice(-cap); return true; };

  // every LayerZero message on all 110+ chains (~8/min) — keep the ones whose pathway touches Zero
  P.zwFeed = async function (st, limit = 100, eid = ZW.eid) {
    const r = await fetch('https://scan.layerzero-api.com/v1/messages/latest?limit=' + limit, { headers: LZH, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('scan feed HTTP ' + r.status);
    const j = await r.json();
    const hits = [];
    for (const m of j.data || []) {
      const pw = m.pathway || {};
      if (pw.srcEid !== eid && pw.dstEid !== eid) continue;
      const g = String(m.guid || m.source?.tx?.txHash || '').slice(0, 18);
      if (!seenAdd(st, g, 'seenGuid', 300)) continue;
      hits.push({ dir: pw.srcEid === eid ? 'from' : 'to', other: pw.srcEid === eid ? (pw.receiver?.chain || pw.dstEid) : (pw.sender?.chain || pw.srcEid),
        app: [pw.sender?.name, pw.receiver?.name, pw.sender?.id].find(x => x && x !== 'unknown') || (pw.sender?.address ? 'app ' + pw.sender.address.slice(0, 8) + '…' + pw.sender.address.slice(-4) : 'unknown app'), status: m.status?.name || '', tx: m.source?.tx?.txHash || '', created: m.created });
    }
    return hits;
  };

  // every block since the last pass, in one JSON-RPC batch: no block is skipped even at 500 ms block time
  P.zwBlocks = async function (url, st, cap = 60) {
    const head = parseInt(await zwRpc([url], 'eth_blockNumber', []), 16);
    const a = st.blk || (st.blk = { last: head - 1 });
    let from = a.last + 1;
    if (head - from + 1 > cap) { a.skipped = (a.skipped || 0) + (head - cap + 1 - from); from = head - cap + 1; }
    if (from > head) return { head, blocks: 0, txs: [] };
    const batch = [];
    for (let n = from; n <= head; n++) batch.push({ jsonrpc: '2.0', id: n, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), true] });
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('batch HTTP ' + r.status);
    const res = await r.json();
    const txs = [];
    let seen = 0;
    for (const x of Array.isArray(res) ? res : []) {
      const b = x.result; if (!b) continue;
      seen++;
      for (const t of b.transactions || []) txs.push({ hash: t.hash, from: t.from, to: t.to, value: Number(BigInt(t.value || '0x0')) / 1e18, block: parseInt(b.number, 16), create: !t.to });
    }
    if (!seen) throw new Error('rpc refused batch');
    a.last = head;
    return { head, blocks: seen, txs };
  };

  // explorer: online? which API? does it leak an RPC endpoint? (polite: one page + one API call per pass)
  P.zwExplorer = async function (base, st) {
    const out = { base, up: false, kind: '', why: '' };
    try {
      if (ZW.explorerDeny.test(new URL(base).hostname)) return { ...out, why: 'denied (not LayerZero Zero)' };
      const r = await fetch(base, { headers: { 'user-agent': 'rookery-watch/1.0 (+https://rookery.stinkypenguin.xyz)' }, redirect: 'follow', signal: AbortSignal.timeout(9000) });
      if (r.status === 429 || r.status === 403) return { ...out, why: 'HTTP ' + r.status + ' (explorer refuses automated access)', blocked: true };
      if (!r.ok) return { ...out, why: 'HTTP ' + r.status };
      const html = (await r.text()).slice(0, 400000);
      out.up = true;
      // RPC endpoints printed on the page ("RPC Endpoint" buttons, add-network configs)
      out.rpcs = [...new Set((html.match(/https:\/\/[a-z0-9.\-]+(?:\/[a-z0-9_\-\/]*)?/gi) || [])
        .filter(u => /rpc/i.test(u) && !ZW.explorerDeny.test(new URL(u).hostname) && !/\.(js|css|svg|png)$/i.test(u)))].slice(0, 6);
      // Blockscout v2 API → total tx counter + latest transactions
      const s2 = await fetch(base.replace(/\/$/, '') + '/api/v2/stats', { headers: { accept: 'application/json', 'user-agent': 'rookery-watch/1.0' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (s2?.ok && /json/.test(s2.headers.get('content-type') || '')) {
        const j = await s2.json().catch(() => null);
        if (j && (j.total_transactions !== undefined || j.total_blocks !== undefined)) {
          out.kind = 'blockscout'; out.totalTx = Number(j.total_transactions || 0); out.totalBlocks = Number(j.total_blocks || 0);
        }
      }
    } catch (e) { out.why = String(e.message || e).slice(0, 60); }
    return out;
  };

  P.zwExplorerTxs = async function (base) {
    const r = await fetch(base.replace(/\/$/, '') + '/api/v2/transactions', { headers: { accept: 'application/json', 'user-agent': 'rookery-watch/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('explorer txs HTTP ' + r.status);
    const j = await r.json().catch(() => ({}));
    return (j.items || []).slice(0, 50).map(t => ({ hash: t.hash, from: t.from?.hash, to: t.to?.hash, value: Number(t.value || 0) / 1e18, block: t.block_number ?? t.block, create: !t.to }));
  };

  // what is happening inside Zero itself, read from any verified live RPC
  P.zwActivity = async function (url, st) {
    const b = await zwRpc([url], 'eth_getBlockByNumber', ['latest', false]);
    if (!b) return null;
    const num = parseInt(b.number, 16), txs = (b.transactions || []).length;
    const a = st.act || (st.act = { since: now(), fromBlock: num, samples: 0, txSum: 0, maxTx: 0 });
    a.head = num; a.samples++; a.txSum += txs; a.maxTx = Math.max(a.maxTx, txs); a.rpc = url;
    return { num, txs, a };
  };

  P.zwTick = async function (opts = {}) {
    if (this._zwBusy && !opts.force) return { busy: true };
    this._zwBusy = true;
    const st = this.zwState();
    const t = now();
    const n = (st.n = (st.n || 0) + 1);
    const out = { n };
    try {
      // 1 · bridge route: Ethereum every tick, the others every 2nd tick
      st.bridge = st.bridge || {};
      const qkeys = Object.keys(ZW.chains).filter(k => ZW.chains[k].quote && (k === 'eth' || n % 2 === 0 || opts.force));
      const qs = await Promise.all(qkeys.map(k => this.zwQuote(k, n).then(q => [k, q])));
      for (const [k, q] of qs) {
        const was = st.bridge[k]?.state || 'unknown';
        if (q.state === 'unknown') { st.bridge[k] = { ...(st.bridge[k] || {}), lastErr: q.why, checked: t }; continue; }
        st.bridge[k] = { state: q.state, why: q.why || '', checked: t, since: was === q.state ? (st.bridge[k]?.since || t) : t };
        if (q.state === 'open' && was !== 'open') await this.zwSay(`🟢 <b>ZRO → Zero bridge is OPEN</b> on ${ZW.chains[k].name}\nquoteSend to EID 33002 now succeeds.\nOfficial: staking.layerzero.network`, st);
        if (q.state === 'closed' && was === 'open') await this.zwSay(`🔴 <b>ZRO → Zero bridge CLOSED</b> on ${ZW.chains[k].name}\n${q.why || ''}`, st);
      }
      out.bridge = Object.fromEntries(Object.entries(st.bridge).map(([k, v]) => [k, v.state]));

      // 2 · transfers to Zero (every 2nd tick ≈ 6 s)
      if (n % 3 === 0 || opts.force) {
        const fresh = [];
        st.logErr = {};
        const got = await Promise.all(Object.keys(ZW.chains).map(k => this.zwLogs(k, st).catch(e => { st.logErr[k] = String(e.message || e).slice(0, 60); return []; })));
        for (const g of got) fresh.push(...g.filter(f => seenAdd(st, f.tx.slice(0, 18))));
        if (fresh.length) {
          st.transfers = (st.transfers || 0) + fresh.length;
          st.pending = (st.pending || []).concat(fresh.map(f => ({ ...f, seen: t }))).slice(-200);
          const sum = fresh.reduce((a, f) => a + f.amount, 0);
          const lines = fresh.slice(0, 4).map(f => `• ${f.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO · ${ZW.chains[f.chain].name} · <a href="${ZW.chains[f.chain].tx}${f.tx}">${short(f.tx)}</a>`).join('\n');
          const first = !st.firstTransfer;
          if (first) st.firstTransfer = t;
          await this.zwSay(`${first ? '🚀 <b>FIRST ZRO transfers to Zero detected</b>' : '📦 <b>ZRO → Zero transfers</b>'}\n${fresh.length} tx · ${sum.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO\n${lines}${fresh.length > 4 ? `\n+${fresh.length - 4} more` : ''}`, st);
        }
        out.newTransfers = fresh.length;
      }

      // 2b · global LayerZero feed: any app, any chain, to or from Zero
      if (n % 3 === 1 || opts.force) {
        try {
          const hits = await this.zwFeed(st);
          st.hb = st.hb || {}; st.hb.feed = (st.hb.feed || 0) + 1;
          const fresh = hits.filter(h => !h.tx || seenAdd(st, h.tx.slice(0, 18)));
          for (const h of fresh) if (h.dir === 'to' && h.tx) st.pending = (st.pending || []).concat([{ chain: 'lz', tx: h.tx, amount: 0, seen: t, app: h.app }]).slice(-200);
          const from = fresh.filter(h => h.dir === 'from'), to = fresh.filter(h => h.dir === 'to');
          st.feedFrom = (st.feedFrom || 0) + from.length; st.feedTo = (st.feedTo || 0) + to.length;
          const fmt = (h) => `• ${h.dir === 'from' ? 'Zero → ' + h.other : h.other + ' → Zero'} · ${h.app} · ${h.status}${h.tx ? ` · <a href="https://layerzeroscan.com/tx/${h.tx}">${short(h.tx)}</a>` : ''}`;
          if (from.length) {
            const first = !st.firstFromZero; if (first) st.firstFromZero = t;
            await this.zwSay(`${first ? '🚨 <b>FIRST message sent FROM Zero</b>\nThe chain is executing transactions.' : '📡 <b>Messages from Zero</b>'}\n${from.slice(0, 5).map(fmt).join('\n')}${from.length > 5 ? `\n+${from.length - 5} more` : ''}`, st);
          }
          if (to.length) await this.zwSay(`➡️ <b>LayerZero → Zero</b> (${to.length})\n${to.slice(0, 5).map(fmt).join('\n')}${to.length > 5 ? `\n+${to.length - 5} more` : ''}`, st);
          st.feedErr = '';
          out.feed = fresh.length;
        } catch (e) { st.feedErr = String(e.message || e).slice(0, 60); }
      }

      // 2c · inside Zero: every block from any verified live RPC — sees every tx, whichever RPC sent it
      const liveRpc = Object.entries(st.rpc || {}).find(([, v]) => v.live)?.[0];
      const exBase = Object.entries(st.explorers || {}).find(([, v]) => v.up)?.[0];
      const txLink = (h) => exBase ? `<a href="${exBase.replace(/\/$/, '')}/tx/${h}">${short(h)}</a>` : `<code>${short(h)}</code>`;
      const pingTxs = async (txs, src) => {
        if (!txs.length) return;
        st.chainTx = (st.chainTx || 0) + txs.length;
        st.txBuf = (st.txBuf || []).concat(txs.map(x => ({ h: x.hash, v: x.value, c: x.create, b: x.block }))).slice(-200);
        const first = !st.firstZeroTx;
        if (!first && t - (st.lastTxPing || 0) < 60e3) return; // at most one activity ping per minute, nothing is lost
        const buf = st.txBuf; st.txBuf = []; st.lastTxPing = t;
        if (first) st.firstZeroTx = t;
        const creates = buf.filter(x => x.c).length, vol = buf.reduce((a, x) => a + (x.v || 0), 0);
        const top = [...buf].sort((a, b) => (b.v || 0) - (a.v || 0)).slice(0, 3).map(x => `• ${txLink(x.h)}${x.v ? ` · ${x.v.toLocaleString('en-US', { maximumFractionDigits: 4 })} ZRO` : ''}${x.c ? ' · contract deploy' : ''}`).join('\n');
        await this.zwSay(`${first ? '🚨 <b>First transactions on Zero</b>' : '⚡ <b>Activity on Zero</b>'}\n${buf.length} tx${creates ? ` · ${creates} contract deploy(s)` : ''}${vol ? ` · ${vol.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO moved` : ''} · blocks ${Math.min(...buf.map(x => x.b))}–${Math.max(...buf.map(x => x.b))}\n${top}\nsource: ${src}`, st);
      };
      if (liveRpc && (n % 3 === 2 || opts.force)) {
        try {
          const r = await this.zwBlocks(liveRpc, st);
          st.blkErr = '';
          await pingTxs(r.txs, 'RPC ' + new URL(liveRpc).hostname);
        } catch (e) { st.blkErr = String(e.message || e).slice(0, 60); }
      }

      // 2d · Zero explorer (official from LayerZero metadata + likely hosts), ~every 30 s, politely
      if (n % 10 === 5 || opts.force) {
        st.explorers = st.explorers || {};
        const bases = [...new Set([...ZW.explorerCandidates, ...(st.metaExplorers || [])])].filter(u => { try { return !ZW.explorerDeny.test(new URL(u).hostname); } catch { return false; } });
        for (const base of bases) {
          const e = await this.zwExplorer(base, st);
          const was = st.explorers[base] || {};
          st.explorers[base] = { up: e.up, kind: e.kind, why: e.why, blocked: !!e.blocked, totalTx: e.totalTx ?? was.totalTx, checked: t };
          if (e.up && !was.up) await this.zwSay(`🔎 <b>Zero explorer is online</b>\n${base}${e.kind ? ` · ${e.kind}` : ''}${e.totalTx !== undefined ? ` · ${e.totalTx} tx so far` : ''}`, st);
          for (const u of e.rpcs || []) if (!(st.extraRpcs || []).includes(u) && !(ZW.rpcCandidates.includes(u))) {
            st.extraRpcs = [...new Set([...(st.extraRpcs || []), u])].slice(0, 12);
            await this.zwSay(`🧭 <b>RPC found on the Zero explorer</b>\n<code>${u}</code>\nverifying it now (chain id 33002 + LayerZero endpoint + moving blocks)`, st);
          }
          // explorer-only mode: no RPC of ours yet, count new tx via the explorer API
          if (e.kind === 'blockscout' && !liveRpc && e.totalTx !== undefined && was.totalTx !== undefined && e.totalTx > was.totalTx) {
            const fresh = (await this.zwExplorerTxs(base).catch(() => [])).filter(x => seenAdd(st, 'x' + String(x.hash).slice(0, 17)));
            if (fresh.length) await pingTxs(fresh, 'explorer ' + new URL(base).hostname);
            else await this.zwSay(`⚡ <b>Activity on Zero</b> (explorer)\n+${e.totalTx - was.totalTx} tx · total ${e.totalTx}`, st);
          }
        }
      }

      if (liveRpc && (n % 5 === 0 || opts.force)) {
        try {
          const r = await this.zwActivity(liveRpc, st);
          if (r && t - (st.act.since || t) > 30 * 60e3) {
            const a = st.act;
            let supply = 0;
            try { supply = Number(BigInt(await zwRpc([liveRpc], 'eth_call', [{ to: ZW.zeroZro, data: '0x18160ddd' }, 'latest']))) / 1e18; } catch { /* optional */ }
            await this.zwSay(`📊 <b>Zero · last 30 min</b>\nblocks ${a.fromBlock} → ${a.head} (+${a.head - a.fromBlock})\ntransactions: ${(st.chainTx || 0) - (a.chainTx0 || 0)} (every block scanned)${supply ? `\nZRO on Zero: ${supply.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''}`, st);
            st.act = { since: t, fromBlock: a.head, samples: 0, txSum: 0, maxTx: 0, chainTx0: st.chainTx || 0 };
          }
        } catch (e) { st.actErr = String(e.message || e).slice(0, 60); }
      }

      // 3 · delivery confirmation via LayerZero Scan (up to 4 pending per tick, each re-checked ≥ 10 s apart)
      const due = (st.pending || []).filter(p => !p.done && t - (p.checked || 0) > 10000 && t - p.seen < 6 * 3600e3).slice(0, 4);
      const scans = await Promise.all(due.map(p => this.zwScan(p.tx)));
      for (const [i, p] of due.entries()) {
        const s = scans[i];
        p.checked = t; p.status = s.status;
        if (s.status === 'DELIVERED') {
          p.done = true;
          st.delivered = (st.delivered || 0) + 1;
          if (!st.firstDelivered) {
            st.firstDelivered = t;
            await this.zwSay(`✅ <b>Bridge works end-to-end</b>\n${p.chain === 'lz' ? (p.app || 'LayerZero message') : p.amount.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ZRO from ' + ZW.chains[p.chain].name} DELIVERED on Zero\n<a href="https://layerzeroscan.com/tx/${p.tx}">LayerZero Scan</a>${s.dstTx ? `\nZero tx ${short(s.dstTx)}` : ''}`, st);
          }
        } else if (/FAILED|BLOCKED|PAYLOAD_STORED/.test(s.status)) {
          p.done = true;
          await this.zwSay(`⚠️ <b>ZRO → Zero transfer ${s.status}</b>\n<a href="https://layerzeroscan.com/tx/${p.tx}">${short(p.tx)}</a>`, st);
        }
      }
      st.pending = (st.pending || []).filter(p => !p.done || t - p.seen < 3600e3);

      // 4 · Zero RPC: candidates + whatever LayerZero metadata publishes (every 10th tick ≈ 30 s)
      if (n % 15 === 0 || opts.force) {
        const urls = [...new Set([...ZW.rpcCandidates, ...(st.metaRpcs || []), ...(st.extraRpcs || [])])];
        const res = await Promise.all(urls.map(u => this.zwRpcCheck(u, st)));
        st.rpc = st.rpc || {};
        for (const r of res) {
          const was = st.rpc[r.url]?.live || false;
          st.rpc[r.url] = { live: r.live, why: r.why || '', block: r.block || 0, supply: r.supply || 0, checked: t };
          if (r.live && this.migOnZeroRpc) { const mr = await this.migOnZeroRpc(r.url, r.block, st).catch(e => ({ error: String(e.message || e) })); if (mr && !mr.waiting) st.migResult = { ts: t, ...(mr.error ? { error: mr.error } : { sha256: mr.sha256, markets: mr.markets }) }; }
          if (r.live && !was) await this.zwSay(`🟢 <b>Zero RPC is LIVE</b>\n<code>${r.url}</code>\nchain id 33002 · block ${r.block}${r.supply ? ` · ZRO on Zero ${r.supply.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''}`, st);
          if (!r.live && was) await this.zwSay(`🔴 <b>Zero RPC stopped answering</b>\n<code>${r.url}</code>\n${r.why || ''}`, st);
        }
        out.rpcLive = res.filter(r => r.live).map(r => r.url);
        if (!out.rpcLive.length) st.migConfirm = 0; // confirmations must be consecutive
      }

      // 5 · official metadata (rpc list for "zerointerop") every 100th tick ≈ 5 min, + peer every 20th ≈ 1 min
      if ((n % 150 === 1 || opts.meta) && !this._zwMetaBusy) {
        this._zwMetaBusy = true;
        try {
          const m = await this.zwMeta();
          const added = m.rpcs.filter(u => !(st.metaRpcs || []).includes(u));
          if (added.length) await this.zwSay(`📣 <b>LayerZero published a Zero RPC</b>\n${added.map(u => `<code>${u}</code>`).join('\n')}`, st);
          const exAdded = m.explorers.filter(u => !(st.metaExplorers || []).includes(u));
          if (exAdded.length && st.metaChecked) await this.zwSay(`🔎 <b>Zero explorer published</b>\n${exAdded.join('\n')}`, st);
          st.metaRpcs = m.rpcs; st.metaExplorers = m.explorers; st.metaStatus = m.status; st.metaChecked = t; st.metaErr = '';
        } catch (e) { st.metaErr = String(e.message || e).slice(0, 60); }
        finally { this._zwMetaBusy = false; }
      }
      if (n % 30 === 0 || opts.force) {
        try {
          const peer = await zwRpc(ZW.chains.eth.rpcs, 'eth_call', [{ to: ZW.zro, data: ZW.peers }, 'latest']);
          if (st.peer && peer !== st.peer) await this.zwSay(`⚠️ <b>ZRO peer for Zero changed</b>\n${st.peer.slice(-40)} → ${peer.slice(-40)}`, st);
          st.peer = peer;
        } catch { /* next round */ }
      }
      // heartbeat every 10 min on the clock (:00, :10, …) with proof of work since the last one
      st.hb = st.hb || {};
      st.hb.checks = (st.hb.checks || 0) + 1;
      const slot = Math.floor(t / 600e3);
      if (st.hb.slot === undefined) Object.assign(st.hb, { slot, checks: 0, feed: 0, cur0: { ...(st.cur || {}) }, transfers0: st.transfers || 0, feedTo0: st.feedTo || 0, feedFrom0: st.feedFrom || 0, chainTx0: st.chainTx || 0 });
      else if (slot !== st.hb.slot) {
        if (this.env.ZW_BOT_TOKEN && !opts.noHeartbeat) await this.zwSay(this.zwHeartbeatText(st, t), st, { heartbeat: true }).catch(() => {});
        st.hb = { slot, checks: 0, feed: 0, cur0: { ...(st.cur || {}) }, transfers0: st.transfers || 0, feedTo0: st.feedTo || 0, feedFrom0: st.feedFrom || 0, chainTx0: st.chainTx || 0, sent: t };
      }
      if (this.env.ZW_BOT_TOKEN) await this.zbDrain().catch(() => {});
      st.last = t; st.lastMs = now() - t;
    } finally {
      this.zwSave(st);
      this._zwBusy = false;
    }
    return out;
  };

  // replay a historical block range through the same detection + delivery path (used to prove the watcher works)
  P.zwBacktest = async function ({ chain = 'eth', from, to, rpcs, step = 100 } = {}) {
    const found = await this.zwLogs(chain, {}, { from: Number(from), to: Number(to), rpcs: rpcs || ['https://eth.drpc.org'], step });
    const out = [];
    for (const f of found.slice(0, 20)) out.push({ ...f, scan: await this.zwScan(f.tx) });
    return { found: found.length, sum: found.reduce((a, f) => a + f.amount, 0), delivered: out.filter(x => x.scan.status === 'DELIVERED').length, items: out };
  };

  P.zwArm = async function () {
    if (this.meta('zw_off') === '1') return;
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || cur > now() + ZW.tick + 500) await this.ctx.storage.setAlarm(now() + ZW.tick);
  };

  const prevAlarm = P.alarm;
  P.alarm = async function () {
    if (prevAlarm) await prevAlarm.call(this).catch(() => {});
    if (this.meta('zw_off') === '1') return;
    const st = this.zwState();
    if (!st.last || now() - st.last >= ZW.tick - 300) await this.zwTick().catch(() => {});
    await this.zwArm().catch(() => {});
  };

  // ───────────── @RookeryAlertsBot: public Zero alerts, /start in any private chat or group ─────────────
  P.zb = async function (method, body) {
    if (!this.env.ZW_BOT_TOKEN) return null;
    const r = await fetch(`https://api.telegram.org/bot${this.env.ZW_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return r.json().catch(() => null);
  };
  P.zbInit = function () {
    if (this._zbInit) return; this._zbInit = true;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS zw_subs (chat_id TEXT PRIMARY KEY, type TEXT, title TEXT, active INTEGER DEFAULT 1, added INTEGER, updated INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS zw_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, text TEXT, tries INTEGER DEFAULT 0, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS zw_upd (id INTEGER PRIMARY KEY, ts INTEGER)`);
    try { this.sql.exec('ALTER TABLE zw_subs ADD COLUMN hb INTEGER DEFAULT 1'); } catch { /* already there */ }
  };
  P.zbSub = function (chat, on) {
    this.zbInit();
    const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '';
    this.sql.exec(`INSERT INTO zw_subs (chat_id,type,title,active,added,updated) VALUES (?,?,?,?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET active=excluded.active, title=excluded.title, type=excluded.type, updated=excluded.updated`,
      String(chat.id), chat.type || '', title.slice(0, 80), on ? 1 : 0, now(), now());
  };
  // send queued alerts; Telegram allows ~30 msg/s overall and ~20/min per group, 25 per pass keeps us well inside
  P.zbDrain = async function (max = 25) {
    this.zbInit();
    if (this._zbDraining) return; this._zbDraining = true;
    try {
      if (Number(this.meta('zb_pause_until') || 0) > now()) return;
      const rows = this.sql.exec('SELECT * FROM zw_outbox ORDER BY id LIMIT ?', max).toArray();
      for (const m of rows) {
        const r = await this.zb('sendMessage', { chat_id: m.chat_id, text: m.text, parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => null);
        if (r?.ok) { this.sql.exec('DELETE FROM zw_outbox WHERE id=?', m.id); continue; }
        const code = r?.error_code, d = String(r?.description || '');
        if (code === 429) { this.setMeta('zb_pause_until', String(now() + 1000 * Number(r?.parameters?.retry_after || 3))); break; }
        if (code === 403 || /chat not found|kicked|blocked|deactivated|not enough rights/i.test(d)) {
          this.sql.exec('UPDATE zw_subs SET active=0, updated=? WHERE chat_id=?', now(), m.chat_id);
          this.sql.exec('DELETE FROM zw_outbox WHERE chat_id=?', m.chat_id); continue;
        }
        if (r?.parameters?.migrate_to_chat_id) { // group upgraded to supergroup
          const nid = String(r.parameters.migrate_to_chat_id);
          this.sql.exec('UPDATE zw_subs SET chat_id=? WHERE chat_id=?', nid, m.chat_id);
          this.sql.exec('UPDATE zw_outbox SET chat_id=? WHERE chat_id=?', nid, m.chat_id); continue;
        }
        if (m.tries >= 3) this.sql.exec('DELETE FROM zw_outbox WHERE id=?', m.id);
        else this.sql.exec('UPDATE zw_outbox SET tries=tries+1 WHERE id=?', m.id);
      }
      this.sql.exec('DELETE FROM zw_outbox WHERE created<?', now() - 3600e3);
    } finally { this._zbDraining = false; }
  };

  P.zwStatusText = function () {
    const st = this.zwState();
    const b = st.bridge || {};
    const live = Object.entries(st.rpc || {}).filter(([, v]) => v.live).map(([k]) => k);
    const chainLive = live.length || st.firstFromZero || st.firstZeroTx;
    const ago = st.last ? Math.max(0, Math.round((now() - st.last) / 1000)) : null;
    const icon = (x) => x === 'open' ? '🟢 open' : x === 'closed' ? '🔴 closed' : '⚪ checking';
    return [
      '🛰 <b>Zero by LayerZero · live watch</b>',
      '',
      `Network: ${chainLive ? '🟢 <b>LIVE</b>' : '⏳ not live yet (official launch: Nov 30, 2026)'}`,
      `ZRO → Zero bridge: Ethereum ${icon(b.eth?.state)} · Arbitrum ${icon(b.arb?.state)} · Base ${icon(b.base?.state)}`,
      `ZRO transfers to Zero seen: ${st.transfers || 0} · delivered: ${st.delivered || 0}`,
      `LayerZero messages to / from Zero: ${st.feedTo || 0} / ${st.feedFrom || 0}`,
      `Public Zero RPC: ${live.length ? live.map(u => `<code>${u}</code>`).join(', ') : 'none yet'}`,
      ago !== null ? `Last check: ${ago}s ago · checks every ~3s` : null,
      '',
      'Alerts land here the moment the bridge opens, ZRO moves to Zero, the first message leaves Zero or an RPC goes live. A short status update follows every 10 minutes.',
      '<i>Community tool, not affiliated with LayerZero. Not financial advice.</i>',
    ].filter(x => x !== null).join('\n').replace(/<i>|<\/i>/g, '');
  };

  P.zwHeartbeatText = function (st, t) {
    const hb = st.hb || {};
    const b = st.bridge || {};
    const live = Object.entries(st.rpc || {}).some(([, v]) => v.live) || st.firstFromZero || st.firstZeroTx;
    const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
    const launch = Date.UTC(2026, 10, 30);
    const left = launch - t;
    const until = left > 0 ? ` · in ${Math.floor(left / 864e5)}d ${Math.floor((left % 864e5) / 36e5)}h` : '';
    const blocks = Object.entries(ZW.chains).map(([k, c]) => [c.name.replace('BNB Chain', 'BNB'), Math.max(0, (st.cur?.[k] || 0) - (hb.cur0?.[k] || st.cur?.[k] || 0))]);
    const totalBlocks = blocks.reduce((a, [, v]) => a + v, 0);
    const events = (st.transfers || 0) - (hb.transfers0 || 0) + (st.feedTo || 0) - (hb.feedTo0 || 0) + (st.feedFrom || 0) - (hb.feedFrom0 || 0) + (st.chainTx || 0) - (hb.chainTx0 || 0);
    const icon = (x) => x === 'open' ? '🟢 open' : x === 'closed' ? '🔴 closed' : '⚪ ?';
    const fmt = (x) => x.toLocaleString('en-US');
    return [
      `🛰 <b>Zero watch · ${hhmm(t)} UTC</b> · still watching`,
      `Network: ${live ? '🟢 LIVE' : `⏳ not live yet · launch Nov 30${until}`}`,
      `Bridge ZRO → Zero: ETH ${icon(b.eth?.state)} · ARB ${icon(b.arb?.state)} · Base ${icon(b.base?.state)}`,
      '',
      `<b>Last 10 min</b>`,
      `• ${fmt(hb.checks || 0)} bridge checks`,
      `• ${fmt(totalBlocks)} blocks scanned (${blocks.map(([n, v]) => `${n} ${fmt(v)}`).join(' · ')})`,
      `• LayerZero feed read ${fmt(hb.feed || 0)}× (all 110+ chains)`,
      `• ${events ? `<b>${fmt(events)} Zero event(s)</b>` : 'no Zero activity yet'}`,
      '',
      `Next update ${hhmm(Math.floor(t / 600e3) * 600e3 + 600e3)} UTC · /status anytime · /quiet mutes these updates`,
    ].join('\n');
  };

  P.zbUpdate = async function (u) {
    this.zbInit();
    const me = this.meta('zb_username') || 'RookeryAlertsBot';
    const kb = { inline_keyboard: [[{ text: '➕ Add to group', url: `https://t.me/${me}?startgroup=true` }], [{ text: 'LayerZero Scan', url: 'https://layerzeroscan.com' }, { text: 'Official staking', url: 'https://staking.layerzero.network' }]] };
    // bot added to / removed from a group or channel
    if (u.my_chat_member) {
      const cm = u.my_chat_member, st = cm.new_chat_member?.status;
      if (['member', 'administrator'].includes(st)) {
        this.zbSub(cm.chat, true);
        await this.zb('sendMessage', { chat_id: cm.chat.id, text: '✅ This chat now gets Zero network alerts.\n\n' + this.zwStatusText(), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
      } else if (['left', 'kicked'].includes(st)) this.zbSub(cm.chat, false);
      return;
    }
    const msg = u.message || u.channel_post;
    if (!msg) return;
    const text = (msg.text || '').trim();
    if (!text.startsWith('/')) return;
    const [cmdRaw, ...args] = text.split(/\s+/);
    const [cmdName, at] = cmdRaw.split('@');
    if (at && at.toLowerCase() !== me.toLowerCase()) return; // command meant for another bot in the group
    const cmd = cmdName.toLowerCase();
    const chat = msg.chat;
    const isGroup = ['group', 'supergroup', 'channel'].includes(chat.type);
    const reply = (t, extra = {}) => this.zb('sendMessage', { chat_id: chat.id, text: t, parse_mode: 'HTML', disable_web_page_preview: true, ...(msg.message_id ? { reply_to_message_id: msg.message_id, allow_sending_without_reply: true } : {}), ...extra });
    const isAdmin = async () => {
      if (chat.type === 'channel' || !isGroup) return true;
      if (!msg.from) return false;
      const r = await this.zb('getChatMember', { chat_id: chat.id, user_id: msg.from.id });
      return r?.ok && ['creator', 'administrator'].includes(r.result.status);
    };
    const owner = String(msg.from?.id || '') === String(this.meta('tg_owner_chat') || '-');

    if (cmd === '/start' || cmd === '/subscribe') {
      this.zbSub(chat, true);
      return reply('✅ Subscribed to Zero alerts.\n\n' + this.zwStatusText(), { reply_markup: kb });
    }
    if (cmd === '/status' || cmd === '/zero') return reply(this.zwStatusText(), { reply_markup: kb });
    if (cmd === '/quiet' || cmd === '/updates') {
      if (!(await isAdmin())) return reply('Only group admins can change this.');
      this.zbSub(chat, true);
      const cur = this.sql.exec('SELECT COALESCE(hb,1) hb FROM zw_subs WHERE chat_id=?', String(chat.id)).one().hb;
      const next = cmd === '/updates' ? 1 : (cur ? 0 : 1);
      this.sql.exec('UPDATE zw_subs SET hb=? WHERE chat_id=?', next, String(chat.id));
      return reply(next ? '🔔 10-minute updates are on. Alerts stay on either way.' : '🔕 10-minute updates muted. You still get every alert. Send /updates to turn them back on.');
    }
    if (cmd === '/stop' || cmd === '/unsubscribe') {
      if (!(await isAdmin())) return reply('Only group admins can turn alerts off here.');
      this.zbSub(chat, false);
      return reply('🔕 Alerts off for this chat. Send /start to turn them back on.');
    }
    if (cmd === '/zerorpc' && owner) {
      const st = this.zwState();
      const rm = (args[0] || '').toLowerCase() === 'remove';
      let url = String((rm ? args[1] : args[0]) || '').trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (!/^https:\/\/[^\s]+$/.test(url)) return reply('Usage: <code>/zerorpc https://…</code> or <code>/zerorpc remove https://…</code>');
      if (rm) { st.extraRpcs = (st.extraRpcs || []).filter(x => x !== url); this.zwSave(st); return reply('Removed ' + url); }
      st.extraRpcs = [...new Set([...(st.extraRpcs || []), url])].slice(0, 10);
      const c = await this.zwRpcCheck(url, st);
      this.zwSave(st);
      return reply(c.live ? `🟢 Verified Zero RPC, watching it\n<code>${url}</code>\nblock ${c.block}` : `👀 Watching, not live yet: ${c.why}\n<code>${url}</code>`);
    }
    if (cmd === '/help') return reply('/start — get Zero alerts here and see the current status\n/status — current status\n/quiet — mute the 10-minute updates (alerts stay on)\n/updates — turn the 10-minute updates back on\n/stop — stop alerts (group admins)\n\nAdd me to any group: the group is subscribed automatically.', { reply_markup: kb });
  };

  P.zbSetup = async function (host) {
    this.zbInit();
    let secret = this.meta('zb_secret');
    if (!secret) { secret = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, '0')).join(''); this.setMeta('zb_secret', secret); }
    const me = await this.zb('getMe', {});
    if (me?.ok) this.setMeta('zb_username', me.result.username);
    const out = { me: me?.result?.username };
    out.webhook = await this.zb('setWebhook', { url: `https://${host}/api/zbot/hook/${secret}`, secret_token: secret, allowed_updates: ['message', 'channel_post', 'my_chat_member'], drop_pending_updates: true });
    const cmds = [{ command: 'start', description: 'Get Zero alerts here + current status' }, { command: 'status', description: 'Zero network and bridge status' }, { command: 'quiet', description: 'Mute the 10-minute updates' }, { command: 'updates', description: 'Turn 10-minute updates back on' }, { command: 'stop', description: 'Stop alerts in this chat' }, { command: 'help', description: 'How it works' }];
    out.cmds = await this.zb('setMyCommands', { commands: cmds });
    out.cmdsGroups = await this.zb('setMyCommands', { commands: cmds, scope: { type: 'all_group_chats' } });
    out.desc = await this.zb('setMyDescription', { description: 'Live alerts for Zero, the LayerZero L1: the second the ZRO → Zero bridge opens or closes, ZRO starts moving to Zero, the first LayerZero message leaves Zero, or a Zero RPC goes live.\n\nPress Start, or add me to your group: it gets the alerts automatically.\n\nCommunity tool, not affiliated with LayerZero. Not financial advice.' });
    out.short = await this.zb('setMyShortDescription', { short_description: 'Zero (LayerZero L1) live alerts: bridge open, ZRO transfers, first blocks, RPC live. Add me to your group.' });
    return out;
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
