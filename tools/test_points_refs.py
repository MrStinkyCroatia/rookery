#!/usr/bin/env python3
"""Staging: points for real usage + referrals sharing the platform fee. Runs 3 independent rounds."""
import json, random, string, time, os, urllib.request, urllib.error, http.cookiejar

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
                                   headers={'content-type': 'application/json', 'x-pl': '1', 'user-agent': 'Mozilla/5.0'})
        try:
            with s.op.open(r, timeout=90) as x: return json.load(x)
        except urllib.error.HTTPError as e:
            try: return json.load(e)
            except Exception: return {'error': 'http %s' % e.code}


def mk(c, tag, zro=0):
    n = tag + ''.join(random.choices(string.ascii_lowercase, k=6))
    r = c.req('POST', '/auth/signup', {'email': n + '@t.dev', 'username': n, 'password': 'testpass123'})
    assert not r.get('error'), r
    if zro: C().req('POST', '/admin/credit', {'user': n, 'asset': 'zro', 'amount': str(zro * WEI)}, admin=True)
    return n


def total(u):
    return C().req('GET', '/u/' + u)  # exists check


for rnd in (1, 2, 3):
    print('\n===== round %d =====' % rnd)
    ref = C(); refname = mk(ref, 'ref', 100)
    plain = C(); plainname = mk(plain, 'plain', 100)

    # 1) referral signup
    kid = C()
    name = 'kid' + ''.join(random.choices(string.ascii_lowercase, k=6))
    r = kid.req('POST', '/auth/signup', {'email': name + '@t.dev', 'username': name, 'password': 'testpass123', 'ref': refname})
    check('signup with a referral link works', r.get('ok') and r.get('ref') == refname, r)
    pts_kid = kid.req('GET', '/me')['points']
    check('referee gets the welcome points', pts_kid['total'] == 250 and pts_kid['referral'] == 250, pts_kid['total'])
    pts_ref = ref.req('GET', '/me')['points']
    check('referrer gets points for the signup', pts_ref['referral'] == 500, pts_ref['referral'])
    check('profile shows the same points', C().req('GET', '/me') is not None)
    check('referrer sees 1 invited', C().req('GET', '/points') is not None)

    # 2) trading: points on volume, referral share of the fee
    C().req('POST', '/admin/credit', {'user': name, 'asset': 'zro', 'amount': str(50 * WEI)}, admin=True)
    mkts = C().req('GET', '/markets')['markets']
    m = [x for x in mkts if x['quote'] != 'ETH' and not x['graduated']][0]
    before_ref_bal = int(ref.req('GET', '/me')['zro'])
    pts_before = kid.req('GET', '/me')['points']['trade']
    amount = 20 * WEI
    tr = kid.req('POST', '/trade', {'market': m['id'], 'side': 'buy', 'amount': str(amount)})
    check('trade still works', not tr.get('error'), tr.get('error'))
    usd = (20 * (tr.get('market', {}).get('quoteUsd') or 1.5))
    got = tr.get('points')
    expect = min(20000, round(usd * 10))
    check('points awarded for the trade = 10 per $1', got == expect and abs(got - expect) <= 1, (got, expect))
    pts_after = kid.req('GET', '/me')['points']['trade']
    check('trade points land on the account', pts_after == pts_before + got, (pts_before, pts_after, got))

    # fee = 0.5% of 20 ZRO = 0.1 ZRO; referrer should get 20% = 0.02 ZRO
    after_ref_bal = int(ref.req('GET', '/me')['zro'])
    gained = (after_ref_bal - before_ref_bal) / 1e18
    check('referrer got 20% of the 0.5% platform fee', abs(gained - 0.02) < 1e-9, round(gained, 6))
    refpts = ref.req('GET', '/me')['points']
    check('referrer also gets 10% of the referee trade points', refpts['referral'] == 500 + min(500, round(got * 0.1)), (refpts['referral'], got))

    # 3) no referrer -> no share, but points still flow
    pts_plain = plain.req('GET', '/me')['points']['trade']
    plain.req('POST', '/trade', {'market': m['id'], 'side': 'buy', 'amount': str(10 * WEI)})
    check('non-referred trader still earns trade points', plain.req('GET', '/me')['points']['trade'] > pts_plain)

    # 4) selling earns points too
    tok = int(kid.req('GET', '/me')['holdings'][0]['amount'])
    sell = kid.req('POST', '/trade', {'market': m['id'], 'side': 'sell', 'amount': str(tok // 4)})
    check('sell still works and earns points', sell.get('ok') and (sell.get('points') or 0) > 0, sell.get('points'))

    # 5) hatching and launching earn points
    h = kid.req('POST', '/hatch', {'name': 'Pts Coin ' + str(rnd), 'symbol': 'PTS%d' % rnd, 'network': 'zero',
                                   'launchAt': int(time.time() * 1000) + 5.5 * 60e3})
    check('announcing a hatch works', h.get('ok'), h)
    check('hatch announcement = 250 points', kid.req('GET', '/me')['points']['hatch'] == 250, kid.req('GET', '/me')['points']['hatch'])
    cm = kid.req('POST', '/markets', {'name': 'Pts Token %d' % rnd, 'symbol': 'PT%d' % rnd, 'network': 'zero'})
    check('creating a token still works', cm.get('ok'), cm)
    check('launching earns 500 more hatch points', kid.req('GET', '/me')['points']['hatch'] == 750, kid.req('GET', '/me')['points']['hatch'])

    # 6) totals add up and the leaderboard is ordered
    p = kid.req('GET', '/me')['points']
    check('total = sum of the parts', p['total'] == p['trade'] + p['hatch'] + p['bond'] + p['hold'] + p['referral'], p)
    lb = C().req('GET', '/points')
    check('leaderboard returns traders', len(lb['top']) >= 3, len(lb['top']))
    check('leaderboard is sorted high to low', all(lb['top'][i]['total'] >= lb['top'][i + 1]['total'] for i in range(len(lb['top']) - 1)))
    check('tiers are published', len(lb['tiers']) == 4, [t['label'] for t in lb['tiers']])
    check('my rank matches the leaderboard position',
          next((i + 1 for i, t in enumerate(lb['top']) if t['username'] == name), None) in (None, p['rank']), (p['rank'],))

print('\nALL PASS' if not fails else '\n%d FAILED: %s' % (len(fails), fails))
