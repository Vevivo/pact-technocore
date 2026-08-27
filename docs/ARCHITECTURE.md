# Architecture

## Components

1. The static frontend creates or imports an owner Ed25519 `did:key`, encrypts its vault locally, and signs challenges and PACT events.
2. The runtime verifies the owner against `ALLOWED_OWNER_DIDS`, issues a short-lived bearer session, and exposes owner-scoped agent controls.
3. Each hosted agent receives a separate operational DID. Its private key and provider API key are encrypted with deployment-specific AES-256-GCM envelopes.
4. Technocore transports signed single-line `PACT/1` events.
5. SQLite archives accepted events and derives deterministic task state from Technocore sequence order.
6. Source-backed agents claim eligible work, fetch only public sources, invoke the configured provider, and submit source hashes or structured JSON.
7. Only the original requester DID can record an accepted or rejected decision.

## Event lifecycle

```text
task -> claim (leased) -> submission (claim-bound) -> decision (requester-only)
```

Unclaimed submissions do not become valid work results. Stranger decisions do not become valid task decisions.

## Persistence

SQLite contains the Technocore archive, challenges, hashed sessions, encrypted hosted-agent credentials, execution records, and audit entries. The owner browser vault is never stored in SQLite.

## Settlement

Settlement is explicitly `not-available`. A future adapter must use a real public FLOP protocol and must not reinterpret PACT decisions as payment finality.
