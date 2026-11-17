#!/usr/bin/env python3
"""End-to-end ledger test of ETH support on the STAGING worker (test seed, no real funds).
Checks: ETH-quoted GIWA markets, ZRO markets bought/sold with ETH (one button), ZRO<->ETH conversion,
quote migration keeping the USD price, and exact per-asset conservation of the ledger."""
import json, random, string, sys, time, urllib.request, http.cookiejar, os

BASE = 'https://rookery-staging.stablepump-ops.workers.dev/api'
ADMIN = open(os.path.join(os.path.dirname(__file__), '..', '.staging', '.admin_key')).read().strip()
WEI = 10**18
fails = []

def check(cond, msg):
    print(('  OK  ' if cond else '  FAIL') + ' ' + msg)
    if not cond: fails.append(msg)

class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
    def req(self, method, path, body=None, admin=False):
        url = BASE + path
        if admin: body = dict(body or {}, key=ADMIN)
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(url, data=data, method=method, headers={'content-type': 'application/json', 'x-pl': '1', 'user-agent': 'stg-test'})
        try:
            with self.op.open(r, timeout=60) as resp: return json.load(resp)
        except urllib.error.HTTPError as e:
            try: return json.load(e)
            except Exception: return {'error': f'http {e.code}'}

def user(c, tag):
    name = tag + ''.join(random.choices(string.ascii_lowercase, k=5))
    r = c.req('POST', '/auth/signup', {'email': name + '@test.dev', 'username': name, 'password': 'testpass123'})
    assert not r.get('error'), r
    return name

admin = Client()
A, Bc = Client(), Client()
ua, ub = user(A, 'ta_'), user(Bc, 'tb_')
print('users', ua, ub)

# fund (test credits on staging only)
for u, asset, amt in [(ua, 'zro', 200 * WEI), (ua, 'eth', 5 * WEI // 100), (ub, 'eth', 2 * WEI // 100), (ub, 'zro', 50 * WEI)]:
    r = admin.req('POST', '/admin/credit', {'user': u, 'amount': str(amt), 'asset': asset, 'note': 'staging test'}, admin=True)
    assert r.get('ok'), r
credits = {'zro': 250 * WEI, 'eth': 7 * WEI // 100}

st = admin.req('GET', '/stats')
print('prices: ZRO', st['zroUsd'], 'ETH', st['ethUsd'])

# 1) markets: ZRO (zero) and ETH (giwa); no rewards tax so conservation is exact
mz = A.req('POST', '/markets', {'name': 'Test Zero', 'symbol': 'TZRO', 'network': 'zero', 'taxMarketing': 1, 'taxBurn': 0.5, 'taxRewards': 0})
me = Bc.req('POST', '/markets', {'name': 'Test Giwa', 'symbol': 'TGIWA', 'network': 'giwa', 'taxMarketing': 1, 'taxBurn': 0.5, 'taxRewards': 0})
check(mz.get('ok') and me.get('ok'), f'create markets {mz.get("id")} {me.get("id")}')
vz = A.req('GET', '/market/' + mz['id'])['market']; ve = A.req('GET', '/market/' + me['id'])['market']
check(vz['quote'] == 'ZRO' and ve['quote'] == 'ETH', f'quotes ZRO / ETH ({vz["quote"]}, {ve["quote"]})')
check(abs(vz['mcapUsd'] - ve['mcapUsd']) / vz['mcapUsd'] < 0.01, f'same starting mcap in USD: {vz["mcapUsd"]:.2f} vs {ve["mcapUsd"]:.2f}')

# 2) trades in each market's own quote
r = A.req('POST', '/trade', {'market': mz['id'], 'side': 'buy', 'amount': str(10 * WEI)}); check(r.get('ok'), f'buy ZRO-market with ZRO: {r.get("error","")}')
r = Bc.req('POST', '/trade', {'market': me['id'], 'side': 'buy', 'amount': str(WEI // 1000)}); check(r.get('ok'), f'buy ETH-market with ETH: {r.get("error","")}')

# 3) one-button cross trades
before = A.req('GET', '/me')
r = A.req('POST', '/trade', {'market': mz['id'], 'side': 'buy', 'amount': str(2 * WEI // 1000), 'pay': 'eth'})
check(r.get('ok') and r.get('paid', {}).get('asset') == 'eth', f'buy ZRO-market paying ETH: {r.get("error","")}')
after = A.req('GET', '/me')
check(int(before['eth']) - int(after['eth']) == 2 * WEI // 1000, 'exactly 0.002 ETH debited')
check(int(after['zro']) >= int(before['zro']), 'ZRO not spent on an ETH-paid buy (creator may receive its marketing fee)')
r = Bc.req('POST', '/trade', {'market': me['id'], 'side': 'buy', 'amount': str(5 * WEI), 'pay': 'zro'})
check(r.get('ok'), f'buy ETH-market paying ZRO: {r.get("error","")}')
tok = int(A.req('GET', '/market/' + mz['id'])['me']['tokens'])
e0 = int(A.req('GET', '/me')['eth'])
r = A.req('POST', '/trade', {'market': mz['id'], 'side': 'sell', 'amount': str(tok // 2), 'pay': 'eth'})
check(r.get('ok') and r.get('received', {}).get('asset') == 'eth', f'sell ZRO-market receiving ETH: {r.get("error","")}')
check(int(A.req('GET', '/me')['eth']) - e0 == int(r.get('received', {}).get('amount', 0)), 'ETH credited equals reported proceeds')

# 4) guards
r = A.req('POST', '/trade', {'market': me['id'], 'side': 'buy', 'amount': str(WEI // 10**7)}); check('Minimum' in (r.get('error') or ''), 'ETH minimum buy enforced')
r = A.req('POST', '/trade', {'market': me['id'], 'side': 'buy', 'amount': str(100 * WEI)}); check('Insufficient ETH' in (r.get('error') or ''), 'insufficient ETH rejected')
r = A.req('POST', '/trade', {'market': mz['id'], 'side': 'buy', 'amount': str(WEI), 'pay': 'btc'}); check('Unsupported' in (r.get('error') or ''), 'unknown pay asset rejected')

# 5) quote migration keeps the USD price
mm = A.req('POST', '/markets', {'name': 'Migrate Me', 'symbol': 'MIG', 'network': 'zero', 'taxMarketing': 0, 'taxBurn': 0, 'taxRewards': 0})
A.req('POST', '/trade', {'market': mm['id'], 'side': 'buy', 'amount': str(20 * WEI)})
holdA = int(A.req('GET', '/market/' + mm['id'])['me']['tokens'])
mig = admin.req('POST', '/admin/migrate-quote', {'market': mm['id']}, admin=True)
check(mig.get('ok'), f'migrate quote: {mig.get("error","")}')
if mig.get('ok'):
    d = abs(mig['priceUsdAfter'] - mig['priceUsdBefore']) / mig['priceUsdBefore']
    check(d < 1e-6, f'USD price preserved: {mig["priceUsdBefore"]:.10f} -> {mig["priceUsdAfter"]:.10f} (diff {d:.2e})')
    v2 = A.req('GET', '/market/' + mm['id'])
    check(v2['market']['quote'] == 'ETH', 'migrated market now quoted in ETH')
    check(int(v2['me']['tokens']) == holdA, 'holder keeps exactly the same tokens')
    r = A.req('POST', '/trade', {'market': mm['id'], 'side': 'sell', 'amount': str(holdA // 2)}); check(r.get('ok'), f'sell after migration pays ETH: {r.get("error","")}')

# 6) whole-ledger conservation per asset (exact, rewards rounding dust aside)
L = admin.req('POST', '/admin/ledger', {}, admin=True)
for a in ['zro', 'eth']:
    d = int(L[a]['diff'])
    print(f"  {a.upper()}  inflow={L[a]['inflow']}  held={L[a]['held']}  diff={d}")
    check(0 <= d < 10**9, f'{a.upper()} ledger conserved across the whole staging DB (diff {d} wei)')
print('\nRESULT:', 'ALL PASSED' if not fails else f'{len(fails)} FAILED: {fails}')
