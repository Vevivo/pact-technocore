import { parseExactJson, digest, TERMINAL, inspectRecord } from './evidence-protocol.mjs';
import { open, signWithJwk } from './crypto.mjs';

export async function boundedText(response, maximum=2_000_000) {
  if (Number(response.headers.get('content-length'))>maximum) throw new Error('Response exceeds the byte limit.');
  const reader=response.body.getReader(); const chunks=[]; let size=0;
  try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maximum)throw new Error('Response exceeds the byte limit.');chunks.push(Buffer.from(value));} }
  catch(error){await reader.cancel();throw error;}
  return Buffer.concat(chunks).toString('utf8');
}

export class EvidenceWorker {
  constructor(config,store,ledger,logger,deps={}) {
    this.config=config;this.store=store;this.ledger=ledger;this.logger=logger;this.fetch=deps.fetch??fetch;this.upload=deps.upload??this.uploadFree;
    this.running=false;this.busy=false;this.timer=null;this.abort=null;
  }
  settings() {
    let saved={};try{saved=JSON.parse(this.store.state('evidence-settings')?.value||'{}');}catch{}
    return {enabled:this.config.evidenceEnabled??true,freeUploads:false,autoArchive:false,includePaper:false,maxUploadsPerDay:3,reportAgentId:null,...saved};
  }
  saveSettings(input,owner) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Settings must be an object.');
    const old=this.settings(),next={...old};
    for(const k of ['enabled','freeUploads','autoArchive','includePaper'])if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw new Error(`${k} must be boolean.`);next[k]=input[k];}
    if((next.freeUploads||next.autoArchive)&&input.confirmPermanent!==true)throw new Error('Confirm irreversible public storage before enabling uploads.');
    if(input.maxUploadsPerDay!==undefined){if(!Number.isInteger(input.maxUploadsPerDay)||input.maxUploadsPerDay<1||input.maxUploadsPerDay>10)throw new Error('Daily upload limit must be 1–10.');next.maxUploadsPerDay=input.maxUploadsPerDay;}
    if(input.reportAgentId!==undefined){
      if(input.reportAgentId!==null&&!this.store.agentForOwner(input.reportAgentId,owner))throw new Error('Reporting agent must belong to you.');
      if(input.reportAgentId&&input.confirmRoomPosting!==true)throw new Error('Confirm one daily archive summary in the PACT room.');
      next.reportAgentId=input.reportAgentId;
    }
    this.store.setState('evidence-settings',JSON.stringify(next));this.store.audit('evidence.settings',owner,null,next);return next;
  }
  start(){if(this.timer)return;this.running=true;this.abort=new AbortController();
    this.ledger.db.prepare("UPDATE evidence_archives SET status='UPLOAD_UNCERTAIN',error='Runtime interrupted during upload. Not resent automatically.' WHERE status='UPLOADING'").run();
    this.timer=setInterval(()=>void this.tick(),this.config.evidencePollMs??15000);this.timer.unref();void this.tick();}
  stop(){this.running=false;clearInterval(this.timer);this.timer=null;this.abort?.abort();}
  async readRoom(name) {
    const prior=this.ledger.room(name),url=new URL(`/r/${encodeURIComponent(name)}`,this.config.technocoreBase);
    url.search=new URLSearchParams({format:'json',limit:'200',...(prior?.cursor?{since:String(prior.cursor)}:{}),n:`pact-evidence-${Date.now()}`}).toString();
    const signal=this.abort?AbortSignal.any([this.abort.signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
    const response=await this.fetch(url,{headers:{accept:'application/json'},cache:'no-store',redirect:'error',signal});
    if(!response.ok)throw new Error(`Room read HTTP ${response.status}.`);
    const body=parseExactJson(await boundedText(response));
    if(body.room!==name||!Array.isArray(body.messages)||body.messages.length>200)throw new Error('Unexpected room response; cursor was not advanced.');
    const header=response.headers.get('x-room-generation');
    const generation=Number.isSafeInteger(body.generation)?body.generation:header!==null&&/^\d+$/.test(header)?Number(header):null;
    const gaps=prior?JSON.parse(prior.gaps_json):[];
    if(prior&&prior.generation!==generation&&prior.cursor>0){
      gaps.push({kind:'ROOM_GENERATION_CHANGED',previousGeneration:prior.generation,generation,detectedAt:new Date().toISOString()});
      this.ledger.markRoom(name,{generation,cursor:0,firstSeq:null,gaps});return {received:0,reset:true};
    }
    let cursor=prior?.cursor??0,firstSeq=prior?.first_seq??body.messages[0]?.seq??null;
    if(!cursor&&body.messages[0]?.seq>1)gaps.push({kind:'HISTORY_BEFORE_CAPTURE',from:1,to:body.messages[0].seq-1,generation});
    // Require strictly increasing, safe seq values before accepting any batch.
    for(let i=0;i<body.messages.length;i++)if(!Number.isSafeInteger(body.messages[i].seq)||body.messages[i].seq<1||(i&&body.messages[i].seq<=body.messages[i-1].seq))throw new Error('Non-monotonic room response.');
    const stats=this.ledger.stats();let bytes=stats.bytes,count=stats.count;
    for(const message of body.messages){
      if(message.seq<=cursor)continue;
      if(cursor>0&&message.seq>cursor+1)gaps.push({kind:'MISSING_SEQUENCE_RANGE',from:cursor+1,to:message.seq-1,generation});
      if(bytes+Buffer.byteLength(JSON.stringify(message))>(this.config.evidenceMaxBytes??100*1024*1024)||count>=(this.config.evidenceMaxRecords??50000))throw new Error('Evidence storage cap reached. Collection paused; existing records were preserved.');
      const result=this.ledger.ingest(name,generation,message);if(result.stored){count++;bytes+=Buffer.byteLength(JSON.stringify(message));}
      cursor=message.seq;
    }
    this.ledger.markRoom(name,{generation,cursor,firstSeq,gaps});
    return {received:body.messages.length,cursor};
  }
  async tick(){
    if(!this.running||this.busy)return;this.busy=true;
    try{
      const settings=this.settings();
      if(settings.enabled){
        // Each response is bounded; one collector per runtime, not per hosted agent.
        let boardOk=false;
        try{
          for(let page=0;page<3&&this.running;page++){const r=await this.readRoom('tclk-offers');if(r.received<200||r.reset)break;}
          boardOk=true;
        }catch(error){this.store.setState('evidence-last-error',error.message);this.logger('warn','Evidence board read failed',{error:error.message});}
        for(const c of this.ledger.pollCases(3)){
          this.ledger.db.prepare('UPDATE evidence_cases SET next_check_at=? WHERE id=?').run(Date.now()+60000,c.id);
          try{await this.readRoom(c.deal_room);}
          catch(error){
            const r=this.ledger.room(c.deal_room);
            this.ledger.markRoom(c.deal_room,{generation:r?.generation,cursor:r?.cursor??0,firstSeq:r?.first_seq,gaps:JSON.parse(r?.gaps_json??'[]'),error:error.message});
            this.logger('warn','Evidence deal read failed',{contract:c.id,error:error.message});
          }
        }
        if(boardOk){this.store.setState('evidence-last-error','');this.store.setState('evidence-last-sync',new Date().toISOString());}
      }
      await this.archiveOne();await this.checkOneUpload();await this.reportDaily();
    }catch(error){if(this.running){this.store.setState('evidence-last-error',error.message);this.logger('warn','Evidence collector paused this cycle',{error:error.message});}}
    finally{this.busy=false;}
  }
  async uploadFree(bytes,tags,signal){
    // Unauthenticated client: deliberately no wallet, signer, funding key,
    // credit spending or x402 payment authorization can be supplied here.
    const {TurboFactory}=await import('@ardrive/turbo-sdk/node');
    // In the pinned SDK, `retries` counts total attempts, including the first.
    const turbo=TurboFactory.unauthenticated({token:'base-usdc',uploadServiceConfig:{retryConfig:{retries:1,retryDelay:()=>0,onRetry:()=>{}}}});
    return turbo.uploadRawX402Data({data:bytes,tags,signal});
  }
  async archiveOne(){
    const s=this.settings();if(!s.freeUploads)return;
    const day=new Date().toISOString().slice(0,10),key=`evidence-uploads:${day}`,used=Number(this.store.state(key)?.value||0);
    if(used>=s.maxUploadsPerDay)return;
    if(s.autoArchive){
      const candidates=this.ledger.db.prepare("SELECT id FROM evidence_cases WHERE status IN ('claimed','refunded','cancelled') AND id NOT IN (SELECT case_id FROM evidence_archives) ORDER BY updated_at DESC LIMIT 10").all();
      for(const c of candidates){const d=this.ledger.detail(c.id);if(!s.includePaper&&d.assessment.payment.status==='NO_VALUE')continue;
        if(d.coverage.status!=='OBSERVED_CONTIGUOUS')continue;
        try{this.ledger.queueArchive(c.id,'operator:auto');break;}catch{/* oversized or invalid: never split to evade the free tier */}}
    }
    const job=this.ledger.db.prepare("SELECT * FROM evidence_archives WHERE status='QUEUED' ORDER BY created_at LIMIT 1").get();if(!job)return;
    const bytes=Buffer.from(job.bundle_json);if(bytes.length>=100*1024){this.ledger.archivePatch(job.id,'BLOCKED',{error:'Free-only size ceiling exceeded.'});return;}
    this.store.setState(key,used+1);this.ledger.archivePatch(job.id,'UPLOADING');
    try{
      const receipt=await this.upload(bytes,[{name:'Content-Type',value:'application/json'},{name:'App-Name',value:'PACT-Evidence'},{name:'Contract-Id',value:job.case_id},{name:'Content-SHA256',value:digest(bytes)}],AbortSignal.timeout(45000));
      if(!/^[A-Za-z0-9_-]{43}$/.test(receipt?.id??''))throw new Error('Upload returned no valid data-item ID.');
      this.ledger.archivePatch(job.id,'SUBMITTED',{txId:receipt.id,receipt});
    }catch(error){const code=error.status??error.response?.status;
      this.ledger.archivePatch(job.id,[400,401,402,403,413,429].includes(code)?'BLOCKED':'UPLOAD_UNCERTAIN',{error:code===402?'Free tier unavailable; payment refused. No wallet is configured.':'Upload not confirmed. No payment or automatic resend was attempted.'});
    }
  }
  async checkOneUpload(){
    const job=this.ledger.db.prepare("SELECT * FROM evidence_archives WHERE status='SUBMITTED' AND updated_at<? ORDER BY updated_at LIMIT 1").get(new Date(Date.now()-60000).toISOString());if(!job)return;
    this.ledger.archivePatch(job.id,'SUBMITTED');
    try{
      const response=await this.fetch(`https://arweave.net/${job.tx_id}`,{signal:AbortSignal.timeout(15000),redirect:'error'});
      if(!response.ok)return;
      const raw=await boundedText(response,100*1024);
      if(digest(raw)!==digest(job.bundle_json)){this.ledger.archivePatch(job.id,'HASH_MISMATCH',{error:'Retrieved bytes differ from the uploaded bundle.'});return;}
      this.ledger.archivePatch(job.id,'RETRIEVABLE');
    }catch{/* accepted by Turbo is not the same as retrievable or on-chain finality */}
  }
  async reportDaily(){
    const s=this.settings();if(!s.reportAgentId)return;
    const agent=this.store.agentById(s.reportAgentId);if(!agent?.enabled||agent.deleted_at)return;
    const key=`evidence-digest:${new Date().toISOString().slice(0,10)}`;if(this.store.state(key))return;
    const last=this.store.state('evidence-last-report')?.value??'1970-01-01';
    const rows=this.ledger.db.prepare("SELECT case_id,tx_id FROM evidence_archives WHERE status='RETRIEVABLE' AND updated_at>? ORDER BY updated_at LIMIT 3").all(last);if(!rows.length)return;
    const text='PACT-EVIDENCE/1 '+JSON.stringify({kind:'archive-summary',records:rows.map(r=>({contract:r.case_id,evidence:`https://arweave.net/${r.tx_id}`})),notice:'Observed signed transcripts archived; not a payment or quality verdict. Paper trades carry no value.'});
    const nonce=String(Date.now()),jwk=JSON.parse(open(this.config.masterKey,agent.private_key_enc,`agent-private:${agent.id}`));
    const envelope={did:agent.did,nonce,text,sig:signWithJwk(jwk,`${this.config.room}|${nonce}|${text}`)};
    // Persist intent before publication. Unknown results are never blindly repeated.
    this.store.setState(key,JSON.stringify({status:'ATTEMPTED',envelope}));
    try{const response=await this.fetch(new URL(`/r/${encodeURIComponent(this.config.room)}`,this.config.technocoreBase),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(envelope),signal:AbortSignal.timeout(15000),redirect:'error'});
      this.store.setState(key,JSON.stringify({status:response.ok?'ACKNOWLEDGED':'UNCONFIRMED',envelope}));if(response.ok)this.store.setState('evidence-last-report',new Date().toISOString());
    }catch{/* leave attempted: do not fake success */}
  }
}
