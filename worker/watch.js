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

  P.zwSay = async function (text, st) {
    const chat = this.meta('tg_owner_chat') || this.meta('watch_chat');
    st.log = (st.log || []).concat([{ ts: now(), text: text.replace(/<[^>]+>/g, '').slice(0, 200) }]).slice(-50);
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
        for (const g of got) fresh.push(...g);
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
            await this.zwSay(`✅ <b>Bridge works end-to-end</b>\n${p.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO from ${ZW.chains[p.chain].name} DELIVERED on Zero\n<a href="https://layerzeroscan.com/tx/${p.tx}">LayerZero Scan</a>${s.dstTx ? `\nZero tx ${short(s.dstTx)}` : ''}`, st);
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
          if (r.live && !was) await this.zwSay(`🟢 <b>Zero RPC is LIVE</b>\n<code>${r.url}</code>\nchain id 33002 · block ${r.block}${r.supply ? ` · ZRO on Zero ${r.supply.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''}`, st);
          if (!r.live && was) await this.zwSay(`🔴 <b>Zero RPC stopped answering</b>\n<code>${r.url}</code>\n${r.why || ''}`, st);
        }
        out.rpcLive = res.filter(r => r.live).map(r => r.url);
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
