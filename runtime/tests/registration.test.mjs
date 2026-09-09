import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.mjs';
import { createApi } from '../src/http-api.mjs';
import { generateIdentity, signWithJwk, open } from '../src/crypto.mjs';

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pact-registration-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const config = { version: 'test', room: 'pact-test', masterKey: randomBytes(32), sessionTtlMs: 3600000,
    publicOrigins: new Set(['https://example.com']), allowedOwnerDids: new Set(), hostedRegistration: 'open',
    maxAgentsPerOwner: 2, maxHostedAgents: 3, ...options };
  const api = createApi(config, store, {}, () => {});
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => api.close(resolve)); store.close(); rmSync(directory, { recursive:true, force:true }); });
  const call = (path, method = 'GET', data, token) => fetch(`http://127.0.0.1:${api.address().port}${path}`, {
    method, headers: { 'content-type':'application/json', ...(token ? { authorization:`Bearer ${token}` } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const login = async identity => {
    const response = await call('/v1/auth/challenge', 'POST', { did:identity.did });
    assert.equal(response.status, 201);
    const challenge = await response.json();
    const verify = await call('/v1/auth/verify', 'POST', { did:identity.did, challengeId:challenge.challengeId,
      signature:signWithJwk(identity.privateJwk, challenge.statement) });
    assert.equal(verify.status, 200);
    return (await verify.json()).token;
  };
  const input = { provider:'openai', model:'gpt-5-mini', apiKey:'test-only-provider-key', confirmHostedKeys:true, policy:{} };
  return { store, config, call, login, input };
}

test('public registration verifies DID possession and isolates owners across all agent controls', async t => {
  const { store, config, call, login, input } = await fixture(t);
  const alice = generateIdentity(), bob = generateIdentity();
  const a = await login(alice), b = await login(bob);
  assert.equal((await call('/v1/agents', 'POST', input)).status, 401);
  assert.equal((await call('/v1/agents', 'POST', { ...input, confirmHostedKeys:false }, a)).status, 400);
  const response = await call('/v1/agents', 'POST', { ...input, ownerDid:bob.did }, a);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.agent.ownerDid, alice.did); // Client-supplied owner cannot override the session.
  assert.notEqual(created.agent.did, alice.did);
  assert.equal(created.agent.enabled, false);
  const stored = store.agentById(created.agent.id);
  assert.notEqual(stored.api_key_enc, input.apiKey);
  assert.equal(open(config.masterKey, stored.api_key_enc, `provider-key:${stored.id}`), input.apiKey);
  const own = await (await call('/v1/agents', 'GET', null, a)).json();
  assert.equal(own.ownerDid, alice.did);
  assert.equal(own.agents.length, 1);
  assert.equal(JSON.stringify(own).includes(input.apiKey), false);
  assert.equal(JSON.stringify(own).includes('recoveryKey'), false);
  assert.equal(JSON.stringify(own).includes('private_key_enc'), false);
  assert.deepEqual((await (await call('/v1/agents', 'GET', null, b)).json()).agents, []);
  for (const [path, method, data] of [
    [`/v1/agents/${stored.id}`, 'PATCH', { enabled:true }],
    [`/v1/agents/${stored.id}`, 'PATCH', { apiKey:'another-test-key' }],
    [`/v1/agents/${stored.id}/network`, 'PATCH', { enabled:false }],
    [`/v1/agents/${stored.id}`, 'DELETE', null],
  ]) assert.equal((await call(path, method, data, b)).status, 404);
  assert.equal((await call(`/v1/agents/${stored.id}`, 'PATCH', { apiKey:'replacement-test-key' }, a)).status, 200);
  assert.equal((await call(`/v1/agents/${stored.id}`, 'DELETE', null, a)).status, 200);
  assert.equal(store.agentById(stored.id).api_key_enc, 'deleted');
});

test('public registration rejects forged and replayed signatures and enforces admission changes', async t => {
  const { config, call } = await fixture(t);
  const owner = generateIdentity(), impostor = generateIdentity();
  const c = await (await call('/v1/auth/challenge', 'POST', { did:owner.did })).json();
  const proof = { did:owner.did, challengeId:c.challengeId, signature:signWithJwk(impostor.privateJwk,c.statement) };
  assert.equal((await call('/v1/auth/verify','POST', proof)).status, 401);
  proof.signature = signWithJwk(owner.privateJwk,c.statement);
  const verified = await call('/v1/auth/verify','POST', proof);
  assert.equal(verified.status, 200);
  const { token } = await verified.json();
  assert.equal((await call('/v1/auth/verify','POST', proof)).status, 400);
  config.hostedRegistration = 'allowlist';
  assert.equal((await call('/v1/agents','GET', null,token)).status, 403);
  assert.equal((await call('/v1/auth/challenge','POST', { did:owner.did })).status, 403);
  config.allowedOwnerDids.add(owner.did);
  assert.equal((await call('/v1/agents','GET', null,token)).status, 200);
});

test('agent quotas hold under concurrent creates and deletion releases capacity', async t => {
  const { call, login, input, store } = await fixture(t);
  const a = await login(generateIdentity()), b = await login(generateIdentity());
  const responses = await Promise.all(Array.from({length:4}, () => call('/v1/agents','POST',input,a)));
  assert.deepEqual(responses.map(r => r.status).sort(), [201,201,409,409]);
  assert.equal(store.activeAgentCount(), 2);
  assert.equal((await call('/v1/agents','POST',input,b)).status, 201);
  assert.equal((await call('/v1/agents','POST',input,b)).status, 409);
  const own = (await (await call('/v1/agents','GET',null,a)).json()).agents;
  assert.equal((await call(`/v1/agents/${own[0].id}`,'DELETE',null,a)).status, 200);
  assert.equal((await call('/v1/agents','POST',input,b)).status, 201);
});
