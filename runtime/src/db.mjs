import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_challenges (
        id TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        statement TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS auth_challenges_did ON auth_challenges(did, expires_at);

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        owner_did TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner_did, expires_at);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        owner_did TEXT NOT NULL,
        did TEXT NOT NULL UNIQUE,
        public_jwk TEXT NOT NULL,
        private_key_enc TEXT NOT NULL,
        api_key_enc TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner_did, created_at);

      CREATE TABLE IF NOT EXISTS room_events (
        room TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        author_did TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        task_id TEXT,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY(room, seq),
        UNIQUE(room, event_id)
      );
      CREATE INDEX IF NOT EXISTS room_events_task ON room_events(room, task_id, seq);
      CREATE INDEX IF NOT EXISTS room_events_kind ON room_events(room, kind, seq);

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        claim_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        result_json TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS executions_agent_day ON executions(agent_id, started_at, status);
      CREATE INDEX IF NOT EXISTS executions_task ON executions(task_id, status);

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        owner_did TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log(created_at);
    `);
  }

  close() { this.db.close(); }

  createChallenge(did, statement, expiresAt) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO auth_challenges(id,did,statement,expires_at) VALUES(?,?,?,?)")
      .run(id, did, statement, expiresAt);
    return id;
  }

  challenge(id) {
    return this.db.prepare("SELECT * FROM auth_challenges WHERE id=?").get(id) || null;
  }

  consumeChallenge(id, usedAt) {
    const result = this.db.prepare("UPDATE auth_challenges SET used_at=? WHERE id=? AND used_at IS NULL").run(usedAt, id);
    return result.changes === 1;
  }

  createSession(tokenHash, ownerDid, createdAt, expiresAt) {
    this.db.prepare("INSERT INTO sessions(token_hash,owner_did,created_at,expires_at) VALUES(?,?,?,?)")
      .run(tokenHash, ownerDid, createdAt, expiresAt);
  }

  session(tokenHash, now) {
    return this.db.prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?").get(tokenHash, now) || null;
  }

  deleteSession(tokenHash) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }

  purgeExpired(now) {
    this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
    this.db.prepare("DELETE FROM auth_challenges WHERE expires_at<=?").run(now);
  }

  insertAgent(agent) {
    this.db.prepare(`INSERT INTO agents(
      id,owner_did,did,public_jwk,private_key_enc,api_key_enc,provider,model,policy_json,enabled,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      agent.id, agent.ownerDid, agent.did, JSON.stringify(agent.publicJwk), agent.privateKeyEnc,
      agent.apiKeyEnc, agent.provider, agent.model, JSON.stringify(agent.policy), agent.enabled ? 1 : 0,
      agent.createdAt, agent.updatedAt,
    );
  }

  agentsForOwner(ownerDid) {
    return this.db.prepare("SELECT * FROM agents WHERE owner_did=? ORDER BY created_at DESC").all(ownerDid);
  }

  enabledAgents() {
    return this.db.prepare("SELECT * FROM agents WHERE enabled=1 ORDER BY created_at ASC").all();
  }

  agentForOwner(id, ownerDid) {
    return this.db.prepare("SELECT * FROM agents WHERE id=? AND owner_did=?").get(id, ownerDid) || null;
  }

  agentById(id) {
    return this.db.prepare("SELECT * FROM agents WHERE id=?").get(id) || null;
  }

  updateAgent(id, ownerDid, changes) {
    const row = this.agentForOwner(id, ownerDid);
    if (!row) return null;
    const next = { ...row, ...changes, updated_at: new Date().toISOString() };
    this.db.prepare(`UPDATE agents SET
      api_key_enc=?, provider=?, model=?, policy_json=?, enabled=?, updated_at=?, last_error=?
      WHERE id=? AND owner_did=?`).run(
      next.api_key_enc, next.provider, next.model, next.policy_json, next.enabled ? 1 : 0,
      next.updated_at, next.last_error ?? row.last_error, id, ownerDid,
    );
    return this.agentForOwner(id, ownerDid);
  }

  markAgentActivity(id, error = null) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE agents SET last_active_at=?,last_error=?,updated_at=? WHERE id=?").run(now, error, now, id);
  }

  insertRoomEvent(room, message, event) {
    const taskId = event.kind === "task" ? event.id : event.taskId || null;
    const result = this.db.prepare(`INSERT OR IGNORE INTO room_events(
      room,seq,ts,author_did,nonce,event_id,kind,task_id,payload_json,received_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      room, message.seq, message.ts, message.from, message.nonce, event.id, event.kind,
      taskId, JSON.stringify(event), new Date().toISOString(),
    );
    return result.changes === 1;
  }

  roomEvents(room, limit = 5000) {
    return this.db.prepare("SELECT * FROM room_events WHERE room=? ORDER BY seq ASC LIMIT ?").all(room, limit);
  }

  lastRoomSeq(room) {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM room_events WHERE room=?").get(room);
    return Number(row?.seq || 0);
  }

  createExecution(taskId, agentId, claimId = null) {
    const execution = { id: randomUUID(), taskId, agentId, claimId, startedAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO executions(id,task_id,agent_id,claim_id,status,started_at) VALUES(?,?,?,?,?,?)")
      .run(execution.id, taskId, agentId, claimId, "running", execution.startedAt);
    return execution;
  }

  finishExecution(id, status, fields = {}) {
    this.db.prepare(`UPDATE executions SET status=?,finished_at=?,input_tokens=?,output_tokens=?,result_json=?,error=? WHERE id=?`)
      .run(status, new Date().toISOString(), fields.inputTokens ?? null, fields.outputTokens ?? null,
        fields.result ? JSON.stringify(fields.result) : null, fields.error ? String(fields.error).slice(0, 1000) : null, id);
  }

  completedToday(agentId, dayPrefix) {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE agent_id=? AND status='submitted' AND started_at LIKE ?")
      .get(agentId, `${dayPrefix}%`);
    return Number(row?.count || 0);
  }

  hasExecution(taskId, agentId) {
    return Boolean(this.db.prepare("SELECT 1 FROM executions WHERE task_id=? AND agent_id=? AND status IN ('running','submitted') LIMIT 1").get(taskId, agentId));
  }

  setState(key, value) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), now);
  }

  state(key) {
    return this.db.prepare("SELECT value,updated_at FROM runtime_state WHERE key=?").get(key) || null;
  }

  audit(action, ownerDid = null, target = null, detail = null) {
    this.db.prepare("INSERT INTO audit_log(id,owner_did,action,target,detail_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), ownerDid, action, target, detail ? JSON.stringify(detail) : null, new Date().toISOString());
  }

  stats(room) {
    const eventCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM room_events WHERE room=?").get(room)?.count || 0);
    const agentCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM agents").get()?.count || 0);
    const onlineAgents = Number(this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE enabled=1").get()?.count || 0);
    const submitted = Number(this.db.prepare("SELECT COUNT(*) AS count FROM executions WHERE status='submitted'").get()?.count || 0);
    return { eventCount, agentCount, onlineAgents, submitted };
  }
}

export function publicAgent(row) {
  return {
    id: row.id,
    ownerDid: row.owner_did,
    did: row.did,
    provider: row.provider,
    model: row.model,
    policy: JSON.parse(row.policy_json),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
    lastError: row.last_error,
  };
}
