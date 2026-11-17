#!/usr/bin/env python3
"""Find/verify the V2 pair init-code hash per chain: recompute CREATE2 for an existing pair."""
import json, sys, urllib.request
from eth_utils import keccak, to_checksum_address

CHAINS = json.load(open(__file__.replace("find_inithash.py", "chains.json")))

def rpc(url, method, params):
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 {"content-type": "application/json", "user-agent": "rookery"})
    return json.load(urllib.request.urlopen(req, timeout=20))["result"]

def call(url, to, data):
    return rpc(url, "eth_call", [{"to": to, "data": data}, "latest"])

def addr(word): return to_checksum_address("0x" + word[-40:])

for key, c in CHAINS.items():
    if not c.get("factory"): continue
    url = c["rpc"]
    try:
        pair = addr(call(url, c["factory"], "0x1e3dd18b" + "0" * 64))          # allPairs(0)
        t0 = addr(call(url, pair, "0x0dfe1681")); t1 = addr(call(url, pair, "0xd21220a7"))
        cands = [c.get("pairInitHash")] if c.get("pairInitHash") else []
        if c.get("router"):
            code = bytes.fromhex(rpc(url, "eth_getCode", [c["router"], "latest"])[2:])
            for i in range(len(code) - 33):
                if code[i] == 0x7f: cands.append("0x" + code[i + 1:i + 33].hex())
        hit = None
        for h in cands:
            if not h: continue
            raw = keccak(b"\xff" + bytes.fromhex(c["factory"][2:]) + keccak(bytes.fromhex(t0[2:]) + bytes.fromhex(t1[2:])) + bytes.fromhex(h[2:]))
            if to_checksum_address(raw[-20:]) == pair: hit = h; break
        print(f"{key:9} pair0={pair} hash={'OK ' + hit if hit else 'NOT FOUND'}")
    except Exception as e:
        print(f"{key:9} ERR {e}")
