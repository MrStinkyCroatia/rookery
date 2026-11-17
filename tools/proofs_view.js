/* ═══════════ PROOFS ═══════════ */
async function viewProofs(tab) {
  document.title = 'Proofs — Rookery';
  tab = tab === 'burns' ? 'burns' : 'reserves';
  const [p, bn] = await Promise.all([api('/proofs'), api('/burns')]);
  const ch = S.stats.chains;
  const STEP = { queued: 'Reserve moving', transferred: 'In burn wallet', bridging: 'Bridging to Robinhood', bridged: 'Buying $臭企鹅', burned: 'Burned', failed: 'Failed' };
  const txl = (base, h, label) => h ? `<a class="mono" style="letter-spacing:0;text-decoration:underline" target="_blank" rel="noopener" href="${base}/tx/${esc(h)}">${label} ↗</a>` : '<span class="mu">—</span>';
  const statusTxt = !bn.token
    ? `<b style="color:var(--tx)">Waiting for the $臭企鹅 listing on Robinhood Chain.</b> The reserve keeps growing; the first burn spends all of it the moment the pool is live.`
    : bn.auto
      ? `<b style="color:var(--tx)">Auto-burn is on.</b> Every ${bn.intervalH}h, when the reserve is at least ${bn.minZro} ZRO, up to ${bn.maxZro.toLocaleString()} ZRO is burned.${bn.nextAutoAt ? ` Next window: ${new Date(Math.max(bn.nextAutoAt, Date.now())).toUTCString().slice(5, 22)} UTC.` : ''}`
      : '<b style="color:var(--tx)">Auto-burn is paused.</b> Burns are triggered manually by the team.';

  app.innerHTML = `
  <section class="wrap page">
    <div class="page-h"><div><h1>Proofs</h1><p>What Rookery owes its users, where the ZRO sits, and every $臭企鹅 burn.</p></div></div>
    <div class="panel" style="margin-bottom:18px"><div class="tabs-h">
      <a href="#/proofs" class="${tab === 'reserves' ? 'on' : ''}" style="padding:9px 13px;border-radius:9px;font-weight:600;font-size:13px;${tab === 'reserves' ? 'background:var(--panel2)' : 'color:var(--tx2)'}">Reserves</a>
      <a href="#/proofs/burns" class="${tab === 'burns' ? 'on' : ''}" style="padding:9px 13px;border-radius:9px;font-weight:600;font-size:13px;${tab === 'burns' ? 'background:var(--panel2)' : 'color:var(--tx2)'}">Burns <span class="cnt">${bn.jobs.filter(j => j.status === 'burned').length}</span></a>
    </div></div>
    <div id="pv"></div>
  </section>`;

  if (tab === 'reserves') {
    $('#pv').innerHTML = `
    <div class="stats" style="grid-template-columns:repeat(3,1fr);margin:0 0 18px">
      <div><span class="mono mu">ZRO owed to users</span><b>${fmtZ(p.liabilities)} ZRO</b><span class="mu" style="font-size:12px">${fmtUsd(p.liabilitiesUsd)}</span></div>
      <div><span class="mono mu">$臭企鹅 burn reserve (pending)</span><b>${fmtZ(bn.pendingZro)} ZRO</b><span class="mu" style="font-size:12px">${fmtUsd(bn.pendingUsd)}</span></div>
      <div><span class="mono mu">Latest Merkle root</span><b style="font-size:13px;font-family:var(--mono);word-break:break-all">${p.root ? esc(p.root.slice(0, 24)) + '…' : 'Not published yet'}</b></div>
    </div>
    <div class="panel pb">
      <h3 style="font-size:16px;margin-bottom:6px">Hot wallet</h3>
      <p class="mu" style="font-size:13px;margin-bottom:12px">Pays withdrawals and funds the burns. Rule: its ZRO must cover everything owed to users plus the pending burn reserve.</p>
      <div class="addr">${esc(p.hotWallet || 'Not configured')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${p.hotWallet ? Object.values(ch).map(c => `<a class="btn sm ghost" target="_blank" rel="noopener" href="${c.explorer}/token/${p.zroToken}?a=${p.hotWallet}">${esc(c.label)} ↗</a>`).join('') : ''}</div>
    </div>`;
    return;
  }

  $('#pv').innerHTML = `
    <div class="stats" style="grid-template-columns:repeat(4,1fr);margin:0 0 18px">
      <div><span class="mono mu">Pending reserve</span><b>${fmtZ(bn.pendingZro)} ZRO</b><span class="mu" style="font-size:12px">${fmtUsd(bn.pendingUsd)}</span></div>
      <div><span class="mono mu">ZRO spent on burns</span><b>${fmtZ(bn.totalZroBurned)} ZRO</b></div>
      <div><span class="mono mu">$臭企鹅 burned</span><b>${fmtT(bn.totalTokensBurned)}</b></div>
      <div><span class="mono mu">Burns</span><b>${bn.jobs.filter(j => j.status === 'burned').length}</b></div>
    </div>
    <div class="peng" style="margin:0 0 18px;grid-template-columns:280px 1fr">
      <img src="/assets/penguin/sticky.webp" alt="">
      <div class="peng-b" style="padding:24px">
        <span class="mono mu">How a burn works</span>
        <div class="flow" style="grid-template-columns:repeat(4,1fr)">
          <div><span class="n">01</span><b>Reserve</b><span>0.5% of every trade, in ZRO.</span></div>
          <div><span class="n">02</span><b>Burn wallet</b><span>ZRO moves from the hot wallet on ${esc(bn.sourceLabel || 'Arbitrum')}.</span></div>
          <div><span class="n">03</span><b>Bridge</b><span>Relay swaps ZRO into ETH on Robinhood Chain.</span></div>
          <div><span class="n">04</span><b>Buy & burn</b><span>Uniswap buys $臭企鹅 straight into the dead address.</span></div>
        </div>
        <p style="font-size:13.5px">${statusTxt}</p>
      </div>
    </div>
    <div class="wallet" style="margin-bottom:18px">
      <div class="panel pb"><span class="mono mu">Burn wallet</span><div class="addr" style="margin-top:10px">${esc(bn.burnWallet || 'Not configured')}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${bn.burnWallet ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="${bn.explorers.source}/address/${bn.burnWallet}">${esc(bn.sourceLabel)} ↗</a><a class="btn sm ghost" target="_blank" rel="noopener" href="${bn.explorers.robinhood}/address/${bn.burnWallet}">Robinhood Chain ↗</a>` : ''}</div></div>
      <div class="panel pb"><span class="mono mu">$臭企鹅 on Robinhood Chain</span><div class="addr" style="margin-top:10px">${bn.token ? esc(bn.token) : 'Not listed yet'}</div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${bn.token ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="${bn.explorers.robinhood}/token/${bn.token}">Token ↗</a><a class="btn sm ghost" target="_blank" rel="noopener" href="${bn.explorers.robinhood}/token/${bn.token}?a=${bn.dead}">Burned at dEaD ↗</a>` : ''}</div></div>
    </div>
    <div class="panel"><div class="panel-h"><h3>Burn history</h3></div>
      <div style="overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>Status</th><th class="r">ZRO</th><th class="r">ETH used</th><th class="r">$臭企鹅 burned</th><th>Reserve move</th><th>Bridge</th><th>Burn tx</th><th class="r">When</th></tr></thead><tbody>
      ${bn.jobs.length ? bn.jobs.map(j => `<tr>
        <td class="mu">${j.id}</td>
        <td><span class="st-tag ${j.status === 'burned' ? 'confirmed' : j.status === 'failed' ? 'failed' : ''}">${esc(STEP[j.status] || j.status)}</span>${j.note && j.status !== 'burned' ? `<div class="mu" style="font-size:11px;margin-top:4px;white-space:normal;max-width:240px">${esc(j.note)}</div>` : ''}</td>
        <td class="r">${fmtZ(j.zro)}</td><td class="r">${B(j.ethIn) > 0n ? fmtZ(j.ethIn, 5) : '—'}</td><td class="r"><b>${B(j.tokensBurned) > 0n ? fmtT(j.tokensBurned) : '—'}</b></td>
        <td>${txl(bn.explorers.source, j.txTransfer, 'transfer')}</td><td>${txl(bn.explorers.source, j.txBridge, 'relay')}</td><td>${txl(bn.explorers.robinhood, j.txBurn, 'burn')}</td>
        <td class="r mu">${ago(j.updated)}</td></tr>`).join('')
      : `<tr><td colspan="9"><div class="empty" style="border:0"><img src="/assets/penguin/t17.webp" alt="">No burns yet. The reserve is growing: <b style="color:var(--tx)">${fmtZ(bn.pendingZro)} ZRO</b> waiting for the first one.</div></td></tr>`}
      </tbody></table></div>
    </div>`;
  if (bn.jobs.some(j => !['burned', 'failed'].includes(j.status))) setTimer(() => { if (location.hash.startsWith('#/proofs/burns')) viewProofs('burns'); }, 15000);
}
