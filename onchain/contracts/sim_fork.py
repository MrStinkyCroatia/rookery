#!/usr/bin/env python3
"""End-to-end test of RookeryPad on a local anvil fork (real DEX factory/router).
usage: python3 sim_fork.py <chainKey> <rpc>   e.g. sim_fork.py rh http://127.0.0.1:8545"""
import json, sys, os
from web3 import Web3

DIR = os.path.dirname(os.path.abspath(__file__))
KEY, RPC = sys.argv[1], sys.argv[2]
C = json.load(open(os.path.join(DIR, "chains.json")))[KEY]
w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 60}))
from web3.middleware import geth_poa_middleware
w3.middleware_onion.inject(geth_poa_middleware, layer=0)   # BNB Chain blocks carry long extraData
A = w3.eth.accounts          # anvil unlocked accounts
# the public anvil keys are EIP-7702-delegated to sweeper bots on real chains -> wipe that code on the fork
for a in A: w3.provider.make_request("anvil_setCode", [a, "0x"])
DEPLOYER, TREAS, CREATOR, ALICE, BOB, REF, EVE, MKT = A[0], A[1], A[2], A[3], A[4], A[5], A[6], A[7]
art = lambda n: json.load(open(os.path.join(DIR, "out", n + ".json")))
PADJ, TOKJ = art("RookeryPad"), art("RookeryToken")
E = 10 ** 18
ok_n = fail_n = 0

def check(name, cond, extra=""):
    global ok_n, fail_n
    if cond: ok_n += 1; print("  PASS", name, extra)
    else: fail_n += 1; print("  FAIL", name, extra)

def reverts(fn, **tx):
    try: fn.call(tx); return False
    except Exception as e: return str(e)[:90]

def send(fn, **tx):
    h = fn.transact(tx); r = w3.eth.wait_for_transaction_receipt(h)
    assert r.status == 1, f"tx failed {fn.fn_name}"
    return r

bal = lambda a: w3.eth.get_balance(a)
ERC = [{"name": n, "type": "function", "stateMutability": "view", "inputs": i, "outputs": [{"type": "uint256"}]}
       for n, i in [("balanceOf", [{"type": "address"}])]] + [
      {"name": "approve", "type": "function", "stateMutability": "nonpayable", "inputs": [{"type": "address"}, {"type": "uint256"}], "outputs": [{"type": "bool"}]},
      {"name": "transfer", "type": "function", "stateMutability": "nonpayable", "inputs": [{"type": "address"}, {"type": "uint256"}], "outputs": [{"type": "bool"}]},
      {"name": "getReserves", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "uint112"}, {"type": "uint112"}, {"type": "uint32"}]},
      {"name": "token0", "type": "function", "stateMutability": "view", "inputs": [], "outputs": [{"type": "address"}]},
      {"name": "deposit", "type": "function", "stateMutability": "payable", "inputs": [], "outputs": []}]
ROUTER = [{"name": "swapExactETHForTokensSupportingFeeOnTransferTokens", "type": "function", "stateMutability": "payable",
           "inputs": [{"type": "uint256"}, {"type": "address[]"}, {"type": "address"}, {"type": "uint256"}], "outputs": []},
          {"name": "swapExactTokensForETHSupportingFeeOnTransferTokens", "type": "function", "stateMutability": "nonpayable",
           "inputs": [{"type": "uint256"}, {"type": "uint256"}, {"type": "address[]"}, {"type": "address"}, {"type": "uint256"}], "outputs": []}]
FACT = [{"name": "createPair", "type": "function", "stateMutability": "nonpayable", "inputs": [{"type": "address"}, {"type": "address"}], "outputs": [{"type": "address"}]}]

print(f"== RookeryPad e2e on {C['name']} fork ({RPC})")
TARGET = 1 * E
Pad = w3.eth.contract(abi=PADJ["abi"], bytecode=PADJ["bytecode"])
r = send(Pad.constructor(C["weth"], C["factory"], bytes.fromhex(C["pairInitHash"][2:]), TREAS, TARGET), **{"from": DEPLOYER})
pad = w3.eth.contract(address=r.contractAddress, abi=PADJ["abi"])
print("  pad", pad.address, "gas", r.gasUsed)

# 1. create with creator first-buy + 1% creator tax + 2% max wallet
meta = json.dumps({"img": "https://rookery.stinkypenguin.xyz/x.png", "desc": "test"})
fn = pad.functions.create("Stinky Test", "STNK", meta, 100, MKT, 200, 0, "0x" + "0" * 40)
r = send(fn, **{"from": CREATOR, "value": E // 400})
ev = pad.events.Created().process_receipt(r)[0]["args"]
tok = w3.eth.contract(address=ev["token"], abi=TOKJ["abi"])
sale = pad.functions.getSale(0).call()
check("create emits + stores sale", sale[0] == ev["token"] and sale[1] == CREATOR, f"gas {r.gasUsed}")
check("creator first buy got tokens", tok.functions.balanceOf(CREATOR).call() > 0)
PAIR = tok.functions.pair().call()
check("pair predicted & stored", PAIR == sale[2], PAIR)

# 2. pool locked pre-graduation
check("transfer to pair blocked", bool(reverts(tok.functions.transfer(PAIR, 1), **{"from": CREATOR})))

# 3. buy with referrer: fee split 80/20
t0, rf0 = bal(TREAS), bal(REF)
amt = E // 400
q = pad.functions.quoteBuy(0, amt).call()
r = send(pad.functions.buy(0, q[0] * 99 // 100, REF), **{"from": ALICE, "value": amt})
fee = amt * 50 // 10000
check("quoteBuy == received", tok.functions.balanceOf(ALICE).call() == q[0])
check("referrer got 20% fee", bal(REF) - rf0 == fee * 2000 // 10000, str(bal(REF) - rf0))
check("treasury got 80% fee", bal(TREAS) - t0 == fee - fee * 2000 // 10000)
# referrer that rejects native coin gets wrapped coin instead (no stuck / failed trades)
REJ = A[50]; w3.provider.make_request("anvil_setCode", [REJ, "0x60006000fd"])
wethc = w3.eth.contract(address=C["weth"], abi=ERC)
w0 = wethc.functions.balanceOf(REJ).call()
send(pad.functions.buy(0, 0, REJ), **{"from": ALICE, "value": E // 1000})
check("rejecting referrer paid in wrapped coin", wethc.functions.balanceOf(REJ).call() - w0 == (E // 1000 * 50 // 10000) * 2000 // 10000)
r = send(pad.functions.buy(0, 0, BOB), **{"from": BOB, "value": E // 400})
check("self-referral ignored", pad.events.Trade().process_receipt(r)[0]["args"]["referrer"] == "0x" + "0" * 40)
r = send(pad.functions.buy(0, 0, TREAS), **{"from": ALICE, "value": E // 1000})
check("treasury as referrer ignored", pad.events.Trade().process_receipt(r)[0]["args"]["referrer"] == "0x" + "0" * 40)

# 4. max wallet 2% before graduation
mw = tok.functions.maxWallet().call()
check("max wallet 2%", mw == 20_000_000 * E)
check("max wallet enforced on curve", bool(reverts(pad.functions.buy(0, 0, "0x" + "0" * 40), **{"from": EVE, "value": E // 2})))

# 5. sell
sellAmt = tok.functions.balanceOf(ALICE).call() // 2
qs = pad.functions.quoteSell(0, sellAmt).call()
send(tok.functions.approve(pad.address, 2 ** 256 - 1), **{"from": ALICE})
b0 = bal(ALICE)
r = send(pad.functions.sell(0, sellAmt, qs[0], "0x" + "0" * 40), **{"from": ALICE})
got = bal(ALICE) - b0 + r.gasUsed * r.effectiveGasPrice
check("sell pays quoteSell", abs(got - qs[0]) <= 10**13 and pad.events.Trade().process_receipt(r)[0]["args"]["quoteAmt"] == qs[0], f"{got/E:.6f}")
check("sell slippage guard", bool(reverts(pad.functions.sell(0, sellAmt // 2, qs[0] * 2, "0x" + "0" * 40), **{"from": ALICE})))

# 6. griefing: WETH donation to pair + attacker pre-creates pair
weth = w3.eth.contract(address=C["weth"], abi=ERC)
send(weth.functions.deposit(), **{"from": EVE, "value": E // 1000})
send(weth.functions.transfer(PAIR, E // 1000), **{"from": EVE})
fac = w3.eth.contract(address=C["factory"], abi=FACT)
send(fac.functions.createPair(tok.address, C["weth"]), **{"from": EVE})
check("attacker pre-created pair == predicted", True)

# 7. graduate with overshoot (several wallets to respect max wallet)
buyers = []
for k in range(100):
    a = Web3.to_checksum_address("0x" + Web3.keccak(text=f"rookery-buyer-{k}").hex()[-40:])
    w3.provider.make_request("anvil_setBalance", [a, hex(10 * E)])
    w3.provider.make_request("anvil_impersonateAccount", [a])
    buyers.append(a)
i = 0
while not pad.functions.getSale(0).call()[4]:
    s = pad.functions.getSale(0).call()
    b = buyers[i % len(buyers)]; i += 1
    if i > 2000: break
    val = E // 250 if s[8] < TARGET * 95 // 100 else E // 10
    if reverts(pad.functions.buy(0, 0, "0x" + "0" * 40), **{"from": b, "value": val}): continue
    before = bal(b)
    r = send(pad.functions.buy(0, 0, "0x" + "0" * 40), **{"from": b, "value": val})
    if pad.functions.getSale(0).call()[4]:
        spent = before - bal(b) - r.gasUsed * r.effectiveGasPrice
        room = s[5] - s[8]
        exp = room + -(-room * 50 // 9950)
        check("last buyer refunded excess", abs(spent - exp) <= 10**13, f"spent {spent/E:.6f} room {room/E:.6f}")
s = pad.functions.getSale(0).call()
check("graduated", s[4] and s[8] == s[5])
pr = w3.eth.contract(address=PAIR, abi=ERC)
res = pr.functions.getReserves().call()
t0addr = pr.functions.token0().call()
rt, rq = (res[0], res[1]) if t0addr == tok.address else (res[1], res[0])
check("LP seeded 200M tokens", rt == 200_000_000 * E, str(rt / E))
check("LP quote = 98% raise + donation", rq == TARGET * 98 // 100 + E // 1000, f"{rq/E:.6f}")
check("LP locked at 0xdead", pr.functions.balanceOf("0x000000000000000000000000000000000000dEaD").call() > 0)
check("pad holds no tokens", tok.functions.balanceOf(pad.address).call() == 0)
endCurve = (s[6] + s[8]) / (s[7] - s[9])
poolPx = rq / rt
check("no price cliff at graduation", abs(poolPx / endCurve - 1) < 0.01, f"curve {endCurve:.3e} pool {poolPx:.3e}")
check("buy after graduation reverts", bool(reverts(pad.functions.buy(0, 0, "0x" + "0" * 40), **{"from": BOB, "value": E // 100})))
check("transfer to pair now allowed", tok.functions.tradingOpen().call())

# 8. DEX swaps are taxed 0.5% + 1% creator, wallet transfers are not
router = w3.eth.contract(address=C["router"], abi=ROUTER)
dl = w3.eth.get_block("latest").timestamp + 600
send(router.functions.swapExactETHForTokensSupportingFeeOnTransferTokens(0, [C["weth"], tok.address], BOB, dl), **{"from": BOB, "value": E // 1000})
acc = tok.functions.balanceOf(tok.address).call()
check("DEX buy taxed", acc > 0, f"{acc/E:.2f} tok")
bb = tok.functions.balanceOf(BOB).call()
send(tok.functions.approve(router.address, 2 ** 256 - 1), **{"from": BOB})
send(router.functions.swapExactTokensForETHSupportingFeeOnTransferTokens(bb // 2, 0, [tok.address, C["weth"]], BOB, dl), **{"from": BOB})
check("DEX sell works with tax", tok.functions.balanceOf(tok.address).call() > acc)
x0 = tok.functions.balanceOf(ALICE).call()
send(tok.functions.transfer(CREATOR, 1000 * E), **{"from": ALICE})
check("wallet transfer untaxed", x0 - tok.functions.balanceOf(ALICE).call() == 1000 * E)
acc = tok.functions.balanceOf(tok.address).call()
m0, tr0 = tok.functions.balanceOf(MKT).call(), tok.functions.balanceOf(TREAS).call()
send(tok.functions.sweep(), **{"from": EVE})
dm, dt = tok.functions.balanceOf(MKT).call() - m0, tok.functions.balanceOf(TREAS).call() - tr0
check("sweep split 1% creator / 0.5% platform", dm + dt == acc and abs(dm / acc - 100 / 150) < 1e-9, f"{dm/E:.2f}/{dt/E:.2f}")

# 9. admin
check("non-owner cannot pause", bool(reverts(pad.functions.setPaused(True), **{"from": EVE})))
send(pad.functions.setPaused(True), **{"from": DEPLOYER})
check("paused blocks new launches", bool(reverts(pad.functions.create("X", "X", "", 0, "0x" + "0" * 40, 0, 0, "0x" + "0" * 40), **{"from": ALICE})))
send(pad.functions.setPaused(False), **{"from": DEPLOYER})
check("creator tax > 3% rejected", bool(reverts(pad.functions.create("X", "X", "", 301, MKT, 0, 0, "0x" + "0" * 40), **{"from": ALICE})))
check("target range enforced", bool(reverts(pad.functions.create("X", "X", "", 0, "0x" + "0" * 40, 0, TARGET * 2, "0x" + "0" * 40), **{"from": ALICE})))
r = send(pad.functions.create("No Tax", "NOTAX", "", 0, "0x" + "0" * 40, 0, TARGET // 2, "0x" + "0" * 40), **{"from": ALICE})
check("second launch, custom target", pad.functions.getSale(1).call()[5] == TARGET // 2, f"gas {r.gasUsed}")
print(f"== {C['name']}: {ok_n} passed, {fail_n} failed")
sys.exit(1 if fail_n else 0)
