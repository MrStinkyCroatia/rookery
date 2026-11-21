// Fixed Litecoin deposit address per user, the same way ZRO/ETH deposits work: one address, send any time,
// credited automatically once it confirms. Keys are derived from the master secret (BIP44 coin type 2, native
// segwit P2WPKH), so no per-order quotes and no expiry. A scanner watches each address through a public
// explorer and credits the difference between what the address received and what we already credited.
import { SigningKey } from 'ethers';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/* ── ripemd160 (WebCrypto has no ripemd160; compact reference implementation) ── */
function ripemd160(bytes) {
  const zl = (x, n) => (x << n) | (x >>> (32 - n));
  const f = (j, x, y, z) => (j < 16 ? x ^ y ^ z : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z));
  const K = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
  const KK = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];
  const r1 = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
  const r2 = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
  const s1 = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
  const s2 = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
  const len = bytes.length;
  const msg = Array.from(bytes); msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  const bits = len * 8;
  for (let i = 0; i < 8; i++) msg.push(i < 4 ? (bits >>> (8 * i)) & 255 : 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  for (let off = 0; off < msg.length; off += 64) {
    const X = [];
    for (let i = 0; i < 16; i++) X[i] = msg[off + 4 * i] | (msg[off + 4 * i + 1] << 8) | (msg[off + 4 * i + 2] << 16) | (msg[off + 4 * i + 3] << 24);
    let al = h0, bl = h1, cl = h2, dl = h3, el = h4, ar = h0, br = h1, cr = h2, dr = h3, er = h4;
    for (let j = 0; j < 80; j++) {
      let t = (zl((al + f(j, bl, cl, dl) + X[r1[j]] + K[(j / 16) | 0]) | 0, s1[j]) + el) | 0;
      al = el; el = dl; dl = zl(cl, 10); cl = bl; bl = t;
      t = (zl((ar + f(79 - j, br, cr, dr) + X[r2[j]] + KK[(j / 16) | 0]) | 0, s2[j]) + er) | 0;
      ar = er; er = dr; dr = zl(cr, 10); cr = br; br = t;
    }
    const t = (h1 + cl + dr) | 0;
    h1 = (h2 + dl + er) | 0; h2 = (h3 + el + ar) | 0; h3 = (h4 + al + br) | 0; h4 = (h0 + bl + cr) | 0; h0 = t;
  }
  const out = [];
  for (const h of [h0, h1, h2, h3, h4]) for (let i = 0; i < 4; i++) out.push((h >>> (8 * i)) & 255);
  return new Uint8Array(out);
}

/* ── bech32 (BIP173) ── */
function polymod(v) {
  let c = 1;
  for (const x of v) {
    const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= GEN[i];
  }
  return c >>> 0;
}
const hrpExpand = (h) => [...[...h].map(c => c.charCodeAt(0) >> 5), 0, ...[...h].map(c => c.charCodeAt(0) & 31)];
const to5 = (bytes) => {
  const out = []; let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
};
export function bech32Encode(hrp, version, program) {
  const data = [version, ...to5(program)];
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const chk = []; for (let i = 0; i < 6; i++) chk.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data, ...chk].map(x => CHARSET[x]).join('');
}

async function hash160(pub) {
  const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', pub));
  return ripemd160(sha);
}

export async function ltcAddressFromPubkey(pub) {
  return bech32Encode('ltc', 0, await hash160(pub));
}

export function installLtcaddr(Cls, H) {
  const { B, now, WEI } = H;
  const P = Cls.prototype;

  P.ltcAddrInit = function () {
    if (this._ltcAddr) return; this._ltcAddr = true;
    for (const c of ['ltc_index INTEGER', 'ltc_address TEXT']) { try { this.sql.exec(`ALTER TABLE users ADD COLUMN ${c}`); } catch { /* exists */ } }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ltc_scan (address TEXT PRIMARY KEY, credited_sat TEXT DEFAULT '0', last_ts INTEGER)`);
  };

  // BIP44 coin type 2 (Litecoin), native segwit; index 9_000_000+ so it can never collide with EVM deposit children
  P.ltcAddressFor = async function (user) {
    this.ltcAddrInit();
    const row = this.sql.exec('SELECT ltc_index, ltc_address FROM users WHERE id=?', user.id).one();
    if (row.ltc_address) return row.ltc_address;
    if (!this.env.MASTER_XPRV) throw new Error('wallet service not configured');
    // the master key already sits at m/44'/60'/0'/0, so LTC keys live on a separate index range of the same tree
    const idx = 9_000_000 + Number(user.id);
    const w = this.master().deriveChild(idx);
    const pub = new SigningKey(w.privateKey).compressedPublicKey;
    if (!/^0x0[23][0-9a-f]{64}$/i.test(pub)) throw new Error('bad public key: ' + String(pub).slice(0, 12));
    const addr = await ltcAddressFromPubkey(Uint8Array.from(pub.slice(2).match(/../g).map(x => parseInt(x, 16))));
    this.sql.exec('UPDATE users SET ltc_index=?, ltc_address=? WHERE id=?', idx, addr, user.id);
    return addr;
  };

  // scanner: credit everything an address has received that we have not credited yet
  P.ltcScan = async function (limit = 60) {
    this.ltcAddrInit();
    const rows = this.sql.exec('SELECT id, ltc_address FROM users WHERE ltc_address IS NOT NULL LIMIT ?', limit).toArray();
    const done = [];
    for (const u of rows) {
      const seen = this.sql.exec('SELECT credited_sat FROM ltc_scan WHERE address=?', u.ltc_address).toArray()[0];
      let got = 0;
      try {
        const r = await fetch('https://litecoinspace.org/api/address/' + u.ltc_address, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const j = await r.json();
        got = Number(j?.chain_stats?.funded_txo_sum || 0);
      } catch { continue; }
      const had = Number(seen?.credited_sat || 0);
      if (got > had) {
        const delta = got - had;                       // satoshis
        const units = BigInt(delta) * 10n ** 10n;      // 1e8 sat = 1 LTC = 1e18 units
        this.ctx.storage.transactionSync(() => {
          const cur = this.sql.exec('SELECT credited_sat FROM ltc_scan WHERE address=?', u.ltc_address).toArray()[0];
          const base = Number(cur?.credited_sat || 0);
          if (got <= base) return;
          this.addBal(u.id, 'ltc', BigInt(got - base) * 10n ** 10n);
          this.sql.exec(`INSERT INTO ltc_scan (address, credited_sat, last_ts) VALUES (?,?,?)
            ON CONFLICT(address) DO UPDATE SET credited_sat=excluded.credited_sat, last_ts=excluded.last_ts`, u.ltc_address, String(got), now());
        });
        done.push({ address: u.ltc_address, credited: (Number(units) / 1e18).toFixed(8) });
      }
    }
    return { scanned: rows.length, credited: done };
  };
}
