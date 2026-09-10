// SPDX-License-Identifier: Apache-2.0
//
// tclk/1 settlement-rail interface: anything that can hold `amount` of `asset` under
// the contract's statement and deadlines. The rail is the source of truth for value;
// tclk frames only coordinate. `MemoryRail` is the reference implementation — the
// executable spec of the predicates a real rail (has-station escrow, x402, EVM/NEAR
// HTLC contracts) must enforce, and what the end-to-end tests drive.
import { canonicalJson } from "./frames.js";
import { verifySecret } from "./locks.js";
/** Project an accepted (or later) contract state onto its rail terms. Throws before accept. */
export function lockTerms(state) {
    if (!state.contract || !state.statement || !state.payerDid || !state.payeeDid) {
        throw new Error(`tclk: contract is not accepted yet (status ${state.status})`);
    }
    return {
        contract: state.contract,
        lock: state.offer.lock,
        statement: state.statement,
        amount: state.offer.amount,
        asset: state.offer.asset,
        payer: state.payerDid,
        payee: state.payeeDid,
        claimByMs: state.offer.claimByMs,
        refundAfterMs: state.offer.refundAfterMs,
    };
}
/**
 * In-process reference rail. Enforces exactly the predicates every real rail must:
 * one lock per contract, claim only with a verifying secret strictly before
 * refundAfterMs, refund only at/after it, and both only from the "locked" state.
 * All violations throw (fail closed).
 */
export class MemoryRail {
    id;
    locks = new Map();
    clock;
    constructor(id = "memory", clock = Date.now) {
        this.id = id;
        this.clock = clock;
    }
    async lock(terms) {
        if (this.locks.has(terms.contract)) {
            throw new Error(`tclk: rail already holds a lock for ${terms.contract}`);
        }
        if (this.clock() >= terms.refundAfterMs) {
            throw new Error("tclk: refusing to lock into an already-open refund window");
        }
        this.locks.set(terms.contract, { terms, status: "locked" });
        return terms.contract;
    }
    async verifyLock(terms, ref) {
        const held = this.locks.get(ref);
        return (held !== undefined &&
            held.status === "locked" &&
            canonicalJson(held.terms) === canonicalJson(terms));
    }
    async claim(ref, secret) {
        const held = this.requireLocked(ref, "claim");
        if (this.clock() >= held.terms.refundAfterMs) {
            throw new Error("tclk: claim after refundAfterMs");
        }
        if (!verifySecret(held.terms.lock, held.terms.statement, secret)) {
            throw new Error("tclk: secret does not open the statement");
        }
        this.locks.set(ref, { ...held, status: "claimed", secret });
    }
    async refund(ref) {
        const held = this.requireLocked(ref, "refund");
        if (this.clock() < held.terms.refundAfterMs) {
            throw new Error("tclk: refund before refundAfterMs");
        }
        this.locks.set(ref, { ...held, status: "refunded" });
    }
    /** Test/inspection helper: the rail's view of one lock. */
    status(ref) {
        return this.locks.get(ref)?.status;
    }
    requireLocked(ref, op) {
        const held = this.locks.get(ref);
        if (!held)
            throw new Error(`tclk: ${op} on an unknown lock ${ref}`);
        if (held.status !== "locked")
            throw new Error(`tclk: ${op} on a ${held.status} lock`);
        return held;
    }
}
