// Read-only mainnet checks for the Rookery Stellar flow (no signing, no funds moved).
import * as SDK from '@stellar/stellar-sdk';
const { rpc, Contract, TransactionBuilder, Networks, Asset, scValToNative, Account } = SDK;
const HOT = 'GDZWHJSSMSQF2GU5S7V4WOJY7BEZUQI3PFHKNK3AHEEFLVNEKG3QX3NI';
const ROUTER = 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK';
const AQUA = new Asset('AQUA', 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA');
const H = 'https://horizon.stellar.org';
const srv = new rpc.Server(process.env.RPC);

async function view(fn, args = []) {
  const acc = await srv.getAccount(HOT);
  const tx = new TransactionBuilder(new Account(HOT, acc.sequenceNumber()), { fee: '100', networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(ROUTER).call(fn, ...args)).setTimeout(60).build();
  const sim = await srv.simulateTransaction(tx);
  if (sim.error) throw new Error(sim.error);
  return scValToNative(sim.result.retval);
}

const t0 = Date.now();
const fee = await view('get_standard_pool_payment_amount');
const payTok = await view('get_init_pool_payment_token');
console.log('pool fee (AQUA):', Number(fee) / 1e7, `| via Alchemy ${Date.now() - t0}ms`);
console.log('payment token = AQUA SAC:', payTok === AQUA.contractId(Networks.PUBLIC) ? 'OK' : 'MISMATCH ' + payTok);

const need = (Number(fee) / 1e7).toFixed(7);
const p = await (await fetch(`${H}/paths/strict-receive?source_assets=native&destination_asset_type=credit_alphanum4&destination_asset_code=AQUA&destination_asset_issuer=${AQUA.issuer}&destination_amount=${need}`)).json();
const best = p._embedded.records.sort((a, b) => a.source_amount - b.source_amount)[0];
console.log(`XLM to buy ${need} AQUA now: ${best.source_amount} XLM`);
// XLM side of the pool at graduation ~ (grad mcap in XLM) * 200M/1B
const xlmUsd = Number(process.env.XLMUSD || 0.1387);
const poolXlm = 30000 / xlmUsd * 0.2;
const cap = Math.min(poolXlm * 0.25, 2500);
console.log('XLM side of pool at $30k grad ~', Math.round(poolXlm), '| AQUA budget cap', cap.toFixed(0), +best.source_amount < cap ? 'OK' : 'OVER CAP');
