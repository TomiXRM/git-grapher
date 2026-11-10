#!/bin/sh
# Settings → Updates. Downloads from the GitHub release of this mod, checks every file against the release's SHA256SUMS,
# and changes nothing until all of it is downloaded and checked.
#   update.sh latest         prints the latest release tag
#   update.sh install <tag>  replaces mods/git-grapher with that release (and its helper for this machine, if the release
#                            has one); the old folder is moved to backups/git-grapher-<time> and that path is printed
#   update.sh helper <tag>   puts only that release's helper in bin/
# Exit: 3 dev copy (scripts/dev-link.sh), 4 checksum mismatch, 5 download failed, 6 bad archive, 7 swap failed,
#       8 no helper for this machine in the release.
# Env: HERDR_APP_HOME; GG_BASE (tests: a file:// folder laid out as <base>/download/<tag>/<asset>).
set -eu
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
base=${GG_BASE:-https://github.com/tomixrm/git-grapher/releases}
mod="$home/mods/git-grapher"

if [ "$1" = latest ]; then # /releases/latest redirects to /releases/tag/<tag>; no API call, no JSON
  curl -fsSI -m 20 -o /dev/null -w '%{redirect_url}' "$base/latest" | sed 's#.*/tag/##'
  exit 0
fi
tag=$2
[ -e "$mod/.dev-link" ] && { echo "This is a development copy (scripts/dev-link.sh); it is not updated." >&2; exit 3; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=aarch64-apple-darwin ;;
  Darwin-x86_64) target=x86_64-apple-darwin ;;
  Linux-x86_64) target=x86_64-unknown-linux-gnu ;;
  Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-gnu ;;
  *) target= ;;
esac

mkdir -p "$home/backups"
tmp=$(mktemp -d "$home/backups/.update.XXXXXX") # same disk as mods/, so the final mv is a rename
trap 'rm -rf "$tmp"' EXIT
get() { curl -fsSL -m 300 -o "$tmp/$1" "$base/download/$tag/$1"; }
check() {
  want=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  got=$( (sha256sum "$tmp/$1" 2>/dev/null || shasum -a 256 "$tmp/$1") | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "$1 does not match the release's SHA256SUMS" >&2; exit 4; }
}

get SHA256SUMS || { echo "Could not download $tag" >&2; exit 5; }
helper=
if [ -n "$target" ] && grep -q "ggit-helper-$target\$" "$tmp/SHA256SUMS"; then
  helper="ggit-helper-$target"
  get "$helper" || { echo "Could not download $helper" >&2; exit 5; }
  check "$helper"
fi

if [ "$1" = helper ]; then
  [ -n "$helper" ] || { echo "The release has no helper for $(uname -s) $(uname -m)" >&2; exit 8; }
  mkdir -p "$mod/bin" && cp "$tmp/$helper" "$mod/bin/ggit-helper.part" && chmod +x "$mod/bin/ggit-helper.part"
  mv -f "$mod/bin/ggit-helper.part" "$mod/bin/ggit-helper"
  exit 0
fi

archive="git-grapher-$tag.tar.gz"
get "$archive" || { echo "Could not download $archive" >&2; exit 5; }
check "$archive"
mkdir "$tmp/new"
tar -xzf "$tmp/$archive" -C "$tmp/new" && [ -f "$tmp/new/git-grapher/main.js" ] || { echo "$archive has no git-grapher/main.js" >&2; exit 6; }
new="$tmp/new/git-grapher"
mkdir -p "$new/bin"
if [ -n "$helper" ]; then cp "$tmp/$helper" "$new/bin/ggit-helper"
elif [ -f "$mod/bin/ggit-helper" ]; then cp "$mod/bin/ggit-helper" "$new/bin/ggit-helper" # built with cargo: kept
fi
[ -f "$new/bin/ggit-helper" ] && chmod +x "$new/bin/ggit-helper"
# ponytail: backups are never pruned (each is the old folder, helper included, ~9 MB); prune by count if that matters
backup="$home/backups/git-grapher-$(date +%Y%m%d-%H%M%S)"
mv "$mod" "$backup" || { echo "Could not move the installed mod aside" >&2; exit 7; }
mv "$new" "$mod" || { mv "$backup" "$mod"; echo "Could not put the new mod in place; the old one is back" >&2; exit 7; }
echo "$backup"
