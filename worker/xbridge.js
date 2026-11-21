// Rookery Bridge: a thin layer over an external cross-chain settlement network.
// The user pays straight into a one-time deposit address and the network delivers on the other chain:
// Rookery never holds the funds and needs no liquidity of its own. Our fee is added to every quote.
// Nothing here is exposed to the browser except neutral fields (no provider names, asset ids or URLs).
import { StellarIO } from './stellar.js';

const API = 'https://1click.chaindefuser.com/v0';
export const XB_SOON = ['zero', 'giwa'];
// key -> network shown in the UI (native coin only for now; one side is always Stellar)
export const XB_NETS = {
  stellar:   { label: 'Stellar',         sym: 'XLM',  name: 'Stellar Lumens', dec: 7,  kind: 'stellar', id: 'nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz', tx: 'https://stellar.expert/explorer/public/tx/' },
  ethereum:  { label: 'Ethereum',        sym: 'ETH',  name: 'Ether',          dec: 18, kind: 'evm', chainId: 1,     id: 'nep141:eth.omft.near',  tx: 'https://etherscan.io/tx/' },
  base:      { label: 'Base',            sym: 'ETH',  name: 'Ether',          dec: 18, kind: 'evm', chainId: 8453,  id: 'nep141:base.omft.near', tx: 'https://basescan.org/tx/' },
  arbitrum:  { label: 'Arbitrum',        sym: 'ETH',  name: 'Ether',          dec: 18, kind: 'evm', chainId: 42161, id: 'nep141:arb.omft.near',  tx: 'https://arbiscan.io/tx/' },
  optimism:  { label: 'Optimism',        sym: 'ETH',  name: 'Ether',          dec: 18, kind: 'evm', chainId: 10,    id: 'nep245:v2_1.omni.hot.tg:10_11111111111111111111', tx: 'https://optimistic.etherscan.io/tx/' },
  robinhood: { label: 'Robinhood Chain', sym: 'ETH',  name: 'Ether',          dec: 18, kind: 'evm', chainId: 4663,  id: 'nep141:hood.omft.near', tx: 'https://robinhoodchain.blockscout.com/tx/' },
  bsc:       { label: 'BNB Chain',       sym: 'BNB',  name: 'BNB',            dec: 18, kind: 'evm', chainId: 56,    id: 'nep141:bnb.omdep.near', tx: 'https://bscscan.com/tx/', minUsd: 1000 },
  polygon:   { label: 'Polygon',         sym: 'POL',  name: 'Polygon',        dec: 18, kind: 'evm', chainId: 137,   id: 'nep141:pol.omdep.near', tx: 'https://polygonscan.com/tx/' },
  avalanche: { label: 'Avalanche',       sym: 'AVAX', name: 'Avalanche',      dec: 18, kind: 'evm', chainId: 43114, id: 'nep141:avax.omdep.near', tx: 'https://snowtrace.io/tx/' },
  solana:    { label: 'Solana',          sym: 'SOL',  name: 'Solana',         dec: 9,  kind: 'solana', id: 'nep141:sol.omft.near', tx: 'https://solscan.io/tx/' },
  bitcoin:   { label: 'Bitcoin',         sym: 'BTC',  name: 'Bitcoin',        dec: 8,  kind: 'btc', id: 'nep141:btc.omft.near', tx: 'https://mempool.space/tx/' },
  tron:      { label: 'Tron',            sym: 'TRX',  name: 'Tron',           dec: 6,  kind: 'tron', id: 'nep141:tron.omft.near', tx: 'https://tronscan.org/#/transaction/', minUsdFrom: 100 },
  litecoin:  { label: 'Litecoin',        sym: 'LTC',  name: 'Litecoin',       dec: 8,  kind: 'ltc', id: 'nep141:ltc.omft.near', tx: 'https://blockstream.info/litecoin/tx/' },
};
const ADDR = {
  stellar: /^G[A-Z2-7]{55}$/,
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  ltc: /^(ltc1[a-z0-9]{25,50}|[LM3][1-9A-HJ-NP-Za-km-z]{25,33})$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};
// any syntactically valid address, only for price-only quotes
const PLACEHOLDER = { stellar: 'GDZWHJSSMSQF2GU5S7V4WOJY7BEZUQI3PFHKNK3AHEEFLVNEKG3QX3NI', evm: '0x2fc334dB3B68995Ca29Ba752d47B4d88c025990D',
  solana: 'So11111111111111111111111111111111111111112', btc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', tron: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
  ltc: 'ltc1qjf0n0gug5m3pxa3thtl7rv9x2g2c2nzvpxqrdv' };
export const validAddr = (net, a) => ADDR[XB_NETS[net]?.kind]?.test(String(a || '').trim()) || false;
// provider wording never reaches the user
const clean = (m) => String(m || 'The bridge is busy, try again in a moment')
  .replace(/1\s*click|near[\s-]*intents|intents|defuse|chaindefuser|near\b/gi, 'bridge').replace(/\s+/g, ' ').slice(0, 200);

export const toUnits = (s, dec) => {
  const [i, f = ''] = String(s).trim().split('.');
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) throw new Error('Enter a valid amount');
  return (BigInt(i || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0')).toString();
};

async function call(path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-api-key'] = key;
  const r = await fetch(API + path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(clean(j.message || j.error || ('error ' + r.status))); e.status = r.status; throw e; }
  return j;
}

export function checkRoute(from, to) {
  if (XB_SOON.includes(from) || XB_SOON.includes(to)) throw new Error('This network is coming soon');
  if (!XB_NETS[from] || !XB_NETS[to]) throw new Error('Pick a supported network');
  if (from === to) throw new Error('Pick two different networks');
  // Stellar is not required: EVM chains, Litecoin, Bitcoin and the rest route directly between each other
}

// cfg: { feeBps, feeTo, key }
export async function xbQuote(cfg, { from, to, amount, recipient, refund, dry = true }) {
  checkRoute(from, to);
  const A = XB_NETS[from], Z = XB_NETS[to];
  const units = toUnits(amount, A.dec);
  if (BigInt(units) <= 0n) throw new Error('Enter an amount');
  if (!dry) {
    if (!validAddr(to, recipient)) throw new Error(`Enter a valid ${Z.label} destination address`);
    if (!validAddr(from, refund)) throw new Error(`Enter your ${A.label} address for refunds`);
  }
  const body = {
    dry, swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: A.id, depositType: 'ORIGIN_CHAIN', destinationAsset: Z.id, amount: units,
    refundTo: dry ? (validAddr(from, refund) ? refund : PLACEHOLDER[A.kind]) : refund, refundType: 'ORIGIN_CHAIN',
    recipient: dry ? (validAddr(to, recipient) ? recipient : PLACEHOLDER[Z.kind]) : recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 60 * 60e3).toISOString(),
    referral: 'rookery',
  };
  if (from === 'stellar') body.depositMode = 'MEMO';
  if (cfg.feeBps > 0 && cfg.feeTo) body.appFees = [{ recipient: cfg.feeTo, fee: cfg.feeBps }];
  const j = await call('/quote', body, cfg.key);
  const q = j.quote || {};
  const inUsd = Number(q.amountInUsd || 0), outUsd = Number(q.amountOutUsd || 0);
  return {
    from, to, amountIn: q.amountIn || units, amountInFmt: q.amountInFormatted || amount, inUsd,
    amountOut: q.amountOut || '0', amountOutFmt: q.amountOutFormatted || '0', outUsd,
    minOutFmt: q.minAmountOut ? (Number(q.minAmountOut) / 10 ** Z.dec).toString() : '',
    feesUsd: Math.max(0, inUsd - outUsd), seconds: Number(q.timeEstimate || 60),
    depositAddress: q.depositAddress || '', depositMemo: q.depositMemo || '', deadline: q.deadline || '',
  };
}

export async function xbStatus(cfg, depositAddress, memo) {
  const qs = 'depositAddress=' + encodeURIComponent(depositAddress) + (memo ? '&depositMemo=' + encodeURIComponent(memo) : '');
  const j = await call('/status?' + qs, null, cfg.key);
  const d = j.swapDetails || {};
  const outTx = (d.destinationChainTxHashes || [])[0]?.hash || '';
  const inTx = (d.originChainTxHashes || [])[0]?.hash || '';
  return { status: j.status || 'UNKNOWN', outTx, inTx, amountOutFmt: d.amountOutFormatted || '', refundedFmt: d.refundedAmountFormatted || '',
    refundTx: (d.refundedTxHashes || d.refundTxHashes || [])[0]?.hash || '' };
}

export async function xbSubmit(cfg, depositAddress, txHash, memo) {
  const body = { txHash: String(txHash), depositAddress };
  if (memo) body.memo = memo;
  try { await call('/deposit/submit', body, cfg.key); } catch { /* optional speed-up only */ }
}

// Stellar side always runs on mainnet, whatever network the launchpad itself is on
let _st;
const mainnet = () => (_st = _st || new StellarIO('mainnet', crypto.getRandomValues(new Uint8Array(32))));
export async function xbStellarXdr({ from, to, amountFmt, memo }) {
  return mainnet().buildPaymentXdr({ from, to, amount: Number(amountFmt), memoId: memo });
}
export async function xbStellarSubmit(xdrB64) { return mainnet().submitXdr(xdrB64); }

export const TERMINAL = ['SUCCESS', 'REFUNDED', 'FAILED'];
