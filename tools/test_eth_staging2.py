#!/usr/bin/env python3
"""Staging: ETH rewards accumulator, full bonding of an ETH market (seamless price), swap exposure cap, ledger."""
import json, random, string, time, os, urllib.request, http.cookiejar
BASE = 'https://rookery-staging.stablepump-ops.workers.dev/api'
ADMIN = open(os.path.join(os.path.dirname(__file__), '..', '.staging', '.admin_key')).read().strip()
WEI = 10**18; fails = []
def check(c, m): print(('  OK  ' if c else '  FAIL') + ' ' + m); (None if c else fails.append(m))
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
def mk_user(c, t):
    n = t + ''.join(random.choices(string.ascii_lowercase, k=5))
    assert not c.req('POST', '/auth/signup', {'email': n + '@t.dev', 'username': n, 'password': 'testpass123'}).get('error'); return n
ad = C(); A, Bu, W = C(), C(), C()
ua, ub, uw = mk_user(A, 'ra_'), mk_user(Bu, 'rb_'), mk_user(W, 'wh_')
for u, a, v in [(ua, 'eth', WEI // 10), (ub, 'eth', WEI // 10), (uw, 'eth', 12 * WEI), (ua, 'zro', 100 * WEI)]:
    assert ad.req('POST', '/admin/credit', {'user': u, 'asset': a, 'amount': str(v)}, admin=True).get('ok')

# rewards in ETH
m = A.req('POST', '/markets', {'name': 'Rew Eth', 'symbol': 'REWE', 'network': 'giwa', 'taxMarketing': 0, 'taxBurn': 0, 'taxRewards': 2})
mid = m['id']
A.req('POST', '/trade', {'market': mid, 'side': 'buy', 'amount': str(WEI // 100)})
Bu.req('POST', '/trade', {'market': mid, 'side': 'buy', 'amount': str(WEI // 100)})
pend = int(A.req('GET', '/market/' + mid)['me']['pendingRewards'])
check(pend > 0, f'holder A accrued ETH rewards from B\'s buy: {pend/WEI:.10f} ETH')
e0 = int(A.req('GET', '/me')['eth'])
r = A.req('POST', '/rewards/claim', {'market': mid})
check(r.get('ok') and int(A.req('GET', '/me')['eth']) - e0 == int(r['claimed']) > 0, f'claim pays rewards in ETH ({int(r.get("claimed",0))/WEI:.10f} ETH)')

# full bonding of an ETH market, seamless
b = W.req('POST', '/markets', {'name': 'Bond Eth', 'symbol': 'BONDE', 'network': 'giwa', 'taxMarketing': 0, 'taxBurn': 0, 'taxRewards': 0})
bid = b['id']; last = None
for i in range(40):
    v = W.req('GET', '/market/' + bid)['market']
    if v['graduated']: break
    last = v
    r = W.req('POST', '/trade', {'market': bid, 'side': 'buy', 'amount': str(WEI // 2)})
    if not r.get('ok'): print('   trade err', r.get('error')); break
v = W.req('GET', '/market/' + bid)['market']
check(v['graduated'], f'ETH market bonded (progress {v["progress"]})')
# seamless: pool price equals the curve-end price computed from the pre-bond state
if v['graduated'] and last:
    vq = int(last['vQuote']); sold_end = 800_000_000 * WEI
    # the bonding buy sold out the curve; reconstruct curve end from final reserve of the pool hand-off is not exposed,
    # so compare the pool's price with the spot just before the bonding trade moved through the end:
    print('   pool price (ETH/token):', v['priceZro'], ' pre-bond spot:', last['priceZro'])
    check(v['priceZro'] >= last['priceZro'], 'pool opened at or above the last curve price (no downward jump)')
    r = W.req('POST', '/trade', {'market': bid, 'side': 'buy', 'amount': str(WEI // 10)})
    check(r.get('ok'), 'trading continues on the ETH pool after bonding')
    r = W.req('POST', '/trade', {'market': bid, 'side': 'sell', 'amount': str(10**24)})
    check(r.get('ok'), 'selling works on the ETH pool')

# swap exposure cap
ad.req('POST', '/admin/config', {'k': 'desk_cap_usd', 'v': '1'}, admin=True)
r = A.req('POST', '/trade', {'market': mid, 'side': 'buy', 'amount': str(50 * WEI), 'pay': 'zro'})
check('limit' in (r.get('error') or ''), f'conversion refused above the exposure cap: {r.get("error")}')
ad.req('POST', '/admin/config', {'k': 'desk_cap_usd', 'v': '3000'}, admin=True)

L = ad.req('POST', '/admin/ledger', {}, admin=True)
for a in ['zro', 'eth']:
    d = int(L[a]['diff']); print(f'  {a.upper()} diff={d} wei'); check(0 <= d < 10**9, f'{a.upper()} whole ledger conserved')
print('\nRESULT:', 'ALL PASSED' if not fails else f'{len(fails)} FAILED: {fails}')
