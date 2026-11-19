// Fake Telegram Bot API for tests: records every call, answers like Telegram would.
// node tools/tg_mock.mjs 8899   ·   GET /calls  ·  POST /reset
import http from 'node:http';
const port = Number(process.argv[2] || 8899);
let calls = [], mid = 1000;
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/calls') return send(calls);
    if (req.url === '/reset') { calls = []; return send({ ok: true }); }
    const m = req.url.match(/^\/bot[^/]+\/(\w+)/);
    if (!m) return send({ ok: false });
    let b = {}; try { b = JSON.parse(body || '{}'); } catch { /* empty */ }
    calls.push({ method: m[1], body: b, ts: Date.now() });
    if (m[1] === 'getMe') return send({ ok: true, result: { id: 1, is_bot: true, username: 'RookerySniperBot' } });
    if (m[1] === 'sendMessage' || m[1] === 'sendPhoto' || m[1] === 'sendAnimation') return send({ ok: true, result: { message_id: ++mid, chat: { id: b.chat_id } } });
    return send({ ok: true, result: true });
  });
}).listen(port, () => console.log('tg mock on', port));
