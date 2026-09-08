#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Upgrade an existing flat PACT installation. Never replace its configuration or data.
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TARGET_DIR=${1:-/opt/pact}
cd -- "$TARGET_DIR"
TARGET_DIR=$(pwd)
[[ "$SOURCE_DIR" != "$TARGET_DIR" ]] || { echo 'Extract the update outside the installed application directory.'; exit 1; }
[[ -f .env && -f compose.yaml && -d src && -f package.json ]] || { echo 'Existing PACT installation not found. Nothing changed.'; exit 1; }
[[ -f "$SOURCE_DIR/src/index.mjs" && -f "$SOURCE_DIR/package.json" ]] || { echo 'Update package is incomplete.'; exit 1; }
for command in docker curl python3 flock; do command -v "$command" >/dev/null || { echo "Missing command: $command"; exit 1; }; done
exec 9>.pact-update.lock
flock -n 9 || { echo 'Another PACT update is already running.'; exit 1; }
docker compose version >/dev/null
docker compose config --quiet
CONTAINER_ID=$(docker compose ps -q pact-runtime)
[[ -n "$CONTAINER_ID" ]] || { echo 'Start the existing pact-runtime service before updating.'; exit 1; }
[[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_ID")" == true ]] || { echo 'Existing runtime is not running.'; exit 1; }

BACKUP_DIR=$(mktemp -d "$TARGET_DIR/pact-backup-XXXXXXXX")
chmod 700 "$BACKUP_DIR"
cp -a -- src "$BACKUP_DIR/src"
cp -p -- package.json "$BACKUP_DIR/package.json"
cp -p -- .env "$BACKUP_DIR/runtime.env"
chmod 600 "$BACKUP_DIR/runtime.env"
echo 'Creating a consistent SQLite backup in the existing data volume...'
docker compose exec -T pact-runtime node src/backup.mjs

STOPPED=0
rollback() {
  local status=$?
  trap - ERR
  if [[ "$STOPPED" == 1 ]]; then
    echo 'Update failed. Restoring previous application code; keeping current database and keys.'
    # Keep the failed release for diagnosis, never delete the only copy of old code.
    if [[ -d src ]]; then mv -- src "$BACKUP_DIR/failed-src"; fi
    cp -a -- "$BACKUP_DIR/src" src
    cp -p -- "$BACKUP_DIR/package.json" package.json
    docker compose up -d --build pact-runtime || echo 'Automatic restart failed. Previous code is restored; inspect docker compose logs.'
  fi
  echo "Private backup directory: $BACKUP_DIR"
  exit "$status"
}
trap rollback ERR

echo 'Stopping only PACT. In-flight work may be interrupted; other services are unaffected.'
docker compose stop -t 45 pact-runtime
STOPPED=1
mv -- src "$BACKUP_DIR/installed-src"
cp -a -- "$SOURCE_DIR/src" src
cp -- "$SOURCE_DIR/package.json" package.json
docker compose up -d --build pact-runtime

echo 'Checking the local runtime...'
HEALTH_OK=0
for attempt in {1..20}; do
  if curl -fsS --max-time 3 http://127.0.0.1:8793/healthz > "$BACKUP_DIR/new-health.json" &&
    python3 - "$BACKUP_DIR/new-health.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f:
    data=json.load(f)
sys.exit(0 if data.get('ok') is True and data.get('version') == '0.3.0' else 1)
PY
  then HEALTH_OK=1; break; fi
  sleep 2
done
[[ "$HEALTH_OK" == 1 ]] || { echo 'The new runtime did not become healthy.'; false; }
curl -fsS --max-time 5 http://127.0.0.1:8793/v1/network-work > "$BACKUP_DIR/new-network-health.json"
python3 - "$BACKUP_DIR/new-network-health.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f:
    data=json.load(f)
assert isinstance(data.get('works'), list), 'Network endpoint has an unexpected response'
PY
trap - ERR
echo 'PACT 0.3.0 is running. Existing configuration, keys and data were preserved.'
echo 'Now publish the separate pact-site folder to ArNS. Network Mode remains off until enabled in the agent card.'
echo "Keep this backup private: $BACKUP_DIR"
