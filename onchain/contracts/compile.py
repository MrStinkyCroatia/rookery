#!/usr/bin/env python3
"""Compile Rookery on-chain contracts -> out/*.json (abi + bytecode)."""
import json, sys, os
import solcx

DIR = os.path.dirname(os.path.abspath(__file__))
FILES = ["RookeryToken.sol", "RookeryPad.sol"]
sources = {f: {"content": open(os.path.join(DIR, f)).read()} for f in FILES}
inp = {
    "language": "Solidity",
    "sources": sources,
    "settings": {
        "optimizer": {"enabled": True, "runs": 200},
        "viaIR": True,
        "evmVersion": "paris",   # PUSH0-free: safe on every target chain
        "outputSelection": {"*": {"*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"]}},
    },
}
out = solcx.compile_standard(inp, solc_version="0.8.26", allow_paths=DIR, base_path=DIR)
errs = [e for e in out.get("errors", []) if e["severity"] == "error"]
for w in [e for e in out.get("errors", []) if e["severity"] == "warning"]:
    print("WARN:", w["formattedMessage"].strip()[:240])
if errs:
    for e in errs: print("ERROR:", e["formattedMessage"])
    sys.exit(1)
os.makedirs(os.path.join(DIR, "out"), exist_ok=True)
for f, cs in out["contracts"].items():
    for name, c in cs.items():
        bc = c["evm"]["bytecode"]["object"]
        if not bc: continue
        json.dump({"abi": c["abi"], "bytecode": bc}, open(os.path.join(DIR, "out", name + ".json"), "w"))
        print(f"OK {name}: deployed {len(c['evm']['deployedBytecode']['object'])//2} B")
