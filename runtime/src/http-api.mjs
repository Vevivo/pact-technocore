import http from "node:http";
import { randomUUID } from "node:crypto";
import { generateIdentity, publicJwkFromDid, randomToken, seal, sha256, verifyDidSignature } from "./crypto.mjs";
import { publicAgent } from "./db.mjs";
import { normalizePolicy } from "./policy.mjs";
import { validProvider } from "./providers.mjs";
import { buildTaskViews } from "./tasks.mjs";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...headers,
  });
  response.end(payload);
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 262_144) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new HttpError(400, "Request body must be valid JSON."); }
}

function modelName(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:/-]{2,100}$/.test(value)) throw new HttpError(400, "Invalid model name.");
  return value;
}

function originAllowed(config, origin) {
  if (!origin) return true;
  return config.publicOrigins.has(origin);
}

function corsHeaders(config, request) {
  const origin = request.headers.origin;
  if (!origin || !originAllowed(config, origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function clientIp(request) {
  const remote = request.socket.remoteAddress || "unknown";
  if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
    return String(request.headers["x-forwarded-for"] || remote).split(",")[0].trim();
  }
  return remote;
}

class RateLimiter {
  constructor() { this.entries = new Map(); }
  take(key, limit, windowMs = 60_000) {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.reset <= now) {
      this.entries.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }
  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.reset <= now) this.entries.delete(key);
  }
}

function bearer(request) {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function authenticate(store, request) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, "DID session required.");
  const session = store.session(sha256(token), new Date().toISOString());
  if (!session) throw new HttpError(401, "DID session expired or invalid.");
  return { token, ownerDid: session.owner_did };
}

function networkSnapshot(config, store) {
  const stats = store.stats(config.room);
  const lastSync = store.state("technocore_last_sync");
  const gap = store.state("technocore_gap");
  return {
    version: config.version,
    room: config.room,
    transport: "technocore",
    lastSeq: store.lastRoomSeq(config.room),
    lastSyncAt: lastSync?.value || null,
    archiveGap: gap ? JSON.parse(gap.value) : null,
    ...stats,
    settlement: "not-available",
  };
}

function agentCreateInput(input) {
  if (!validProvider(input.provider)) throw new HttpError(400, "Unsupported inference provider.");
  if (typeof input.apiKey !== "string" || input.apiKey.length < 8 || input.apiKey.length > 512) throw new HttpError(400, "Provider API key is required.");
  return { provider: input.provider, model: modelName(input.model), apiKey: input.apiKey, policy: normalizePolicy(input.policy) };
}

export function createApi(config, store, technocore, logger) {
  const limiter = new RateLimiter();
  const sweep = setInterval(() => { limiter.sweep(); store.purgeExpired(new Date().toISOString()); }, 60_000);
  sweep.unref();

  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    const requestId = randomUUID();
    const headers = corsHeaders(config, request);
    try {
      const origin = request.headers.origin;
      if (origin && !originAllowed(config, origin)) throw new HttpError(403, "Origin is not allowed.");
      if (request.method === "OPTIONS") {
        response.writeHead(204, headers);
        response.end();
        return;
      }
      const ip = clientIp(request);
      const bucket = request.method === "GET" ? "read" : "write";
      const limit = bucket === "read" ? 120 : 30;
      if (!limiter.take(`${bucket}:${ip}`, limit)) throw new HttpError(429, "Too many requests. Try again shortly.");
      const url = new URL(request.url || "/", "http://pact.local");

      if (request.method === "GET" && url.pathname === "/healthz") {
        const snapshot = networkSnapshot(config, store);
        json(response, snapshot.lastSyncAt ? 200 : 503, { ok: Boolean(snapshot.lastSyncAt), uptimeSeconds: Math.floor(process.uptime()), ...snapshot }, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/network") {
        json(response, 200, networkSnapshot(config, store), headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/tasks") {
        const tasks = buildTaskViews(store.roomEvents(config.room)).slice(0, 500);
        json(response, 200, { room: config.room, tasks }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/challenge") {
        if (!limiter.take(`auth:${ip}`, 10)) throw new HttpError(429, "Too many login attempts.");
        const input = await body(request);
        try { publicJwkFromDid(input.did); } catch { throw new HttpError(400, "A valid Ed25519 did:key is required."); }
        if (!config.allowedOwnerDids.has(input.did)) throw new HttpError(403, "This DID is not authorized to control hosted agents.");
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        const nonce = randomToken(24);
        const statement = `PACT LOGIN\nDID: ${input.did}\nChallenge: ${nonce}\nExpires: ${expiresAt}`;
        const id = store.createChallenge(input.did, statement, expiresAt);
        json(response, 201, { challengeId: id, statement, expiresAt }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/verify") {
        if (!limiter.take(`auth:${ip}`, 10)) throw new HttpError(429, "Too many login attempts.");
        const input = await body(request);
        const challenge = store.challenge(input.challengeId);
        const now = new Date().toISOString();
        if (!challenge || challenge.used_at || challenge.expires_at <= now || challenge.did !== input.did) throw new HttpError(400, "Challenge is invalid or expired.");
        if (!verifyDidSignature(input.did, challenge.statement, input.signature)) throw new HttpError(401, "DID signature did not verify.");
        if (!store.consumeChallenge(challenge.id, now)) throw new HttpError(409, "Challenge was already used.");
        const token = randomToken(32);
        const expiresAt = new Date(Date.now() + config.sessionTtlMs).toISOString();
        store.createSession(sha256(token), input.did, now, expiresAt);
        store.audit("session.created", input.did);
        json(response, 200, { token, ownerDid: input.did, expiresAt }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        const session = authenticate(store, request);
        store.deleteSession(sha256(session.token));
        store.audit("session.deleted", session.ownerDid);
        json(response, 200, { ok: true }, headers);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/agents") {
        const session = authenticate(store, request);
        json(response, 200, { agents: store.agentsForOwner(session.ownerDid).map(publicAgent) }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/agents") {
        const session = authenticate(store, request);
        const input = agentCreateInput(await body(request));
        const identity = generateIdentity();
        const id = randomUUID();
        const now = new Date().toISOString();
        store.insertAgent({
          id, ownerDid: session.ownerDid, did: identity.did, publicJwk: identity.publicJwk,
          privateKeyEnc: seal(config.masterKey, JSON.stringify(identity.privateJwk), `agent-private:${id}`),
          apiKeyEnc: seal(config.masterKey, input.apiKey, `provider-key:${id}`),
          provider: input.provider, model: input.model, policy: input.policy, enabled: false,
          createdAt: now, updatedAt: now,
        });
        store.audit("agent.created", session.ownerDid, id, { did: identity.did, provider: input.provider, model: input.model });
        json(response, 201, {
          agent: publicAgent(store.agentForOwner(id, session.ownerDid)),
          recoveryKey: identity.privateJwk,
          recoveryNotice: "Shown once. Encrypt and store this operational agent key separately from your human DID.",
        }, headers);
        return;
      }
      const agentMatch = url.pathname.match(/^\/v1\/agents\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && agentMatch) {
        const session = authenticate(store, request);
        const existing = store.agentForOwner(agentMatch[1], session.ownerDid);
        if (!existing) throw new HttpError(404, "Agent not found.");
        const input = await body(request);
        const changes = {};
        if (input.provider !== undefined) {
          if (!validProvider(input.provider)) throw new HttpError(400, "Unsupported inference provider.");
          changes.provider = input.provider;
        }
        if (input.model !== undefined) changes.model = modelName(input.model);
        if (input.apiKey !== undefined) {
          if (typeof input.apiKey !== "string" || input.apiKey.length < 8 || input.apiKey.length > 512) throw new HttpError(400, "Invalid provider API key.");
          changes.api_key_enc = seal(config.masterKey, input.apiKey, `provider-key:${existing.id}`);
        }
        const nextPolicy = input.policy !== undefined ? normalizePolicy(input.policy) : JSON.parse(existing.policy_json);
        changes.policy_json = JSON.stringify(nextPolicy);
        if (input.enabled !== undefined) {
          if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be boolean.");
          if (input.enabled && nextPolicy.allowedRequesterDids.length === 0) throw new HttpError(400, "Add at least one trusted requester DID before enabling autonomous work.");
          changes.enabled = input.enabled ? 1 : 0;
        }
        const updated = store.updateAgent(existing.id, session.ownerDid, changes);
        store.audit("agent.updated", session.ownerDid, existing.id, { enabled: Boolean(updated.enabled), policy: nextPolicy });
        json(response, 200, { agent: publicAgent(updated) }, headers);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        const input = await body(request);
        await technocore.postEnvelope(input);
        store.audit("message.relayed", input.did, config.room, { nonce: input.nonce });
        json(response, 201, { ok: true, room: config.room, lastSeq: store.lastRoomSeq(config.room) }, headers);
        return;
      }
      throw new HttpError(404, "Route not found.");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = status >= 500 ? "Internal service error." : error.message;
      if (status >= 500) logger("error", "HTTP request failed", { requestId, error: error.message });
      json(response, status, { error: message, requestId }, headers);
    } finally {
      logger("debug", "HTTP request", { requestId, method: request.method, path: request.url, durationMs: Date.now() - started });
    }
  });

  server.on("close", () => clearInterval(sweep));
  return server;
}
