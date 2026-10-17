#!/usr/bin/env bash
# Puts a backup made by deploy/backup.sh back as the database of la2l-server.
#
#   bash deploy/restore.sh ~/la2l-server-backups/la2l-20261017-031700.db
#
# First it checks the backup (deploy/check-db.js) and asks (--yes skips the question). Then it
# stops the server, backs up the database as it is now, so this restore can be undone the same
# way, puts the backup in place and starts the server again. It works whether the server runs,
# is stopped or keeps restarting. When something fails before the database is replaced, the
# server starts again with its own database.
#
# What happened after the backup is lost: a computer or app that paired since then must pair
# again, and a waiting package whose files are gone counts as expired.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run this script with bash: bash deploy/restore.sh <backup>" >&2
  exit 1
fi

set -euo pipefail
umask 077

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="${LA2L_CONTAINER:-la2l-server}"
BACKUPS="${LA2L_BACKUP_DIR:-$HOME/la2l-server-backups}"

yes=0
file=""
for arg in "$@"; do
  case "$arg" in
    --yes) yes=1 ;;
    -*)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
    *) file="$arg" ;;
  esac
done
if [ -z "$file" ]; then
  echo "Which backup? bash deploy/restore.sh <file>. The newest in $BACKUPS:" >&2
  find "$BACKUPS" -maxdepth 1 -name 'la2l-*.db' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 5 | cut -d' ' -f2- >&2
  exit 1
fi
if [ ! -f "$file" ]; then
  echo "There is no file $file." >&2
  exit 1
fi
file=$(realpath -- "$file")
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "There is no container $CONTAINER. Start the server once with bash deploy/update.sh, then restore." >&2
  exit 1
fi
volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")
# The image of the container. With Docker's containerd image store, a rebuild that changes
# nothing gives the tag a new image and drops the old one, while the container keeps running from
# it; the container's image id then no longer exists. Then the image it was started as is used,
# such as la2l-server:local. The check then uses the code of that tag, which is the code the container runs as long as the rebuild changed nothing.
image=$(docker inspect -f '{{.Image}}' "$CONTAINER")
if ! docker image inspect "$image" >/dev/null 2>&1; then
  image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
fi
if [ -z "$volume" ]; then
  echo "The container $CONTAINER has no volume at /data." >&2
  exit 1
fi
# Every helper container gets the backup on stdin, so it needs no access to files on this machine.
helper() {
  docker run --rm -i --network none --read-only --tmpfs /tmp --cap-drop ALL "$@"
}

# 1. Check the backup, with the code of the server that will open it.
if ! summary=$(helper --entrypoint node "$image" --disable-warning=ExperimentalWarning -e "$(cat "$DEPLOY/check-db.js")" <"$file"); then
  echo "$file cannot be restored. Nothing changed." >&2
  exit 1
fi
echo "The backup: $summary."
if [ "$yes" != 1 ]; then
  read -r -p "It replaces the database of $CONTAINER. Type yes to go on: " answer
  if [ "$answer" != yes ]; then
    echo "Nothing changed."
    exit 1
  fi
fi

# A copy of the chosen backup: the backup below keeps only the newest 30 and could otherwise
# delete the very file that is to be restored.
restore=$(mktemp)
cp "$file" "$restore"
stopped=0
replaced=0
undo=""
finish() {
  rm -f "$restore"
  if [ "$stopped" = 1 ] && [ "$replaced" = 0 ]; then
    echo "The database was not replaced. Starting the server again with its own database." >&2
    docker start "$CONTAINER" >/dev/null || true
  fi
}
trap finish EXIT
kept=""
undo_hint() {
  if [ -n "$undo" ]; then
    echo "To undo: bash deploy/restore.sh $(printf '%q' "$undo")"
  elif [ -n "$kept" ]; then
    echo "The old database is kept in the volume as la2l.db.before-restore."
  fi
}

# 2. Stop the server, then back up its database as it is now.
docker stop "$CONTAINER" >/dev/null
stopped=1
keep=0
if LA2L_CONTAINER="$CONTAINER" LA2L_BACKUP_DIR="$BACKUPS" bash "$DEPLOY/backup.sh"; then
  undo=$(find "$BACKUPS" -maxdepth 1 -name 'la2l-*.db' -type f -printf '%T@ %p\n' | sort -rn | head -n 1 | cut -d' ' -f2-)
else
  echo "There is no backup of the database as it is now, so its files are kept in the volume." >&2
  keep=1
fi

# 3. Put the backup in place. The WAL files belong to the old database: next to the restored one
# they would damage it, so they go (after a copy, when there is no backup of it).
# shellcheck disable=SC2016 # the script runs in the helper's sh, which expands $1 there
kept=$(helper --user node -v "$volume:/data" --entrypoint sh "$image" -c '
  set -e
  cat >/data/la2l.db.restore
  if [ "$1" = 1 ] && [ -e /data/la2l.db ]; then
    rm -f /data/la2l.db.before-restore /data/la2l.db.before-restore-wal
    cp -p /data/la2l.db /data/la2l.db.before-restore
    [ ! -e /data/la2l.db-wal ] || cp -p /data/la2l.db-wal /data/la2l.db.before-restore-wal
    echo kept
  fi
  rm -f /data/la2l.db-wal /data/la2l.db-shm
  mv /data/la2l.db.restore /data/la2l.db
' restore "$keep" <"$restore")
replaced=1

# 4. Start the server and wait for its health check. A server that stops at once (for example
# because of a setting) shows as exited or restarting.
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! docker start "$CONTAINER" >/dev/null; then
  echo "The database was replaced, but the container did not start." >&2
  undo_hint >&2
  exit 1
fi
# docker start sets the count back to 0; it goes up when the server stops and Docker restarts it.
restarts=$(docker inspect -f '{{.RestartCount}}' "$CONTAINER")
printf 'Waiting for the health check'
status=starting
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  state=$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo missing)
  case "$state" in
    exited* | dead* | restarting* | missing) break ;;
  esac
  [ "${state#* }" = "$restarts" ] || break
  printf '.'
  sleep 2
done
echo
if [ "$status" != healthy ]; then
  echo "The server does not start with this database. The last lines of its log:" >&2
  docker logs --tail 20 "$CONTAINER" >&2
  undo_hint >&2
  exit 1
fi

docker logs --since "$since" "$CONTAINER" 2>&1 | grep -E ' (state|cleanup):' || true
echo "Restored $file."
undo_hint
