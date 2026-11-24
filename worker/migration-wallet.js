import {getAddress, verifyMessage, ZeroAddress} from 'ethers';

// Enrollment only. This table does not authorize a withdrawal or modify any ledger balance.
export function migrationWallet(book, uid, op, input, origin) {
  const sql = book.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS zero_recipient_v1(uid INTEGER PRIMARY KEY, addr TEXT UNIQUE NOT NULL, confirmed INTEGER NOT NULL, message TEXT NOT NULL, signature TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS zero_recipient_challenge(uid INTEGER PRIMARY KEY, addr TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, origin TEXT NOT NULL, message TEXT NOT NULL)');
  const current = () => sql.exec('SELECT addr AS address, confirmed FROM zero_recipient_v1 WHERE uid=?',uid).toArray()[0] || null;
  const locked = () => !!book.meta('mig_snapshot_zero') || book.netPaused('zero') || book.meta('zero_finalized') === '1';
  if(op === 'status') return {recipient:current(),locked:locked()};
  if(locked()) throw new Error('Migration enrollment is closed.');
  if(current()) throw new Error('A verified destination already exists for this account.');
  if(op === 'challenge') {
    const addr=getAddress(String(input.address || '')); if(addr===ZeroAddress) throw new Error('Choose your own EVM wallet.');
    const nonce=crypto.randomUUID(), expires=Date.now()+300000;
    const message=['Rookery | Zero migration destination',origin,'Account: u'+uid,'Destination: '+addr,'Network: Zero (33002)','Register this address for my migration allocation only. No transfer, token approval or login.', 'Nonce: '+nonce,'Expires: '+new Date(expires).toISOString()].join('\n');
    sql.exec('INSERT OR REPLACE INTO zero_recipient_challenge VALUES(?,?,?,?,?,?)',uid,addr,nonce,expires,origin,message);
    return {message,nonce,address:addr};
  }
  if(op !== 'confirm') throw new Error('Unknown enrollment action');
  return book.ctx.storage.transactionSync(()=>{
    const c=sql.exec('SELECT * FROM zero_recipient_challenge WHERE uid=?',uid).toArray()[0];
    if(!c || c.origin!==origin || c.nonce!==input.nonce || c.expires<=Date.now()) throw new Error('Request a new signature: this request has expired or was replaced.');
    if(!/^0x[0-9a-f]{130}$/i.test(input.signature || '') || verifyMessage(c.message,input.signature)!==c.addr) throw new Error('The signature does not match the selected wallet.');
    if(sql.exec('SELECT uid FROM zero_recipient_v1 WHERE addr=?',c.addr).toArray().length) throw new Error('This wallet is already registered.');
    sql.exec('INSERT INTO zero_recipient_v1 VALUES(?,?,?,?,?)',uid,c.addr,Date.now(),c.message,input.signature);
    sql.exec('DELETE FROM zero_recipient_challenge WHERE uid=?',uid);
    return {recipient:current(),locked:false};
  });
}
