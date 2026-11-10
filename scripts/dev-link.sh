#!/usr/bin/env bash
# Development install: copy mods/git-grapher into herdr-app (a real folder, as a normal install is).
# A symlinked mod folder loads its JS but not its svg icons, and per-file symlinks fail ("resolves outside the
# application directory"), so it is a copy. `--watch` re-copies every second; herdr reloads a copy when a file changes.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd); home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
src="$here/mods/git-grapher/" dst="$home/mods/git-grapher"
[ -L "$dst" ] && rm "$dst"
rsync -a --delete --exclude .dev-link "$src" "$dst/"
touch "$dst/.dev-link" # Settings → Updates leaves a development copy alone
herdr-app check "$dst"
# ponytail: polling rsync, use fswatch if it is ever installed
[ "${1:-}" = --watch ] && while sleep 1; do rsync -a --delete --exclude .dev-link "$src" "$dst/"; done
exit 0
