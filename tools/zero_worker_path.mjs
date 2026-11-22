// Runs the WORKER's own migration code (zeromig.js: zeroMigrate -> zeroSend -> zeroRun) against a local chain id 33002,
// with in-memory stand-ins for meta / SQL / R2. Proves signing, fee selection, receipts and background state end to end.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { HDNodeWallet } from 'ethers';
import { installZeroMig } from '../worker/zeromig.js';

const HF = process.argv[2] || 'cancun';
const PORT = 8610;
const RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.HOME + '/.foundry/bin/anvil', ['--chain-id', '33002', '--port', String(PORT), '--hardfork', HF, '--silent', '--gas-limit', '60000000', '--block-time', '1'], { stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rpc = async (m, p = []) => { const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
for (let i = 0; i < 60; i++) { try { await rpc('eth_chainId'); break; } catch { await sleep(250); } }

const WEI = 10n ** 18n, B = (x) => BigInt(x || 0);
const meta = new Map(), r2 = new Map(), jobs = [];
const root = HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, 'm');
class Books {
  constructor() { this.env = { BACKUPS: { get: async (k) => r2.has(k) ? { text: async () => r2.get(k) } : null, put: async (k, v) => r2.set(k, v) } }; this.ctx = { waitUntil: (p) => jobs.push(p) }; }
  meta(k) { return meta.get(k) || ''; } setMeta(k, v) { meta.set(k, v); }
  master() { return root; }
  get sql() { return { exec: () => ({ toArray: () => JSON.parse(readFileSync('.rehearsal/creators_rows.json', 'utf8')) }) }; }
}
installZeroMig(Books, { B, WEI, now: () => Date.now(), vQuote: (m) => B(m.v_zro) * WEI });
const bk = new Books();
// creators as SQL rows (id, wallet)
const cr = JSON.parse(readFileSync('.rehearsal/creators.json', 'utf8')).creators;
(await import('node:fs')).writeFileSync('.rehearsal/creators_rows.json', JSON.stringify(Object.entries(cr).map(([u, w]) => ({ id: Number(u.slice(1)), wallet: w }))));
// official snapshot + artifacts in "R2", Zero paused
r2.set('snap.json', readFileSync('.rehearsal/snapshot.json', 'utf8'));
r2.set('rookery/migration/zero_artifacts.json', readFileSync('out/zero_artifacts.json', 'utf8'));
meta.set('mig_snapshot_zero', JSON.stringify({ key: 'snap.json' }));
meta.set('net_paused_zero', '1');
// fund the HD children the worker derives (deployer gets the reserves, dex gets gas)
const K = bk.zeroKeys();
for (const a of [K.deployer.address, K.dex.address, K.custody.address]) await rpc('anvil_setBalance', [a, '0x' + (5000n * WEI).toString(16)]);

const out = { hardfork: HF, keys: { deployer: K.deployer.address, dex: K.dex.address, custody: K.custody.address } };
try {
  out.dry = (await bk.zeroMigrate({ rpc: RPC, allowUnverified: true, dryRun: true, dex: 'own' })).funds;
  out.start = await bk.zeroMigrate({ rpc: RPC, allowUnverified: true, dex: 'own' });
  out.second = await bk.zeroMigrate({ rpc: RPC, allowUnverified: true, dex: 'own' });     // must say "running", not start twice
  await Promise.all(jobs);
  const st = JSON.parse(meta.get('zero_run_status'));
  out.status = { state: st.state, error: st.error, build: st.report?.build, imported: st.report?.imported, checks: st.report?.checks, seconds: st.finished && ((st.finished - st.started) / 1000).toFixed(1) };
  const run = JSON.parse(meta.get('zero_run'));
  out.persisted = { imports: Object.keys(run.imports).length, steps: Object.keys(run.steps) };
  // reserved addresses the worker shows on token pages == what landed on-chain
  const reservedCurve = bk.zeroAddrs().curve;
  out.reservedCurveHasCode = (await rpc('eth_getCode', [reservedCurve, 'latest'])) !== '0x';
  const snap = JSON.parse(readFileSync('.rehearsal/snapshot.json', 'utf8'));
  let ok = 0; for (const m of snap.markets) if ((await rpc('eth_getCode', [bk.zeroTokenAddr(m.id), 'latest'])) !== '0x') ok++;
  out.tokenPagesAddressesLive = `${ok}/${snap.markets.length}`;
} catch (e) { out.error = String(e.stack || e).slice(0, 700); }
console.log(JSON.stringify(out, null, 1));
anvil.kill(); process.exit(0);
