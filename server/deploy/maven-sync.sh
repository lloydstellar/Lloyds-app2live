#!/usr/bin/env bash
# Puts LA2L's Android libraries online in its own Maven repository,
# https://lloydstellar.nl/la2l/maven/: the Maven files of every GitHub release android-v<version>
# of this repository (made by .github/workflows/publish-android.yml) go into the volume that
# la2l-server serves them from.
#
#   bash deploy/maven-sync.sh            (in server/) after a new release
#   bash deploy/maven-sync.sh --check    download and check every release, change nothing
#
# Before anything goes online it checks every release: the ZIP holds only the files of
# nl.lloydstellar:la2l and nl.lloydstellar:la2l-ktx of its own version, and no links; every file
# has a good signature of the key in ../sdk/android/signing-key.asc; every checksum matches. When
# one check fails, nothing changes online. Then it writes the maven-metadata.xml of both libraries
# with every version, and puts the whole repository in place at once.
#
# The releases come through the gh login of this machine. For tests: LA2L_MAVEN_ZIPS=<folder>
# takes the ZIP files from that folder instead, LA2L_MAVEN_KEY=<file> takes another public key,
# and LA2L_CONTAINER another container, as for the other scripts.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run this script with bash: bash deploy/maven-sync.sh" >&2
  exit 1
fi

set -euo pipefail
umask 022

cd "$(dirname "$0")/.."
REPO="lloydstellar/Lloyds-app2live"
CONTAINER="${LA2L_CONTAINER:-la2l-server}"
KEY="${LA2L_MAVEN_KEY:-../sdk/android/signing-key.asc}"
LIBRARIES=(la2l la2l-ktx)

mode="sync"
case "${1:-}" in
  "") ;;
  --check) mode="check" ;;
  *)
    echo "Unknown option $1. Use --check, or nothing." >&2
    exit 2
    ;;
esac

fail() {
  echo "$1 Nothing was changed online." >&2
  exit 1
}

work="$(mktemp -d)"
export GNUPGHOME="$work/gnupg"
trap 'gpgconf --kill all >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir -p "$work/zips" "$work/unpacked" "$work/repo/nl/lloydstellar" "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

# The releases.
if [ -n "${LA2L_MAVEN_ZIPS:-}" ]; then
  cp "$LA2L_MAVEN_ZIPS"/la2l-android-maven-*.zip "$work/zips/"
else
  tags="$(gh release list --repo "$REPO" --limit 200 --json tagName --jq '.[].tagName' | grep -E '^android-v[0-9]+\.[0-9]+\.[0-9]+$' || true)"
  if [ -z "$tags" ]; then
    echo "There is no release android-v<version> on GitHub yet, so there is nothing to put online."
    exit 0
  fi
  for tag in $tags; do
    gh release download "$tag" --repo "$REPO" --pattern "la2l-android-maven-${tag#android-v}.zip" --dir "$work/zips"
  done
fi

# The key the releases are signed with.
gpg --batch --quiet --import "$KEY" 2>/dev/null
fingerprint="$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')"
[ -n "$fingerprint" ] || fail "No key in $KEY."

versions=()
for zip in "$work/zips"/la2l-android-maven-*.zip; do
  [ -e "$zip" ] || fail "No release ZIP file found."
  name="${zip##*/}"
  v="${name#la2l-android-maven-}"
  v="${v%.zip}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "$name: no version in the name."
  vre="${v//./\\.}"
  unzip -tq "$zip" >/dev/null 2>&1 || fail "$name: not a good ZIP file."

  # Every name in the ZIP: a folder on the way, or a file of one of the two libraries in this
  # version, or their maven-metadata.xml (which is made again below).
  while IFS= read -r entry; do
    if [[ "$entry" =~ ^(nl/|nl/lloydstellar/|nl/lloydstellar/(la2l|la2l-ktx)/|nl/lloydstellar/(la2l|la2l-ktx)/$vre/)$ ]]; then
      continue
    elif [[ "$entry" =~ ^nl/lloydstellar/(la2l|la2l-ktx)/maven-metadata\.xml(\.(md5|sha1|sha256|sha512))?$ ]]; then
      continue
    elif [[ "$entry" =~ ^nl/lloydstellar/(la2l|la2l-ktx)/$vre/([A-Za-z0-9][A-Za-z0-9._-]*)$ ]]; then
      library="${BASH_REMATCH[1]}"
      file="${BASH_REMATCH[2]}"
      [[ "$file" =~ ^$library-$vre(-[a-z]+)?\.(aar|jar|pom|module)(\.asc)?(\.(md5|sha1|sha256|sha512))?$ ]] || fail "$name: a file that does not belong: $entry."
    else
      fail "$name: a path that does not belong: $entry."
    fi
  done < <(unzip -Z1 "$zip")

  dir="$work/unpacked/$v"
  mkdir -p "$dir"
  unzip -q "$zip" -d "$dir"
  [ -z "$(find "$dir" ! -type f ! -type d)" ] || fail "$name: holds a link or another special file."

  for library in "${LIBRARIES[@]}"; do
    from="$dir/nl/lloydstellar/$library/$v"
    [ -f "$from/$library-$v.pom" ] || fail "$name: no $library-$v.pom."
    # A good signature of our key on every library file.
    while IFS= read -r -d '' f; do
      [ -f "$f.asc" ] || fail "$name: ${f##*/} is not signed."
      status="$(gpg --batch --status-fd 1 --verify "$f.asc" "$f" 2>/dev/null)" || fail "$name: the signature of ${f##*/} is not good."
      grep -q "^\[GNUPG:\] VALIDSIG $fingerprint " <<<"$status" || fail "$name: ${f##*/} is signed with another key."
    done < <(find "$from" -type f \( -name '*.aar' -o -name '*.jar' -o -name '*.pom' -o -name '*.module' \) -print0)
    # Every checksum matches its file.
    while IFS= read -r -d '' sum; do
      algorithm="${sum##*.}"
      f="${sum%.*}"
      [ -f "$f" ] || fail "$name: ${sum##*/} without its file."
      expected="$(head -c 300 "$sum" | awk 'NR == 1 { print $1 }')"
      actual="$("${algorithm}sum" "$f" | cut -d' ' -f1)"
      [ "$expected" = "$actual" ] || fail "$name: ${f##*/} does not match ${sum##*/}."
    done < <(find "$from" -type f \( -name '*.md5' -o -name '*.sha1' -o -name '*.sha256' -o -name '*.sha512' \) -print0)
    mkdir -p "$work/repo/nl/lloydstellar/$library"
    cp -R "$from" "$work/repo/nl/lloydstellar/$library/$v"
  done
  versions+=("$v")
done

# The maven-metadata.xml of each library, with every version, newest last, and its checksums.
stamp="$(date -u +%Y%m%d%H%M%S)"
sorted="$(printf '%s\n' "${versions[@]}" | sort -V)"
newest="$(tail -n 1 <<<"$sorted")"
for library in "${LIBRARIES[@]}"; do
  meta="$work/repo/nl/lloydstellar/$library/maven-metadata.xml"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <groupId>nl.lloydstellar</groupId>\n'
    printf '  <artifactId>%s</artifactId>\n  <versioning>\n    <latest>%s</latest>\n    <release>%s</release>\n    <versions>\n' "$library" "$newest" "$newest"
    while IFS= read -r v; do printf '      <version>%s</version>\n' "$v"; done <<<"$sorted"
    printf '    </versions>\n    <lastUpdated>%s</lastUpdated>\n  </versioning>\n</metadata>\n' "$stamp"
  } >"$meta"
  for algorithm in md5 sha1 sha256 sha512; do
    "${algorithm}sum" "$meta" | cut -d' ' -f1 | tr -d '\n' >"$meta.$algorithm"
  done
done
cp "$KEY" "$work/repo/signing-key.asc"

summary="la2l and la2l-ktx $(tr '\n' ' ' <<<"$sorted")"
if [ "$mode" = check ]; then
  echo "Checked: $summary(signed by $fingerprint). Nothing was changed."
  exit 0
fi

# Into the volume of the server, through a short-lived container of its image, as backup.sh does.
docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "There is no container $CONTAINER."
volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/maven"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")
[ -n "$volume" ] || fail "The container $CONTAINER has no volume at /maven: update it first (deploy/update.sh)."
image=$(docker inspect -f '{{.Image}}' "$CONTAINER")
if ! docker image inspect "$image" >/dev/null 2>&1; then
  image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER")
fi
# The new repository is copied next to the old one first; the two renames that swap them take
# a moment, so a download never sees half a repository.
docker run --rm -i --network none --read-only --cap-drop ALL -v "$volume:/maven" -v "$work/repo:/in:ro" \
  --entrypoint sh "$image" -s <<'SH'
set -eu
cd /maven
rm -rf .next .old
cp -R /in .next
mkdir .old
for x in nl signing-key.asc; do
  if [ -e "$x" ]; then mv "$x" .old/; fi
  mv ".next/$x" "$x"
done
rm -rf .next .old
SH

# The server reads the files when they are asked for: no restart needed.
if docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/maven/signing-key.asc').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"; then
  echo "Online: $summary(signed by $fingerprint)."
else
  echo "The files are in the volume, but the server does not serve them. Is it la2l-server 0.12.0 or newer?" >&2
  exit 1
fi
