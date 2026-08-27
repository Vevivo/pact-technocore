export type ProofMode = "source-citations" | "structured-json" | "human-review";
export type PactTask = { pact: 1; kind: "task"; id: string; createdAt: string; title: string; brief: string; sources: string[]; proof: ProofMode; capability: "web-research"; settlement: "not-available"; expiresAt?: string };
export type PactClaim = { pact: 1; kind: "claim"; id: string; taskId: string; createdAt: string; leaseSeconds: number };
export type PactSubmission = { pact: 1; kind: "submission"; id: string; taskId: string; claimId?: string; createdAt: string; summary: string; evidence: string[]; model: string };
export type PactDecision = { pact: 1; kind: "decision"; id: string; taskId: string; submissionId: string; createdAt: string; verdict: "accepted" | "rejected" };
export type PactEvent = PactTask | PactClaim | PactSubmission | PactDecision;
const PREFIX = "PACT/1 ";

export function sweepSingleLine(value: string) { return value.replace(/[\p{Cc}\p{Cf}]/gu, " "); }
export function encodePactMessage(event: PactEvent) {
  const encoded = `${PREFIX}${JSON.stringify(event)}`;
  if (encoded.length > 4096) throw new Error("PACT message exceeds Technocore's 4096 character limit.");
  return sweepSingleLine(encoded);
}
export function decodePactMessage(text: string): PactEvent | null {
  if (!text.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(PREFIX.length)) as Partial<PactEvent>;
    if (parsed.pact !== 1 || typeof parsed.kind !== "string" || typeof parsed.id !== "string") return null;
    if (parsed.kind === "task") {
      if (
        typeof parsed.title !== "string" || parsed.title.length > 80 ||
        typeof parsed.brief !== "string" || parsed.brief.length > 1200 ||
        !Array.isArray(parsed.sources) || parsed.sources.length > 3 || parsed.sources.some((item) => typeof item !== "string" || item.length > 2048) ||
        !["source-citations", "structured-json", "human-review"].includes(String(parsed.proof)) ||
        (parsed.capability !== undefined && parsed.capability !== "web-research") ||
        parsed.settlement !== "not-available"
      ) return null;
      return { ...parsed, capability: parsed.capability ?? "web-research" } as PactTask;
    }
    if (parsed.kind === "claim") {
      if (typeof parsed.taskId !== "string" || !Number.isInteger(parsed.leaseSeconds) || Number(parsed.leaseSeconds) < 60 || Number(parsed.leaseSeconds) > 1800) return null;
      return parsed as PactClaim;
    }
    if (parsed.kind === "submission") {
      if (typeof parsed.taskId !== "string" || typeof parsed.summary !== "string" || parsed.summary.length > 1200 || !Array.isArray(parsed.evidence) || parsed.evidence.length > 6 || parsed.evidence.some((item) => typeof item !== "string" || item.length > 2200)) return null;
      return parsed as PactSubmission;
    }
    if (parsed.kind === "decision") {
      if (typeof parsed.taskId !== "string" || typeof parsed.submissionId !== "string" || !["accepted", "rejected"].includes(String(parsed.verdict))) return null;
      return parsed as PactDecision;
    }
    return null;
  } catch { return null; }
}
