#!/usr/bin/env python3
"""Staging: badges (early / creator / bonded / diamond) and "hatching soon" (announce -> notify -> launch)."""
import json, random, string, sys, time, os, urllib.request, urllib.error, http.cookiejar

BASE = 'https://rookery-staging.stablepump-ops.workers.dev/api'
ADMIN = open(os.path.join(os.path.dirname(__file__), '..', '.staging', '.admin_key')).read().strip()
WEI = 10 ** 18
fails = []


def check(m, c, extra=None):
    print(('  OK   ' if c else '  FAIL ') + m + ('' if extra is None else '  ' + str(extra)))
    if not c: fails.append(m)


class C:
    def __init__(s): s.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def req(s, meth, path, body=None, admin=False):
        if admin: body = dict(body or {}, key=ADMIN)
        r = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=meth,
                                   headers={'content-type': 'application/json', 'x-pl': '1', 'user-agent': 't'})
        try:
            with s.op.open(r, timeout=90) as x: return json.load(x)
        except urllib.error.HTTPError as e:
            try: return json.load(e)
            except Exception: return {'error': f'http {e.code}'}


def mk(c, tag, zro=0):
    n = tag + ''.join(random.choices(string.ascii_lowercase, k=5))
    r = c.req('POST', '/auth/signup', {'email': n + '@t.dev', 'username': n, 'password': 'testpass123'})
    assert not r.get('error'), r
    if zro: C().req('POST', '/admin/credit', {'user': n, 'asset': 'zro', 'amount': str(zro * WEI)}, admin=True)
    return n


print('\n== badges ==')
boss = C(); name = mk(boss, 'bdg', 400)
me = boss.req('GET', '/me')
check('new account has no creator/diamond badge yet', me['badges'] == ['early'] or me['badges'] == [], me['badges'])
check('early hatcher badge on a low user id', 'early' in me['badges'], me['badges'])

mk_ = boss.req('POST', '/markets', {'name': 'Badge Test', 'symbol': 'BDGT', 'network': 'zero'})
check('creator badge after hatching', 'creator' in boss.req('GET', '/me')['badges'])
prof = C().req('GET', '/u/' + name)
check('profile exposes the same badges', prof.get('badges') == boss.req('GET', '/me')['badges'], prof.get('badges'))

# 25 trades -> Diamond flipper
m = boss.req('POST', '/markets', {'name': 'Flip Test', 'symbol': 'FLIP', 'network': 'zero'})['id']
tr = None
for i in range(25):
    tr = boss.req('POST', '/trade', {'market': m, 'side': 'buy', 'amount': str(WEI)})
    if i == 0 and not (tr.get('tokens') or tr.get('ok')): print('  trade failed:', tr)

b = boss.req('GET', '/me')['badges']
check('diamond flipper after 25 trades', 'diamond' in b, b)

# bonded badge: find a graduated market on staging and check its creator
mkts = C().req('GET', '/markets')['markets']
grad = [x for x in mkts if x.get('graduated')]
if grad:
    who = C().req('GET', '/u/' + grad[0]['creator'])
    check(f"bonded badge for the creator of bonded ${grad[0]['symbol']}", 'bonded' in (who.get('badges') or []), who.get('badges'))
else:
    print('  (no bonded market on staging, skipped)')

# badges on the token page: holders, trades, comments
tk = boss.req('GET', '/market/' + m)
check('holders carry badges', all('badges' in h for h in tk['holders']))
check('trades carry badges', all('badges' in t for t in tk['trades']))
check('my badge shows on my trade', any('diamond' in (t['badges'] or []) for t in tk['trades'] if t['username'] == name))

print('\n== hatching soon ==')
a = C(); aname = mk(a, 'hatch')
r = a.req('POST', '/hatch', {'name': 'Too Soon', 'symbol': 'TS', 'network': 'zero', 'launchAt': int(time.time() * 1000) + 60e3})
check('rejects a launch under 5 minutes', not r.get('ok') and '5 minutes' in str(r.get('error')), r.get('error'))
r = a.req('POST', '/hatch', {'name': 'Too Far', 'symbol': 'TF', 'network': 'zero', 'launchAt': int(time.time() * 1000) + 40 * 864e5})
check('rejects a launch over 30 days', not r.get('ok') and '30 days' in str(r.get('error')), r.get('error'))
r = a.req('POST', '/hatch', {'name': 'No Ticker', 'network': 'zero', 'launchAt': int(time.time() * 1000) + 3600e3})
check('rejects a hatch without a ticker', not r.get('ok'), r.get('error'))

soon = int(time.time() * 1000) + 6 * 60e3          # 6 minutes out, so we can watch it go live
r = a.req('POST', '/hatch', {'name': 'Merlin Two', 'symbol': 'MR2', 'network': 'zero', 'description': 'the sequel', 'launchAt': soon})
check('announce a hatch', r.get('ok') and r.get('id'), r)
hid = r.get('id')
list_ = C().req('GET', '/hatches')['hatches']
row = next((x for x in list_ if x['id'] == hid), None)
check('hatch appears in the public list', bool(row), [x['symbol'] for x in list_])
check('status is upcoming while the countdown runs', row and row['status'] == 'upcoming', row and row['status'])
check('0 waiting at the start', row and row['waiting'] == 0, row and row['waiting'])

watcher = C(); mk(watcher, 'wait')
other = C(); mk(other, 'other', 10)
s1 = watcher.req('POST', '/hatch/sub', {'id': hid})
check('someone signs up for the notification', s1.get('subscribed') is True and s1.get('waiting') == 1, s1)
row = next(x for x in C().req('GET', '/hatches')['hatches'] if x['id'] == hid)
check('waiting count goes up for everyone', row['waiting'] == 1, row['waiting'])
check('subscriber sees it as subscribed', next(x for x in watcher.req('GET', '/hatches')['hatches'] if x['id'] == hid)['subscribed'] is True)
s2 = watcher.req('POST', '/hatch/sub', {'id': hid})
check('tapping again unsubscribes', s2.get('subscribed') is False and s2.get('waiting') == 0, s2)
watcher.req('POST', '/hatch/sub', {'id': hid})       # back on the list
check('creator sees their own hatch flagged', next(x for x in a.req('GET', '/hatches')['hatches'] if x['id'] == hid)['isMine'] is True)
check('/me returns followed hatches for the bell',
      any(h['id'] == hid for h in watcher.req('GET', '/me').get('hatches', [])))

# nobody else can cancel it
check('another user cannot cancel it', not other.req('POST', '/hatch/cancel', {'id': hid}).get('ok'))

print("\n== countdown -> live -> launch ==")
IDF = os.path.join(os.path.dirname(__file__), '.hatch_test')
if '--live' not in sys.argv:
    open(IDF, 'w').write(hid + '\n' + aname)
    print(f'  hatch {hid} created; run this script with --live after the countdown to check the launch')
else:
    hid, aname, = open(IDF).read().split('\n')[:2]
    a = C()
    a.req('POST', '/auth/login', {'email': aname + '@t.dev', 'password': 'testpass123'})
    row = next((x for x in C().req('GET', '/hatches')['hatches'] if x['id'] == hid), None)
    check('status flips to live at the chosen time', row and row['status'] == 'live' and row['secsLeft'] == 0, (row and row['status'], row and row['secsLeft']))
    check('subscriber still on the list when it goes live', row and row['waiting'] >= 1, row and row['waiting'])
    C().req('POST', '/admin/credit', {'user': aname, 'asset': 'zro', 'amount': str(200 * WEI)}, admin=True)
    done = a.req('POST', '/markets', {'name': row['name'], 'symbol': row['symbol'], 'network': row['network'], 'hatchId': hid})
    check('creator launches it from the hatch', done.get('ok') and done.get('id'), done)
    after = C().req('GET', '/hatches')['hatches']
    check('the hatch leaves the "hatching soon" list once launched', not any(x['id'] == hid for x in after))
    mk2 = C().req('GET', '/market/' + done['id'])['market']
    check('the new market carries the announced name and ticker', mk2['name'] == 'Merlin Two' and mk2['symbol'] == 'MR2', (mk2['name'], mk2['symbol']))
    r = a.req('POST', '/hatch', {'name': 'Cancel Me', 'symbol': 'CNL', 'network': 'giwa', 'launchAt': int(time.time() * 1000) + 7200e3})
    check('cancel own hatch', a.req('POST', '/hatch/cancel', {'id': r['id']}).get('ok') and
          not any(x['id'] == r['id'] for x in C().req('GET', '/hatches')['hatches']))

print('\nALL PASS' if not fails else f'\n{len(fails)} FAILED')
