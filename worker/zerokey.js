// Zero's RPC admits allowlisted IPs or a Console API key (x-api-key). The key is sent ONLY to LayerZero's own hosts
// and never leaves the worker: it is not part of any API response.
export const zeroKey = { v: '' };
export const zeroHdr = (url) => (zeroKey.v && /^https:\/\/[a-z0-9.-]+\.layerzero\.network(\/|$|:)/i.test(String(url)) ? { 'x-api-key': zeroKey.v } : {});
export const zeroKeyLoad = (book) => { zeroKey.v = String(book.env?.ZERO_RPC_KEY || book.meta('zero_rpc_key') || ''); return !!zeroKey.v; };
