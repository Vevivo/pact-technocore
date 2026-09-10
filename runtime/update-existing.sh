#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Upgrade a flat installation, preserving keys and data. Registration changes only with an explicit flag.
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TARGET_DIR=${1:-/opt/pact}
REGISTRATION_OPTION=${2:-}
[[ -z "$REGISTRATION_OPTION" || "$REGISTRATION_OPTION" == --open-registration ]] || { echo 'Usage: update-existing.sh [target-directory] [--open-registration]'; exit 1; }
cd -- "$TARGET_DIR"
TARGET_DIR=$(pwd)
[[ "$SOURCE_DIR" != "$TARGET_DIR" ]] || { echo 'Extract the update outside the installed application directory.'; exit 1; }
[[ -f .env && -f compose.yaml && -d src && -f package.json ]] || { echo 'Existing PACT installation not found. Nothing changed.'; exit 1; }
[[ -f "$SOURCE_DIR/src/index.mjs" && -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" && -f "$SOURCE_DIR/Dockerfile" ]] || { echo 'Update package is incomplete.'; exit 1; }
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
for file in Dockerfile package-lock.json; do if [[ -f "$file" ]]; then cp -p -- "$file" "$BACKUP_DIR/$file"; fi; done
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
    for file in Dockerfile package-lock.json; do
      if [[ -f "$BACKUP_DIR/$file" ]]; then cp -p -- "$BACKUP_DIR/$file" "$file";
      elif [[ -f "$file" ]]; then mv -- "$file" "$BACKUP_DIR/failed-$file"; fi
    done
    cp -p -- "$BACKUP_DIR/runtime.env" .env
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
cp -- "$SOURCE_DIR/package-lock.json" package-lock.json
cp -- "$SOURCE_DIR/Dockerfile" Dockerfile
if [[ "$REGISTRATION_OPTION" == --open-registration ]]; then
  python3 - <<'PY'
from pathlib import Path
import re
p = Path('.env')
lines = p.read_text().splitlines()
lines = [line for line in lines if not re.match(r'^\s*(?:export\s+)?HOSTED_REGISTRATION\s*=', line)]
lines.append('HOSTED_REGISTRATION=open')
p.write_text('\n'.join(lines) + '\n')
p.chmod(0o600)
PY
fi
docker compose up -d --build pact-runtime

echo 'Checking the local runtime...'
HEALTH_OK=0
for attempt in {1..20}; do
  if curl -fsS --max-time 3 http://127.0.0.1:8793/healthz > "$BACKUP_DIR/new-health.json" &&
    python3 - "$BACKUP_DIR/new-health.json" <<'PY'
import json,sys
with open(sys.argv[1]) as f:
    data=json.load(f)
sys.exit(0 if data.get('ok') is True and data.get('version') == '0.4.0' else 1)
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
curl -fsS --max-time 10 http://127.0.0.1:8793/v1/evidence > "$BACKUP_DIR/new-evidence-health.json"
trap - ERR
echo 'PACT 0.4.0 is running. Existing keys and data were preserved.'
if [[ "$REGISTRATION_OPTION" == --open-registration ]]; then
  echo 'Public registration is enabled. Each verified DID can manage only its own agents with its own provider key.'
else
  echo 'Existing registration settings were preserved.'
fi
echo 'Publish the matching 0.4.0 pact-site folder to show the Evidence tab. Older work-board clients remain compatible.'
echo 'Evidence collection is read-only. Free-only uploads and archive room summaries require explicit operator consent in Evidence settings.'
echo "Keep this backup private: $BACKUP_DIR"
