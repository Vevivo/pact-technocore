import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.mjs';
import { generateIdentity, signWithJwk, sha256 } from '../src/crypto.mjs';
import { makeOffer, makeAccept, encodeFrame, generateHashLock, dealRoom } from '../src/vendor/tclk/index.js';
import { inspectRecord, parseExactJson, makeBundle, verifyBundle, stableJson, digest } from '../src/evidence-protocol.mjs';
import { EvidenceStore } from '../src/evidence-store.mjs';
import { EvidenceWorker } from '../src/evidence-worker.mjs';
import { createApi } from '../src/http-api.mjs';
import { NetworkStore } from '../src/network-store.mjs';

function fixture(t, options={}) {
  const dir=mkdtempSync(join(tmpdir(),'pact-evidence-test-')),store=new Store(join(dir,'pact.sqlite'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const config={technocoreBase:'https://technocore.chat',room:'mb-pact-work-v1',masterKey:randomBytes(32),publicOrigins:new Set(),allowedOwnerDids:new Set(),hostedRegistration:'open',...options};
  const ledger=new EvidenceStore(store,config),payer=generateIdentity(),payee=generateIdentity(),now=Date.now(),lock=generateHashLock();
  const rail=options.rail??'paper';
  const offer=makeOffer({from:payer.did,role:'payer',amount:'10',asset:'USDC',lock:'hash',rails:[rail],expiresMs:now+60000,claimByMs:now+120000,refundAfterMs:now+240000,job:{proto:'pact',id:'test-job',context:'Unit test only'}});
  const accept=makeAccept(offer,{from:payee.did,statement:lock.hash});const room=dealRoom(accept.contract);
  let increment=0;
  const message=(name,seq,signer,frame,ts=now+increment++)=>{
    const text=typeof frame==='string'?frame:encodeFrame(frame),nonce=`178787111111111${seq.toString().padStart(4,'0')}`;
    return {seq,ts:new Date(ts).toISOString(),from:signer.did,nonce,text,sig:signWithJwk(signer.privateJwk,`${name}|${nonce}|${text}`)};
  };
  const board=[message('tclk-offers',101,payer,offer),message('tclk-offers',102,payee,accept)];
  const deal=[message(room,1,payer,{type:'lock',from:payer.did,contract:accept.contract,rail,ref:'paper:test-1'}),message(room,2,payee,{type:'reveal',from:payee.did,contract:accept.contract,secret:lock.preimage})];
  const seed=()=>{ledger.markRoom('tclk-offers',{generation:1,cursor:102,firstSeq:100,gaps:[{kind:'HISTORY_BEFORE_CAPTURE',from:1,to:99,generation:1}]});ledger.markRoom(room,{generation:1,cursor:2,firstSeq:1,gaps:[]});for(const m of board)ledger.ingest('tclk-offers',1,m);for(const m of deal)ledger.ingest(room,1,m);};
  return {store,config,ledger,payer,payee,now,lock,offer,accept,room,message,board,deal,seed};
}
const response=(room,messages,generation=1)=>new Response(JSON.stringify({room,messages,generation}),{headers:{'content-type':'application/json'}});

test('evidence: exact 19-digit nonce survives JSON and signature verification',t=>{
  const f=fixture(t),m=f.board[0];const raw=JSON.stringify(m).replace(`"nonce":"${m.nonce}"`,`"nonce":${m.nonce}`);
  const parsed=parseExactJson(raw);assert.equal(parsed.nonce,m.nonce);assert.equal(inspectRecord('tclk-offers',parsed).valid,true);
  assert.equal(inspectRecord('tclk-offers',{...m,text:m.text+'x'}).signatureValid,false);
  assert.equal(inspectRecord('lobby',m).signatureValid,false);
});
test('evidence: two-party path, paper distinction, search and portable verification',t=>{
  const f=fixture(t);f.seed();const d=f.ledger.detail(f.accept.contract);
  assert.equal(d.status,'claimed');assert.equal(d.assessment.payment.status,'NO_VALUE');assert.equal(d.coverage.status,'OBSERVED_CONTIGUOUS');
  assert.equal(f.ledger.list(f.payer.did,25,0,'contracts').total,1);assert.equal(f.ledger.list('102',25,0,'contracts').total,1);assert.equal(f.ledger.list('paper:test-1',25,0,'contracts').total,1);
  const b=makeBundle(d);assert.equal(verifyBundle(b).verdict,'VALID_OBSERVED_TRANSCRIPT');
  b.records[0].message.text+='tampered';assert.equal(verifyBundle(b).verdict,'TAMPERED_OR_INVALID');
});
test('evidence: replays cannot change state and cannot poison a valid path',t=>{
  const f=fixture(t);f.seed();f.ledger.ingest(f.room,1,{...f.deal[1],seq:3});const d=f.ledger.detail(f.accept.contract);
  assert.equal(d.status,'claimed');assert.equal(d.assessment.rejected.length,1);assert.equal(d.assessment.protocolValid,true);
});
test('evidence: modified cached verdict never substitutes for envelope verification',t=>{
  const f=fixture(t);f.seed();const b=makeBundle(f.ledger.detail(f.accept.contract));
  b.records[1].protocolValid=false;b.records[1].message.sig='A'.repeat(86);delete b.bundleSha256;b.bundleSha256=digest(stableJson(b));
  assert.equal(verifyBundle(b).signaturesValid,false);
});
test('evidence: wrong signer or wrong room cannot produce a verified handshake',t=>{
  const f=fixture(t);const bad=f.message('tclk-offers',103,f.payer,f.accept);
  assert.equal(inspectRecord('tclk-offers',bad).valid,false);
  assert.equal(inspectRecord('lobby',f.message('lobby',1,f.payer,f.offer)).valid,false);
  f.ledger.ingest('tclk-offers',1,f.board[0]);f.ledger.ingest('tclk-offers',1,bad);assert.equal(f.ledger.get(f.accept.contract),null);
});
test('evidence: missing history is explicit, unknown epochs are not contiguous',t=>{
  const f=fixture(t);f.seed();f.ledger.markRoom(f.room,{generation:1,cursor:2,firstSeq:2,gaps:[{kind:'HISTORY_BEFORE_CAPTURE',from:1,to:1}]});
  assert.equal(verifyBundle(makeBundle(f.ledger.detail(f.accept.contract))).verdict,'INCOMPLETE');
  f.ledger.markRoom(f.room,{generation:null,cursor:2,gaps:[]});assert.equal(f.ledger.detail(f.accept.contract).coverage.status,'INCOMPLETE');
});
test('evidence: expired and cross-epoch acceptances do not create contracts',t=>{
  const f=fixture(t);f.ledger.ingest('tclk-offers',1,f.board[0]);f.ledger.ingest('tclk-offers',2,f.board[1]);assert.equal(f.ledger.get(f.accept.contract),null);
  f.ledger.ingest('tclk-offers',1,f.message('tclk-offers',103,f.payee,f.accept,f.now+120000));assert.equal(f.ledger.get(f.accept.contract),null);
});
test('evidence: multiple counterparties are separate contracts, not one offer status',t=>{
  const f=fixture(t);f.seed();const another=generateIdentity(),a=makeAccept(f.offer,{from:another.did,statement:generateHashLock().hash});
  f.ledger.ingest('tclk-offers',1,f.message('tclk-offers',103,another,a));assert.equal(f.ledger.list('',25,0,'contracts').total,2);
});
test('evidence: collection does not write rooms or call a model; generation reset is visible',async t=>{
  const f=fixture(t);let version=1,calls=[];const w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{},{fetch:async(url,init)=>{calls.push({url:String(url),init});return response('tclk-offers',f.board,version);}});
  await w.readRoom('tclk-offers');assert.equal(f.ledger.room('tclk-offers').cursor,102);version=2;await w.readRoom('tclk-offers');assert.equal(f.ledger.room('tclk-offers').cursor,0);assert.equal(f.ledger.room('tclk-offers').first_seq,null);
  assert(calls.every(x=>!x.init.method||x.init.method==='GET'));assert(JSON.parse(f.ledger.room('tclk-offers').gaps_json).some(g=>g.kind==='ROOM_GENERATION_CHANGED'));
});
test('evidence: cap preserves stored history and does not falsely advance cursor',async t=>{
  const f=fixture(t,{evidenceMaxRecords:1});const w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{},{fetch:async()=>response('tclk-offers',f.board)});
  await assert.rejects(w.readRoom('tclk-offers'),/cap reached/);assert.equal(f.ledger.stats().count,1);assert.equal(f.ledger.room('tclk-offers'),null);
});
test('evidence: restart-safe uploads are off by default, deduplicated and free only',async t=>{
  const f=fixture(t);f.seed();let uploads=0;const w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{},{upload:async()=>{uploads++;return {id:'a'.repeat(43)};}});
  const job=f.ledger.queueArchive(f.accept.contract,f.payer.did);assert.equal(f.ledger.queueArchive(f.accept.contract,f.payer.did).id,job.id);
  await w.archiveOne();assert.equal(uploads,0);assert.throws(()=>w.saveSettings({freeUploads:true},f.payer.did),/Confirm/);
  w.saveSettings({freeUploads:true,confirmPermanent:true,maxUploadsPerDay:1},f.payer.did);await w.archiveOne();await w.archiveOne();assert.equal(uploads,1);assert.equal(f.ledger.detail(f.accept.contract).archives[0].status,'SUBMITTED');
});
test('evidence: payment request is blocked without retry; uncertain result is retained',async t=>{
  const f=fixture(t);f.seed();let calls=0;const w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{},{upload:async()=>{calls++;throw Object.assign(new Error('pay'),{status:402});}});
  w.saveSettings({freeUploads:true,confirmPermanent:true},f.payer.did);f.ledger.queueArchive(f.accept.contract,f.payer.did);await w.archiveOne();await w.archiveOne();assert.equal(calls,1);assert.equal(f.ledger.detail(f.accept.contract).archives[0].status,'BLOCKED');
});
test('evidence: retrieved bytes must match before archive is marked retrievable',async t=>{
  const f=fixture(t);f.seed();const j=f.ledger.queueArchive(f.accept.contract,f.payer.did);f.ledger.archivePatch(j.id,'SUBMITTED',{txId:'a'.repeat(43)});f.ledger.db.prepare("UPDATE evidence_archives SET updated_at='2000-01-01' WHERE id=?").run(j.id);
  const w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{},{fetch:async()=>new Response('wrong bytes')});await w.checkOneUpload();assert.equal(f.ledger.detail(f.accept.contract).archives[0].status,'HASH_MISMATCH');
});
test('evidence: no heartbeat spam and no automatic archive of paper rehearsals',async t=>{
  const f=fixture(t);f.seed();let writes=0;const w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{},{fetch:async()=>{writes++;throw new Error('No writes expected');}});
  await w.reportDaily();assert.equal(writes,0);w.saveSettings({freeUploads:true,autoArchive:true,confirmPermanent:true},f.payer.did);await w.archiveOne();assert.equal(f.ledger.detail(f.accept.contract).archives.length,0);
});
test('evidence: public readers cannot edit settings or upload, operator can',async t=>{
  const f=fixture(t);f.config.allowedOwnerDids.add(f.payer.did);const w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{});const server=createApi(f.config,f.store,{},()=>{},new NetworkStore(f.store),{ledger:f.ledger,worker:w});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/v1/evidence')).status,200);assert.equal((await fetch(base+'/v1/evidence/settings')).status,401);
  f.store.db.prepare('INSERT INTO sessions(token_hash,owner_did,created_at,expires_at) VALUES(?,?,?,?)').run(sha256('foreign'),f.payee.did,new Date().toISOString(),new Date(Date.now()+100000).toISOString());
  assert.equal((await fetch(base+'/v1/evidence/settings',{headers:{authorization:'Bearer foreign'}})).status,403);
  f.store.createSession(sha256('operator'),f.payer.did,new Date().toISOString(),new Date(Date.now()+100000).toISOString());
  assert.equal((await fetch(base+'/v1/evidence/settings',{headers:{authorization:'Bearer operator'}})).status,200);
  assert.equal((await fetch(base+'/v1/evidence/settings',{method:'PATCH',headers:{authorization:'Bearer operator','content-type':'application/json'},body:JSON.stringify({freeUploads:true})})).status,400);
});
test('evidence: funded-rail announcements remain UNVERIFIED without a chain adapter',t=>{
  const f=fixture(t,{rail:'flop-htlc'});f.seed();assert.equal(f.ledger.detail(f.accept.contract).assessment.payment.status,'UNVERIFIED');
});
test('evidence: attachment hash is checked and an oversized bundle cannot enter upload queue',t=>{
  const f=fixture(t);f.seed();for(let i=0;i<3;i++)f.ledger.addAttachment(f.accept.contract,{label:`public-${i}`,mime:'text/plain',dataBase64:Buffer.alloc(32000,i+1).toString('base64')},f.payer.did);
  assert.throws(()=>f.ledger.queueArchive(f.accept.contract,f.payer.did),/100 KiB/);
  const b=makeBundle(f.ledger.detail(f.accept.contract));b.attachments[0].dataBase64='dGFtcGVyZWQ=';delete b.bundleSha256;b.bundleSha256=digest(stableJson(b));assert.equal(verifyBundle(b).attachmentsValid,false);
});
test('evidence: failed read does not block previously queued preservation',async t=>{
  const f=fixture(t);f.seed();let uploads=0;const w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{},{fetch:async()=>{throw new Error('upstream unavailable');},upload:async()=>{uploads++;return{id:'b'.repeat(43)};}});
  w.saveSettings({freeUploads:true,confirmPermanent:true},f.payer.did);f.ledger.queueArchive(f.accept.contract,f.payer.did);w.running=true;await w.tick();w.stop();assert.equal(uploads,1);assert.match(f.store.state('evidence-last-error').value,/upstream/);
});
test('evidence: real SDK adapter attempts once, without payment headers, including 402/500',async t=>{
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  const f=fixture(t),w=new EvidenceWorker(f.config,f.store,f.ledger,()=>{});let status=200,calls=[];
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify(status===200?{id:'a'.repeat(43)}:{error:'unavailable'}),{status,headers:{'content-type':'application/json'}});};
  const bytes=Buffer.from('{"test":true}');const receipt=await w.uploadFree(bytes,[],AbortSignal.timeout(5000));assert.equal(receipt.id,'a'.repeat(43));assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/x402\/upload\/unsigned$/);assert.deepEqual(Buffer.from(calls[0].init.body),bytes);assert(!Object.keys(calls[0].init.headers).some(k=>/payment|authorization/i.test(k)));
  for(status of [402,500]){calls=[];await assert.rejects(w.uploadFree(bytes,[],AbortSignal.timeout(5000)));assert.equal(calls.length,1);}
});
