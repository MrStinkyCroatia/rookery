#!/usr/bin/env python3
"""Audit sent withdrawals against the chain: find any whose transaction reverted (status 0)."""
import json, urllib.request, concurrent.futures as cf

API = 'https://rookery.stinkypenguin.xyz/api'
KEY = open('/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch/.admin_key').read().strip()
RPC = {
    'ethereum': ['https://ethereum.publicnode.com', 'https://eth.llamarpc.com'],
    'base': ['https://mainnet.base.org', 'https://base.llamarpc.com'],
    'arbitrum': ['https://arb1.arbitrum.io/rpc'],
    'bsc': ['https://bsc-dataseed.binance.org'],
    'optimism': ['https://mainnet.optimism.io'],
}


def post(url, body):
    r = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                               headers={'content-type': 'application/json', 'user-agent': 'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(r, timeout=40))


def get(url):
    r = urllib.request.Request(url, headers={'user-agent': 'Mozilla/5.0', 'x-pl': '1'})
    return json.load(urllib.request.urlopen(r, timeout=60))


def receipt(chain, h):
    for u in RPC.get(chain, []):
        try:
            d = post(u, {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getTransactionReceipt', 'params': [h]})
            return d.get('result')
        except Exception:
            continue
    return 'ERR'


rows = get(API + '/admin/withdrawals?status=sent&limit=400&key=' + KEY)['rows']
print('checking %d sent withdrawals...' % len(rows))

bad, missing, err, okc = [], [], [], 0
with cf.ThreadPoolExecutor(max_workers=8) as ex:
    futs = {ex.submit(receipt, r['chain'], r['txid']): r for r in rows if r.get('txid')}
    for f in cf.as_completed(futs):
        r = futs[f]
        rc = f.result()
        if rc == 'ERR':
            err.append(r)
        elif rc is None:
            missing.append(r)
        elif rc['status'] != '0x1':
            bad.append({**r, 'block': int(rc['blockNumber'], 16)})
        else:
            okc += 1

print('  confirmed ok: %d' % okc)
print('  reverted (money owed to the user): %d' % len(bad))
for b in sorted(bad, key=lambda x: x['id']):
    print('    id %s %s %s %.4f ZRO  %s  tx %s... block %s' % (
        b['id'], b['username'], b['chain'], int(b['amount']) / 1e18, b['note'], b['txid'][:12], b['block']))
print('  no receipt yet (mempool): %d' % len(missing))
print('  rpc errors: %d' % len(err))
json.dump(bad, open('/home/user/95359ef5-7be3-4b6b-89f3-63cb34ac24d5/prelaunch/tools/.reverted_withdrawals.json', 'w'), indent=1)
