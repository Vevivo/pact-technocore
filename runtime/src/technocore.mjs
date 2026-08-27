import { decodeEvent, encodeEvent, singleLine } from "./protocol.mjs";
import { signWithJwk, verifyDidSignature } from "./crypto.mjs";

function messageValid(room, message) {
  if (!message || !Number.isSafeInteger(message.seq) || message.seq < 1) return false;
  if (typeof message.ts !== "string" || Number.isNaN(Date.parse(message.ts))) return false;
  if (typeof message.from !== "string" || !Number.isSafeInteger(message.nonce) || message.nonce < 1) return false;
  if (typeof message.text !== "string" || message.text !== singleLine(message.text)) return false;
  // Technocore verifies the signature before storing a did:key author, but its
  // read API intentionally returns the DID and nonce without returning `sig`.
  // Envelopes relayed by PACT are independently checked in postEnvelope().
  try {
    return message.from.startsWith("did:key:z") && Boolean(message.nonce);
  } catch {
    return false;
  }
}

export class TechnocoreClient {
  constructor(config, store, logger, fetchImpl = fetch) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.running = false;
    this.abort = null;
  }

  roomUrl(search = {}) {
    const url = new URL(`/r/${encodeURIComponent(this.config.room)}`, this.config.technocoreBase);
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async syncOnce({ wait = 0 } = {}) {
    const since = this.store.lastRoomSeq(this.config.room);
    const search = since > 0
      ? { format: "json", since, wait: Math.min(10, wait), limit: 200 }
      : { format: "json", limit: 200 };
    const timeout = AbortSignal.timeout((Math.max(0, wait) + 15) * 1000);
    const signal = this.abort?.signal ? AbortSignal.any([this.abort.signal, timeout]) : timeout;
    const response = await this.fetch(this.roomUrl(search), {
      headers: { accept: "application/json", "user-agent": `PACT-Runtime/${this.config.version}` },
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error(`Technocore read HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (since > 0 && Number.isSafeInteger(body.first_seq) && body.first_seq > since + 1) {
      this.store.setState("technocore_gap", JSON.stringify({ expected: since + 1, firstAvailable: body.first_seq, detectedAt: new Date().toISOString() }));
      this.logger("warn", "Technocore retention gap detected", { expected: since + 1, firstAvailable: body.first_seq });
    }
    let accepted = 0;
    for (const message of messages) {
      if (!messageValid(this.config.room, message)) continue;
      const event = decodeEvent(message.text);
      if (!event) continue;
      if (this.store.insertRoomEvent(this.config.room, message, event)) accepted += 1;
    }
    this.store.setState("technocore_last_sync", new Date().toISOString());
    return { accepted, received: messages.length, lastSeq: this.store.lastRoomSeq(this.config.room) };
  }

  async postEnvelope(envelope) {
    const { did, sig, nonce, text } = envelope || {};
    if (!Number.isSafeInteger(nonce) || nonce < 1 || typeof text !== "string" || text !== singleLine(text)) {
      throw new Error("Invalid signed message envelope.");
    }
    if (!decodeEvent(text)) throw new Error("Only valid PACT events can be relayed.");
    if (!verifyDidSignature(did, `${this.config.room}|${nonce}|${text}`, sig)) throw new Error("DID signature did not verify.");
    const response = await this.fetch(this.roomUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `PACT-Runtime/${this.config.version}` },
      body: JSON.stringify({ did, sig, nonce, text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Technocore write HTTP ${response.status}: ${body.slice(0, 300)}`);
    return body;
  }

  async publish(privateJwk, did, event) {
    const text = encodeEvent(event);
    const stateKey = `nonce:${did}:${this.config.room}`;
    const previous = Number(this.store.state(stateKey)?.value || 0);
    const nonce = Math.max(Date.now(), previous + 1);
    this.store.setState(stateKey, nonce);
    const sig = signWithJwk(privateJwk, `${this.config.room}|${nonce}|${text}`);
    await this.postEnvelope({ did, sig, nonce, text });
    return { did, sig, nonce, text };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    while (this.running) {
      try {
        await this.syncOnce({ wait: 10 });
      } catch (error) {
        if (!this.running) break;
        this.store.setState("technocore_last_error", error.message);
        this.logger("error", "Technocore sync failed", { error: error.message });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  stop() {
    this.running = false;
    this.abort?.abort();
  }
}

export { messageValid };
