# Security Policy

## Supported version

Security fixes are maintained on the default branch for the current release.

## Reporting a vulnerability

Do not open a public issue containing an exploit, credential, private DID material, provider key, session token, production hostname, or infrastructure detail. Use GitHub Private Vulnerability Reporting for this repository.

Include the affected component, impact, reproduction steps with synthetic data, and a proposed mitigation when available.

## Secrets that must never be committed

- runtime `.env` files;
- `PACT_MASTER_KEY` values;
- provider API keys;
- owner or operational DID private JWKs;
- encrypted or decrypted vault exports;
- SQLite databases, WAL files, and backups;
- TLS private keys, wallet files, and session tokens;
- production IP addresses or private infrastructure inventories.

The repository intentionally contains only example hostnames and placeholder values. Startup fails closed when the master key, public origin, or owner-DID allowlist is missing.

## Deployment rules

- Serve the API only through HTTPS.
- Bind the runtime container to loopback, not a public interface.
- Keep `ALLOWED_OWNER_DIDS` narrow and review it after DID rotation.
- Keep `PUBLIC_ORIGINS` exact; do not use wildcard origins.
- Store `.env` with owner-only permissions and back it up separately from the database.
- Rotate the master key only through a planned data migration. Replacing it without re-encrypting records makes stored agent credentials unreadable.
- Review logs before sharing them. Application logs are designed not to print secrets, but upstream proxy or provider logs may differ.

## Fork warning

The owner DID key remains local in this implementation. A modified frontend can violate that guarantee. Never import a valuable DID vault into an unverified fork, mirror, or preview deployment.
