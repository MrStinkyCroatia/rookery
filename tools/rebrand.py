import os
os.chdir('/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch/site')
MARK = '<img src="/assets/penguin/mark.webp" alt="" style="width:14px;height:20px;filter:invert(1)">'

def sub(path, pairs):
    s = open(path).read()
    for a, b in pairs:
        assert a in s, f'{path}: missing -> {a[:90]}'
        s = s.replace(a, b)
    open(path, 'w').write(s)

sub('index.html', [
    ('<title>PreLaunch — launch before the chain does</title>', '<title>Rookery — the Stinky Penguin launchpad</title>'),
    ('PreLaunch is the launchpad for networks that are not live yet. Trade tokens for Zero (LayerZero) and GIWA today with ZRO, migrate 1:1 at mainnet. 0.5% of every trade buys and burns pLAUNCH.',
     'Rookery is the Stinky Penguin launchpad for networks that are not live yet. Trade tokens for Zero (LayerZero) and GIWA today with ZRO, migrate 1:1 at mainnet. 0.5% of every trade buys and burns $臭企鹅.'),
    ('<meta property="og:title" content="PreLaunch — launch before the chain does">', '<meta property="og:title" content="Rookery — where tokens hatch before their chain">'),
    ('Trade tokens for Zero and GIWA before mainnet. Priced in ZRO, shown in $. 0.5% of every trade burns pLAUNCH.',
     'The Stinky Penguin launchpad. Trade tokens for Zero and GIWA before mainnet. 0.5% of every trade burns $臭企鹅.'),
    ('<a class="brand" href="#/"><img src="/assets/logo-64.png" alt="">PreLaunch<em>.</em></a>\n    <nav class="nav">',
     '<a class="brand" href="#/"><img src="/assets/logo-64.png" alt="">Rookery<em>.</em><span class="by">by Stinky Penguin</span></a>\n    <nav class="nav">'),
    ('<span class="pill hide-m num" id="burnPill" title="0.5% of every trade, reserved to buy & burn pLAUNCH"><span class="mono">pLAUNCH BURN</span><b id="burnPx">—</b></span>',
     '<a class="pill hide-m num" id="burnPill" href="#/docs" title="0.5% of every trade buys &amp; burns $臭企鹅">' + MARK + '<span class="mono">$臭企鹅 BURN</span><b id="burnPx">—</b></a>'),
    ("<a class=\"brand\" href=\"#/\"><img src=\"/assets/logo-64.png\" alt=\"\">PreLaunch<em>.</em></a>\n      <p style=\"margin-top:14px\">PreLaunch is a launchpad for networks that are not live yet. Trading happens on PreLaunch's internal ledger and settles in ZRO; at each network's mainnet, balances migrate 1:1 on-chain. 0.5% of every trade is reserved to buy and burn pLAUNCH.",
     "<a class=\"brand\" href=\"#/\"><img src=\"/assets/logo-64.png\" alt=\"\">Rookery<em>.</em><span class=\"by\">by Stinky Penguin</span></a>\n      <p style=\"margin-top:14px\">Rookery is the Stinky Penguin launchpad for networks that are not live yet. Trading happens on Rookery's internal ledger and settles in ZRO; at each network's mainnet, balances migrate 1:1 on-chain. 0.5% of every trade is used to buy and burn $臭企鹅, the Stinky Penguin token. Parody mascot, not affiliated with Bryan Pellegrino."),
    ('<nav><a href="#/docs">Docs</a><a href="#/proofs">Proofs</a><a href="https://x.com/StinkyPenguinL0" target="_blank" rel="noopener">𝕏</a></nav>',
     '<nav><a href="#/docs">Docs</a><a href="#/proofs">Proofs</a><a href="https://stinkypenguin.xyz" target="_blank" rel="noopener">Stinky Penguin</a><a href="https://x.com/StinkyPenguinL0" target="_blank" rel="noopener">𝕏</a></nav>'),
])

s = open('styles.css').read()
s += '''
.brand .by{font:500 9.5px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--mu);margin-left:4px;padding:3px 7px;border:1px solid var(--line2);border-radius:6px}
.peng{display:grid;grid-template-columns:1.1fr 1fr;border:1px solid var(--line);border-radius:20px;overflow:hidden;background:var(--panel);margin-top:34px}
.peng img{width:100%;height:100%;object-fit:cover;filter:grayscale(1)}
.peng-b{padding:34px;display:flex;flex-direction:column;justify-content:center;gap:14px}
.peng-b h2{font-size:34px;letter-spacing:-.045em;line-height:1.02}
.peng-b h2 span{color:var(--mu)}
.peng-b p{color:var(--tx2);font-size:15px;line-height:1.65}
.peng-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}
.peng-strip img{border-radius:12px;border:1px solid var(--line);aspect-ratio:16/9;object-fit:cover;filter:grayscale(1)}
.empty img{width:220px;margin:0 auto 14px;border-radius:14px;filter:grayscale(1)}
@media (max-width:900px){.peng{grid-template-columns:1fr}.peng-strip{grid-template-columns:1fr 1fr}.brand .by{display:none}}
'''
open('styles.css', 'w').write(s)

PENG = '''  <section class="wrap">
    <div class="peng">
      <img src="/assets/penguin/allin.webp" alt="Stinky Penguin going all-in">
      <div class="peng-b">
        <span class="mono mu">Powered by the penguin</span>
        <h2>Every trade feeds<br><span>the penguin.</span></h2>
        <p>Rookery is the launchpad of Stinky Penguin. <b style="color:var(--tx)">0.5% of every buy and sell</b> on any token here goes to buying and burning <b style="color:var(--tx)">$臭企鹅</b>. More launches, more volume, fewer penguins.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="https://stinkypenguin.xyz" target="_blank" rel="noopener">Meet the penguin</a><a class="btn ghost" href="#/docs">Burn mechanics</a></div>
        <span class="mono mu">Burn reserve now · <b style="color:var(--tx)">${fmtUsd(st.plaunchBurnUsd)}</b></span>
      </div>
    </div>
  </section>
  <section class="wrap" style="padding-bottom:40px">
    <div class="bar-row">'''

DOCS_BURN = '''<h2 id="plaunch">$臭企鹅 buy &amp; burn</h2>
      <div class="fig" style="display:grid;grid-template-columns:160px 1fr;gap:18px;align-items:center">
        <img src="/assets/penguin/sticky.webp" alt="" style="border-radius:12px;filter:grayscale(1)">
        <p style="margin:0"><b style="color:var(--tx)">Stinky Penguin ($臭企鹅)</b> is the mascot and the token behind Rookery. It lives on Robinhood Chain as a LayerZero OFT, with a 1:1 bridge to Zero at mainnet. <a href="https://stinkypenguin.xyz" target="_blank" rel="noopener" style="text-decoration:underline;color:var(--tx)">stinkypenguin.xyz</a></p>
      </div>
      <p>The 0.5% platform fee from every trade on Rookery, on every token and every network, is collected in ZRO into the <b>$臭企鹅 burn reserve</b> (live in the header, now <b>${fmtUsd(S.stats.plaunchBurnUsd)}</b>).</p>
      <ol>
        <li>The reserve accumulates in ZRO from every buy and sell.</li>
        <li>On a fixed schedule it is used to market-buy $臭企鹅 on Robinhood Chain.</li>
        <li>Every bought $臭企鹅 is sent to the dead address and permanently burned. Each burn transaction is published on the Proofs page.</li>
      </ol>
      <p>Until $臭企鹅 trading opens, the reserve simply grows. More launches and more volume on Rookery means more penguins burned.</p>
      <div class="peng-strip"><img src="/assets/penguin/allin.webp" alt=""><img src="/assets/penguin/atlas.webp" alt=""><img src="/assets/penguin/t17.webp" alt=""><img src="/assets/penguin/stay.webp" alt=""></div>

      '''

s = open('app.js').read()
start = s.index('<h2 id="plaunch">pLAUNCH</h2>'); end = s.index('<h2 id="safety">')
s = s[:start] + DOCS_BURN + s[end:]
open('app.js', 'w').write(s)

sub('app.js', [
    ("document.title = 'PreLaunch — launch before the chain does';", "document.title = 'Rookery — the Stinky Penguin launchpad';"),
    ('<span class="kicker"><span class="dot soon"></span>Pre-mainnet launchpad · priced in ZRO</span>\n        <h1>Launch before<br><span>the chain does.</span></h1>',
     '<span class="kicker"><img src="/assets/penguin/mark.webp" alt="" style="width:12px;height:17px;filter:invert(1)">The Stinky Penguin launchpad · priced in ZRO</span>\n        <h1>Hatch before<br><span>the chain does.</span></h1>'),
    ('<div class="burn"><span class="mono mu">pLAUNCH burn reserve</span><b>${fmtUsd(st.plaunchBurnUsd)}</b></div>',
     '<div class="burn"><span class="mono mu">$臭企鹅 burn reserve</span><b>' + MARK + '${fmtUsd(st.plaunchBurnUsd)}</b></div>'),
    ('  <section class="wrap" style="padding-bottom:40px">\n    <div class="bar-row">', PENG),
    ("""`<div class="empty" style="grid-column:1/-1">No tokens${S.net ? ' on this network' : ''} yet. <a href="#/create" style="text-decoration:underline;color:var(--tx)">Create the first one</a>.</div>`""",
     """`<div class="empty" style="grid-column:1/-1"><img src="/assets/penguin/stay.webp" alt="">The rookery is quiet${S.net ? ' on this network' : ''}. <a href="#/create" style="text-decoration:underline;color:var(--tx)">Hatch the first token</a>.</div>`"""),
    ("document.title = 'Trading — PreLaunch';", "document.title = 'Trading — Rookery';"),
    ("document.title = `${m.symbol} ${fmtUsd(m.priceUsd)} — PreLaunch`;", "document.title = `${m.symbol} ${fmtUsd(m.priceUsd)} — Rookery`;"),
    ('<div class="tax-row"><span class="tax-dot" style="background:#fff"></span>pLAUNCH buy & burn<b>0.5%</b></div>',
     '<div class="tax-row"><span class="tax-dot" style="background:#fff"></span>$臭企鹅 buy &amp; burn (Stinky Penguin)<b>0.5%</b></div>'),
    ("document.title = 'Create a token — PreLaunch';", "document.title = 'Create a token — Rookery';"),
    ("<p>Launch on a network before its mainnet. Free to create, trades in ZRO, migrates 1:1 at launch.</p>",
     "<p>Hatch a token for a network before its mainnet. Free to create, trades in ZRO, migrates 1:1 at launch. 0.5% of every trade burns $臭企鹅.</p>"),
    ("Applied to every buy and sell on top of PreLaunch's 0.5% pLAUNCH burn. Max 5% each, 10% total.",
     "Applied to every buy and sell on top of Rookery's 0.5% $臭企鹅 burn. Max 5% each, 10% total."),
    ("· 0.5% pLAUNCH burn ·", "· 0.5% $臭企鹅 burn ·"),
    ("document.title = 'Wallet — PreLaunch';", "document.title = 'Wallet — Rookery';"),
    ("Sent instantly from the PreLaunch hot wallet. Network gas is on us.", "Sent instantly from the Rookery hot wallet. Network gas is on us."),
    ("document.title = `${p.username} — PreLaunch`;", "document.title = `${p.username} — Rookery`;"),
    ("document.title = (mode === 'signup' ? 'Sign up' : 'Log in') + ' — PreLaunch';", "document.title = (mode === 'signup' ? 'Sign up' : 'Log in') + ' — Rookery';"),
    ("<h1>${mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>", "<h1>${mode === 'signup' ? 'Join the rookery' : 'Welcome back'}</h1>"),
    ("document.title = 'Docs — PreLaunch';", "document.title = 'Docs — Rookery';"),
    ('<a href="#/docs" data-s="plaunch">pLAUNCH</a>', '<a href="#/docs" data-s="plaunch">$臭企鹅 burn</a>'),
    ('<h1 id="overview">How PreLaunch works</h1>\n      <p>PreLaunch is a launchpad for blockchains that are announced but not live yet.',
     '<h1 id="overview">How Rookery works</h1>\n      <p>Rookery is the Stinky Penguin launchpad for blockchains that are announced but not live yet. In a rookery penguins hatch; here tokens hatch before their chain exists.'),
    ('<p>PreLaunch only lists networks that are not on mainnet yet.', '<p>Rookery only lists networks that are not on mainnet yet.'),
    ('Withdrawals</b> are sent instantly from the PreLaunch hot wallet on the network you choose. Gas is paid by PreLaunch.',
     'Withdrawals</b> are sent instantly from the Rookery hot wallet on the network you choose. Gas is paid by Rookery.'),
    ('<div class="tax-row"><span class="tax-dot" style="background:#fff"></span>pLAUNCH buy & burn — platform, every trade<b>0.5%</b></div>',
     '<div class="tax-row"><span class="tax-dot" style="background:#fff"></span>$臭企鹅 buy &amp; burn — platform, every trade<b>0.5%</b></div>'),
    ("PreLaunch holds deposits in custody until you withdraw. Only use money you can afford to lose. PreLaunch is not affiliated with LayerZero Labs, the LayerZero Foundation, Upbit or Dunamu.",
     "Rookery holds deposits in custody until you withdraw. Only use money you can afford to lose. Rookery and Stinky Penguin are not affiliated with LayerZero Labs, the LayerZero Foundation, Bryan Pellegrino, Upbit, Dunamu or Robinhood."),
    ("document.title = 'Proofs — PreLaunch';", "document.title = 'Proofs — Rookery';"),
    ("<p>What PreLaunch owes its users, and where the ZRO sits.</p>", "<p>What Rookery owes its users, and where the ZRO sits.</p>"),
    ('<div><span class="mono mu">pLAUNCH burn reserve</span><b>${fmtZ(p.plaunchBurn)} ZRO</b></div>', '<div><span class="mono mu">$臭企鹅 burn reserve</span><b>${fmtZ(p.plaunchBurn)} ZRO</b></div>'),
])
print('ok')
