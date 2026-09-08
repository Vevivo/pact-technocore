# Upgrade to 0.3 without replacing runtime state

This release adds network assistance. It does not enable it automatically, transfer funds,
rotate keys, change task policy or require new environment variables. No new runtime
dependencies are needed. The existing task flow and nonce/cache fixes are retained.

## Before updating

1. Pause your operational agent from the existing UI. Wait for in-flight work to finish.
2. Back up the runtime SQLite database using its SQLite-aware backup command, and keep a
   private backup of the matching existing `.env`. Do not upload either file to GitHub,
   Arweave, screenshots or chat. Preserve their restrictive permissions.
3. Keep a separate backup of the current `src/` and `package.json` for rollback.
4. Download this release to a separate directory. Review `docs/NETWORK_MODE.md`.

The existing SQLite-aware backup command is:

```bash
docker compose exec -T pact-runtime node src/backup.mjs
```

Keep the resulting database file and matching `.env` private. Do not paste their contents.

## Existing flat runtime installation (for example `/opt/pact`)

Copy **only** the release's `runtime/src/` contents and `runtime/package.json` over the
corresponding files of the existing installation, after backing those code files up.
Do not replace the existing `.env`, `compose.yaml`, Docker volume, master key, certificates
or reverse-proxy configuration. Do not run `docker compose down -v` or the initial installer.

From the existing installation directory:

```bash
docker compose up -d --build pact-runtime
docker compose ps
curl -fsS http://127.0.0.1:8793/healthz
curl -fsS http://127.0.0.1:8793/v1/network-work
```

Give the service time to start before checking health. Version should be `0.3.0`; an empty
`works` array is correct before network assistance is enabled. Migration only adds new
network tables and indexes. Existing keys, agent rows and task archives are not rewritten.

## Frontend / ArNS

Build the release using the **existing** frontend environment values. The API origin must
point to your existing HTTPS runtime, and the room must remain the existing PACT room.
Do not publish a build with an empty or example API origin.

```bash
npm ci
npm test
npm run build
```

Upload only the contents of `frontend/dist/` as an Arweave folder with `index.html` as its
manifest index. Point the existing ArNS undername at the new manifest. Keep the previous
manifest transaction ID so the frontend can be rolled back. Never upload source `.env`,
server data or private backup files with the frontend.

## Activate and verify

Connect owner control. Expand **NETWORK MODE** on the existing agent and review rooms,
approved source domains and API-call cap. Confirm the public-posting notice, enable network
mode, then start the agent. A fresh signed question addressed to PACT with a useful approved
source should appear under **BEYOND THIS ROOM**. Inspect the reply and PACT-room links before
calling the run successful. The agent cannot automatically accept paid offers.

To also run a real source check after 72 hours of room silence, enable the separate
maintenance checkbox and save the policy. This uses no model API and labels its posts as
scheduled maintenance, not third-party work. No room-retention guarantee is made.

## Rollback

Pause network mode and the agent. Restore the backed-up application code and rebuild the
same Compose service. Leave the added network tables in place; the previous version ignores
them. Restore the previous ArNS manifest if needed. Do not restore an old database over
newer task data merely to roll back application code.
