import { normalizeNetworkPolicy } from './network-policy.mjs';

export class NetworkStore {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS network_profiles (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id), policy_json TEXT NOT NULL,
        enabled_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_scan_at TEXT, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS network_work (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), agent_did TEXT NOT NULL,
        room TEXT NOT NULL, source_json TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT, result_json TEXT, reply_json TEXT, mirror_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS network_work_agent_created ON network_work(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS network_work_status ON network_work(status, updated_at);
      CREATE TABLE IF NOT EXISTS network_steps (
        id INTEGER PRIMARY KEY, work_id TEXT NOT NULL REFERENCES network_work(id),
        status TEXT NOT NULL, detail TEXT, ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS network_steps_work ON network_steps(work_id, id);
      CREATE TABLE IF NOT EXISTS network_calls (
        work_id TEXT NOT NULL REFERENCES network_work(id), phase TEXT NOT NULL,
        agent_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(work_id, phase)
      );
      CREATE INDEX IF NOT EXISTS network_calls_agent_created ON network_calls(agent_id, created_at);
    `);
  }
  profile(agentId) {
    const row = this.db.prepare('SELECT * FROM network_profiles WHERE agent_id=?').get(agentId);
    return row ? { policy: JSON.parse(row.policy_json), enabledAt: row.enabled_at, revision: row.updated_at + ':' + row.policy_json,
      lastScanAt: row.last_scan_at, lastError: row.last_error } : { policy: normalizeNetworkPolicy(), enabledAt: null, revision: null, lastScanAt: null, lastError: null };
  }
  saveProfile(agentId, policy) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO network_profiles(agent_id,policy_json,enabled_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET policy_json=excluded.policy_json,enabled_at=excluded.enabled_at,
      updated_at=excluded.updated_at,last_error=NULL`).run(agentId, JSON.stringify(policy), now, now);
    return this.profile(agentId);
  }
  scanStatus(agentId, error = null) {
    this.db.prepare('UPDATE network_profiles SET last_scan_at=?,last_error=? WHERE agent_id=?')
      .run(new Date().toISOString(), error, agentId);
  }
  create({ id, agent, room, source, kind }) {
    const now = new Date().toISOString();
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO network_work
      (id,agent_id,agent_did,room,source_json,kind,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'received',?,?)`)
      .run(id, agent.id, agent.did, room, JSON.stringify(source), kind, kind === 'offer' ? 'tclk offer observed' : 'Evaluating a room request', now, now);
    if (inserted.changes) this.step(id, 'received', kind === 'maintenance' ? 'Operator-authorized scheduled maintenance. No source-room request exists.' : 'Signed source message verified.');
    return Boolean(inserted.changes);
  }
  get(id) { return this.db.prepare('SELECT * FROM network_work WHERE id=?').get(id) ?? null; }
  update(id, changes) {
    const columns = ['title', 'kind', 'status', 'reason', 'result_json', 'reply_json', 'mirror_json'];
    const entries = Object.entries(changes).filter(([key]) => columns.includes(key));
    if (!entries.length) return;
    this.db.prepare(`UPDATE network_work SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`)
      .run(...entries.map(([,value]) => value), new Date().toISOString(), id);
  }
  step(id, status, detail = null) {
    this.update(id, { status, reason: detail });
    this.db.prepare('INSERT INTO network_steps(work_id,status,detail,ts) VALUES(?,?,?,?)')
      .run(id, status, detail, new Date().toISOString());
  }
  callsToday(agentId) {
    return Number(this.db.prepare('SELECT COUNT(*) n FROM network_calls WHERE agent_id=? AND created_at>=?')
      .get(agentId, new Date().toISOString().slice(0, 10))?.n ?? 0);
  }
  reserveCall(id, agentId, phase, limit) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const allowed = this.callsToday(agentId) < limit;
      const added = allowed && this.db.prepare('INSERT OR IGNORE INTO network_calls(work_id,phase,agent_id,created_at) VALUES(?,?,?,?)')
        .run(id, phase, agentId, new Date().toISOString()).changes === 1;
      this.db.exec('COMMIT');
      return Boolean(added);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pending() {
    return this.db.prepare("SELECT * FROM network_work WHERE status IN ('reply_pending','mirror_pending') ORDER BY created_at LIMIT 5").all();
  }
  recoverInterrupted() {
    for (const row of this.db.prepare("SELECT id FROM network_work WHERE status IN ('received','assessing','reading','working')").all()) {
      this.step(row.id, 'interrupted', 'Runtime stopped during execution. Not retried automatically.');
    }
  }
  recent(limit = 50) { return this.db.prepare('SELECT * FROM network_work ORDER BY created_at DESC LIMIT ?').all(limit).map(row => this.publicWork(row)); }
  publicWork(row) {
    const result = row.result_json ? JSON.parse(row.result_json) : null;
    return { id: row.id, agentDid: row.agent_did, room: row.room, source: JSON.parse(row.source_json),
      kind: row.kind, title: row.title, status: row.status, reason: row.reason, result,
      reply: row.reply_json ? JSON.parse(row.reply_json) : null,
      mirror: row.mirror_json ? JSON.parse(row.mirror_json) : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
      steps: this.db.prepare('SELECT status,detail,ts FROM network_steps WHERE work_id=? ORDER BY id').all(row.id),
      requesterAcceptance: 'not-recorded', settlement: 'not-available' };
  }
}
