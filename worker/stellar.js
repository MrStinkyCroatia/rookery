// Rookery ⇄ Stellar: XLM deposits (omnibus account + memo), payouts, and on-chain graduation into Aquarius.
// Network I/O is plain fetch (Horizon REST + Soroban JSON-RPC); the SDK is only used to build/sign XDR.
import { Keypair, Asset, Operation, TransactionBuilder, Networks, rpc, Address, xdr, nativeToScVal, scValToNative, Account, Memo, AuthRequiredFlag } from '@stellar/stellar-sdk';

export const ST_NETS = {
  testnet: { horizon: 'https://horizon-testnet.stellar.org', rpc: 'https://soroban-testnet.stellar.org', pass: Networks.TESTNET,
    router: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD', aqua: ['AQUA', 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER'],
    explorer: 'https://stellar.expert/explorer/testnet', aquaUi: 'https://aqua.network/pools' },
  mainnet: { horizon: 'https://horizon.stellar.org', rpc: 'https://soroban-rpc.aqua.network', rpc2: 'https://mainnet.sorobanrpc.com', pass: Networks.PUBLIC,
    router: 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK', aqua: ['AQUA', 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA'],
    explorer: 'https://stellar.expert/explorer/public', aquaUi: 'https://aqua.network/pools' },
};
export const f7 = (n) => (Math.floor(Number(n) * 1e7) / 1e7).toFixed(7);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const wei2xlm = (w) => Number(BigInt(w) / 100_000_000_000n) / 1e7;           // 18 -> 7 decimals, rounded down
export const xlm2wei = (s) => {                                                       // "12.3456789" -> 18-dec bigint
  const [i, f = ''] = String(s).split('.');
  return BigInt(i || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
};
// a safe Stellar asset code from a Rookery ticker (1-12 chars A-Z0-9)
// SEP-53: wallets sign sha256("Stellar Signed Message:\n" + message)
export async function verifySep53(address, message, signatureB64) {
  try {
    const msg = new TextEncoder().encode('Stellar Signed Message:\n' + message);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', msg));
    const sig = Buffer.from(String(signatureB64 || ''), 'base64');
    if (!sig.length) return false;
    return Keypair.fromPublicKey(String(address)).verify(Buffer.from(hash), sig);
  } catch { return false; }
}
export const issuerFromSeed = (seed) => Keypair.fromRawEd25519Seed(Buffer.from(seed));
export const assetCode = (sym) => (String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'TOKEN').slice(0, 12);

export class StellarIO {
  constructor(net, secretSeed32, extraRpc = '') {
    this.net = net; this.N = ST_NETS[net];
    // private RPC (e.g. Alchemy, from a worker secret) first, public endpoints as fallback
    this.rpcs = [extraRpc, this.N.rpc, this.N.rpc2].filter(Boolean);
    this.hot = Keypair.fromRawEd25519Seed(secretSeed32);
  }
  get hotAddress() { return this.hot.publicKey(); }
  async hz(path, init) {
    const r = await fetch(this.N.horizon + path, { ...init, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`Horizon ${r.status}: ${JSON.stringify(j?.extras?.result_codes || j?.title || '')}`); e.status = r.status; e.codes = j?.extras?.result_codes; throw e; }
    return j;
  }
  async account(id) {
    try { return await this.hz(`/accounts/${id}`); } catch (e) { if (e.status === 404) return null; throw e; }
  }
  async seq(id) { const a = await this.account(id); if (!a) throw new Error('Stellar account not found: ' + id); return new Account(id, a.sequence); }
  async submit(tx) {
    const body = 'tx=' + encodeURIComponent(tx.toXDR());
    return this.hz('/transactions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  }
  async classic(kp, ops, { signers = [], memo } = {}) {
    const tb = new TransactionBuilder(await this.seq(kp.publicKey()), { fee: '5000', networkPassphrase: this.N.pass });
    ops.forEach(o => tb.addOperation(o));
    if (memo != null) tb.addMemo(typeof memo === 'number' || /^\d+$/.test(String(memo)) ? Memo.id(String(memo)) : Memo.text(String(memo).slice(0, 28)));
    const tx = tb.setTimeout(120).build();
    tx.sign(kp, ...signers);
    return this.submit(tx);
  }
  /* ───── Soroban ───── */
  async srpc(method, params) {
    let last;
    for (const u of this.rpcs) {
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25000) });
        const j = await r.json();
        if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
        return j.result;
      } catch (e) { last = e; }
    }
    throw last;
  }
  async rpcHealth() {
    return Promise.all(this.rpcs.map(async (u, i) => {
      const t0 = Date.now();
      try {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }), signal: AbortSignal.timeout(10000) });
        const j = await r.json();
        return { rpc: i === 0 && this.rpcs.length > 2 ? 'private' : new URL(u).host, status: j.result?.status, ledger: j.result?.latestLedger, ms: Date.now() - t0 };
      } catch (e) { return { rpc: new URL(u).host, error: String(e.message).slice(0, 80), ms: Date.now() - t0 }; }
    }));
  }
  async simulate(tx) {
    const raw = await this.srpc('simulateTransaction', { transaction: tx.toXDR() });
    if (raw.error) throw new Error('simulate: ' + String(raw.error).slice(0, 300));
    return raw;
  }
  async viewRaw(contract, fn, args = []) {
    const tx = new TransactionBuilder(await this.seq(this.hotAddress), { fee: '100', networkPassphrase: this.N.pass })
      .addOperation(Operation.invokeContractFunction({ contract, function: fn, args })).setTimeout(60).build();
    const raw = await this.simulate(tx);
    return xdr.ScVal.fromXDR(raw.results[0].xdr, 'base64');
  }
  // router.get_pools -> [{ hash(hex), address }] (bytes map keys must be read from XDR, scValToNative stringifies them)
  async pools(tokens) {
    const v = await this.viewRaw(this.N.router, 'get_pools', [xdr.ScVal.scvVec(tokens.map(a => Address.fromString(a).toScVal()))]);
    const g = (o, n) => (typeof o?.[n] === 'function' ? o[n]() : o?.[n]);   // works with old and new generated XDR classes
    const entries = g(v, 'value') || [];
    return entries.map(e => ({ hash: Buffer.from(scValToNative(g(e, 'key'))).toString('hex'), address: String(scValToNative(g(e, 'val'))) }));
  }
  async view(contract, fn, args = []) {
    const tx = new TransactionBuilder(await this.seq(this.hotAddress), { fee: '100', networkPassphrase: this.N.pass })
      .addOperation(Operation.invokeContractFunction({ contract, function: fn, args })).setTimeout(60).build();
    const raw = await this.simulate(tx);
    return scValToNative(xdr.ScVal.fromXDR(raw.results[0].xdr, 'base64'));
  }
  async invoke(kp, contractOrOp, fn, args) {
    const op = typeof contractOrOp === 'string' ? Operation.invokeContractFunction({ contract: contractOrOp, function: fn, args }) : contractOrOp;
    let tx = new TransactionBuilder(await this.seq(kp.publicKey()), { fee: '1000000', networkPassphrase: this.N.pass }).addOperation(op).setTimeout(120).build();
    const raw = await this.simulate(tx);
    tx = rpc.assembleTransaction(tx, rpc.parseRawSimulation(raw)).build();
    tx.sign(kp);
    const sent = await this.srpc('sendTransaction', { transaction: tx.toXDR() });
    if (sent.status === 'ERROR') throw new Error(`${fn || 'invoke'} rejected: ${sent.errorResultXdr || ''}`.slice(0, 300));
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const g = await this.srpc('getTransaction', { hash: sent.hash });
      if (g.status === 'SUCCESS') {
        let value = null;
        try { const meta = xdr.TransactionMeta.fromXDR(g.resultMetaXdr, 'base64'); const sm = meta.value().sorobanMeta?.(); if (sm) value = scValToNative(sm.returnValue()); } catch { /* no return value */ }
        if (value == null && g.returnValue) try { value = scValToNative(xdr.ScVal.fromXDR(g.returnValue, 'base64')); } catch { /* ignore */ }
        return { hash: sent.hash, value };
      }
      if (g.status === 'FAILED') throw new Error(`${fn || 'invoke'} failed on-chain ${sent.hash}`);
    }
    throw new Error(`${fn || 'invoke'} not confirmed ${sent.hash}`);
  }
  sac(asset) { return asset.contractId(this.N.pass); }
  aquaAsset() { return new Asset(this.N.aqua[0], this.N.aqua[1]); }

  /* ───── deposits: payments into the hot account; memo id = Rookery user id ───── */
  async incoming(cursor) {
    const j = await this.hz(`/accounts/${this.hotAddress}/payments?order=asc&limit=100&join=transactions${cursor ? '&cursor=' + cursor : ''}`);
    const out = [];
    for (const p of j._embedded.records) {
      const to = p.type === 'create_account' ? p.account : p.to;
      if (to !== this.hotAddress || !p.transaction_successful) continue;
      const native = p.type === 'create_account' || (p.type === 'payment' && p.asset_type === 'native') || (/path_payment/.test(p.type) && p.asset_type === 'native');
      const token = p.type === 'payment' && p.asset_type !== 'native' && p.asset_code;
      if (!native && !token) continue;
      const amount = p.type === 'create_account' ? p.starting_balance : p.amount;
      const t = p.transaction || {};
      out.push({ id: p.id, paging: p.paging_token, from: p.from || p.funder || p.source_account, amount, memo: t.memo, memoType: t.memo_type, hash: p.transaction_hash,
        asset: native ? 'native' : `${p.asset_code}:${p.asset_issuer}`, code: native ? null : p.asset_code, issuer: native ? null : p.asset_issuer });
    }
    const last = j._embedded.records.length ? j._embedded.records[j._embedded.records.length - 1].paging_token : cursor;
    return { items: out, cursor: last, more: j._embedded.records.length === 100 };
  }
  async headCursor() {
    const j = await this.hz(`/accounts/${this.hotAddress}/payments?order=desc&limit=1`).catch(() => null);
    return j?._embedded?.records?.[0]?.paging_token || 'now';
  }

  /* ───── payouts ───── */
  async payXlm(to, amount, memo) {
    const exists = await this.account(to);
    const op = exists ? Operation.payment({ destination: to, asset: Asset.native(), amount: f7(amount) })
      : Operation.createAccount({ destination: to, startingBalance: f7(amount) });
    if (!exists && Number(amount) < 1) throw new Error('This Stellar address is not activated yet: send at least 1 XLM');
    return this.classic(this.hot, [op], { memo: memo || undefined });
  }
  async payAsset(to, code, issuer, amount, memo) {
    const a = await this.account(to);
    if (!a) throw new Error('This Stellar address does not exist yet');
    if (!a.balances.some(b => b.asset_code === code && b.asset_issuer === issuer)) throw new Error(`Add a trustline for ${code} in your Stellar wallet first (issuer ${issuer.slice(0, 6)}…)`);
    return this.classic(this.hot, [Operation.payment({ destination: to, asset: new Asset(code, issuer), amount: f7(amount) })], { memo: memo || undefined });
  }
  async balances() {
    const a = await this.account(this.hotAddress);
    return a ? a.balances : [];
  }

  /* ───── issue the asset when the token is created: it exists on Stellar from minute one ───── */
  async issueAt({ code, supply, issuerKp, log = () => {} }) {
    const asset = new Asset(code, issuerKp.publicKey());
    const iss = issuerKp.publicKey();
    // 1. the issuer account exists (2 XLM reserve); it needs no trustline of its own
    if (!(await this.account(iss))) {
      await this.classic(this.hot, [Operation.createAccount({ destination: iss, startingBalance: '2' })], { memo: `issue ${code}` });
      log('issuer account');
    }
    // 2. the hot wallet can hold the token
    const hasTrust = async () => (await this.balances()).some(b => b.asset_code === code && b.asset_issuer === iss);
    if (!(await hasTrust())) { await this.classic(this.hot, [Operation.changeTrust({ asset })]); log('trustline'); }
    // 3. mint the whole supply into the hot wallet, in slices the network accepts
    const have = async () => Number((await this.balances()).find(b => b.asset_code === code && b.asset_issuer === iss)?.balance || 0);
    let left = Number(supply) - (await have());
    while (left > 0.0000001) {
      const amt = Math.min(left, 900_000_000);
      await this.classic(this.hot, [Operation.payment({ source: iss, destination: this.hotAddress, asset, amount: f7(amt) })], { signers: [issuerKp] });
      left = Math.round((left - amt) * 1e7) / 1e7;
      log('minted ' + amt);
    }
    // 4. the token is a real contract from day one (Aquarius pools it later)
    try { await this.invoke(this.hot, Operation.createStellarAssetContract({ asset }), 'create_sac'); }
    catch (e) { if (!/exist|ExistingValue|simulate/i.test(e.message)) throw e; }
    return { issuer: iss, sac: this.sac(asset) };
  }
  // burn what the curve burned (sending it back to the issuer destroys it) and close the issuer for good
  async ensureSac(code, issuer) {
    const asset = new Asset(code, issuer);
    try { await this.invoke(this.hot, Operation.createStellarAssetContract({ asset }), 'create_sac'); }
    catch (e) { if (!/exist|ExistingValue|simulate/i.test(e.message)) throw e; }
    return this.sac(asset);
  }
  // build an unsigned XLM payment the user's own wallet signs (no keys leave the wallet)
  async buildPaymentXdr({ from, to, amount, memo, trust }) {
    const acc = await this.account(from);
    if (!acc) throw new Error('This Stellar account is not active yet: fund it with at least 1 XLM');
    const tb = new TransactionBuilder(new Account(from, acc.sequence), { fee: '10000', networkPassphrase: this.N.pass });
    if (trust && !acc.balances.some(b => b.asset_code === trust.code && b.asset_issuer === trust.issuer))
      tb.addOperation(Operation.changeTrust({ asset: new Asset(trust.code, trust.issuer) }));
    tb.addOperation(Operation.payment({ destination: to, asset: Asset.native(), amount: f7(amount) }));
    if (memo) tb.addMemo(Memo.text(String(memo).slice(0, 28)));
    return tb.setTimeout(180).build().toXDR();
  }
  // a holder sends tokens back from their wallet (to sell them on the curve); the wallet signs, we submit
  async buildTokenPaymentXdr({ from, to, code, issuer, amount, memo }) {
    const acc = await this.account(from);
    if (!acc) throw new Error('This Stellar account is not active yet');
    const tb = new TransactionBuilder(new Account(from, acc.sequence), { fee: '10000', networkPassphrase: this.N.pass });
    tb.addOperation(Operation.payment({ destination: to, asset: new Asset(code, issuer), amount: f7(amount) }));
    if (memo) tb.addMemo(Memo.text(String(memo).slice(0, 28)));
    return tb.setTimeout(180).build().toXDR();
  }
  // only a trustline, for holders who want their wallet ready before they buy
  async buildTrustXdr({ from, code, issuer }) {
    const acc = await this.account(from);
    if (!acc) throw new Error('This Stellar account is not active yet: fund it with at least 2 XLM');
    const tb = new TransactionBuilder(new Account(from, acc.sequence), { fee: '10000', networkPassphrase: this.N.pass });
    tb.addOperation(Operation.changeTrust({ asset: new Asset(code, issuer) }));
    return tb.setTimeout(180).build().toXDR();
  }
  async tokenBalance(address, code, issuer) {
    const a = await this.account(address);
    if (!a) return null;
    const b = a.balances.find(x => x.asset_code === code && x.asset_issuer === issuer);
    return b ? { balance: Number(b.balance), authorized: !!b.is_authorized } : { balance: null, authorized: false };
  }

  /* ───── tokens in holders' own wallets before graduation ───── */
  // AUTH_REQUIRED, never revocable: authorized wallets hold and move the token freely, but no contract (an Aquarius
  // pool) can receive it until graduation clears the flag, so nobody can open a pool at another price early
  async requireAuth({ code, issuerKp }) {
    const acc = await this.account(issuerKp.publicKey());
    if (!acc) throw new Error('issuer account missing');
    if (acc.flags?.auth_required) return false;
    if (!acc.signers.some(x => x.weight > 0)) return false;          // issuer already closed: token graduated
    await this.classic(this.hot, [Operation.setOptions({ source: issuerKp.publicKey(), setFlags: AuthRequiredFlag })], { signers: [issuerKp], memo: `auth ${code}` });
    return true;
  }
  // pay tokens to a holder; authorizes the trustline in the same transaction when needed
  async payAssetAuth(to, code, issuerKp, amount, memo) {
    const iss = issuerKp.publicKey();
    const a = await this.account(to);
    if (!a) throw new Error('This Stellar address does not exist yet');
    const tl = a.balances.find(b => b.asset_code === code && b.asset_issuer === iss);
    if (!tl) throw new Error(`Add a trustline for ${code} in your Stellar wallet first (issuer ${iss.slice(0, 6)}…)`);
    const asset = new Asset(code, iss);
    const ops = [];
    if (!tl.is_authorized) ops.push(Operation.setTrustLineFlags({ source: iss, trustor: to, asset, flags: { authorized: true } }));
    ops.push(Operation.payment({ destination: to, asset, amount: f7(amount) }));
    return this.classic(this.hot, ops, { signers: ops.length > 1 ? [issuerKp] : [], memo: memo || undefined });
  }
  // authorize trustlines holders opened on their own (so they can pass tokens to each other); contracts stay blocked
  async authorizeTrustlines(code, issuerKp) {
    const iss = issuerKp.publicKey();
    const j = await this.hz(`/accounts?asset=${code}:${iss}&limit=200`);
    const todo = (j._embedded?.records || [])
      .filter(r => r.account_id !== this.hotAddress && r.balances.some(b => b.asset_code === code && b.asset_issuer === iss && !b.is_authorized))
      .map(r => r.account_id);
    const asset = new Asset(code, iss);
    for (let i = 0; i < todo.length; i += 50) {
      await this.classic(this.hot, todo.slice(i, i + 50).map(t => Operation.setTrustLineFlags({ source: iss, trustor: t, asset, flags: { authorized: true } })), { signers: [issuerKp] });
    }
    return todo.length;
  }
  async submitXdr(xdrB64) {
    const tx = TransactionBuilder.fromXDR(String(xdrB64), this.N.pass);
    return this.submit(tx);
  }
  async lockIssuer({ code, issuerKp, burnTok = 0, log = () => {} }) {
    const asset = new Asset(code, issuerKp.publicKey());
    const iss = issuerKp.publicKey();
    if (!(await this.account(iss))) await this.classic(this.hot, [Operation.createAccount({ destination: iss, startingBalance: '2' })]);
    const have = Number((await this.balances()).find(b => b.asset_code === code && b.asset_issuer === iss)?.balance || 0);
    const burn = Math.min(Number(burnTok) || 0, have);
    if (burn > 0.0000001) {
      await this.classic(this.hot, [Operation.payment({ destination: iss, asset, amount: f7(burn) })], { memo: `burn ${code}` });
      log('burned ' + burn);
    }
    const acc = await this.account(iss);
    if (acc && acc.signers.some(x => x.weight > 0)) {
      await this.classic(this.hot, [Operation.setOptions({ source: iss, ...(acc.flags?.auth_required ? { clearFlags: AuthRequiredFlag } : {}),
        masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1 })], { signers: [issuerKp], memo: `lock ${code}` });
      log('issuer locked');
    }
  }

  /* ───── graduation into Aquarius (resumable: `S` is persisted by the caller after every step) ───── */
  async graduate({ code, poolXlm, poolTok, circTok, burnTok = 0, issuerKp, preIssued = false, S, save, log = () => {} }) {
    const vec = (arr) => xdr.ScVal.scvVec(arr.map(a => Address.fromString(a).toScVal()));
    const u128 = (v) => nativeToScVal(BigInt(v), { type: 'u128' });
    const stroops = (n) => BigInt(Math.floor(Number(n) * 1e7));
    if (issuerKp) {
      // the asset was minted at launch: the derived issuer is the only truth, never a stale state entry
      if (S.issuer !== issuerKp.publicKey() || S.issuerSecret) { S.issuer = issuerKp.publicKey(); delete S.issuerSecret; await save(S); }
    } else if (!S.issuer) {
      const k = Keypair.random(); S.issuer = k.publicKey(); S.issuerSecret = k.secret(); await save(S);
    }
    const asset = new Asset(code, S.issuer);
    if (!S.issued) {
      if (preIssued && issuerKp) {
        // the asset was minted when the token was created: burn what the curve burned, then close the issuer
        if (!S.issuerLocked) { await this.lockIssuer({ code, issuerKp, burnTok, log }); S.issuerLocked = true; await save(S); }
        S.issued = true; await save(S);
      } else {
        const iss = S.issuerSecret ? Keypair.fromSecret(S.issuerSecret) : issuerKp;
        await this.classic(this.hot, [
          Operation.createAccount({ destination: S.issuer, startingBalance: '2' }),
          Operation.changeTrust({ asset }),
          Operation.payment({ source: S.issuer, destination: this.hotAddress, asset, amount: f7(Number(poolTok) + Number(circTok)) }),
          Operation.setOptions({ source: S.issuer, homeDomain: 'rookery.stinkypenguin.xyz' }),
          Operation.setOptions({ source: S.issuer, masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1 }),
        ], { signers: [iss], memo: `rookery grad ${code}` });
        S.issued = true; delete S.issuerSecret; await save(S); log('issued');
      }
    }
    const tokC = this.sac(asset), xlmC = this.sac(Asset.native());
    if (!S.sac) {
      try { await this.invoke(this.hot, Operation.createStellarAssetContract({ asset }), 'create_sac'); }
      catch (e) { if (!/exist|ExistingValue|simulate/i.test(e.message)) throw e; }
      S.sac = tokC; await save(S); log('sac');
    }
    const tokens = Buffer.compare(Address.fromString(xlmC).toBuffer(), Address.fromString(tokC).toBuffer()) < 0 ? [xlmC, tokC] : [tokC, xlmC];
    S.tokens = tokens;
    if (!S.poolHash) {
      const ex = (await this.pools(tokens))[0];
      if (ex) { S.poolHash = ex.hash; S.pool = ex.address; }
      else {
        const payTok = String(await this.view(this.N.router, 'get_init_pool_payment_token'));
        if (payTok !== this.sac(this.aquaAsset())) throw new Error('Aquarius pool fee token changed: ' + payTok);
        const need = Number(await this.view(this.N.router, 'get_standard_pool_payment_amount')) / 1e7;
        const bal = await this.balances();
        const aq = this.aquaAsset();
        const have = Number(bal.find(b => b.asset_code === aq.code && b.asset_issuer === aq.issuer)?.balance || 0);
        if (have < need) {
          const xlmBefore = Number(bal.find(b => b.asset_type === 'native').balance);
          const ops = [];
          if (!bal.some(b => b.asset_code === aq.code && b.asset_issuer === aq.issuer)) ops.push(Operation.changeTrust({ asset: aq }));
          ops.push(Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: f7(S.aquaMaxXlm), destination: this.hotAddress, destAsset: aq, destAmount: f7(need - have + 0.0000001), path: [] }));
          await this.classic(this.hot, ops);
          const after = await this.balances();
          S.aquaCostXlm = Math.max(0, xlmBefore - Number(after.find(b => b.asset_type === 'native').balance));
          await save(S); log(`bought ${need} AQUA for ${S.aquaCostXlm} XLM`);
        }
        await this.invoke(this.hot, this.N.router, 'init_standard_pool', [Address.fromString(this.hotAddress).toScVal(), vec(tokens), nativeToScVal(30, { type: 'u32' })]);
        // read the pool back from the registry instead of decoding the return value (meta format differs across protocols)
        const e2 = (await this.pools(tokens))[0];
        if (!e2) throw new Error('Aquarius pool not found after creation');
        S.poolHash = e2.hash; S.pool = e2.address;
      }
      await save(S); log('pool ' + S.pool);
    }
    // XLM that actually goes into the pool: the graduation reserve minus what the on-chain set-up costs
    if (S.depositXlm == null) {
      // issuer 2 + keeper reserve 6 + 3 for Soroban fees and the hot wallet's trustline reserve: what is left over stays with
      // the platform, so the hot wallet can never end up short of user balances because of a graduation
      S.depositXlm = Math.floor((Number(poolXlm) - (S.aquaCostXlm || 0) - 2 - 6 - 3) * 1e7) / 1e7;
      if (S.depositXlm <= 0) throw new Error('Graduation reserve too small for the on-chain set-up');
      await save(S);
    }
    // never pour into a pool someone else already priced: the deposit would land at their ratio
    if (!S.funded) {
      const r = await this.poolReserves(S.pool, tokens);
      if (r.xlm > 0 || r.tok > 0) throw new Error(`Aquarius pool ${S.pool} already holds liquidity (${r.xlm} XLM / ${r.tok} tokens): graduation paused for review`);
    }
    if (!S.keeper) { const k = Keypair.random(); S.keeper = k.publicKey(); S.keeperSecret = k.secret(); await save(S); }
    if (!S.funded) {
      const kp = Keypair.fromSecret(S.keeperSecret);
      await this.classic(this.hot, [
        Operation.createAccount({ destination: S.keeper, startingBalance: f7(S.depositXlm + 6) }),
        Operation.changeTrust({ source: S.keeper, asset }),
        Operation.payment({ destination: S.keeper, asset, amount: f7(poolTok) }),
      ], { signers: [kp] });
      S.funded = true; await save(S); log('keeper funded');
    }
    if (!S.deposited) {
      const kp = Keypair.fromSecret(S.keeperSecret);
      const amounts = tokens.map(t => (t === xlmC ? stroops(S.depositXlm) : stroops(poolTok)));
      const r = await this.invoke(kp, this.N.router, 'deposit', [Address.fromString(S.keeper).toScVal(), vec(tokens),
        nativeToScVal(Buffer.from(S.poolHash, 'hex'), { type: 'bytes' }), xdr.ScVal.scvVec(amounts.map(u128)), u128(0)]);
      S.deposited = r.hash; await save(S); log('deposited');
    }
    if (!S.locked) {
      const kp = Keypair.fromSecret(S.keeperSecret);
      await this.classic(kp, [Operation.setOptions({ masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1 })]);
      S.locked = true; delete S.keeperSecret; await save(S); log('keeper locked');
    }
    return S;
  }
  async poolReserves(pool, tokens) {
    const res = await this.view(pool, 'get_reserves');
    const xlmC = this.sac(Asset.native());
    const i = tokens.indexOf(xlmC);
    return { xlm: Number(res[i]) / 1e7, tok: Number(res[1 - i]) / 1e7 };
  }
}
