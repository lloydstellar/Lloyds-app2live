#!/usr/bin/env bash
# Builds and starts la2l-server with the code that is checked out now, on the VPS.
#
#   bash deploy/update.sh            (in server/, after "git pull")
#
# A new build means a new container, and Docker throws the log of the old one away. So this
# script saves that log first, in ~/la2l-server-logs (LA2L_LOG_DIR to choose another folder),
# and keeps the last 30 saved logs. The logs hold IP addresses: they stay on the VPS, outside
# the repository. Then it waits until the new server answers its health check.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run this script with bash: bash deploy/update.sh" >&2
  exit 1
fi

set -euo pipefail

cd "$(dirname "$0")/.."
LOGS="${LA2L_LOG_DIR:-$HOME/la2l-server-logs}"
KEEP=30

if docker inspect la2l-server >/dev/null 2>&1; then
  mkdir -p "$LOGS"
  chmod 700 "$LOGS"
  saved="$LOGS/la2l-server-$(date -u +%Y%m%d-%H%M%S).log"
  docker logs la2l-server >"$saved" 2>&1
  chmod 600 "$saved"
  echo "Saved the log of the running server: $saved ($(wc -l <"$saved") lines)"
  # Only the newest $KEEP saved logs stay.
  find "$LOGS" -maxdepth 1 -name 'la2l-server-*.log' -type f -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | xargs -r rm -f
fi

docker compose up -d --build

printf 'Waiting for the health check'
status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' la2l-server 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  printf '.'
  sleep 2
done
echo
if [ "$status" != healthy ]; then
  echo "The server is not healthy ($status). The last lines of its log:" >&2
  docker logs --tail 30 la2l-server >&2
  exit 1
fi

docker logs la2l-server 2>&1 | grep -E ' (listening on|state:|cleanup:)' | tail -n 3
port=$(docker port la2l-server 8787/tcp | head -n 1)
curl -fsS "http://${port}/api/health"
echo
