import { PROOF_MODES, CAPABILITIES } from "./protocol.mjs";
import { publicJwkFromDid } from "./crypto.mjs";

export const DEFAULT_POLICY = Object.freeze({
  capabilities: ["web-research"],
  allowedProofs: ["source-citations", "structured-json"],
  allowedRequesterDids: [],
  maxTasksPerDay: 3,
  maxSourcesPerTask: 3,
  maxSourceChars: 60_000,
});

export function normalizePolicy(input = {}) {
  const capabilities = Array.isArray(input.capabilities) ? [...new Set(input.capabilities)] : DEFAULT_POLICY.capabilities;
  const allowedProofs = Array.isArray(input.allowedProofs) ? [...new Set(input.allowedProofs)] : DEFAULT_POLICY.allowedProofs;
  const allowedRequesterDids = Array.isArray(input.allowedRequesterDids) ? [...new Set(input.allowedRequesterDids)] : DEFAULT_POLICY.allowedRequesterDids;
  if (!capabilities.length || capabilities.some((item) => !CAPABILITIES.has(item))) throw new Error("Unsupported agent capability policy.");
  if (!allowedProofs.length || allowedProofs.some((item) => !PROOF_MODES.has(item))) throw new Error("Unsupported proof policy.");
  if (allowedRequesterDids.length > 50) throw new Error("Requester allow-list is too large.");
  for (const did of allowedRequesterDids) {
    if (did !== "*") publicJwkFromDid(did);
  }
  const maxTasksPerDay = Number(input.maxTasksPerDay ?? DEFAULT_POLICY.maxTasksPerDay);
  const maxSourcesPerTask = Number(input.maxSourcesPerTask ?? DEFAULT_POLICY.maxSourcesPerTask);
  const maxSourceChars = Number(input.maxSourceChars ?? DEFAULT_POLICY.maxSourceChars);
  if (!Number.isInteger(maxTasksPerDay) || maxTasksPerDay < 1 || maxTasksPerDay > 25) throw new Error("maxTasksPerDay must be 1 to 25.");
  if (!Number.isInteger(maxSourcesPerTask) || maxSourcesPerTask < 1 || maxSourcesPerTask > 3) throw new Error("maxSourcesPerTask must be 1 to 3.");
  if (!Number.isInteger(maxSourceChars) || maxSourceChars < 5000 || maxSourceChars > 120_000) throw new Error("maxSourceChars must be 5000 to 120000.");
  return { capabilities, allowedProofs, allowedRequesterDids, maxTasksPerDay, maxSourcesPerTask, maxSourceChars };
}

export function policyAllows(policy, view) {
  const requesters = policy.allowedRequesterDids;
  return view.status === "open"
    && policy.capabilities.includes(view.task.capability)
    && policy.allowedProofs.includes(view.task.proof)
    && (requesters.includes("*") || requesters.includes(view.author))
    && view.task.sources.length > 0
    && view.task.sources.length <= policy.maxSourcesPerTask
    && view.task.settlement === "not-available";
}
