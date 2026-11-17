  /* ───────────── Telegram buybot ───────────── */
  async tg(method, body) {
    if (!this.env.TG_BOT_TOKEN) return null;
    const r = await fetch(`https://api.telegram.org/bot${this.env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json().catch(() => null);
  }
  buyMessage(m, t, usd, buyer, host, emoji) {
    const spentUsd = (Number(B(t.zro)) / 1e18) * usd;
    const unit = emoji || '🟢';
    const dots = unit.repeat(Math.max(1, Math.min(30, Math.round(spentUsd / 10))));
    const bars = Math.round(Math.min(100, m.progress) / 10);
    return `<b>${escH(m.name)} ($${escH(m.symbol)}) Buy!</b>\n${dots}\n\n` +
      `💸 <b>Spent:</b> ${(Number(B(t.zro)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 2 })} ZRO (${usdTxt(spentUsd)})\n` +
      `🐧 <b>Got:</b> ${tokTxt(t.tokens)} ${escH(m.symbol)}\n` +
      `👤 <b>Buyer:</b> <a href="https://${host}/#/u/${encodeURIComponent(buyer)}">${escH(buyer)}</a>\n` +
      `💲 <b>Price:</b> ${usdTxt(m.priceUsd)}\n` +
      `📊 <b>Market cap:</b> ${usdTxt(m.mcapUsd)}\n` +
      `🥚 <b>Bonded:</b> ${m.progress.toFixed(1)}%  ${'▰'.repeat(bars)}${'▱'.repeat(10 - bars)}\n` +
      `👥 <b>Holders:</b> ${m.holders}\n` +
      `🌐 <b>Network:</b> ${m.network === 'giwa' ? 'GIWA (pre-mainnet)' : 'Zero by LayerZero (pre-mainnet)'}`;
  }
  // inline buttons: Buy / Chart, then socials, then the penguin burn
  buyKeyboard(m, sub, host) {
    const page = `https://${host}/#/t/${m.id}`;
    const rows = [[{ text: `🛒 Buy $${m.symbol}`, url: page }, { text: '📈 Chart', url: page }]];
    const x = sub?.x || m.x, tg = sub?.tg || m.tg, web = sub?.web || m.web;
    const social = [];
    if (x) social.push({ text: '𝕏 Twitter', url: x });
    if (tg) social.push({ text: '💬 Telegram', url: tg });
    if (web) social.push({ text: '🌐 Website', url: web });
    if (social.length) rows.push(social);
    rows.push([{ text: '🔥 0.5% of every trade burns $臭企鹅', url: `https://${host}/#/proofs/burns` }]);
    return { inline_keyboard: rows };
  }
  async postTo(chat_id, text, keyboard, media, fallbackPhoto) {
    const base = { chat_id, caption: text, parse_mode: 'HTML', reply_markup: keyboard };
    let r = null;
    if (media?.id) {
      if (media.type === 'animation') r = await this.tg('sendAnimation', { ...base, animation: media.id });
      else if (media.type === 'video') r = await this.tg('sendVideo', { ...base, video: media.id });
      else r = await this.tg('sendPhoto', { ...base, photo: media.id });
    } else if (fallbackPhoto) {
      r = await this.tg('sendPhoto', { ...base, photo: fallbackPhoto });
    }
    if (!r || !r.ok) r = await this.tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: keyboard });
    return r;
  }
  async notifyBuy(marketId, trade, buyer, host) {
    if (!this.env.TG_BOT_TOKEN) return;
    const usd = this.zroUsd();
    const m = this.view(this.market(marketId), usd);
    const spentUsd = (Number(B(trade.zro)) / 1e18) * usd;
    const subs = this.sql.exec('SELECT * FROM tg_subs WHERE market=?', marketId).toArray().filter(s => spentUsd >= (s.min_usd || 0));
    const feed = this.meta('tg_feed_chat');
    if (feed && !subs.some(s => s.chat_id === feed)) subs.push({ chat_id: feed });
    const raw = this.sql.exec('SELECT image FROM markets WHERE id=?', marketId).toArray()[0]?.image;
    const tokenImg = raw ? `https://${host}/api/img/m/${marketId}` : null;
    for (const s of subs) {
      const text = this.buyMessage(m, trade, usd, buyer, host, s.emoji);
      const r = await this.postTo(s.chat_id, text, this.buyKeyboard(m, s, host), s.media_id ? { id: s.media_id, type: s.media_type } : null, tokenImg);
      if (r && !r.ok && [400, 403].includes(r.error_code) && /chat not found|kicked|not a member|blocked/i.test(r.description || '')) {
        this.sql.exec('DELETE FROM tg_subs WHERE chat_id=?', s.chat_id);
      }
    }
  }
  async notifyLaunch(marketId, host) {
    const feed = this.meta('tg_feed_chat');
    if (!this.env.TG_BOT_TOKEN || !feed) return;
    const m = this.view(this.market(marketId), this.zroUsd());
    const text = `🥚 <b>New token hatched on Rookery</b>\n\n<b>${escH(m.name)} ($${escH(m.symbol)})</b>\n` +
      `🌐 ${m.network === 'giwa' ? 'GIWA' : 'Zero by LayerZero'} · pair ${escH(m.symbol)}/ZRO\n👤 by ${escH(m.creator)}\n` +
      `🧾 Taxes: ${m.taxes.marketing}% marketing · ${m.taxes.burn}% burn · ${m.taxes.rewards}% ZRO rewards`;
    const raw = this.sql.exec('SELECT image FROM markets WHERE id=?', marketId).toArray()[0]?.image;
    await this.postTo(feed, text, this.buyKeyboard(m, null, host), null, raw ? `https://${host}/api/img/m/${marketId}` : null);
  }
  parseMarketRef(s) {
    s = String(s || '').trim();
    const mm = s.match(/#\/t\/([a-z0-9-]+)/i);
    const id = mm ? mm[1] : s.replace(/^\$/, '');
    let row = this.sql.exec('SELECT id FROM markets WHERE id=?', id).toArray()[0];
    if (!row) row = this.sql.exec('SELECT id FROM markets WHERE symbol=? COLLATE NOCASE ORDER BY created DESC LIMIT 1', id).toArray()[0];
    return row?.id || null;
  }
  mediaOf(msg) {
    if (!msg) return null;
    if (msg.animation) return { id: msg.animation.file_id, type: 'animation' };
    if (msg.video) return { id: msg.video.file_id, type: 'video' };
    if (msg.photo?.length) return { id: msg.photo[msg.photo.length - 1].file_id, type: 'photo' };
    if (msg.document && /gif|mp4/.test(msg.document.mime_type || '')) return { id: msg.document.file_id, type: 'animation' };
    return null;
  }
  async tgUpdate(u, host) {
    const msg = u.message || u.channel_post;
    if (!msg) return;
    const text = (msg.text || msg.caption || '').trim();
    if (!text.startsWith('/')) return;
    const chat = msg.chat;
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    const reply = (t, extra = {}) => this.tg('sendMessage', { chat_id: chat.id, text: t, parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id, ...extra });
    const isGroup = ['group', 'supergroup', 'channel'].includes(chat.type);
    const isAdmin = async () => {
      if (chat.type === 'channel' || !isGroup) return true;
      if (!msg.from) return false;
      const r = await this.tg('getChatMember', { chat_id: chat.id, user_id: msg.from.id });
      return r?.ok && ['creator', 'administrator'].includes(r.result.status);
    };
    const subsHere = () => this.sql.exec('SELECT * FROM tg_subs WHERE chat_id=?', String(chat.id)).toArray();
    // optional trailing ticker narrows a setting to one tracked token
    const target = (arg) => { const id = arg ? this.parseMarketRef(arg) : null; return id ? ' AND market=' + `'${id.replace(/'/g, '')}'` : ''; };
    const url = (u) => { u = String(u || '').trim(); if (!u) return ''; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; return /^https:\/\/[^\s]+$/.test(u) ? u.slice(0, 200) : ''; };

    if (cmd === '/start' || cmd === '/help') {
      return reply(`<b>Rookery Buy Bot</b> 🐧\nPosts every buy of a Rookery token in your group.\n\n` +
        `<b>Setup</b>\n<code>/track TICKER</code> start posting buys\n<code>/untrack</code> stop\n<code>/tracked</code> what is tracked here\n\n` +
        `<b>Make it yours</b>\n<code>/setmedia</code> reply to a GIF, photo or video (or send one with this caption)\n<code>/clearmedia</code> back to the token image\n` +
        `<code>/socials x=x.com/you tg=t.me/you web=you.xyz</code> buttons under each post\n<code>/socials clear</code> use the token's own links\n` +
        `<code>/emoji 🐧</code> buy-size emoji\n<code>/minbuy 25</code> only buys above $25\n<code>/preview</code> see how a post looks\n\nTrade: https://${host}`,
        { reply_markup: { inline_keyboard: [[{ text: '➕ Add me to your group', url: `https://t.me/${this.meta('tg_bot') || 'RookeryBuyBot'}?startgroup=track` }], [{ text: '🥚 Open Rookery', url: `https://${host}` }]] } });
    }
    if (cmd === '/track') {
      if (!isGroup) return reply('Add me to a group first, then use /track there.');
      if (!(await isAdmin())) return reply('Only group admins can do that.');
      const id = this.parseMarketRef(args[0]);
      if (!id) return reply('Token not found. Use the ticker, the token id or the Rookery link.');
      this.sql.exec('INSERT INTO tg_subs (chat_id,market,min_usd,created) VALUES (?,?,0,?) ON CONFLICT(chat_id,market) DO NOTHING', String(chat.id), id, now());
      const m = this.view(this.market(id), this.zroUsd());
      return reply(`✅ Tracking <b>${escH(m.name)} ($${escH(m.symbol)})</b>. Every buy will be posted here.\n\nTip: reply to a GIF with /setmedia and use /socials to add your links. /preview shows the result.`,
        { reply_markup: this.buyKeyboard(m, null, host) });
    }
    if (!isGroup && cmd !== '/preview') return reply('Use this command inside the group where the bot is tracking a token.');
    if (!(await isAdmin())) return reply('Only group admins can do that.');
    const subs = subsHere();
    if (!subs.length && cmd !== '/untrack') return reply('Nothing tracked here yet. Use /track TICKER first.');

    if (cmd === '/untrack') {
      const id = args[0] ? this.parseMarketRef(args[0]) : null;
      if (id) this.sql.exec('DELETE FROM tg_subs WHERE chat_id=? AND market=?', String(chat.id), id);
      else this.sql.exec('DELETE FROM tg_subs WHERE chat_id=?', String(chat.id));
      return reply('Stopped tracking.');
    }
    if (cmd === '/minbuy') {
      const v = Math.max(0, Number(args[0]) || 0);
      this.sql.exec(`UPDATE tg_subs SET min_usd=? WHERE chat_id=?${target(args[1])}`, v, String(chat.id));
      return reply(`Posting buys above $${v}.`);
    }
    if (cmd === '/setmedia') {
      let media = this.mediaOf(msg) || this.mediaOf(msg.reply_to_message);
      if (!media && args[0] && /^https?:\/\//i.test(args[0])) media = { id: args[0], type: /\.(gif|mp4)(\?|$)/i.test(args[0]) ? 'animation' : 'photo' };
      if (!media) return reply('Reply to a GIF, photo or video with /setmedia, or send the media with /setmedia as its caption.');
      const tick = media.id.startsWith('http') ? args[1] : args[0];
      this.sql.exec(`UPDATE tg_subs SET media_id=?, media_type=? WHERE chat_id=?${target(tick)}`, media.id, media.type, String(chat.id));
      return reply(`✅ ${media.type === 'animation' ? 'GIF' : media.type === 'video' ? 'Video' : 'Image'} saved. It will be shown with every buy. Send /preview to check.`);
    }
    if (cmd === '/clearmedia') {
      this.sql.exec(`UPDATE tg_subs SET media_id=NULL, media_type=NULL WHERE chat_id=?${target(args[0])}`, String(chat.id));
      return reply('Media cleared. Posts will use the token image.');
    }
    if (cmd === '/socials') {
      if ((args[0] || '').toLowerCase() === 'clear') {
        this.sql.exec('UPDATE tg_subs SET x=NULL, tg=NULL, web=NULL WHERE chat_id=?', String(chat.id));
        return reply("Socials cleared. Buttons will use the token's own links.");
      }
      const kv = Object.fromEntries(args.map(a => a.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.toLowerCase(), v]));
      const x = url(kv.x || kv.twitter), tg = url(kv.tg || kv.telegram), web = url(kv.web || kv.site || kv.website);
      if (!x && !tg && !web) return reply('Usage: <code>/socials x=x.com/you tg=t.me/you web=you.xyz</code>');
      const sets = []; const vals = [];
      if (x) { sets.push('x=?'); vals.push(x); } if (tg) { sets.push('tg=?'); vals.push(tg); } if (web) { sets.push('web=?'); vals.push(web); }
      this.sql.exec(`UPDATE tg_subs SET ${sets.join(',')} WHERE chat_id=?`, ...vals, String(chat.id));
      return reply('✅ Social buttons saved. Send /preview to check.');
    }
    if (cmd === '/emoji') {
      const e = [...(args[0] || '')].slice(0, 2).join('');
      if (!e) return reply('Usage: <code>/emoji 🐧</code>');
      this.sql.exec(`UPDATE tg_subs SET emoji=? WHERE chat_id=?${target(args[1])}`, e, String(chat.id));
      return reply(`Buy emoji set to ${escH(e)}.`);
    }
    if (cmd === '/tracked') {
      const rows = this.sql.exec('SELECT s.*, m.symbol FROM tg_subs s JOIN markets m ON m.id=s.market WHERE s.chat_id=?', String(chat.id)).toArray();
      return reply(rows.map(r => `• <b>$${escH(r.symbol)}</b> · min $${r.min_usd}${r.media_id ? ' · ' + r.media_type : ''}${r.emoji ? ' · ' + escH(r.emoji) : ''}${r.x || r.tg || r.web ? ' · custom socials' : ''}`).join('\n'));
    }
    if (cmd === '/preview') {
      const s = subs[0];
      const usd = this.zroUsd();
      const m = this.view(this.market(s.market), usd);
      const sample = { zro: (25n * WEI).toString(), tokens: Books.quoteBuy(this.market(s.market), 25n * WEI).toString() };
      const raw = this.sql.exec('SELECT image FROM markets WHERE id=?', s.market).toArray()[0]?.image;
      await this.postTo(chat.id, '👀 <i>Preview</i>\n\n' + this.buyMessage(m, sample, usd, 'preview', host, s.emoji), this.buyKeyboard(m, s, host),
        s.media_id ? { id: s.media_id, type: s.media_type } : null, raw ? `https://${host}/api/img/m/${s.market}` : null);
    }
  }

