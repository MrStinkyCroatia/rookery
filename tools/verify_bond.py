#!/usr/bin/env python3
"""Verify a curve -> pool transition against the expected values, from the watcher log."""
import json, sys

WEI = 10**18
VZ, VT = 3150 * WEI, 1073000000 * WEI
CURVE, SUPPLY = 800_000_000 * WEI, 1_000_000_000 * WEI
RES = SUPPLY - CURVE  # 200M tokens earmarked for the pool


def main(path):
    rows = [json.loads(l) for l in open(path) if 'error' not in l]
    grad = [r for r in rows if r.get('graduated')]
    if not grad:
        last = rows[-1]
        print(f'not bonded yet: progress {last["progress"]:.2f}%, reserve {last["reserve"]/1e18:.2f} ZRO')
        return
    pre = [r for r in rows if not r.get('graduated')]
    p = pre[-1] if pre else None
    g = grad[0]
    print('=== moment przejscia ===')
    if p:
        print(f'ostatni odczyt przed bondingiem: {p["progress"]:.4f}%  rezerwa {p["reserve"]/WEI:.6f} ZRO  cena {p["price"]}')
    print(f'pierwszy odczyt po bondingu:      poolZro {int(g["poolZro"])/WEI:.6f}  poolTok {int(g["poolTok"])/WEI/1e6:.4f}M  cena {g["price"]}')

    if p:
        z_end = VZ + p['reserve']
        t_end = VT - p['sold']
        curve_price = (z_end * WEI) // t_end
        raised = p['reserve']
        # expected pool, same formula as the worker
        pz = (RES * z_end) // t_end
        pt = RES
        spare_zro = 0
        if pz > raised:
            pz, pt = raised, (raised * t_end) // z_end
        else:
            spare_zro = raised - pz
        exp_price = (pz * WEI) // pt
        print()
        print('=== porownanie z oczekiwaniem ===')
        print(f'cena konca krzywej        {curve_price}')
        print(f'cena puli po przejsciu    {g["price"]}')
        print(f'roznica (wei na token)    {g["price"] - curve_price}   {"OK - zero skoku" if g["price"] == curve_price else "UWAGA - skok ceny"}')
        print(f'poolTok  expected {pt/WEI:.6f}   is {int(g["poolTok"])/WEI:.6f}   {"OK" if int(g["poolTok"]) == pt else "DIFF"}')
        print(f'poolZro  expected {pz/WEI:.6f}   is {int(g["poolZro"])/WEI:.6f}   {"OK" if int(g["poolZro"]) == pz else "DIFF"}')
        print(f'ZRO poza pula (na spalenie $臭企鹅): {spare_zro/WEI:.6f} ZRO')
        print(f'cena oczekiwana {exp_price}  |  cena rzeczywista {g["price"]}  |  {"ZGADZA SIE" if g["price"] == exp_price else "NIE ZGADZA SIE"}')
        print(f'cena po bondingu w ZRO/token: {g["price"]/WEI:.12f}   (wczesniej {curve_price/WEI:.12f})')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'bryan_watch.jsonl')
