#!/usr/bin/env python3
"""Watch BRYAN's bonding curve and catch the exact moment it turns into a pool."""
import json, time, urllib.request, os, sys

URL = 'https://rookery.stinkypenguin.xyz/api/market/bryan-0f9018'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bryan_watch.jsonl')
WEI = 10**18
VZ, VT = 3150 * WEI, 1073000000 * WEI
CURVE, SUPPLY = 800_000_000 * WEI, 1_000_000_000 * WEI


def get():
    r = urllib.request.Request(URL, headers={'user-agent': 'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(r, timeout=15))


def snapshot():
    d = get()
    m = d.get('market', d)
    sold, res = int(m['sold']), int(m['reserveZro'])
    z, t = VZ + res, VT - sold
    return {
        'ts': time.time(), 'progress': m['progress'], 'sold': sold, 'reserve': res,
        'price': int(m['priceZro']), 'priceUsd': m['priceUsd'], 'mcap': m['mcapUsd'],
        'graduated': bool(m['graduated']), 'poolZro': m.get('poolZro'), 'poolTok': m.get('poolTok'),
        'burned': m.get('burned'), 'trades': m['trades'], 'holders': m['holders'],
        'curveEndPrice': (z * WEI) // t, 'left': CURVE - sold,
    }


def main():
    log = open(OUT, 'a', buffering=1)
    print('watching', URL, flush=True)
    prev = None
    bonded_at = None
    while True:
        try:
            s = snapshot()
        except Exception as e:
            log.write(json.dumps({'ts': time.time(), 'error': str(e)[:120]}) + '\n')
            time.sleep(15)
            continue
        log.write(json.dumps(s) + '\n')
        if s['graduated'] and bonded_at is None:
            bonded_at = s
            print('BONDED', json.dumps({k: s[k] for k in ('progress', 'reserve', 'price', 'poolZro', 'poolTok')}), flush=True)
        if bonded_at and time.time() - bonded_at['ts'] > 900:
            print('done: 15 min after bonding', flush=True)
            return
        if s['graduated']:
            time.sleep(30)
        else:
            time.sleep(15)


if __name__ == '__main__':
    main()
