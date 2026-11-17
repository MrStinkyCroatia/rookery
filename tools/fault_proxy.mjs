// JSON-RPC proxy in front of an anvil fork that can reproduce a flaky public RPC:
// with the fault on, eth_sendRawTransaction is forwarded (the tx lands) but the caller gets an error,
// and eth_getTransactionByHash pretends not to know that tx. This is the exact failure seen on mainnet.
// Usage: node tools/fault_proxy.mjs <listenPort> <upstreamUrl>;  toggle with GET /__fault?on=1 | on=0
import http from 'node:http';
const [port, upstream] = [Number(process.argv[2] || 8549), process.argv[3] || 'http://127.0.0.1:8547'];
let fault = false;
const hidden = new Set();
const fwd = async (q) => (await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q) })).json();
async function one(q) {
  if (fault && q.method === 'eth_sendRawTransaction') {
    const r = await fwd(q);
    if (r.result) hidden.add(String(r.result).toLowerCase());
    return { jsonrpc: '2.0', id: q.id, error: { code: -32005, message: 'simulated 429 Too Many Requests' } };
  }
  if (fault && q.method === 'eth_getTransactionByHash' && hidden.has(String(q.params?.[0]).toLowerCase())) return { jsonrpc: '2.0', id: q.id, result: null };
  return fwd(q);
}
http.createServer(async (req, res) => {
  if (req.url.startsWith('/__fault')) {
    fault = req.url.includes('on=1');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ fault, hidden: hidden.size }));
  }
  let body = '';
  for await (const c of req) body += c;
  try {
    const j = JSON.parse(body);
    const out = Array.isArray(j) ? await Promise.all(j.map(one)) : await one(j);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  } catch (e) { res.statusCode = 500; res.end(String(e.message || e)); }
}).listen(port, '127.0.0.1');
