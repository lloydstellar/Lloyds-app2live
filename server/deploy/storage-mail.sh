#!/usr/bin/env bash
# Sends an e-mail when la2l-server warns that its storage fills up: the log line "WARNING storage",
# which the server writes at most once an hour while the packages take more than
# STORAGE_WARN_PERCENT of MAX_TOTAL_STORAGE_MB (src/storage-watch.js). The mail goes out through
# the sendmail of the VPS itself.
#
#   bash deploy/storage-mail.sh            look at the log of the last 20 minutes, mail a warning
#   bash deploy/storage-mail.sh --test     send a test mail, to see that mail arrives
#   bash deploy/storage-mail.sh --dry-run  print the mail it would send, and send nothing
#
# Run it from cron every 15 minutes, so every warning is seen once:
#   */15 * * * * bash $HOME/la2l-server/server/deploy/storage-mail.sh >> $HOME/la2l-server-logs/storage-mail.log 2>&1
# The address is not in the repository: it is the first line of ~/.config/la2l/alert-email
# (LA2L_ALERT_FILE to choose another file).

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run this script with bash: bash deploy/storage-mail.sh" >&2
  exit 1
fi

set -euo pipefail

CONTAINER="${LA2L_CONTAINER:-la2l-server}"
ADDRESS_FILE="${LA2L_ALERT_FILE:-$HOME/.config/la2l/alert-email}"
STATE="${LA2L_ALERT_STATE:-$HOME/.config/la2l/alert-last}"
SENDMAIL="${LA2L_SENDMAIL:-/usr/sbin/sendmail}"

mode="check"
case "${1:-}" in
  "") ;;
  --test) mode="test" ;;
  --dry-run) mode="dry" ;;
  *)
    echo "Unknown option $1. Use --test or --dry-run, or nothing." >&2
    exit 2
    ;;
esac

if [ ! -r "$ADDRESS_FILE" ]; then
  echo "No address: put it on the first line of $ADDRESS_FILE." >&2
  exit 1
fi
address="$(head -n 1 "$ADDRESS_FILE" | tr -d '[:space:]')"
if ! [[ "$address" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "The first line of $ADDRESS_FILE is not an e-mail address." >&2
  exit 1
fi

# The mail as sendmail -t reads it: the headers, an empty line, the text.
mail() {
  printf 'To: %s\nSubject: %s\nContent-Type: text/plain; charset=utf-8\n\n%s\n' "$address" "$1" "$2"
}

send() {
  if [ "$mode" = dry ]; then
    mail "$1" "$2"
    return
  fi
  mail "$1" "$2" | "$SENDMAIL" -t
}

if [ "$mode" = test ]; then
  send "LA2L: test of the storage warning" "This is a test from deploy/storage-mail.sh on $(hostname). When the packages on la2l-server take most of their room, a mail like this says so."
  echo "$(date -u +%FT%TZ) test mail sent"
  exit 0
fi

# The warnings of the last 20 minutes. The cron runs every 15, so a warning is seen once or
# twice; the last one sent is kept, so twice still means one mail.
lines="$(docker logs --since 20m "$CONTAINER" 2>&1 | grep 'WARNING storage' || true)"
[ -n "$lines" ] || exit 0
last="$(tail -n 1 <<<"$lines")"
if [ "$mode" != dry ] && [ -f "$STATE" ] && [ "$(cat "$STATE")" = "$last" ]; then
  exit 0
fi
send "LA2L: the storage of the server fills up" "$last

New packages are refused at the limit. What to do: server/README.md of the LA2L repository, under troubleshooting."
if [ "$mode" != dry ]; then
  (umask 077 && mkdir -p "$(dirname "$STATE")" && printf '%s\n' "$last" >"$STATE")
  echo "$(date -u +%FT%TZ) storage warning mailed"
fi
