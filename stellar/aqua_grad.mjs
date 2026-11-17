// Graduation to Aquarius, step by step (shared by the test script and mirrored in the worker):
//  1 issue asset (1B to the hot wallet, issuer locked)  2 deploy its SAC  3 hot wallet buys the AQUA pool fee
//  4 router.init_standard_pool  5 keeper (fresh, funded with XLM + pool tokens) deposits  6 keeper locked = LP burned
import * as SDK from '@stellar/stellar-sdk';
const { Keypair, Asset, Operation, TransactionBuilder, nativeToScVal, Address, xdr, rpc, Horizon, scValToNative } = SDK;

export const NETS = {
  testnet: { horizon: 'https://horizon-testnet.stellar.org', rpc: 'https://soroban-testnet.stellar.org', pass: SDK.Networks.TESTNET,
    router: 'CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD', aqua: new Asset('AQUA', 'GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER') },
  mainnet: { horizon: 'https://horizon.stellar.org', rpc: 'https://soroban-rpc.aqua.network', pass: SDK.Networks.PUBLIC,
    router: 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK', aqua: new Asset('AQUA', 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA') },
};
export const fmt7 = (n) => (Math.floor(Number(n) * 1e7) / 1e7).toFixed(7);

export function ctx(net) {
  const N = NETS[net];
  return { N, hz: new Horizon.Server(N.horizon), rp: new rpc.Server(N.rpc), net };
}
export async function classic(c, kp, ops, extraSigners = []) {
  const a = await c.hz.loadAccount(kp.publicKey());
  const tb = new TransactionBuilder(a, { fee: '2000', networkPassphrase: c.N.pass });
  ops.forEach(o => tb.addOperation(o));
  const tx = tb.setTimeout(120).build();
  tx.sign(kp, ...extraSigners);
  try { return await c.hz.submitTransaction(tx); }
  catch (e) { throw new Error('classic tx failed: ' + JSON.stringify(e.response?.data?.extras?.result_codes || e.message)); }
}
export async function invoke(c, kp, contract, fn, args) {
  const a = await c.rp.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(a, { fee: '1000000', networkPassphrase: c.N.pass })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args })).setTimeout(120).build();
  const sim = await c.rp.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`simulate ${fn}: ${sim.error}`);
  tx = rpc.assembleTransaction(tx, sim).build();
  tx.sign(kp);
  const sent = await c.rp.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`send ${fn}: ${JSON.stringify(sent.errorResult?.result()?.switch?.()?.name || sent)}`);
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const g = await c.rp.getTransaction(sent.hash);
    if (g.status === 'SUCCESS') return { hash: sent.hash, value: g.returnValue ? scValToNative(g.returnValue) : null };
    if (g.status === 'FAILED') throw new Error(`${fn} failed on-chain ${sent.hash}`);
  }
  throw new Error(`${fn} not confirmed ${sent.hash}`);
}
export async function simulateView(c, contract, fn, args, source) {
  const a = await c.rp.getAccount(source);
  const tx = new TransactionBuilder(a, { fee: '100', networkPassphrase: c.N.pass })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args })).setTimeout(60).build();
  const sim = await c.rp.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`view ${fn}: ${sim.error}`);
  return scValToNative(sim.result.retval);
}
export const sac = (c, asset) => asset.contractId(c.N.pass);
export const sortTokens = (a, b) => (Buffer.compare(Address.fromString(a).toBuffer(), Address.fromString(b).toBuffer()) < 0 ? [a, b] : [b, a]);
const vecAddr = (arr) => xdr.ScVal.scvVec(arr.map(x => Address.fromString(x).toScVal()));
const u128 = (v) => nativeToScVal(BigInt(v), { type: 'u128' });
const stroops = (n) => BigInt(Math.floor(Number(n) * 1e7));

/** whole graduation; `state` is persisted between steps by the caller (job resume) */
export async function graduate(c, hot, { code, poolXlm, poolTok, circTok, state = {}, save = async () => {}, log = () => {} }) {
  const S = state;
  // 1) issuer -> asset, all supply to the hot wallet (users' circulating balances + pool tokens), issuer locked
  if (!S.issuer) {
    const iss = Keypair.random();
    S.issuer = iss.publicKey(); S.issuerSecret = iss.secret(); await save(S);
  }
  const asset = new Asset(code, S.issuer);
  if (!S.issued) {
    const iss = Keypair.fromSecret(S.issuerSecret);
    const total = Number(poolTok) + Number(circTok);
    await classic(c, hot, [
      Operation.createAccount({ destination: S.issuer, startingBalance: '2' }),
      Operation.changeTrust({ asset }),
      Operation.payment({ source: S.issuer, destination: hot.publicKey(), asset, amount: fmt7(total) }),
      Operation.setOptions({ source: S.issuer, homeDomain: 'rookery.stinkypenguin.xyz' }),
      Operation.setOptions({ source: S.issuer, masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1 }),
    ], [iss]);
    S.issued = true; delete S.issuerSecret; await save(S); log('issued + issuer locked');
  }
  // 2) SAC for the asset (idempotent: already-exists is fine)
  const tokC = sac(c, asset), xlmC = sac(c, Asset.native());
  if (!S.sac) {
    try {
      const a = await c.rp.getAccount(hot.publicKey());
      let tx = new TransactionBuilder(a, { fee: '1000000', networkPassphrase: c.N.pass }).addOperation(Operation.createStellarAssetContract({ asset })).setTimeout(120).build();
      const sim = await c.rp.simulateTransaction(tx);
      if (!rpc.Api.isSimulationError(sim)) {
        tx = rpc.assembleTransaction(tx, sim).build(); tx.sign(hot);
        const s = await c.rp.sendTransaction(tx);
        for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 1500)); const g = await c.rp.getTransaction(s.hash); if (g.status !== 'NOT_FOUND') break; }
      }
    } catch (e) { log('sac: ' + e.message); }
    S.sac = tokC; await save(S); log('SAC ' + tokC);
  }
  const tokens = sortTokens(xlmC, tokC);
  // 3+4) pool: reuse an existing standard pool for the pair, otherwise create one (hot pays the AQUA fee)
  if (!S.poolHash) {
    const pools = await simulateView(c, c.N.router, 'get_pools', [vecAddr(tokens)], hot.publicKey());
    const existing = pools && Object.keys(pools).length ? Object.entries(pools)[0] : null;
    if (existing) { S.poolHash = Buffer.from(existing[0]).toString('hex'); S.pool = existing[1]; }
    else {
      const payTok = String(await simulateView(c, c.N.router, 'get_init_pool_payment_token', [], hot.publicKey()));
      if (payTok !== sac(c, c.N.aqua)) throw new Error('Aquarius pool fee token changed: ' + payTok);
      const need = Number(await simulateView(c, c.N.router, 'get_standard_pool_payment_amount', [], hot.publicKey())) / 1e7;
      const acct = await c.hz.loadAccount(hot.publicKey());
      const have = Number(acct.balances.find(b => b.asset_code === c.N.aqua.code && b.asset_issuer === c.N.aqua.issuer)?.balance || 0);
      if (have < need) {
        const ops = [];
        if (!acct.balances.some(b => b.asset_code === c.N.aqua.code && b.asset_issuer === c.N.aqua.issuer)) ops.push(Operation.changeTrust({ asset: c.N.aqua }));
        ops.push(Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: fmt7(Number(S.aquaMaxXlm || 5000)), destination: hot.publicKey(), destAsset: c.N.aqua, destAmount: fmt7(need - have + 1), path: [] }));
        await classic(c, hot, ops); log(`bought ${need - have} AQUA`);
      }
      const r = await invoke(c, hot, c.N.router, 'init_standard_pool', [new Address(hot.publicKey()).toScVal(), vecAddr(tokens), nativeToScVal(30, { type: 'u32' })]);
      S.poolHash = Buffer.from(r.value[0]).toString('hex'); S.pool = r.value[1];
    }
    await save(S); log('pool ' + S.pool);
  }
  // 5) keeper: fresh account, receives the pool XLM + tokens, deposits, then 6) locks itself
  if (!S.keeper) { const k = Keypair.random(); S.keeper = k.publicKey(); S.keeperSecret = k.secret(); await save(S); }
  const keeper = S.keeperSecret ? Keypair.fromSecret(S.keeperSecret) : null;
  if (!S.funded) {
    await classic(c, hot, [
      Operation.createAccount({ destination: S.keeper, startingBalance: fmt7(Number(poolXlm) + 6) }),
      Operation.changeTrust({ source: S.keeper, asset }),
      Operation.payment({ destination: S.keeper, asset, amount: fmt7(poolTok) }),
    ], [keeper]);
    S.funded = true; await save(S); log('keeper funded');
  }
  if (!S.deposited) {
    const amounts = tokens.map(t => (t === xlmC ? stroops(poolXlm) : stroops(poolTok)));
    const r = await invoke(c, keeper, c.N.router, 'deposit', [new Address(S.keeper).toScVal(), vecAddr(tokens), nativeToScVal(Buffer.from(S.poolHash, 'hex'), { type: 'bytes' }),
      xdr.ScVal.scvVec(amounts.map(u128)), u128(0)]);
    S.deposited = r.hash; await save(S); log('deposited ' + r.hash);
  }
  if (!S.locked) {
    await classic(c, keeper, [Operation.setOptions({ masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1 })]);
    S.locked = true; delete S.keeperSecret; await save(S); log('keeper locked — LP burned');
  }
  return { ...S, asset: `${code}:${S.issuer}`, tokens };
}
export { SDK, Keypair, Asset, Address, nativeToScVal, xdr };
