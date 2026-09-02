import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateIdentity,
  open,
  seal,
  signWithJwk,
  verifyDidSignature,
  publicJwkFromDid,
} from "../src/crypto.mjs";
import { decodeEvent, encodeEvent, newEvent } from "../src/protocol.mjs";
import { buildTaskViews } from "../src/tasks.mjs";
import { isPrivateAddress, selectLookupResult } from "../src/source-reader.mjs";
import { normalizePolicy, policyAllows } from "../src/policy.mjs";
import { Store } from "../src/db.mjs";
import { createApi } from "../src/http-api.mjs";
import { TechnocoreClient, messageValid } from "../src/technocore.mjs";
import { openAiRequestBody, openAiResponseText } from "../src/providers.mjs";

test("Ed25519 DID signing and encrypted envelopes round trip", () => {
  const identity = generateIdentity();
  assert.equal(publicJwkFromDid(identity.did).x, identity.publicJwk.x);
  const signature = signWithJwk(identity.privateJwk, "PACT test payload");
  assert.equal(verifyDidSignature(identity.did, "PACT test payload", signature), true);
  assert.equal(verifyDidSignature(identity.did, "tampered", signature), false);
  const key = randomBytes(32);
  const encrypted = seal(key, "provider-secret", "test");
  assert.equal(open(key, encrypted, "test"), "provider-secret");
  assert.throws(() => open(key, encrypted, "wrong-purpose"));
});

test("PACT protocol accepts explicit real-work events and rejects fake settlement", () => {
  const task = newEvent("task", {
    title: "Inspect official source",
    brief: "Read the supplied source and return a concise evidence-backed result.",
    sources: ["https://example.com/"],
    proof: "source-citations",
    capability: "web-research",
    settlement: "not-available",
  });
  assert.deepEqual(decodeEvent(encodeEvent(task)), task);
  assert.throws(() => encodeEvent({ ...task, settlement: "100-flop" }));
});

test("task state uses Technocore seq order and requester-only decisions", () => {
  const task = newEvent("task", {
    title: "Verify one source",
    brief: "Read the source, hash its raw response, and summarize only verified facts.",
    sources: ["https://example.com"], proof: "source-citations", capability: "web-research", settlement: "not-available",
  });
  const claim = newEvent("claim", { taskId: task.id, leaseSeconds: 600 });
  const submission = newEvent("submission", { taskId: task.id, claimId: claim.id, summary: "done", evidence: ["https://example.com/#sha256=abc"], model: "openai:test" });
  const badDecision = newEvent("decision", { taskId: task.id, submissionId: submission.id, verdict: "accepted" });
  const goodDecision = newEvent("decision", { taskId: task.id, submissionId: submission.id, verdict: "accepted" });
  const rows = [
    row(1, "did:key:requester", task), row(2, "did:key:worker", claim), row(3, "did:key:worker", submission),
    row(4, "did:key:stranger", badDecision), row(5, "did:key:requester", goodDecision),
  ];
  const [view] = buildTaskViews(rows, Date.parse("2026-08-27T00:05:00Z"));
  assert.equal(view.status, "accepted");
  assert.equal(view.decision.author, "did:key:requester");
  assert.equal(view.activeClaim.author, "did:key:worker");
});

test("agent policies are deny-by-default and source fetch blocks private networks", () => {
  const policy = normalizePolicy({});
  assert.deepEqual(policy.allowedRequesterDids, []);
  assert.equal(policyAllows(policy, { status: "open", author: "did:key:any", task: { capability: "web-research", proof: "source-citations", sources: ["https://example.com"], settlement: "not-available" } }), false);
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.2.3.4"), true);
  assert.equal(isPrivateAddress("169.254.1.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("source lookup supports Node multi-address callbacks without weakening SSRF checks", () => {
  const answers = [
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ];
  assert.deepEqual(selectLookupResult(answers, { all: true }), answers);
  assert.deepEqual(selectLookupResult(answers, { family: 4 }), answers[0]);
  assert.deepEqual(selectLookupResult(answers, 6), answers[1]);
  assert.throws(() => selectLookupResult([{ address: "127.0.0.1", family: 4 }], { all: true }));
  assert.throws(() => selectLookupResult([{ address: undefined, family: 4 }], { all: true }));
});

test("OpenAI responses preserve text items and diagnose incomplete output", () => {
  const request = openAiRequestBody("gpt-5-mini", "Complete one signed task.");
  assert.equal(request.reasoning.effort, "low");
  assert.equal(request.max_output_tokens, 3000);
  assert.equal(request.store, false);
  assert.equal(openAiResponseText({
    status: "completed",
    output: [
      { type: "reasoning", content: [] },
      { type: "message", content: [{ type: "output_text", text: "{\"summary\":\"done\",\"evidence\":[]}" }] },
    ],
  }), "{\"summary\":\"done\",\"evidence\":[]}");
  assert.throws(
    () => openAiResponseText({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", content: [] }] }),
    /incomplete.*max_output_tokens/i,
  );
});

test("DID login creates a separate disabled operational agent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pact-test-"));
  const store = new Store(join(directory, "test.sqlite"));
  const owner = generateIdentity();
  const config = {
    version: "test", room: "mb-pact-work-v1", masterKey: randomBytes(32), sessionTtlMs: 3_600_000,
    publicOrigins: new Set(["https://pact_example.ar.io"]), allowedOwnerDids: new Set([owner.did]), arnsUndername: "pact_example",
  };
  store.setState("technocore_last_sync", new Date().toISOString());
  const relayed = [];
  const api = createApi(config, store, { postEnvelope: async (value) => relayed.push(value) }, () => {});
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => api.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${api.address().port}`;
  const challengeResponse = await fetch(`${base}/v1/auth/challenge`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://pact_example.ar.io" }, body: JSON.stringify({ did: owner.did }),
  });
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json();
  const loginResponse = await fetch(`${base}/v1/auth/verify`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://pact_example.ar.io" },
    body: JSON.stringify({ challengeId: challenge.challengeId, did: owner.did, signature: signWithJwk(owner.privateJwk, challenge.statement) }),
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  const createResponse = await fetch(`${base}/v1/agents`, {
    method: "POST", headers: { authorization: `Bearer ${login.token}`, "content-type": "application/json", origin: "https://pact_example.ar.io" },
    body: JSON.stringify({ provider: "openai", model: "gpt-5-mini", apiKey: "test-provider-key", policy: {} }),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.agent.ownerDid, owner.did);
  assert.notEqual(created.agent.did, owner.did);
  assert.equal(created.agent.enabled, false);
  assert.equal(created.recoveryKey.crv, "Ed25519");

  const deleteResponse = await fetch(`${base}/v1/agents/${created.agent.id}`, {
    method: "DELETE", headers: { authorization: `Bearer ${login.token}`, origin: "https://pact_example.ar.io" },
  });
  assert.equal(deleteResponse.status, 200);
  const listResponse = await fetch(`${base}/v1/agents`, {
    headers: { authorization: `Bearer ${login.token}`, origin: "https://pact_example.ar.io" },
  });
  assert.equal(listResponse.status, 200);
  assert.deepEqual((await listResponse.json()).agents, []);
  const deletedAgent = store.agentById(created.agent.id);
  assert.equal(deletedAgent.enabled, 0);
  assert.equal(deletedAgent.private_key_enc, "deleted");
  assert.equal(deletedAgent.api_key_enc, "deleted");
  assert.ok(deletedAgent.deleted_at);

  const outsider = generateIdentity();
  const denied = await fetch(`${base}/v1/auth/challenge`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://pact_example.ar.io" }, body: JSON.stringify({ did: outsider.did }),
  });
  assert.equal(denied.status, 403);
});

test("a successful Technocore write returns without waiting for an archive read", async () => {
  const identity = generateIdentity();
  const event = newEvent("task", {
    title: "Verify relay acknowledgement",
    brief: "Confirm that a successful write does not block on a second archive request.",
    sources: ["https://example.com"], proof: "source-citations", capability: "web-research", settlement: "not-available",
  });
  const room = "mb-pact-work-v1";
  const nonce = String(Date.now());
  const text = encodeEvent(event);
  const sig = signWithJwk(identity.privateJwk, `${room}|${nonce}|${text}`);
  const calls = [];
  const client = new TechnocoreClient(
    { room, technocoreBase: "https://technocore.example", version: "test" },
    { lastRoomSeq: () => 0 },
    () => {},
    async (url, init) => {
      calls.push({ url: String(url), method: init.method, body: init.body });
      return new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } });
    },
  );
  await client.postEnvelope({ did: identity.did, sig, nonce, text });
  assert.deepEqual(calls.map((call) => call.method), ["POST"]);
  assert.equal(typeof JSON.parse(calls[0].body).nonce, "string");

  const legacyNonce = Date.now() + 1;
  const legacySig = signWithJwk(identity.privateJwk, `${room}|${legacyNonce}|${text}`);
  await client.postEnvelope({ did: identity.did, sig: legacySig, nonce: legacyNonce, text });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "POST"]);
  assert.equal(JSON.parse(calls[1].body).nonce, String(legacyNonce));
  assert.equal(messageValid(room, {
    seq: 1, ts: new Date().toISOString(), from: identity.did, nonce, text,
  }), true);
  assert.equal(messageValid(room, {
    seq: 1, ts: new Date().toISOString(), from: identity.did, nonce: Number(nonce), text,
  }), true);
  assert.equal(messageValid(room, {
    seq: 1, ts: new Date().toISOString(), from: identity.did, nonce: 0, text,
  }), false);
});

test("Technocore room reads use a unique cache-busting token", async () => {
  const urls = [];
  const store = {
    lastRoomSeq: () => 8,
    setState: () => {},
  };
  const client = new TechnocoreClient(
    { room: "mb-pact-work-v1", technocoreBase: "https://technocore.example", version: "test" },
    store,
    () => {},
    async (url) => {
      urls.push(new URL(url));
      return Response.json({ room: "mb-pact-work-v1", count: 0, first_seq: null, last_seq: 8, messages: [] });
    },
  );
  await client.syncOnce();
  await client.syncOnce();
  assert.equal(urls.length, 2);
  assert.ok(urls[0].searchParams.get("n"));
  assert.notEqual(urls[0].searchParams.get("n"), urls[1].searchParams.get("n"));
});

function row(seq, author, event) {
  return {
    room: "mb-pact-work-v1", seq, ts: `2026-08-27T00:0${seq}:00Z`, author_did: author,
    nonce: seq, event_id: event.id, kind: event.kind, task_id: event.kind === "task" ? event.id : event.taskId,
    payload_json: JSON.stringify(event), received_at: "2026-08-27T00:10:00Z",
  };
}
