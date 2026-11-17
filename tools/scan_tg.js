  /* ───────────── continuous deposit detection (all users, all chains) ───────────── */
  async scanDeposits() {
    const users = this.sql.exec('SELECT * FROM users WHERE dep_address IS NOT NULL').toArray();
    if (!users.length) return { hits: 0 };
    const byTopic = new Map(users.map(u => ['0x' + '0'.repeat(24) + u.dep_address.slice(2).toLowerCase(), u]));
    const topics = [...byTopic.keys()];
    const hit = new Map();
    for (const chain of Object.keys(CHAINS)) {
      try {
        const latest = BigInt(await rpc(chain, 'eth_blockNumber', []));
        const saved = this.meta('scan_' + chain);
        let from = saved ? BigInt(saved) : latest - 20n;
        if (from > latest) continue;
        if (latest - from > 50_000n) from = latest - 50_000n; // never fall hopelessly behind
        const to = from + SCAN_RANGE < latest ? from + SCAN_RANGE : latest;
        for (let i = 0; i < topics.length; i += 100) {
          const logs = await rpc(chain, 'eth_getLogs', [{ address: ZRO_TOKEN, fromBlock: toHex(from), toBlock: toHex(to),
            topics: [TRANSFER_TOPIC, null, topics.slice(i, i + 100)] }]);
          for (const l of logs || []) { const u = byTopic.get(String(l.topics[2]).toLowerCase()); if (u) hit.set(u.id, u); }
        }
        this.setMeta('scan_' + chain, (to + 1n).toString());
      } catch { /* RPC hiccup: retry this range next tick */ }
    }
    const credited = [];
    for (const u of hit.values()) {
      const f = await this.checkDeposits(u).catch(() => []);
      if (f.length) credited.push({ user: u.username, found: f });
    }
    return { hits: hit.size, credited };
  }

  /* ───────────── Telegram buybot ───────────── */
  async tg(method, body) {
    if (!this.env.TG_BOT_TOKEN) return null;
    const r = await fetch(`https://api.telegram.org/bot${this.env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => null);
  }
  buyMessage(m, t, usd, buyer, host) {
    const spentUsd = (Number(B(t.zro)) / 1e18) * usd;
    const dots = '🟢'.repeat(Math.max(1, Math.min(30, Math.round(spentUsd / 10))));
    const bars = Math.round(Math.min(100, m.progress) / 10);
    const link = `https://${host}/#/t/${m.id}`;
    return `<b>${escH(m.name)} ($${escH(m.symbol)}) buy!</b>\n${dots}\n\n` +
      `💸 <b>Spent:</b> ${(Number(B(t.zro)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO (${usdTxt(spentUsd)})\n` +
      `🐧 <b>Got:</b> ${tokTxt(t.tokens)} ${escH(m.symbol)}\n` +
      `👤 <b>Buyer:</b> <a href="https://${host}/#/u/${encodeURIComponent(buyer)}">${escH(buyer)}</a>\n` +
      `💲 <b>Price:</b> ${usdTxt(m.priceUsd)}\n` +
      `📊 <b>Market cap:</b> ${usdTxt(m.mcapUsd)}\n` +
      `🥚 <b>Bonded:</b> ${m.progress.toFixed(1)}%  ${'▰'.repeat(bars)}${'▱'.repeat(10 - bars)}\n` +
      `👥 <b>Holders:</b> ${m.holders}\n` +
      `🌐 <b>Network:</b> ${m.network === 'giwa' ? 'GIWA (pre-mainnet)' : 'Zero by LayerZero (pre-mainnet)'}\n\n` +
      `<a href="${link}">Trade on Rookery</a> · <a href="https://${host}/#/proofs/burns">0.5% burns $臭企鹅</a>`;
  }
  async notifyBuy(marketId, trade, buyer, host) {
    if (!this.env.TG_BOT_TOKEN) return;
    const usd = this.zroUsd();
    const m = this.view(this.market(marketId), usd);
    const spentUsd = (Number(B(trade.zro)) / 1e18) * usd;
    const subs = this.sql.exec('SELECT chat_id, min_usd FROM tg_subs WHERE market=?', marketId).toArray();
    const feed = this.meta('tg_feed_chat');
    const chats = subs.filter(s => spentUsd >= (s.min_usd || 0)).map(s => s.chat_id);
    if (feed && !chats.includes(feed)) chats.push(feed);
    const text = this.buyMessage(m, trade, usd, buyer, host);
    const raw = this.sql.exec('SELECT image FROM markets WHERE id=?', marketId).toArray()[0]?.image;
    for (const chat_id of chats) {
      let r = null;
      if (raw) r = await this.tg('sendPhoto', { chat_id, photo: `https://${host}/api/img/m/${marketId}`, caption: text, parse_mode: 'HTML' });
      if (!r || !r.ok) r = await this.tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
      // the bot was removed from a group: stop posting there
      if (r && !r.ok && [400, 403].includes(r.error_code) && /chat not found|kicked|not a member|blocked/i.test(r.description || '')) {
        this.sql.exec('DELETE FROM tg_subs WHERE chat_id=?', chat_id);
      }
    }
  }
  async notifyLaunch(marketId, host) {
    const feed = this.meta('tg_feed_chat');
    if (!this.env.TG_BOT_TOKEN || !feed) return;
    const m = this.view(this.market(marketId), this.zroUsd());
    const text = `🥚 <b>New token hatched on Rookery</b>\n\n<b>${escH(m.name)} ($${escH(m.symbol)})</b>\n` +
      `🌐 ${m.network === 'giwa' ? 'GIWA' : 'Zero by LayerZero'} · pair ${escH(m.symbol)}/ZRO\n👤 by ${escH(m.creator)}\n` +
      `🧾 Taxes: ${m.taxes.marketing}% marketing · ${m.taxes.burn}% burn · ${m.taxes.rewards}% ZRO rewards\n\n` +
      `<a href="https://${host}/#/t/${m.id}">Trade on Rookery</a>`;
    await this.tg('sendMessage', { chat_id: feed, text, parse_mode: 'HTML', disable_web_page_preview: true });
  }
  parseMarketRef(s) {
    s = String(s || '').trim();
    const m = s.match(/#\/t\/([a-z0-9-]+)/i);
    const id = m ? m[1] : s.replace(/^\$/, '');
    let row = this.sql.exec('SELECT id FROM markets WHERE id=?', id).toArray()[0];
    if (!row) row = this.sql.exec('SELECT id FROM markets WHERE symbol=? COLLATE NOCASE ORDER BY created DESC LIMIT 1', id).toArray()[0];
    return row?.id || null;
  }
  async tgUpdate(u, host) {
    const msg = u.message || u.channel_post;
    if (!msg || !msg.text) return;
    const chat = msg.chat;
    const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    const reply = (text) => this.tg('sendMessage', { chat_id: chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id });
    const isGroup = ['group', 'supergroup'].includes(chat.type);
    const isAdmin = async () => {
      if (!isGroup) return true;
      if (!msg.from) return false;
      const r = await this.tg('getChatMember', { chat_id: chat.id, user_id: msg.from.id });
      return r?.ok && ['creator', 'administrator'].includes(r.result.status);
    };
    if (cmd === '/start' || cmd === '/help') {
      return reply(`<b>Rookery Buy Bot</b> 🐧\nPosts every buy of a Rookery token in your group.\n\n` +
        `1. Add me to your group\n2. Send <code>/track TOKEN</code> (ticker, token id or the Rookery link)\n\n` +
        `Other commands:\n<code>/minbuy 25</code> only post buys above $25\n<code>/untrack TOKEN</code>\n<code>/tracked</code>\n\n` +
        `Trade: https://${host}`);
    }
    if (cmd === '/track') {
      if (!isGroup) return reply('Add me to a group first, then use /track there.');
      if (!(await isAdmin())) return reply('Only group admins can do that.');
      const id = this.parseMarketRef(args[0]);
      if (!id) return reply('Token not found. Use the ticker, the token id or the Rookery link.');
      this.sql.exec('INSERT INTO tg_subs (chat_id,market,min_usd,created) VALUES (?,?,0,?) ON CONFLICT(chat_id,market) DO NOTHING', String(chat.id), id, now());
      const m = this.market(id);
      return reply(`✅ Tracking <b>${escH(m.name)} ($${escH(m.symbol)})</b>. Every buy will be posted here.\nhttps://${host}/#/t/${id}`);
    }
    if (cmd === '/untrack') {
      if (!(await isAdmin())) return reply('Only group admins can do that.');
      const id = args[0] ? this.parseMarketRef(args[0]) : null;
      if (id) this.sql.exec('DELETE FROM tg_subs WHERE chat_id=? AND market=?', String(chat.id), id);
      else this.sql.exec('DELETE FROM tg_subs WHERE chat_id=?', String(chat.id));
      return reply('Stopped tracking.');
    }
    if (cmd === '/minbuy') {
      if (!(await isAdmin())) return reply('Only group admins can do that.');
      const v = Math.max(0, Number(args[0]) || 0);
      this.sql.exec('UPDATE tg_subs SET min_usd=? WHERE chat_id=?', v, String(chat.id));
      return reply(`Posting buys above $${v}.`);
    }
    if (cmd === '/tracked') {
      const rows = this.sql.exec('SELECT s.market, s.min_usd, m.symbol FROM tg_subs s JOIN markets m ON m.id=s.market WHERE s.chat_id=?', String(chat.id)).toArray();
      return reply(rows.length ? rows.map(r => `• $${escH(r.symbol)} (min $${r.min_usd})`).join('\n') : 'Nothing tracked here yet. Use /track TOKEN.');
    }
  }

