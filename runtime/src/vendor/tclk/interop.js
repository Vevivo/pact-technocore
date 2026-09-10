// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 interop mappings: a tclk contract is the *payment leg* of a job defined in
// another protocol, never a competing task schema. These are the total, pure mappings
// from tclk status onto the lifecycles agents already speak — the same shape
// `flopStateToA2A` gives the on-chain primitives.
/** Total mapping onto the A2A task state machine. */
export function tclkStatusToA2A(status) {
    switch (status) {
        case "proposed": return "submitted";
        case "accepted": return "submitted";
        // Funds committed, work in progress, awaiting the reveal.
        case "locked": return "working";
        case "claimed": return "completed";
        case "refunded": return "failed";
        case "cancelled": return "canceled";
    }
}
/**
 * Total mapping onto ACP phases. ACP's evaluation sits inside `locked`: the evaluator
 * accepting delivery is the payee's cue to reveal — an ACP state transition is never
 * itself treated as execution proof (same stance as the Virtuals ACP bridge).
 */
export function tclkStatusToAcpPhase(status) {
    switch (status) {
        case "proposed": return "request";
        case "accepted": return "negotiation";
        case "locked": return "transaction";
        case "claimed": return "completed";
        case "refunded": return "rejected";
        case "cancelled": return "rejected";
    }
}
/** Bind an offer to an A2A task. */
export function a2aJob(taskId, contextId) {
    return contextId === undefined
        ? { proto: "a2a", id: taskId }
        : { proto: "a2a", id: taskId, context: contextId };
}
/** Bind an offer to a Virtuals ACP job. */
export function acpJob(jobId) {
    return { proto: "acp", id: String(jobId) };
}
