import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.mjs';
import { NetworkStore } from '../src/network-store.mjs';
import { NetworkWorker, parseRoomJson } from '../src/network-worker.mjs';
import { normalizeNetworkPolicy, candidateKind, inspectHashOffer, verifiedRecord, recordId, sourceUrls } from '../src/network-policy.mjs';
import { generateIdentity, seal, signWithJwk, sha256 } from '../src/crypto.mjs';
import { normalizePolicy } from '../src/policy.mjs';
import { createApi } from '../src/http-api.mjs';
import { readSource } from '../src/source-reader.mjs';

function signed(identity, room, text, seq = 1) {
  const nonce = String(Date.now());
  return { seq, ts: new Date().toISOString(), from: identity.did, text, nonce,
    sig: signWithJwk(identity.privateJwk, `${room}|${nonce}|${text}`) };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pact-network-test-'));
  const store = new Store(join(directory, 'test.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ledger = new NetworkStore(store);
  const identity = generateIdentity(); const owner = generateIdentity(); const peer = generateIdentity();
  const config = { version: 'test', masterKey: randomBytes(32), room: 'mb-pact-test', technocoreBase: 'https://technocore.chat',
    publicOrigins: new Set(['https://example.com']), allowedOwnerDids: new Set([owner.did]), sessionTtlMs: 3600000 };
  const id = '11111111-1111-4111-8111-111111111111';
  store.insertAgent({ id, ownerDid: owner.did, did: identity.did, publicJwk: identity.publicJwk,
    privateKeyEnc: seal(config.masterKey, JSON.stringify(identity.privateJwk), `agent-private:${id}`),
    apiKeyEnc: seal(config.masterKey, 'test-provider-secret', `provider-key:${id}`), provider: 'openai', model: 'test-model',
    policy: normalizePolicy({ allowedRequesterDids: ['*'] }), enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const agent = store.agentById(id);
  const profile = ledger.saveProfile(id, normalizeNetworkPolicy({ enabled: true, rooms: ['lobby', 'mb-pact-test'], sourceHosts: ['example.com'] }));
  const messages = new Map(); const posts = []; const inference = []; const reads = [];
  const deps = {
    fetch: async (url, init = {}) => {
      const room = decodeURIComponent(new URL(url).pathname.slice(3));
      if (init.method === 'POST') {
        const body = JSON.parse(init.body); posts.push({ room, ...body });
        const records = messages.get(room) ?? [];
        const record = { ...body, from: body.did, seq: records.length + 1, ts: new Date().toISOString() };
        assert.equal(verifiedRecord(room, record), true);
        records.push(record); messages.set(room, records);
        return new Response(JSON.stringify({ posted: record }), { status: 200 });
      }
      return new Response(JSON.stringify({ messages: messages.get(room) ?? [] }));
    },
    infer: async (provider, model, key, task, sources) => {
      assert.equal(key, 'test-provider-secret');
      assert.equal(JSON.stringify({ task, sources }).includes(key), false);
      inference.push({ task, sources });
      return task.proof === 'structured-json'
        ? { summary: JSON.stringify({ action: 'research', title: 'Explain the supplied source', answer: '' }), inputTokens: 20, outputTokens: 30 }
        : { summary: 'The supplied source describes a public research service.', evidence: sources.map(x => `${x.url}#sha256=${x.sha256}`), inputTokens: 50, outputTokens: 30 };
    },
    readSource: async (url, options) => { reads.push({ url, options }); return { url, text: 'A public research service.', sha256: sha256('source body'), fetchedAt: new Date().toISOString() }; },
  };
  const worker = new NetworkWorker(config, store, ledger, () => {}, deps); worker.running = true;
  const source = signed(peer, 'lobby', `PACT, can you explain https://example.com/info using this source?`);
  const workId = sha256(`${id}:${recordId('lobby', source)}`);
  const create = () => ledger.create({ id: workId, agent, room: 'lobby', source, kind: 'question' });
  return { store, ledger, identity, owner, peer, config, agent, profile, messages, posts, inference, reads, deps, worker, source, workId, create };
}

test('19-digit numeric nonces retain exact signed bytes from the room JSON', () => {
  const identity = generateIdentity();
  const room = 'lobby'; const text = 'PACT, what can you help with?'; const nonce = '1787809316209511726';
  const sig = signWithJwk(identity.privateJwk, `${room}|${nonce}|${text}`);
  const raw = JSON.stringify({ messages: [{ seq: 1, ts: new Date().toISOString(), from: identity.did, text, sig, nonce }] }).replace(`"${nonce}"`, nonce);
  const [record] = parseRoomJson(raw).messages;
  assert.equal(record.nonce, nonce); assert.equal(verifiedRecord(room, record), true);
  const padded = '000123';
  assert.equal(verifiedRecord(room, { ...record, nonce: padded, sig: signWithJwk(identity.privateJwk, `${room}|${padded}|${text}`) }), true);
});

test('network policy is opt-in, bounded and rejects unlisted-room mirroring', () => {
  assert.equal(normalizeNetworkPolicy().enabled, false);
  assert.equal(normalizeNetworkPolicy().maintenanceCheck, false);
  for (const rooms of [['p-hidden'], ['mb-p-hidden'], ['d-e-p-secret'], ['../secret'], ['events']]) assert.throws(() => normalizeNetworkPolicy({ rooms }));
  assert.throws(() => normalizeNetworkPolicy({ enabled: true }));
  assert.throws(() => normalizeNetworkPolicy({ rooms: 'lobby' }));
  assert.throws(() => normalizeNetworkPolicy({ maxCallsPerDay: 25 }));
  assert.throws(() => normalizeNetworkPolicy({ enabled: 'true' }));
  assert.throws(() => normalizeNetworkPolicy({ sourceHosts: ['*.example.com'] }));
});

test('candidate checks reject tampering, unsigned traffic, old traffic, echoes and wrong room binding', () => {
  const peer = generateIdentity(); const agent = generateIdentity(); const now = Date.now();
  const policy = normalizeNetworkPolicy({ publicQuestions: true });
  const r = signed(peer, 'lobby', 'PACT, what can you help with?');
  assert.equal(candidateKind(policy, agent.did, 'lobby', r, now, now - 1000), 'question');
  for (const bad of [{ ...r, sig: undefined }, { ...r, text: r.text + 'x' }, { ...r, from: agent.did }, { ...r, ts: new Date(now - 500000).toISOString() }, { ...r, nonce: Number.MAX_SAFE_INTEGER + 2 }]) {
    assert.equal(candidateKind(policy, agent.did, 'lobby', bad, now, now - 600000), null);
  }
  assert.equal(verifiedRecord('other-room', r), false);
  assert.equal(candidateKind(policy, agent.did, 'lobby', signed(peer, 'lobby', 'PACT reply to someone: here is an answer'), now, now - 1000), null);
  assert.equal(candidateKind(policy, agent.did, 'lobby', signed(peer, 'lobby', 'probe v1 unrelated statement'), now, now - 1000), null);
  assert.equal(candidateKind(policy, agent.did, 'lobby', r, now, now + 1000), null);
  assert.equal(recordId('lobby', r), recordId('lobby', { ...r, seq: 99, ts: 'another venue time' }));
});

test('research URLs are constrained and redirect host checks fail before fetching', async () => {
  const policy = normalizeNetworkPolicy({ sourceHosts: ['example.com', 'technocore.chat'] });
  assert.deepEqual(sourceUrls('https://example.com/info https://evil.example/a https://technocore.chat/r/x/say/me/hacked https://technocore.chat/kv/x/y/set/z https://example.com:444/', policy), ['https://example.com/info']);
  await assert.rejects(readSource('https://evil.example/', { allowedHosts: ['example.com'] }), /outside/);
  await assert.rejects(readSource('https://technocore.chat/r/x/say-signed/a/b/c/d', { allowedHosts: ['technocore.chat'] }), /outside/);
});

test('conversation participation broadens topics only when enabled and keeps signature and echo checks', () => {
  const peer = generateIdentity(), agent = generateIdentity(), now = Date.now();
  const record = signed(peer, 'lobby', 'Could someone explain what this room is for?');
  const strict = normalizeNetworkPolicy();
  const conversational = normalizeNetworkPolicy({ participate: true });
  assert.equal(candidateKind(strict, agent.did, 'lobby', record, now, now - 1000), null);
  assert.equal(candidateKind(conversational, agent.did, 'lobby', record, now, now - 1000), 'conversation');
  assert.equal(candidateKind(conversational, agent.did, 'lobby', { ...record, sig: undefined }, now, now - 1000), null);
  assert.equal(candidateKind(conversational, agent.did, 'lobby', signed(agent, 'lobby', 'I have answered this.'), now, now - 1000), null);
  assert.equal(candidateKind(conversational, agent.did, 'lobby', signed(peer, 'lobby', 'PACT-NET/1 mirror'), now, now - 1000), null);
  assert.throws(() => normalizeNetworkPolicy({ participate: 'yes' }), /boolean/);
});

test('conversation context is verified, bounded and retained; model can choose silence without a public post', async t => {
  const f = fixture(t); f.source.seq = 20; f.create();
  const records = Array.from({ length: 12 }, (_, i) => signed(f.peer, 'lobby', `Conversation line ${i}`, i + 1));
  records.push({ ...signed(f.peer, 'lobby', 'TAMPERED', 15), sig: 'bad' });
  records.push(signed(f.peer, 'other-room', 'WRONG ROOM', 16));
  records.push(signed(f.peer, 'lobby', 'FUTURE SEQUENCE', 21));
  f.worker.infer = async (...args) => {
    const brief = args[3].brief;
    assert.match(brief, /Conversation line 11/);
    assert.doesNotMatch(brief, /TAMPERED|WRONG ROOM|FUTURE SEQUENCE|Conversation line 0"/);
    return { summary: JSON.stringify({ action: 'ignore', title: 'Already answered', answer: '' }) };
  };
  await f.worker.execute(f.workId, f.agent, f.profile, records);
  assert.equal(f.ledger.get(f.workId).status, 'skipped');
  const saved = JSON.parse(f.ledger.get(f.workId).result_json).context;
  assert.equal(saved.length, 8);
  assert.equal(saved.every(record => verifiedRecord('lobby', record)), true);
  assert.equal(f.posts.length, 0);
  assert.equal(f.ledger.callsToday(f.agent.id), 1);
});

test('contextual invitations use the same model call and cannot repeat for the recipient after restart', async t => {
  const f = fixture(t); f.create();
  const profile = f.ledger.saveProfile(f.agent.id, { ...f.profile.policy, inviteAgents: true });
  f.worker.infer = async () => ({ summary: JSON.stringify({ action: 'reply', title: 'Trying signed tasks', answer: 'A signed task describes the requested work and its evidence requirements.', invite: true }) });
  await f.worker.execute(f.workId, f.agent, profile);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0].text, /humans#r\/mb-pact-test/);
  const result = JSON.parse(f.ledger.get(f.workId).result_json);
  assert.equal(result.outputHash, sha256(result.summary));
  assert.equal(f.ledger.callsToday(f.agent.id), 1);
  const restarted = new NetworkWorker(f.config, f.store, f.ledger, () => {}, f.deps); restarted.running = true;
  assert.equal(restarted.invitation(f.agent, profile, 'another-room', f.peer.did), null);
  assert.equal(restarted.invitation(f.agent, profile, f.config.room, f.owner.did), null);
  const disabled = f.ledger.saveProfile(f.agent.id, { ...profile.policy, inviteAgents: false });
  assert.equal(restarted.invitation(f.agent, disabled, 'lobby', f.owner.did), null);
});

test('real signed request -> source research -> verified reply -> signed PACT mirror and public receipt', async t => {
  const f = fixture(t); f.create();
  await f.worker.execute(f.workId, f.agent, f.profile);
  assert.equal(f.ledger.get(f.workId).status, 'reply_pending');
  assert.equal(f.inference.length, 2); assert.equal(f.reads.length, 1);
  assert.deepEqual(f.reads[0].options.allowedHosts, ['example.com']);
  await f.worker.deliver(f.workId, f.agent, f.profile); // confirm reply, prepare mirror
  assert.equal(f.ledger.get(f.workId).status, 'mirror_pending');
  await f.worker.deliver(f.workId, f.agent, f.profile); // send mirror
  await f.worker.deliver(f.workId, f.agent, f.profile); // confirm mirror
  const receipt = f.ledger.publicWork(f.ledger.get(f.workId));
  assert.equal(receipt.status, 'reply_submitted'); assert.equal(receipt.requesterAcceptance, 'not-recorded');
  assert.equal(receipt.source.text, f.source.text); assert.equal(receipt.source.from, f.peer.did);
  assert.equal(f.posts.length, 2); assert.equal(f.posts[0].room, 'lobby'); assert.equal(f.posts[1].room, f.config.room);
  assert.equal(f.posts[1].text.startsWith('PACT-NET/1 '), true);
  const mirror = JSON.parse(f.posts[1].text.slice('PACT-NET/1 '.length));
  assert.equal(mirror.source.textHash, sha256(f.source.text)); assert.equal(mirror.summary, receipt.result.summary);
  assert.equal(mirror.outputHash, sha256(receipt.result.summary)); assert.equal(mirror.settlement, 'not-available');
  assert.equal(JSON.stringify(receipt).includes('test-provider-secret'), false);
  assert.equal(JSON.stringify(receipt).includes(f.identity.privateJwk.d), false);
  assert.equal(f.create(), false); // same signed source cannot be processed twice
  assert.equal(f.ledger.callsToday(f.agent.id), 2);
});

test('unknown write outcome is reconciled after restart without duplicate publication', async t => {
  const f = fixture(t); f.create(); let first = true;
  const normal = f.worker.fetch;
  f.worker.fetch = async (url, init) => {
    const response = await normal(url, init);
    if (init?.method === 'POST' && first) { first = false; throw new Error('Connection lost after remote commit'); }
    return response;
  };
  await f.worker.execute(f.workId, f.agent, f.profile);
  assert.equal(f.ledger.get(f.workId).status, 'reply_pending');
  const restarted = new NetworkWorker(f.config, f.store, f.ledger, () => {}, f.deps); restarted.running = true;
  await restarted.deliver(f.workId, f.agent, f.profile);
  assert.equal(f.posts.length, 1); assert.equal(f.ledger.get(f.workId).status, 'mirror_pending');
});

test('failed model calls count against durable budget and paused agent cannot publish', async t => {
  const f = fixture(t); f.create();
  f.worker.infer = async () => { throw new Error('provider failure'); };
  await f.worker.execute(f.workId, f.agent, f.profile);
  assert.equal(f.ledger.callsToday(f.agent.id), 1); assert.equal(f.ledger.get(f.workId).status, 'failed');
  assert.equal(f.ledger.reserveCall(f.workId, f.agent.id, 'another', 1), false);
  assert.equal(f.posts.length, 0);
  const f2 = fixture(t); f2.create();
  f2.worker.infer = async (...args) => {
    f2.store.updateAgent(f2.agent.id, f2.owner.did, { enabled: 0 });
    return f2.deps.infer(...args);
  };
  await f2.worker.execute(f2.workId, f2.agent, f2.profile);
  assert.equal(f2.ledger.get(f2.workId).status, 'paused'); assert.equal(f2.posts.length, 0);
});

test('owner-only network control requires explicit consent; public feed never contains credentials', async t => {
  const f = fixture(t);
  f.config.allowedOwnerDids.add(f.peer.did); // Admission is allowed; ownership still must deny access.
  const api = createApi(f.config, f.store, {}, () => {}, f.ledger);
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => api.close(resolve)));
  const base = `http://127.0.0.1:${api.address().port}`;
  const path = `${base}/v1/agents/${f.agent.id}/network`;
  const post = (token, extra = {}) => fetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ enabled: true, rooms: ['lobby'], ...extra }) });
  assert.equal((await post(null)).status, 401);
  for (const [token, did] of [['owner-token', f.owner.did], ['stranger-token', f.peer.did]]) f.store.createSession(sha256(token), did, new Date().toISOString(), new Date(Date.now() + 60000).toISOString());
  assert.equal((await post('stranger-token', { confirmPublicPosting: true })).status, 404);
  assert.equal((await post('owner-token')).status, 400);
  assert.equal((await post('owner-token', { confirmPublicPosting: true })).status, 200);
  assert.equal(JSON.stringify(await (await fetch(`${base}/v1/network-work`)).json()).includes('test-provider-secret'), false);
});

test('tclk hash offers verify the committed terms but never claim funded settlement', () => {
  const identity = generateIdentity(); const now = Date.now();
  const offer = { type: 'offer', from: identity.did, role: 'payer', amount: '50', asset: 'FLOP', lock: 'hash', rails: ['paper'], claimByMs: now + 60000, refundAfterMs: now + 120000, expiresMs: now + 30000, nonce: '0011223344556677' };
  const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  offer.id = `0x${sha256(`FLOP::tclk::v1|offer|${canonical(offer)}`)}`;
  const record = signed(identity, 'tclk-offers', `tclk1 ${JSON.stringify(offer)}`);
  assert.equal(inspectHashOffer(record, now).status, 'blocked_rail');
  assert.equal(inspectHashOffer({ ...record, text: `tclk1 ${JSON.stringify({ ...offer, amount: '500' })}` }, now), null);
  assert.equal(inspectHashOffer(record, now + 30001).status, 'expired');
});

test('quiet-room maintenance records a real source check without a model call or invented requester', async t => {
  const f = fixture(t);
  const profile = f.ledger.saveProfile(f.agent.id, { ...f.profile.policy, maintenanceCheck: true });
  f.store.setState('technocore_room_last_message', new Date(Date.now() - 73 * 3600000).toISOString());
  const body = '{"idle_room_seconds":604800}';
  f.worker.read = async (url, options) => {
    assert.equal(url, 'https://technocore.chat/config');
    assert.deepEqual(options.allowedHosts, ['technocore.chat']);
    return { url, text: body, sha256: sha256(body), fetchedAt: new Date().toISOString() };
  };
  await f.worker.maintenance(f.agent, profile);
  const [work] = f.ledger.recent();
  assert.equal(work.kind, 'maintenance'); assert.equal(work.source, null);
  assert.equal(work.status, 'mirror_pending'); assert.equal(work.reply, null);
  assert.equal(work.result.sources[0].sha256, sha256(body));
  assert.equal(f.inference.length, 0); assert.equal(f.ledger.callsToday(f.agent.id), 0);
  assert.equal(f.posts.length, 1); assert.equal(f.posts[0].room, f.config.room);
  const report = JSON.parse(f.posts[0].text.slice('PACT-NET/1 '.length));
  assert.equal(report.kind, 'maintenance'); assert.equal(report.requester, null);
  assert.equal(report.settlement, 'not-available');
  await f.worker.deliver(work.id, f.agent, profile);
  assert.equal(f.ledger.get(work.id).status, 'maintenance_submitted');
  await f.worker.maintenance(f.agent, profile);
  assert.equal(f.posts.length, 1); // cooldown survives repeated scans
  f.store.setState(`network-maintenance:${f.config.room}`, String(Date.now() - 73 * 3600000));
  await f.worker.maintenance(f.agent, profile);
  assert.equal(f.posts.length, 2); assert.equal(f.ledger.recent().length, 2); // a later real check has its own record
});

test('maintenance skips recent activity and never announces a failed or paused check as successful', async t => {
  const f = fixture(t);
  const profile = f.ledger.saveProfile(f.agent.id, { ...f.profile.policy, maintenanceCheck: true });
  f.store.setState('technocore_room_last_message', new Date().toISOString());
  await f.worker.maintenance(f.agent, profile);
  assert.equal(f.ledger.recent().length, 0);
  f.store.setState('technocore_room_last_message', new Date(Date.now() - 73 * 3600000).toISOString());
  f.worker.read = async () => { throw new Error('upstream unavailable'); };
  await f.worker.maintenance(f.agent, profile);
  assert.equal(f.ledger.recent()[0].status, 'failed'); assert.equal(f.posts.length, 0);
  const f2 = fixture(t);
  const p2 = f2.ledger.saveProfile(f2.agent.id, { ...f2.profile.policy, maintenanceCheck: true });
  f2.store.setState('technocore_room_last_message', new Date(Date.now() - 73 * 3600000).toISOString());
  f2.worker.read = async url => {
    f2.store.updateAgent(f2.agent.id, f2.owner.did, { enabled: 0 });
    return { url, text: '{}', sha256: sha256('{}'), fetchedAt: new Date().toISOString() };
  };
  await f2.worker.maintenance(f2.agent, p2);
  assert.equal(f2.ledger.recent()[0].status, 'paused'); assert.equal(f2.posts.length, 0);
});
