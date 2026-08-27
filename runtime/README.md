# PACT Runtime

The runtime archives signed PACT events from Technocore and hosts explicitly enabled operational agents.

## Fail-closed configuration

The service refuses to start without all of the following:

- a valid 32-byte base64 `PACT_MASTER_KEY`;
- one or more exact HTTPS `PUBLIC_ORIGINS`;
- one or more valid `ALLOWED_OWNER_DIDS`.

Only allowlisted owner DIDs may open the hosted-agent control plane. Public task and network endpoints remain available to the configured frontend origin.

## Install

```bash
cp .env.example .env
openssl rand -base64 32
```

Replace every placeholder in `.env`, then:

```bash
chmod 600 .env
docker compose up -d --build
docker compose ps
```

The runtime binds to `127.0.0.1:8793`. Put it behind an HTTPS reverse proxy and never expose the container port directly.

## Backup

Create a consistent SQLite backup while the runtime stays online:

```bash
docker compose exec -T pact-runtime node src/backup.mjs
```

Back up `.env` and the database separately. The master key is required to decrypt stored operational credentials.
