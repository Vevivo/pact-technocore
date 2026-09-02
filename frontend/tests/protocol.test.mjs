import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } });
after(async () => vite.close());

test("PACT/1 task messages round-trip as a single line", async () => {
  const { encodePactMessage, decodePactMessage } = await vite.ssrLoadModule("/src/protocol.ts");
  const task = { pact: 1, kind: "task", id: "task-1", createdAt: "2026-08-26T00:00:00Z", title: "Inspect a source", brief: "Return only findings supported by the supplied source.", sources: ["https://example.com"], proof: "source-citations", capability: "web-research", settlement: "not-available" };
  const encoded = encodePactMessage(task);
  assert.match(encoded, /^PACT\/1 /);
  assert.doesNotMatch(encoded, /[\r\n]/);
  assert.deepEqual(decodePactMessage(encoded), task);
});

test("claim leases are explicit and bounded", async () => {
  const { encodePactMessage, decodePactMessage } = await vite.ssrLoadModule("/src/protocol.ts");
  const claim = { pact: 1, kind: "claim", id: "claim-123", taskId: "task-1234", createdAt: "2026-08-26T00:00:00Z", leaseSeconds: 600 };
  assert.deepEqual(decodePactMessage(encodePactMessage(claim)), claim);
  assert.equal(decodePactMessage(`PACT/1 ${JSON.stringify({ ...claim, leaseSeconds: 59 })}`), null);
});

test("rejects malformed or imaginary-settlement messages", async () => {
  const { decodePactMessage } = await vite.ssrLoadModule("/src/protocol.ts");
  assert.equal(decodePactMessage("hello"), null);
  assert.equal(decodePactMessage('PACT/1 {"pact":1,"kind":"task","id":"x","title":"x","brief":"x","sources":[],"proof":"human-review","settlement":"flop"}'), null);
});

test("the interface declares reduced-motion behavior", async () => {
  const css = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/styles.css", import.meta.url), "utf8"));
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test("the task composer exposes relay progress and an inline failure state", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, css] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /01 SIGN/);
  assert.match(app, /02 RELAY/);
  assert.match(app, /03 CONFIRM/);
  assert.match(app, /Relay confirmation timed out/);
  assert.match(css, /composer-status\.relay-error/);
  assert.doesNotMatch(app, /<fieldset className="proof-choices/);
});

test("signed Technocore envelopes serialize nonce as a digit string", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, identity] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/identity.ts", import.meta.url), "utf8"),
  ]);
  assert.match(app, /const nextNonce = \(\) => String\(/);
  assert.match(identity, /nonce: string/);
});
