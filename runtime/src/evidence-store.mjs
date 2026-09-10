import { randomUUID } from 'node:crypto';
import { dealRoom, foldTranscript } from './vendor/tclk/index.js';
import { inspectRecord, digest, stableJson, foldEvidence, makeBundle, HASH_ID, TERMINAL } from './evidence-protocol.mjs';

export class EvidenceStore {
  constructor(store, config = {}) {
    this.store = store; this.db = store.db; this.config = config;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence_rooms(room TEXT PRIMARY KEY, generation INTEGER, cursor INTEGER NOT NULL DEFAULT 0, first_seq INTEGER, last_checked TEXT, gaps_json TEXT NOT NULL DEFAULT '[]', last_error TEXT);
      CREATE TABLE IF NOT EXISTS evidence_records(id TEXT PRIMARY KEY, room TEXT NOT NULL, generation INTEGER, seq INTEGER NOT NULL, ts TEXT NOT NULL, signer TEXT NOT NULL, kind TEXT, offer_id TEXT, contract_id TEXT, protocol_valid INTEGER NOT NULL, reason TEXT, message_json TEXT NOT NULL, record_json TEXT, received_at TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS evidence_records_offer ON evidence_records(offer_id,room,seq);
      CREATE INDEX IF NOT EXISTS evidence_records_contract ON evidence_records(contract_id,room,seq);
      CREATE INDEX IF NOT EXISTS evidence_records_room ON evidence_records(room,generation,seq);
      CREATE TABLE IF NOT EXISTS evidence_cases(id TEXT PRIMARY KEY, offer_id TEXT, offer_record TEXT, accept_record TEXT, deal_room TEXT, status TEXT NOT NULL, payer TEXT, payee TEXT, job_id TEXT, title TEXT, updated_at TEXT NOT NULL, next_check_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS evidence_cases_offer ON evidence_cases(offer_id);
      CREATE INDEX IF NOT EXISTS evidence_cases_payer ON evidence_cases(payer);
      CREATE INDEX IF NOT EXISTS evidence_cases_payee ON evidence_cases(payee);
      CREATE INDEX IF NOT EXISTS evidence_cases_poll ON evidence_cases(next_check_at);
      CREATE TABLE IF NOT EXISTS evidence_archives(id TEXT PRIMARY KEY, case_id TEXT NOT NULL, content_hash TEXT NOT NULL, bundle_json TEXT NOT NULL, status TEXT NOT NULL, tx_id TEXT, receipt_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, requested_by TEXT NOT NULL, UNIQUE(case_id,content_hash));
      CREATE INDEX IF NOT EXISTS evidence_archives_case ON evidence_archives(case_id,created_at);
      CREATE INDEX IF NOT EXISTS evidence_archives_status ON evidence_archives(status,created_at);
      CREATE TABLE IF NOT EXISTS evidence_attachments(id TEXT PRIMARY KEY, case_id TEXT NOT NULL, label TEXT NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, data_base64 TEXT NOT NULL, added_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(case_id,sha256));
      CREATE INDEX IF NOT EXISTS evidence_attachments_case ON evidence_attachments(case_id);
      PRAGMA optimize;
    `);
    if(!this.db.prepare('PRAGMA table_info(evidence_cases)').all().some(c=>c.name==='assessment_json'))this.db.exec('ALTER TABLE evidence_cases ADD COLUMN assessment_json TEXT');
  }
  room(name) { return this.db.prepare('SELECT * FROM evidence_rooms WHERE room=?').get(name) ?? null; }
  markRoom(name, { generation, cursor, firstSeq, gaps, error = null }) {
    this.db.prepare(`INSERT INTO evidence_rooms(room,generation,cursor,first_seq,last_checked,gaps_json,last_error) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(room) DO UPDATE SET generation=excluded.generation,cursor=excluded.cursor,first_seq=CASE WHEN evidence_rooms.generation IS NOT excluded.generation THEN excluded.first_seq ELSE coalesce(evidence_rooms.first_seq,excluded.first_seq) END,last_checked=excluded.last_checked,gaps_json=excluded.gaps_json,last_error=excluded.last_error`)
      .run(name, generation ?? null, cursor, firstSeq ?? null, new Date().toISOString(), JSON.stringify(gaps.slice(-100)), error);
  }
  stats() {
    const records = this.db.prepare('SELECT COUNT(*) AS count, coalesce(sum(bytes),0) AS bytes FROM evidence_records').get();
    const cases = this.db.prepare('SELECT COUNT(*) AS count FROM evidence_cases WHERE accept_record IS NOT NULL').get().count;
    const archived = this.db.prepare("SELECT COUNT(*) AS count FROM evidence_archives WHERE status='RETRIEVABLE'").get().count;
    return { ...records, cases, archived, rooms: this.db.prepare('SELECT * FROM evidence_rooms ORDER BY room LIMIT 100').all().map(r => ({ ...r, gaps: JSON.parse(r.gaps_json), gaps_json: undefined })) };
  }
  ingest(room, generation, message) {
    const inspection = inspectRecord(room, message);
    if (!inspection.record || !inspection.signatureValid) return { stored: false, reason: inspection.reason };
    // Non-protocol text is kept only inside a followed deal and only from its parties.
    if (!message.text.startsWith('tclk1 ')) {
      const party = this.db.prepare('SELECT id FROM evidence_cases WHERE deal_room=? AND (payer=? OR payee=?) LIMIT 1').get(room, message.from, message.from);
      if (!party) return { stored: false, reason: 'Not a party statement.' };
    }
    const f = inspection.frame;
    let loose = {}; try { loose = JSON.parse(message.text.slice(6)); } catch { /* diagnostic only */ }
    const offerId = f?.type === 'offer' ? f.id : f?.type === 'accept' ? f.ref : HASH_ID.test(loose.ref) && loose.type === 'accept' ? loose.ref : null;
    const contract = f?.contract ?? (HASH_ID.test(loose.contract) ? loose.contract : null);
    const id = digest(stableJson([room, generation ?? null, message.seq, message.from, String(message.nonce), message.text, message.sig]));
    const raw = JSON.stringify(message), now = new Date().toISOString();
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO evidence_records(id,room,generation,seq,ts,signer,kind,offer_id,contract_id,protocol_valid,reason,message_json,record_json,received_at,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, room, generation ?? null, message.seq, message.ts, message.from, f?.type ?? (message.text.startsWith('tclk1 ')? 'invalid':'statement'), offerId, contract,
        inspection.valid ? 1:0, inspection.reason, raw, JSON.stringify(inspection.record), now, Buffer.byteLength(raw));
    if (!inserted.changes) return { stored: false, duplicate: true };
    if (inspection.valid && f.type === 'offer') {
      this.db.prepare(`INSERT OR IGNORE INTO evidence_cases(id,offer_id,offer_record,status,payer,payee,job_id,title,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run('offer:'+f.id, f.id, id, 'proposed', f.role==='payer'?f.from:null, f.role==='payee'?f.from:null, f.job?.id ?? null, (f.job?.context ?? f.job?.id ?? 'Signed tclk offer').slice(0,300), now);
      for (const accept of this.db.prepare("SELECT id FROM evidence_records WHERE offer_id=? AND kind='accept' AND protocol_valid=1 ORDER BY seq LIMIT 100").all(f.id)) this.matchAccept(accept.id);
    }
    if (inspection.valid && f.type === 'accept') this.matchAccept(id);
    if (contract) this.refresh(contract);
    if (room.startsWith('mb-p-tclk-')) for (const c of this.db.prepare('SELECT id FROM evidence_cases WHERE deal_room=?').all(room)) this.refresh(c.id);
    return { stored: true, valid: inspection.valid, reason: inspection.reason };
  }
  row(id) { return this.db.prepare('SELECT * FROM evidence_records WHERE id=?').get(id); }
  matchAccept(id) {
    const accept = this.row(id), a = JSON.parse(accept.message_json), af = JSON.parse(a.text.slice(6));
    // An offer in a different room epoch cannot be silently paired by seq alone.
    const offer = this.db.prepare("SELECT * FROM evidence_records WHERE offer_id=? AND kind='offer' AND protocol_valid=1 AND generation IS ? AND seq<? ORDER BY seq LIMIT 1").get(af.ref, accept.generation, accept.seq);
    if (!offer) return;
    const folded = foldTranscript([JSON.parse(offer.record_json), JSON.parse(accept.record_json)]);
    if (folded.state?.status !== 'accepted' || folded.state.contract !== af.contract || folded.steps.some(s=>!s.ok)) return;
    const s = folded.state, now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO evidence_cases(id,offer_id,offer_record,accept_record,deal_room,status,payer,payee,job_id,title,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.contract, s.offer.id, offer.id, accept.id, dealRoom(s.contract), 'accepted', s.payerDid, s.payeeDid, s.offer.job?.id ?? null, (s.offer.job?.context ?? s.offer.job?.id ?? 'Signed tclk contract').slice(0,300), now);
    this.refresh(s.contract);
  }
  get(id) { return this.db.prepare('SELECT * FROM evidence_cases WHERE id=?').get(id) ?? null; }
  caseRecords(c) {
    const first = [c.offer_record, c.accept_record].filter(Boolean).map(id=>this.row(id));
    const extra = c.deal_room ? this.db.prepare('SELECT * FROM evidence_records WHERE room=? OR contract_id=? ORDER BY received_at,seq LIMIT 1000').all(c.deal_room,c.id) : [];
    const ids = new Set(first.map(r=>r.id));
    // Board/deal room seq values are not comparable. Handshake first; deal append order next.
    return [...first,...extra.filter(r=>!ids.has(r.id)).sort((a,b)=>a.room.localeCompare(b.room)||(a.generation??0)-(b.generation??0)||a.seq-b.seq)].map(r=>({
      id:r.id,room:r.room,generation:r.generation,message:JSON.parse(r.message_json),record:JSON.parse(r.record_json),protocolValid:Boolean(r.protocol_valid),reason:r.reason,receivedAt:r.received_at,
    }));
  }
  refresh(id) {
    const c = this.get(id); if (!c) return;
    const records=this.caseRecords(c);
    const last=records.map(r=>r.receivedAt).sort().at(-1)??c.updated_at;
    if(c.assessment_json&&last<c.updated_at)return;
    const result = foldEvidence(records, c.accept_record ? c.id : undefined);
    this.db.prepare('UPDATE evidence_cases SET status=?,updated_at=?,assessment_json=? WHERE id=?').run(result.state?.status ?? 'incomplete', last, JSON.stringify(result), id);
  }
  detail(id) {
    const c = this.get(id); if (!c) return null;
    const records = this.caseRecords(c), assessment = c.assessment_json?JSON.parse(c.assessment_json):foldEvidence(records, c.accept_record ? id : undefined);
    const rooms = ['tclk-offers', ...(c.deal_room?[c.deal_room]:[])].map(name=>this.room(name));
    const handshake=records.filter(r=>r.room==='tclk-offers');
    const minBoard=Math.min(...handshake.map(r=>r.message.seq)),maxBoard=Math.max(...handshake.map(r=>r.message.seq));
    const gaps = rooms.flatMap(r=>r?JSON.parse(r.gaps_json).filter(g=>
      r.room!=='tclk-offers'||g.kind==='ROOM_GENERATION_CHANGED'||(g.to>=minBoard&&g.from<=maxBoard)).map(g=>({room:r.room,...g})):[]);
    if(records.some(r=>r.generation!==this.room(r.room)?.generation))gaps.push({kind:'RECORDS_FROM_PREVIOUS_GENERATION'});
    const availableCount=c.deal_room?this.db.prepare('SELECT count(*) AS n FROM evidence_records WHERE room=? OR contract_id=?').get(c.deal_room,c.id).n:0;
    if(availableCount>1000)gaps.push({kind:'BUNDLE_RECORD_LIMIT',available:availableCount,maximum:1000});
    const coverage = { status: rooms.some(r=>!r||r.generation===null)||gaps.length ? 'INCOMPLETE' : 'OBSERVED_CONTIGUOUS',
      gaps, notice:'Coverage describes the collected window only, not the complete lifetime of this deal.',
      rooms:rooms.filter(Boolean).map(r=>({room:r.room,generation:r.generation,firstObservedSeq:r.first_seq,lastObservedSeq:r.cursor,lastChecked:r.last_checked})) };
    const archives = this.db.prepare('SELECT id,status,content_hash AS contentHash,tx_id AS transactionId,error,created_at AS createdAt,updated_at AS updatedAt FROM evidence_archives WHERE case_id=? ORDER BY created_at DESC LIMIT 20').all(id);
    const attachments = this.db.prepare('SELECT id,label,mime,sha256,data_base64 AS dataBase64,added_by AS addedBy,created_at AS createdAt FROM evidence_attachments WHERE case_id=? ORDER BY created_at').all(id);
    return { id:c.id, offerId:c.offer_id, title:c.title, status:c.status, payer:c.payer, payee:c.payee, jobId:c.job_id,
      source:{base:this.config.technocoreBase ?? 'https://technocore.chat',board:'tclk-offers',dealRoom:c.deal_room},
      records,coverage,assessment,archives,attachments,updatedAt:c.updated_at };
  }
  list(query='', limit=25, offset=0, status='all') {
    query=String(query).trim().slice(0,180); limit=Math.min(50,Math.max(1,Number(limit)||25)); offset=Math.min(100000,Math.max(0,Number(offset)||0));
    const q='%'+query.replace(/[\\%_]/g,'\\$&')+'%';
    const where=`WHERE (id LIKE ? ESCAPE '\\' OR offer_id LIKE ? ESCAPE '\\' OR payer LIKE ? ESCAPE '\\' OR payee LIKE ? ESCAPE '\\' OR job_id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR deal_room LIKE ? ESCAPE '\\' OR id IN (SELECT case_id FROM evidence_attachments WHERE sha256=?) OR id IN (SELECT case_id FROM evidence_archives WHERE content_hash=? OR tx_id=?) OR offer_record IN (SELECT id FROM evidence_records WHERE seq=?) OR accept_record IN (SELECT id FROM evidence_records WHERE seq=?) OR id IN (SELECT contract_id FROM evidence_records WHERE seq=? OR message_json LIKE ? ESCAPE '\\')) AND (?='all' OR (?='contracts' AND accept_record IS NOT NULL) OR status=?)`;
    const seq=/^\d+$/.test(query)?Number(query):-1;
    const args=[q,q,q,q,q,q,q,query,query,query,seq,seq,seq,query?q:'__no_query__',status,status,status];
    const rows=this.db.prepare(`SELECT * FROM evidence_cases ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...args,limit,offset);
    return {cases:rows.map(c=>{const d=this.detail(c.id);return {id:c.id,offerId:c.offer_id,title:c.title,status:c.status,payer:c.payer,payee:c.payee,jobId:c.job_id,updatedAt:c.updated_at,coverage:d.coverage.status,payment:d.assessment.payment,archives:d.archives};}),total:this.db.prepare(`SELECT COUNT(*) AS n FROM evidence_cases ${where}`).get(...args).n,limit,offset};
  }
  pollCases(limit=3) {
    // Continue observing for receipts after terminal transitions. Old records stay
    // searchable, but stop automatic room reads after seven days without new evidence.
    return this.db.prepare("SELECT * FROM evidence_cases WHERE accept_record IS NOT NULL AND next_check_at<=? AND updated_at>? ORDER BY next_check_at,updated_at LIMIT ?").all(Date.now(),new Date(Date.now()-7*86400000).toISOString(),limit);
  }
  queueArchive(id, owner) {
    const detail=this.detail(id); if(!detail) throw new Error('Contract not found.');
    if(!detail.payee||!detail.payer||!detail.assessment.protocolValid) throw new Error('A verified two-party handshake is required before archiving.');
    const contentHash=digest(stableJson({records:detail.records,attachments:detail.attachments,coverage:detail.coverage.status}));
    const previous=this.db.prepare('SELECT id,status FROM evidence_archives WHERE case_id=? AND content_hash=?').get(id,contentHash); if(previous)return previous;
    const bundle=makeBundle(detail), raw=stableJson(bundle);
    if(Buffer.byteLength(raw)>=100*1024) throw new Error('Bundle reaches the 100 KiB free-only limit. Download it locally; no paid upload was attempted.');
    const archiveId=randomUUID(),now=new Date().toISOString();
    this.db.prepare('INSERT INTO evidence_archives(id,case_id,content_hash,bundle_json,status,created_at,updated_at,requested_by) VALUES(?,?,?,?,?,?,?,?)').run(archiveId,id,contentHash,raw,'QUEUED',now,now,owner);
    return {id:archiveId,status:'QUEUED'};
  }
  archivePatch(id,status,fields={}) {
    this.db.prepare('UPDATE evidence_archives SET status=?,tx_id=coalesce(?,tx_id),receipt_json=coalesce(?,receipt_json),error=?,updated_at=? WHERE id=?')
      .run(status,fields.txId??null,fields.receipt?JSON.stringify(fields.receipt):null,fields.error??null,new Date().toISOString(),id);
  }
  addAttachment(id,{label,mime,dataBase64},owner) {
    if(!this.get(id))throw new Error('Contract not found.');
    if(typeof label!=='string'||label.length<1||label.length>100||!['text/plain','application/json','application/pdf'].includes(mime))throw new Error('Use a short label and a text, JSON or PDF file.');
    if(typeof dataBase64!=='string'||dataBase64.length>64000||Buffer.from(dataBase64,'base64').toString('base64')!==dataBase64)throw new Error('Attachment must be canonical base64, at most 48 KB.');
    if(this.db.prepare('SELECT count(*) AS n FROM evidence_attachments WHERE case_id=?').get(id).n>=3)throw new Error('At most three supporting attachments per contract.');
    const sha256=digest(Buffer.from(dataBase64,'base64'));
    this.db.prepare('INSERT OR IGNORE INTO evidence_attachments VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),id,label,mime,sha256,dataBase64,owner,new Date().toISOString());
    return {sha256,notice:'Operator-supplied supporting material, not a counterparty-signed delivery or acceptance.'};
  }
}
