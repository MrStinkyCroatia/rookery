// Matching rules for one-signature wallet buys, kept free of runtime deps so they can be unit tested.
// The user pays `amount + tag` wei to their own deposit address; the scanner reports the credited delta
// and this decides what the order does with it.

export const ORDER_TTL_MS = 10 * 60e3;
export const ORDER_TOL_BPS = 200n; // 2% tolerance around the requested size

export function matchOrder(order, deltaWei) {
  const d = BigInt(deltaWei);
  const amount = BigInt(order.amount);
  const tagged = BigInt(order.tagged);
  const tol = (amount * ORDER_TOL_BPS) / 10000n;
  if (d === tagged) return { action: 'fill', amount: amount.toString(), exact: true };
  if (d >= amount - tol && d <= amount + tol) {
    return {
      action: 'fill',
      amount: (d < amount ? d : amount).toString(),
      exact: false,
      excess: (d > amount ? d - amount : 0n).toString(),
    };
  }
  if (d > amount + tol) return { action: 'none', reason: 'over' };
  return { action: 'cancel', reason: 'under', shortfall: (amount - d).toString() };
}
