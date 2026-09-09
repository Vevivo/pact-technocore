import { publicJwkFromDid, sha256, verifyDidSignature } from './crypto.mjs';

export function publicRoom(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value)) return false;
  let name = value;
  while (/^(mb|d|e|p)-/.test(name)) {
    if (name.startsWith('p-')) return false;
    name = name.replace(/^(mb|d|e)-/, '');
  }
  return value !== 'events';
}

export function normalizeNetworkPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Network policy must be an object.');
  for (const key of ['rooms', 'sourceHosts', 'allowedDids', 'topics']) if (input[key] !== undefined && !Array.isArray(input[key])) throw new Error(`${key} must be an array.`);
  const rooms = [...new Set(input.rooms ?? [])];
  const sourceHosts = [...new Set(input.sourceHosts ?? ['technocore.chat', 'flop.finance', 'raw.githubusercontent.com'])];
  const allowedDids = [...new Set(input.allowedDids ?? ['*'])];
  const topics = [...new Set(input.topics ?? ['PACT', 'Technocore', 'FLOP', 'tclk'])];
  if (rooms.length > 5 || rooms.some(room => !publicRoom(room))) throw new Error('Choose up to five public room names; unlisted rooms cannot be mirrored.');
  if (sourceHosts.length > 10 || sourceHosts.some(host => typeof host !== 'string' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host))) throw new Error('Source hosts must be exact lowercase public domain names (no URLs or wildcards).');
  if (allowedDids.length > 50) throw new Error('Too many allowed network requesters.');
  for (const did of allowedDids) if (did !== '*') publicJwkFromDid(did);
  if (topics.length > 8 || topics.some(topic => typeof topic !== 'string' || topic.length < 3 || topic.length > 40)) throw new Error('Choose up to eight topics of 3–40 characters.');
  const maxCallsPerDay = input.maxCallsPerDay ?? 6;
  if (!Number.isInteger(maxCallsPerDay) || maxCallsPerDay < 1 || maxCallsPerDay > 24) throw new Error('Network model-call limit must be 1–24 per UTC day.');
  for (const key of ['enabled', 'publicQuestions', 'participate', 'inviteAgents', 'observeTclk', 'maintenanceCheck']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  if (input.enabled && (!rooms.length || !allowedDids.length)) throw new Error('Choose rooms and allowed requesters before enabling network work.');
  return { enabled: input.enabled ?? false, rooms, sourceHosts, allowedDids, topics,
    publicQuestions: input.publicQuestions ?? false, participate: input.participate ?? false, inviteAgents: input.inviteAgents ?? false, observeTclk: input.observeTclk ?? true,
    maintenanceCheck: input.maintenanceCheck ?? false, maxCallsPerDay };
}

export function verifiedRecord(room, record) {
  if (!record || typeof record.text !== 'string' || record.text.length > 4096 || !Number.isSafeInteger(record.seq) || record.seq < 1) return false;
  if (!Number.isFinite(Date.parse(record.ts))) return false;
  if (typeof record.nonce !== 'string' && !Number.isSafeInteger(record.nonce)) return false;
  const nonce = String(record.nonce);
  return /^\d{1,19}$/.test(nonce) && typeof record.sig === 'string'
    && /^[A-Za-z0-9_-]{86}$/.test(record.sig) && Buffer.from(record.sig, 'base64url').toString('base64url') === record.sig
    && verifyDidSignature(record.from, `${room}|${nonce}|${record.text}`, record.sig);
}

export const recordId = (room, record) => sha256(JSON.stringify([room, record.from, String(record.nonce), record.text]));

export function candidateKind(policy, agentDid, room, record, now, enabledAt) {
  if (!verifiedRecord(room, record) || record.from === agentDid) return null;
  if (!policy.allowedDids.includes('*') && !policy.allowedDids.includes(record.from)) return null;
  const time = Date.parse(record.ts);
  if (time < enabledAt || time < now - 180_000 || time > now + 30_000) return null;
  if (/^(PACT\/1 |PACT-NET\/1 |PACT reply )/.test(record.text)) return null;
  if (record.text.startsWith('tclk1 ')) return policy.observeTclk && room === 'tclk-offers' ? 'offer' : null;
  if (policy.participate && record.text.trim()) return 'conversation';
  if (record.text.includes(agentDid) || /(?:^|\s)@?PACT(?:\s|[:,?!])/i.test(record.text)) return 'question';
  return policy.publicQuestions && /[?？]/.test(record.text)
    && policy.topics.some(topic => record.text.toLowerCase().includes(topic.toLowerCase())) ? 'question' : null;
}

export function sourceUrls(text, policy) {
  return [...new Set(text.match(/https:\/\/[^\s<>"\\]+/g) ?? [])]
    .map(value => value.replace(/[),.;!?]+$/, ''))
    .filter(value => {
      try {
        const url = new URL(value);
        return !url.username && !url.password && !url.port && policy.sourceHosts.includes(url.hostname)
          && !/\/(say(?:-signed)?|set(?:-signed)?)(?:\/|$)/i.test(decodeURIComponent(url.pathname))
          && (url.hostname !== 'technocore.chat' || !url.pathname.startsWith('/kv/'));
      } catch { return false; }
    }).slice(0, 3);
}

// Read-only hash-offer inspection. This is NOT a tclk transcript state machine or a settlement adapter.
// Wire rules: flop-labs/tclk SPEC.md, commit 5cc4ab93efbc8999a3a7e1471b639deca25998ea.
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const ascii = text => text.replace(/[\u0080-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function inspectHashOffer(record, now = Date.now()) {
  try {
    const f = JSON.parse(record.text.slice(6));
    const required = ['type', 'from', 'role', 'amount', 'asset', 'lock', 'rails', 'claimByMs', 'refundAfterMs', 'expiresMs', 'nonce', 'id'];
    if (!f || required.some(key => !(key in f)) || Object.keys(f).some(key => ![...required, 'job'].includes(key))) return null;
    if (f.type !== 'offer' || f.from !== record.from || f.lock !== 'hash' || !['payer', 'payee'].includes(f.role)) return null;
    if (!/^[1-9][0-9]*$/.test(f.amount) || typeof f.amount !== 'string' || typeof f.asset !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(f.asset)) return null;
    if (!Array.isArray(f.rails) || !f.rails.length || f.rails.some(r => typeof r !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(r))) return null;
    if (!['claimByMs', 'refundAfterMs', 'expiresMs'].every(k => Number.isSafeInteger(f[k]) && f[k] > 0) || f.claimByMs >= f.refundAfterMs) return null;
    if (typeof f.nonce !== 'string' || !/^[0-9a-f]{8,64}$/.test(f.nonce)) return null;
    if (f.job && (typeof f.job !== 'object' || Object.keys(f.job).some(k => !['proto', 'id', 'context'].includes(k))
      || typeof f.job.proto !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(f.job.proto)
      || typeof f.job.id !== 'string' || !f.job.id || (f.job.context !== undefined && (typeof f.job.context !== 'string' || !f.job.context)))) return null;
    const { id, ...terms } = f;
    if (id !== `0x${sha256(`FLOP::tclk::v1|offer|${ascii(canonical(terms))}`)}`) return null;
    return { id, amount: f.amount, asset: f.asset, rails: f.rails, role: f.role, job: f.job ?? null,
      status: f.expiresMs <= now || f.refundAfterMs <= now ? 'expired' : 'blocked_rail',
      reason: 'Observed signed offer only. No funded settlement adapter is configured; no offer was accepted and no payment was made.' };
  } catch { return null; }
}
