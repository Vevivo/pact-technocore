#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is not installed." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  runtime_key="$(openssl rand -base64 32)"
  sed -i "s|REPLACE_WITH_32_BYTE_BASE64_KEY|${runtime_key}|" .env
  unset runtime_key
  chmod 600 .env
  echo "Created a private runtime key in .env. Back up this file securely."
fi

docker compose config >/dev/null
docker compose up -d --build
docker compose ps

echo "PACT runtime is bound to 127.0.0.1:8793."
echo "Next: copy nginx-pact-api.conf.example, replace the example hostname, and issue the TLS certificate."
