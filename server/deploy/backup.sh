#!/usr/bin/env bash
# Makes a copy of the database of la2l-server in ~/la2l-server-backups (LA2L_BACKUP_DIR to choose
# another folder) and keeps the newest 30 copies.
#
#   bash deploy/backup.sh            (in server/; deploy/update.sh runs it before every update)
#
# The database is what must survive: the paired computers and apps, and the results the apps
# read. The WAV files are not in a backup: they wait 24 hours at most, and an app can send them
# again. During a pairing the database also holds the device token it hands out, so a backup is
# as private as the server itself: it stays on the VPS, in a folder only you can read.
#
# The copy is made by deploy/copy-db.js in a short-lived container of the server's image, with
# the server's volume, so it works whether the server runs, is stopped, or keeps restarting.
# deploy/restore.sh puts a backup back.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run this script with bash: bash deploy/backup.sh" >&2
  exit 1
fi

set -euo pipefail
umask 077

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="${LA2L_CONTAINER:-la2l-server}"
BACKUPS="${LA2L_BACKUP_DIR:-$HOME/la2l-server-backups}"
KEEP=30

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "There is no container $CONTAINER, so there is no database to back up." >&2
  exit 1
fi
volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")
# The image of the container. With Docker's containerd image store, a rebuild that changes
# nothing gives the tag a new image and drops the old one, while the container keeps running from
# it; the container's image id then no longer exists. Then the image it was started as is used,
# such as la2l-server:local.
image=$(docker inspect -f '{{.Image}}' "$CONTAINER")
if ! docker image inspect "$image" >/dev/null 2>&1; then
  image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
fi
if [ -z "$volume" ]; then
  echo "The container $CONTAINER has no volume at /data." >&2
  exit 1
fi

mkdir -p "$BACKUPS" # with umask 077 a new folder is readable by you only; an existing one is left as it is
name="la2l-$(date -u +%Y%m%d-%H%M%S).db"
part="$BACKUPS/.$name.part"
trap 'rm -f "$part"' EXIT

docker run --rm -i --network none --read-only --tmpfs /tmp --cap-drop ALL -v "$volume:/data" \
  --entrypoint node "$image" --disable-warning=ExperimentalWarning - <"$DEPLOY/copy-db.js" >"$part"

if [ "$(head -c 15 "$part")" != "SQLite format 3" ]; then
  echo "The backup is not a database. Nothing was saved." >&2
  exit 1
fi
mv "$part" "$BACKUPS/$name"
echo "Saved a backup of the database: $BACKUPS/$name ($(du -h "$BACKUPS/$name" | cut -f1))"

# Only the newest $KEEP backups stay.
find "$BACKUPS" -maxdepth 1 -name 'la2l-*.db' -type f -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2- | xargs -r -d '\n' rm -f
