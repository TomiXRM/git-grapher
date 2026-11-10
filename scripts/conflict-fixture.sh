#!/usr/bin/env bash
# Create a merge stopped on content, add/add, binary, modify/delete, rename/rename, directory/file and submodule conflicts.
# Content includes checkout.ts and long-policy.txt; the binary fixture has a distinct image on each side.
#   scripts/conflict-fixture.sh <dir> creates <dir>/repo and <dir>/sub-origin, stopped in git merge incoming.
set -euo pipefail
base=${1:?usage: conflict-fixture.sh <dir>}
mkdir -p "$base"; base=$(cd "$base" && pwd)
rm -rf "$base/repo" "$base/sub-origin"
g() { git -c user.name=Dev -c user.email=dev@example.com -c init.defaultBranch=main -c protocol.file.allow=always "$@"; }

# a tiny repo to be the submodule; two commits so each side can point at its own
g init -q "$base/sub-origin"
( cd "$base/sub-origin" && echo one > s && g add s && g commit -qm "sub one" && echo two > s && g commit -qam "sub two" )
sub1=$(git -C "$base/sub-origin" rev-parse HEAD~1) sub2=$(git -C "$base/sub-origin" rev-parse HEAD)

g init -q "$base/repo"; cd "$base/repo"
# a real 160 × 100 PNG of one colour per side, so a preview shows which is which
png() {
  local data
  case "$1" in
    base) data='iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAElEQVR4nO3RQQkAMAzAwPqn7+mdijEIBycgkNk9hM33Ap4yOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7gOIPjDI4zOM7guAuS+AEo+2pKKgAAAABJRU5ErkJggg==' ;;
    current) data='iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwE9nJsMaxhQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEX3J0e3YisSw8AAAAASUVORK5CYII=' ;;
    incoming) data='iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwM9pRJMYyxQijIMLMNjsdQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXejFUkfbCGWQAAAAASUVORK5CYII=' ;;
  esac
  printf %s "$data" | base64 -d > "$2"
}
cat > checkout.ts <<'EOF'
export function checkout(branch: string) {
  const ref = resolve(branch);
  if (!ref) throw new Error("no such branch");
  return switchTo(ref);
}

export function total(items: number[]) {
  return items.reduce((a, b) => a + b, 0);
}
EOF
{ echo "# Policy"; for i in $(seq 1 60); do echo "Rule $i: be kind to the repository."; done; } > long-policy.txt
big() { for i in $(seq 1 100); do echo "  step($i, \"$1\");"; done; echo "  report(\"$1: a long line that runs well past the width of a narrow column, to see the sideways scroll\", { verbose: true, retries: 3 });"; } # every line differs: one 100-line conflict
{ echo "export function run() {"; big base; echo "}"; } > big-rewrite.ts
png base image.png
echo "delete me on one side" > to-delete.txt
printf 'export const name = "src";\nexport const size = 1;\n' > renamed-src.ts
echo "a file here" > dir-vs-file
g -c protocol.file.allow=always submodule add -q "$base/sub-origin" vendor/sub 2>/dev/null
git -C vendor/sub checkout -q "$sub1"
g add -A && g commit -qm "Base"

g switch -qc incoming
sed 's/no such branch/unknown branch/' checkout.ts > fixture-edit.tmp && mv fixture-edit.tmp checkout.ts
sed 's/a + b, 0/a + b, 0) || 0/' checkout.ts > fixture-edit.tmp && mv fixture-edit.tmp checkout.ts
sed 's/^Rule 5:.*/Rule 5: incoming wording./; s/^Rule 40:.*/Rule 40: incoming says so./' long-policy.txt > fixture-edit.tmp && mv fixture-edit.tmp long-policy.txt
echo "added both ways B" > added-both.txt
{ echo "export function run() {"; big incoming; echo "}"; } > big-rewrite.ts
png incoming image.png
echo "changed on incoming" > to-delete.txt
g mv renamed-src.ts renamed-b.ts
g rm -q dir-vs-file && mkdir dir-vs-file && echo child > dir-vs-file/child.txt
git -C vendor/sub checkout -q "$sub2"
g add -A && g commit -qm "Incoming third"

g switch -q main
git -C vendor/sub checkout -q "$sub1"
sed 's/no such branch/branch not found/' checkout.ts > fixture-edit.tmp && mv fixture-edit.tmp checkout.ts
sed 's/^Rule 5:.*/Rule 5: current wording./; s/^Rule 40:.*/Rule 40: current says otherwise./' long-policy.txt > fixture-edit.tmp && mv fixture-edit.tmp long-policy.txt
echo "added both ways A" > added-both.txt
{ echo "export function run() {"; big current; echo "}"; } > big-rewrite.ts
png current image.png
g rm -q to-delete.txt
g mv renamed-src.ts renamed-a.ts
echo "the file grew on current" >> dir-vs-file
( cd vendor/sub && echo three > s && g commit -qam "sub three" )
g add -A && g commit -qm "Current-side changes"

g merge --no-edit incoming >/dev/null 2>&1 || true
git status --short
echo "$base/repo"
