// Integration check against isolated staging only. No chain transactions or persistent private keys.
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
const root='https://rookery-staging.stablepump-ops.workers.dev/api';
let cookie='';
async function api(path,body){const r=await fetch(root+path+(body?'':'?r='+Math.random()),{method:body?'POST':'GET',headers:{'content-type':'application/json','x-pl':'1',cookie},body:body?JSON.stringify(body):undefined});const c=r.headers.get('set-cookie');if(c) cookie=c.split(';')[0];return [r.status,await r.json()];}
const dest='/migration/zero/recipient', login=Wallet.createRandom(), wallet=Wallet.createRandom();
assert.equal((await api(dest))[0],401);
const [,n]=await api('/auth/wallet/nonce',{address:login.address});assert.equal((await api('/auth/wallet/verify',{nonce:n.nonce,signature:await login.signMessage(n.message)}))[0],200);
const [,initial]=await api(dest);assert.equal(initial.recipient,null);
if(initial.locked){assert.notEqual((await api(dest+'/challenge',{address:wallet.address}))[0],200);console.log('PASS staging: account status, authorization and snapshot enrollment lock');process.exit(0);}
const [,c]=await api(dest+'/challenge',{address:wallet.address});assert.ok(c.message.includes(wallet.address));
const wrong=await api(dest+'/confirm',{nonce:c.nonce,signature:await login.signMessage(c.message)});assert.notEqual(wrong[0],200);
const signed={nonce:c.nonce,signature:await wallet.signMessage(c.message)};
const [status,result]=await api(dest+'/confirm',signed);assert.equal(status,200,JSON.stringify(result));assert.equal(result.recipient.address,wallet.address);
assert.equal((await api(dest))[1].recipient.address,wallet.address);
assert.notEqual((await api(dest+'/confirm',signed))[0],200);
assert.notEqual((await api(dest+'/challenge',{address:login.address}))[0],200);
console.log('PASS staging: authentication, empty state, signed destination, wrong signer rejected, verification persisted, replay and overwrite refused');
