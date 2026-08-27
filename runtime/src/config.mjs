import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid HTTPS origin: ${value}`);
  }
  return url.origin;
}

function requiredList(name, validate) {
  const values = (process.env[name] || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.length) throw new Error(`${name} must contain at least one value.`);
  for (const value of values) validate(value);
  return values;
}

function ownerDid(value) {
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(value)) {
    throw new Error(`Invalid owner DID in ALLOWED_OWNER_DIDS: ${value}`);
  }
}

function masterKey() {
  const value = process.env.PACT_MASTER_KEY || "";
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("PACT_MASTER_KEY must be exactly 32 random bytes encoded as base64.");
  }
  return decoded;
}

const dataDir = resolve(process.env.DATA_DIR || "./data");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });

export const config = Object.freeze({
  version: "0.2.1",
  port: integer("PORT", 8793, 1024, 65535),
  dataDir,
  databasePath: resolve(dataDir, "pact.sqlite"),
  masterKey: masterKey(),
  publicOrigins: new Set(requiredList("PUBLIC_ORIGINS", httpsOrigin).map(httpsOrigin)),
  allowedOwnerDids: new Set(requiredList("ALLOWED_OWNER_DIDS", ownerDid)),
  arnsUndername: (process.env.ARNS_UNDERNAME || "pact_example").toLowerCase(),
  technocoreBase: httpsOrigin(process.env.TECHNOCORE_BASE || "https://technocore.chat"),
  room: process.env.PACT_ROOM || "mb-pact-work-v1",
  sessionTtlMs: integer("SESSION_TTL_HOURS", 24, 1, 168) * 60 * 60 * 1000,
  agentScanMs: integer("AGENT_SCAN_SECONDS", 15, 10, 300) * 1000,
  logLevel: process.env.LOG_LEVEL || "info",
});

if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(config.room)) {
  throw new Error("PACT_ROOM is not a valid Technocore room name.");
}
