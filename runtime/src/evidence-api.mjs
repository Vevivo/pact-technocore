import { makeBundle,verifyBundle } from './evidence-protocol.mjs';

const inputAction = action => { try { return action(); } catch(error) { error.status ??= 400; throw error; } };

export async function evidenceRoute({request,response,url,config,store,ledger,worker,json,headers,body,authenticate}) {
  if(!url.pathname.startsWith('/v1/evidence'))return false;
  const operator=()=>{const session=authenticate(config,store,request);if(!config.allowedOwnerDids.has(session.ownerDid)){const e=new Error('Evidence administration requires the server operator DID.');e.status=403;throw e;}return session.ownerDid;};
  if(request.method==='GET'&&url.pathname==='/v1/evidence'){
    json(response,200,{...ledger.list(url.searchParams.get('q')??'',url.searchParams.get('limit'),url.searchParams.get('offset'),url.searchParams.get('status')??'all'),
      collector:{enabled:worker.settings().enabled,lastSyncAt:store.state('evidence-last-sync')?.value??null,lastError:store.state('evidence-last-error')?.value||null,
        ...ledger.stats(),maxRecords:config.evidenceMaxRecords??50000,maxBytes:config.evidenceMaxBytes??100*1024*1024},
      notice:'Observed signed coordination, not a payment explorer or arbitration verdict.'},headers);return true;
  }
  if(url.pathname==='/v1/evidence/settings'){
    if(request.method==='GET'){operator();json(response,200,{settings:worker.settings()},headers);return true;}
    if(request.method==='PATCH'){const owner=operator(),input=await body(request);const settings=inputAction(()=>worker.saveSettings(input,owner));json(response,200,{settings},headers);return true;}
  }
  if(request.method==='POST'&&url.pathname==='/v1/evidence/verify'){
    const input=await body(request);json(response,200,inputAction(()=>verifyBundle(input)),headers);return true;
  }
  const match=url.pathname.match(/^\/v1\/evidence\/(offer:0x[0-9a-f]{64}|0x[0-9a-f]{64})(?:\/(bundle|archive|attachment))?$/);
  if(!match){const e=new Error('Evidence route not found.');e.status=404;throw e;}
  const id=match[1],action=match[2],detail=ledger.detail(id);
  if(!detail){const e=new Error('Evidence not found in the collected window.');e.status=404;throw e;}
  if(request.method==='GET'){
    if(action==='bundle'){json(response,200,makeBundle(detail),{...headers,'content-disposition':`attachment; filename="pact-evidence-${id.replace(':','-')}.json"`});return true;}
    if(!action){json(response,200,detail,headers);return true;}
  }
  if(request.method==='POST'&&action==='archive'){
    const owner=operator(),input=await body(request);
    const job=inputAction(()=>{
      if(input.confirmPermanent!==true)throw new Error('Confirm public permanent storage. Uploaded data cannot be deleted.');
      if(!worker.settings().freeUploads)throw new Error('Enable free-only archives in operator settings first.');
      return ledger.queueArchive(id,owner);
    });json(response,202,job,headers);return true;
  }
  if(request.method==='POST'&&action==='attachment'){
    const owner=operator(),input=await body(request);json(response,201,inputAction(()=>ledger.addAttachment(id,input,owner)),headers);return true;
  }
  const error=new Error('Method not allowed.');error.status=405;throw error;
}
