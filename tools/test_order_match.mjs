// Unit tests for the one-signature order matcher (no network, no runtime).
import { matchOrder, ORDER_TOL_BPS } from '../worker/orders.js';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); };

const WEI = 10n ** 18n;
const base = 100n * WEI;          // 100 ZRO requested
const tag = 417n;                 // unique tag
const order = { amount: base.toString(), tagged: (base + tag).toString() };
const tol = (base * ORDER_TOL_BPS) / 10000n;   // 2 ZRO

// exact tagged payment: fills the full requested size
let r = matchOrder(order, (base + tag).toString());
ok('exact tagged amount fills', r.action === 'fill' && r.amount === base.toString() && r.exact === true, JSON.stringify(r));

// paid slightly more, but not the tag: fill requested size, excess stays on the balance
r = matchOrder(order, (base + 1n * WEI).toString());
ok('overpayment within tolerance fills the order size', r.action === 'fill' && r.amount === base.toString() && r.excess === (1n * WEI).toString(), JSON.stringify(r));

// paid slightly less within tolerance: fill what actually arrived
r = matchOrder(order, (base - 1n * WEI).toString());
ok('underpayment within tolerance fills the received amount', r.action === 'fill' && r.amount === (base - 1n * WEI).toString(), JSON.stringify(r));

// boundaries
r = matchOrder(order, (base + tol).toString());
ok('exactly +2% still fills', r.action === 'fill', JSON.stringify(r));
r = matchOrder(order, (base + tol + 1n).toString());
ok('one wei above +2% does not fill', r.action === 'none' && r.reason === 'over', JSON.stringify(r));
r = matchOrder(order, (base - tol).toString());
ok('exactly -2% still fills', r.action === 'fill' && r.amount === (base - tol).toString(), JSON.stringify(r));

// a clearly smaller payment cancels the order and keeps the money on the balance
r = matchOrder(order, (10n * WEI).toString());
ok('tiny payment cancels with a shortfall', r.action === 'cancel' && r.shortfall === (90n * WEI).toString(), JSON.stringify(r));

// a much larger payment is not treated as this order (could be a normal deposit)
r = matchOrder(order, (500n * WEI).toString());
ok('big payment is left as a plain deposit', r.action === 'none' && r.reason === 'over');

// the tag must not be mistaken for the requested size
r = matchOrder(order, tag.toString());
ok('tag alone never fills', r.action === 'cancel');

// small orders still behave (minimum buy size)
const small = { amount: (WEI / 10n).toString(), tagged: (WEI / 10n + 7n).toString() };
r = matchOrder(small, small.tagged);
ok('minimum-size order fills on the tag', r.action === 'fill' && r.amount === small.amount, JSON.stringify(r));

// zero / garbage input must not fill anything
r = matchOrder(order, '0');
ok('zero payment cancels', r.action === 'cancel');
let threw = false;
try { matchOrder(order, 'abc'); } catch { threw = true; }
ok('garbage amount throws instead of filling', threw);

console.log(`== order matcher: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
