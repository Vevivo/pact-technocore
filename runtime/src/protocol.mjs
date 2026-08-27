import { randomUUID } from "node:crypto";

export const PREFIX = "PACT/1 ";
export const CAPABILITIES = new Set(["web-research"]);
export const PROOF_MODES = new Set(["source-citations", "structured-json", "human-review"]);

export function singleLine(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

function iso(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function identifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(value);
}

function strings(value, maxItems, maxLength) {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => typeof item === "string" && item.length <= maxLength);
}

export function decodeEvent(text) {
  if (typeof text !== "string" || !text.startsWith(PREFIX)) return null;
  try {
    const event = JSON.parse(text.slice(PREFIX.length));
    if (event?.pact !== 1 || !identifier(event.id) || !iso(event.createdAt) || typeof event.kind !== "string") return null;
    if (event.kind === "task") {
      if (typeof event.title !== "string" || event.title.length < 4 || event.title.length > 80) return null;
      if (typeof event.brief !== "string" || event.brief.length < 20 || event.brief.length > 1200) return null;
      if (!strings(event.sources, 3, 2048) || !PROOF_MODES.has(event.proof)) return null;
      if (event.settlement !== "not-available") return null;
      if (event.capability !== undefined && !CAPABILITIES.has(event.capability)) return null;
      if (event.expiresAt !== undefined && !iso(event.expiresAt)) return null;
      return { ...event, capability: event.capability || "web-research" };
    }
    if (event.kind === "claim") {
      if (!identifier(event.taskId) || !Number.isInteger(event.leaseSeconds) || event.leaseSeconds < 60 || event.leaseSeconds > 1800) return null;
      return event;
    }
    if (event.kind === "submission") {
      if (!identifier(event.taskId) || typeof event.summary !== "string" || event.summary.length < 1 || event.summary.length > 1200) return null;
      if (!strings(event.evidence, 6, 2200) || typeof event.model !== "string" || event.model.length > 120) return null;
      if (event.claimId !== undefined && !identifier(event.claimId)) return null;
      return event;
    }
    if (event.kind === "decision") {
      if (!identifier(event.taskId) || !identifier(event.submissionId) || !["accepted", "rejected"].includes(event.verdict)) return null;
      return event;
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeEvent(event) {
  const decoded = decodeEvent(`${PREFIX}${JSON.stringify(event)}`);
  if (!decoded) throw new Error("Invalid PACT event.");
  const text = singleLine(`${PREFIX}${JSON.stringify(decoded)}`);
  if (text.length > 4096) throw new Error("PACT event exceeds the Technocore message limit.");
  return text;
}

export function newEvent(kind, fields) {
  return { pact: 1, kind, id: randomUUID(), createdAt: new Date().toISOString(), ...fields };
}
