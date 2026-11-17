#!/usr/bin/env python3
"""Staging test: R2 backup/restore round-trip, duplicate-token guard, wallet PnL, creator earnings."""
import json, random, string, sys, time, urllib.request, urllib.error, http.cookiejar

BASE = sys.argv[1] if len(sys.argv) > 1 else 'https://rookery-staging.stablepump-ops.workers.dev/api'
KEY = open('/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch/.staging/.admin_key').read().strip()
WEI = 10 ** 18
ok_all = True


def check(name, cond, extra=''):
    global ok_all
    ok_all &= bool(cond)
    print(('PASS ' if cond else 'FAIL ') + name + (('  ' + str(extra)) if extra else ''))


class C:
    def __init__(self): self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def req(self, method, path, body=None):
        h = {'content-type': 'application/json', 'x-pl': '1', 'user-agent': 't'}
        r = urllib.request.Request(BASE + path, method=method, headers=h, data=json.dumps(body).encode() if body is not None else None)
        try:
            with self.op.open(r, timeout=120) as res: return json.loads(res.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read() or b'{}')


def admin(path, extra=None):
    return C().req('POST', '/admin/' + path, {'key': KEY, **(extra or {})})


def user():
    c = C(); n = 'bk_' + ''.join(random.choices(string.ascii_lowercase, k=6))
    r = c.req('POST', '/auth/signup', {'email': n + '@t.dev', 'username': n, 'password': 'testpass123'})
    assert not r.get('error'), r
    return c, n


# ── 1. backup → change → restore → state matches the backup ──
b1 = admin('backup')
check('manual backup written to R2', b1.get('ok') and b1.get('bytes', 0) > 0, {k: b1.get(k) for k in ('key', 'bytes', 'rawBytes', 'ms')})
mk_before = C().req('GET', '/markets')['markets']
ids_before = sorted(m['id'] for m in mk_before)
lst = admin('backups')
check('backup listed', any(x['key'] == b1.get('key') for x in lst.get('backups', [])), len(lst.get('backups', [])))

creator, cname = user()
admin('credit', {'user': cname, 'asset': 'zro', 'amount': str(200 * WEI)})
admin('credit', {'user': cname, 'asset': 'eth', 'amount': str(WEI // 20)})
r1 = creator.req('POST', '/markets', {'name': 'Dup Test Coin', 'symbol': 'DUPT', 'network': 'zero', 'taxMarketing': 2})
check('first create ok', r1.get('ok'), r1)
# ── 2. duplicate guard ──
r2 = creator.req('POST', '/markets', {'name': 'dup test coin ', 'symbol': 'DUPT', 'network': 'zero'})
check('same name within 2 min is rejected', not r2.get('ok') and 'Wait 2 minutes' in str(r2.get('error')), r2.get('error'))
r3 = creator.req('POST', '/markets', {'name': 'Another Coin', 'symbol': 'ANO', 'network': 'zero'})
check('different name is still allowed', r3.get('ok'), r3)
other, oname = user()
r4 = other.req('POST', '/markets', {'name': 'Dup Test Coin', 'symbol': 'DUPT', 'network': 'zero'})
check('another creator may use the same name', r4.get('ok'), r4)

# ── 3. trades → creator earnings + wallet PnL ──
trader, tname = user()
admin('credit', {'user': tname, 'asset': 'zro', 'amount': str(300 * WEI)})
admin('credit', {'user': tname, 'asset': 'eth', 'amount': str(WEI // 20)})
mid = r1['id']
b = trader.req('POST', '/trade', {'market': mid, 'side': 'buy', 'amount': str(100 * WEI)})
check('buy 100 ZRO', b.get('ok') or b.get('tokens'), b.get('error'))
me = trader.req('GET', '/me')
toks = next(h for h in me['holdings'] if h['id'] == mid)['amount']
s = trader.req('POST', '/trade', {'market': mid, 'side': 'sell', 'amount': str(int(toks) // 2)})
check('sell half', s.get('ok') or s.get('zro'), s.get('error'))
# second token, bought with ETH (cross-asset), then fully sold -> closed position
b2 = trader.req('POST', '/trade', {'market': r3['id'], 'side': 'buy', 'amount': str(WEI // 100), 'pay': 'eth'})
check('buy ZRO token paying ETH', b2.get('ok') or b2.get('tokens'), b2.get('error'))
me = trader.req('GET', '/me')
t2 = next(h for h in me['holdings'] if h['id'] == r3['id'])['amount']
s2 = trader.req('POST', '/trade', {'market': r3['id'], 'side': 'sell', 'amount': t2})
check('sell all of token 2', s2.get('ok') or s2.get('zro'), s2.get('error'))

me0 = trader.req('GET', '/me')
check('/me without ?pnl stays light (pnl null)', me0.get('pnl') is None)
me = trader.req('GET', '/me?pnl=1')
P = me['pnl']
print('     wallet pnl:', json.dumps(P))
# cross-check against the per-token position endpoint on the token page
pos1 = trader.req('GET', '/market/' + mid)['me']['pnl']
pos2 = trader.req('GET', '/market/' + r3['id'])['me']['pnl']
zusd = C().req('GET', '/stats')['zroUsd']
exp = (pos1['pnlZro'] + pos2['pnlZro']) * zusd
check('total PnL = sum of token-page PnLs', abs(P['totalUsd'] - exp) < 1e-6 * max(1, abs(exp)) + 1e-9, (P['totalUsd'], exp))
check('2 positions, 1 open, 1 closed', P['positions'] == 2 and abs(P['openUsd'] - pos1['pnlZro'] * zusd) < 1e-6 and abs(P['closedUsd'] - pos2['pnlZro'] * zusd) < 1e-6)
h1 = next(h for h in me['holdings'] if h['id'] == mid)
check('holding row carries its PnL', abs(h1['pnlUsd'] - pos1['pnlZro'] * zusd) < 1e-6, h1.get('pnlUsd'))
check('PnL is negative after fees on a round trip', P['closedUsd'] < 0, P['closedUsd'])

prof = C().req('GET', '/u/' + cname)
E = prof.get('creatorEarned')
m1 = next(m for m in prof['created'] if m['id'] == mid)
exp_mkt = int(m1['mktPaid']) / 1e18
print('     creatorEarned:', E, '| marketing tax paid on', mid, exp_mkt, 'ZRO')
check('creator earnings = marketing tax paid', E and abs(E['zro'] - exp_mkt) < 1e-9 and exp_mkt > 0)
# 2% of 100 ZRO buy + 2% of the half-sell proceeds
cr = creator.req('GET', '/me')
check('creator ZRO balance grew by exactly the earnings', abs(int(cr['zro']) / 1e18 - (200 + exp_mkt)) < 1e-9, int(cr['zro']) / 1e18)

# ── 4. restore the backup taken before all of this ──
rs = admin('restore', {'object': b1['key'], 'confirm': 'RESTORE'})
check('restore ran', rs.get('ok'), {k: rs.get(k) for k in ('key', 'safetyCopy')} if rs.get('ok') else rs)
admin('restart'); time.sleep(6)
ids_after = sorted(m['id'] for m in C().req('GET', '/markets')['markets'])
check('markets identical to the backup', ids_after == ids_before, (len(ids_before), len(ids_after)))
gone = C().req('GET', '/u/' + cname)
check('users created after the backup are gone', 'error' in gone, gone.get('error'))
ld = admin('ledger')
check('ledger still balances after restore', abs(ld['zro']['diffUnits']) < 1e-6 and abs(ld['eth']['diffUnits']) < 1e-9, (ld['zro']['diffUnits'], ld['eth']['diffUnits']))
# and the safety copy can bring the post-test state back
rs2 = admin('restore', {'object': rs['safetyCopy'], 'confirm': 'RESTORE'})
admin('restart'); time.sleep(6)
check('safety copy restores the newer state', rs2.get('ok') and 'error' not in C().req('GET', '/u/' + cname))
bad = admin('restore', {'object': b1['key']})
check('restore without confirm is refused', not bad.get('ok'), bad.get('error'))
print('\nALL PASS' if ok_all else '\nSOME FAILED')
