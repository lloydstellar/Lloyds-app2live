#!/usr/bin/env bash
# Puts LA2L into nginx, or updates it after nginx-la2l.conf changed. Afterwards
# https://<domain>/la2l/ goes to the la2l-server container on 127.0.0.1:8787.
#
#   bash install-nginx.sh --check         shows what it would change; needs no sudo
#   sudo bash install-nginx.sh            installs LA2L, or updates the snippet
#   sudo bash install-nginx.sh --remove   takes LA2L out of nginx again
#   --domain example.org                  for another domain than lloydstellar.nl
#
# It copies nginx-la2l.conf to /etc/nginx/snippets/la2l.conf and adds an include line right
# after the server_name line of the server block that listens on 443 for the domain. The site
# file is backed up first. nginx is reloaded only when "nginx -t" passes; when it fails,
# everything is put back as it was. Running it again changes nothing.
#
# For the Debian and Ubuntu layout: the sites nginx loads are in /etc/nginx/sites-enabled and
# /etc/nginx/conf.d. A control panel (Plesk, cPanel, DirectAdmin, HestiaCP) has its own place
# for extra directives; use that instead of this script.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run this with bash: sudo bash $0" >&2
  exit 2
fi
set -euo pipefail

DOMAIN=lloydstellar.nl
MODE=install
ARGS="$*"
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --remove) MODE=remove ;;
    --domain)
      DOMAIN=${2:-}
      [ -n "$DOMAIN" ] || { echo "--domain needs a name." >&2; exit 2; }
      shift
      ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) echo "Unknown option: $1. See --help." >&2; exit 2 ;;
  esac
  shift
done

SELF=$(readlink -f "${BASH_SOURCE[0]}")
HERE=$(dirname "$SELF")
SOURCE=$HERE/nginx-la2l.conf
SNIPPET=/etc/nginx/snippets/la2l.conf
COMMENT='# LA2L: /la2l/ goes to the la2l-server container (server/deploy/install-nginx.sh).'
INCLUDE='include snippets/la2l.conf;'
# The include line, also when someone wrote it with the full path.
INCLUDE_RE='^[[:space:]]*include[[:space:]]+(/etc/nginx/)?snippets/la2l\.conf;[[:space:]]*$'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say() { printf '%s\n' "$*"; }
stop() {
  printf 'Stopped: %s\n' "$*" >&2
  exit 1
}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then stop "this needs root. Run: sudo bash $SELF${ARGS:+ $ARGS}"; fi
}

# The server_name line of every server block that listens on 443 for $DOMAIN, as "file:line".
# A block runs from its "server {" line to the next one.
find_targets() {
  local f
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
    [ -f "$f" ] || continue
    awk -v domain="$DOMAIN" -v file="$f" '
      function end_block() { if (tls && at) print file ":" at; tls = 0; at = 0 }
      { line = $0; sub(/#.*/, "", line) }
      line ~ /^[ \t]*server[ \t]*\{/ { end_block() }
      line ~ /^[ \t]*listen[ \t]/ && line ~ /[ \t:]443([ \t;]|$)/ { tls = 1 }
      line ~ /^[ \t]*server_name[ \t]/ {
        n = split(line, word, /[ \t;]+/)
        for (i = 2; i <= n; i++) if (word[i] == domain) at = NR
      }
      END { end_block() }
    ' "$f"
  done
}

has_include() { grep -Eq "$INCLUDE_RE" "$1"; }

# File $1 with the comment and the include line after line $2, indented like that line.
with_include() {
  awk -v at="$2" -v comment="$COMMENT" -v line="$INCLUDE" '
    { print }
    NR == at { match($0, /^[ \t]*/); pad = substr($0, 1, RLENGTH); print pad comment; print pad line }
  ' "$1"
}

# File $1 without the comment and the include line.
without_include() {
  awk -v comment="$COMMENT" '
    { t = $0; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t) }
    t == comment { next }
    t ~ /^include[ \t]+(\/etc\/nginx\/)?snippets\/la2l\.conf;$/ { next }
    { print }
  ' "$1"
}

# Puts the content of $1 in place of $2 in one step (a rename in the same folder), with the
# owner and mode $2 had. A half-written file never takes the place of a good one.
replace_file() {
  local tmp
  tmp=$(mktemp "$(dirname "$2")/.la2l-XXXXXX")
  if ! cat "$1" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if [ -e "$2" ]; then
    chown --reference="$2" "$tmp"
    chmod --reference="$2" "$tmp"
  else
    chmod 644 "$tmp"
  fi
  mv -f "$tmp" "$2"
}

# Where the backup of $1 goes: next to it, as Debian keeps old configs in sites-available.
# Not in sites-enabled: nginx loads every file there, so a backup would become a second site.
backup_path() {
  local dir
  dir=$(dirname "$1")
  if [ "$dir" = /etc/nginx/sites-enabled ]; then dir=/var/backups; fi
  printf '%s/%s.bak-%s-la2l' "$dir" "$(basename "$1")" "$(date +%Y%m%d-%H%M%S)"
}

nginx_ok() { nginx -t >"$TMP/nginx-t.txt" 2>&1; }

reload_nginx() {
  if [ -d /run/systemd/system ]; then systemctl reload nginx; else nginx -s reload; fi
  sleep 2 # the old workers finish their requests first
}

http_status() {
  if command -v curl >/dev/null; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" || true
  else
    echo "unknown (no curl)"
  fi
}

report_la2l() {
  local url="https://$DOMAIN/la2l/api/health" status
  if ! command -v curl >/dev/null; then return 0; fi
  status=$(curl -s -o "$TMP/health" -w '%{http_code}' --max-time 15 "$url" || true)
  if [ "$status" = 200 ] && grep -q '"ok": *true' "$TMP/health"; then
    say "LA2L: $url answers $(head -c 200 "$TMP/health")"
  elif [ "$status" = 502 ] || [ "$status" = 504 ]; then
    say "LA2L: nginx is ready, but the la2l-server container does not answer yet ($status)."
    say "      Start it: cd $(dirname "$HERE") && docker compose up -d --build"
  else
    say "LA2L: $url answers $status."
  fi
}

check() {
  say "Server block for $DOMAIN on port 443: $SITE, line $LINE."
  if has_include "$SITE"; then
    say "The include line is there."
  else
    say "These lines would be added:"
    with_include "$SITE" "$LINE" >"$TMP/site"
    diff -u --label "$SITE" --label "$SITE (with LA2L)" "$SITE" "$TMP/site" || true
  fi
  if [ ! -f "$SNIPPET" ]; then
    say "$SNIPPET would be made from $SOURCE."
  elif cmp -s "$SOURCE" "$SNIPPET"; then
    say "$SNIPPET is up to date."
  else
    say "$SNIPPET would change:"
    diff -u "$SNIPPET" "$SOURCE" || true
  fi
  report_la2l
  if has_include "$SITE" && cmp -s "$SOURCE" "$SNIPPET" 2>/dev/null; then
    say "Nothing to do."
  else
    say "To do it: sudo bash $SELF"
  fi
}

install_la2l() {
  need_root
  [ -f "$SOURCE" ] || stop "$SOURCE is missing."
  if ! nginx_ok; then
    cat "$TMP/nginx-t.txt" >&2
    stop "nginx -t fails before any change. Fix that first; nothing was changed."
  fi

  local add_include=1 new_snippet=1 had_snippet=0 backup="" before after
  if has_include "$SITE"; then add_include=0; fi
  if cmp -s "$SOURCE" "$SNIPPET" 2>/dev/null; then new_snippet=0; fi
  if [ $add_include = 0 ] && [ $new_snippet = 0 ]; then
    say "Nothing to do: $SITE includes $SNIPPET, and that is up to date."
    report_la2l
    return 0
  fi
  before=$(http_status "https://$DOMAIN/")

  # The snippet goes first: until the include line is there, nginx does not read it.
  if [ -f "$SNIPPET" ]; then
    cp -p "$SNIPPET" "$TMP/old-snippet"
    had_snippet=1
  fi
  replace_file "$SOURCE" "$SNIPPET"
  if [ $add_include = 1 ]; then
    backup=$(backup_path "$SITE")
    cp -p "$SITE" "$backup"
    with_include "$SITE" "$LINE" >"$TMP/site"
    replace_file "$TMP/site" "$SITE"
  fi

  if ! nginx_ok; then
    if [ -n "$backup" ]; then replace_file "$backup" "$SITE"; fi
    if [ $had_snippet = 1 ]; then replace_file "$TMP/old-snippet" "$SNIPPET"; else rm -f "$SNIPPET"; fi
    cat "$TMP/nginx-t.txt" >&2
    if nginx_ok; then stop "nginx -t failed with the LA2L lines. Everything is back as it was, and nginx was not reloaded."; fi
    stop "nginx -t failed, and still fails with the old files back. Check by hand: sudo nginx -t"
  fi
  reload_nginx || stop "nginx -t passed, but the reload failed. Check: sudo systemctl status nginx"

  if [ -n "$backup" ]; then
    say "Backup of the site file: $backup"
    say "Added to $SITE:"
    diff -u "$backup" "$SITE" | sed -n '3,$p' || true
  fi
  if [ $new_snippet = 1 ]; then
    if [ $had_snippet = 1 ]; then say "Updated $SNIPPET."; else say "Installed $SNIPPET."; fi
  fi
  say "nginx -t passed and nginx was reloaded."
  after=$(http_status "https://$DOMAIN/")
  if [ "$after" = "$before" ]; then
    say "Website: https://$DOMAIN/ answers $after, as before."
  else
    say "WARNING: https://$DOMAIN/ answered $before before and $after now."
    say "         To take LA2L out again: sudo bash $SELF --remove"
  fi
  report_la2l
}

remove_la2l() {
  need_root
  if ! nginx_ok; then
    cat "$TMP/nginx-t.txt" >&2
    stop "nginx -t fails before any change. Fix that first; nothing was changed."
  fi

  local backup="" had_snippet=0
  if has_include "$SITE"; then
    backup=$(backup_path "$SITE")
    cp -p "$SITE" "$backup"
    without_include "$SITE" >"$TMP/site"
    replace_file "$TMP/site" "$SITE"
  fi
  # The snippet goes too, unless another file still includes it.
  if [ -f "$SNIPPET" ] && ! grep -Eqs "$INCLUDE_RE" /etc/nginx/nginx.conf /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; then
    cp -p "$SNIPPET" "$TMP/old-snippet"
    had_snippet=1
    rm -f "$SNIPPET"
  fi
  if [ -z "$backup" ] && [ $had_snippet = 0 ]; then
    say "Nothing to remove: LA2L is not in nginx."
    return 0
  fi

  if ! nginx_ok; then
    if [ -n "$backup" ]; then replace_file "$backup" "$SITE"; fi
    if [ $had_snippet = 1 ]; then replace_file "$TMP/old-snippet" "$SNIPPET"; fi
    cat "$TMP/nginx-t.txt" >&2
    stop "nginx -t failed without the LA2L lines. Everything is back as it was, and nginx was not reloaded."
  fi
  reload_nginx || stop "nginx -t passed, but the reload failed. Check: sudo systemctl status nginx"
  if [ -n "$backup" ]; then say "Backup of the site file: $backup"; fi
  if [ $had_snippet = 1 ]; then say "Removed $SNIPPET."; fi
  say "LA2L is out of nginx, and nginx was reloaded."
}

targets=$(find_targets)
count=$(grep -c . <<<"$targets" || true)
if [ "$count" -eq 0 ]; then
  stop "no server block listens on 443 for $DOMAIN in /etc/nginx/sites-enabled or /etc/nginx/conf.d."
fi
if [ "$count" -gt 1 ]; then
  stop "$count server blocks listen on 443 for $DOMAIN ($(tr '\n' ' ' <<<"$targets")). Add the include line by hand."
fi
SITE=$(readlink -f "${targets%:*}")
LINE=${targets##*:}

case $MODE in
  check) check ;;
  install) install_la2l ;;
  remove) remove_la2l ;;
esac
