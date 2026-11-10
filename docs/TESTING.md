# Tests

```sh
npm test            # everything; run before a release
npm run test:fast   # parsers, layout, store, view decisions, preview, update — no write paths
```

Files run two processes at a time. CI runs `npm test` on every push and pull request.

## Fixtures

`test/fx.js` makes one temporary root per process; every repository, remote, worktree and shim lives under it and is removed
on exit (`GGIT_KEEP=1 npm test` keeps and prints it). Child processes get a private HOME, no global or system git config, a
fixed identity and dates, non-interactive git and a 15 s timeout. Product git calls go through `herdrAdapter`, the same adapter
the mod uses.

Read git output with `raw` (untrimmed) and files as Buffers when bytes matter.

## What a result must show

- **completed:** the OIDs, parent order, tree, index entries (stage, mode, blob) and file bytes the operation promises.
- **refused:** nothing changed. `F.refused` / `F.same` compare a snapshot before and after: HEAD and symbolic HEAD, all refs,
  index entries and unmerged stages, worktree bytes, modes and symlink targets, and operation-state files (MERGE_HEAD, …).
  Not compared: FETCH_HEAD, the object database (unreachable objects from `hash-object -w` or `commit-tree` are harmless),
  reflogs, config and worktree registration — tests check those directly when they are the operation's contract. Preview tests
  add the raw index digest, porcelain status and stash order.
- **unknown:** the exact outcome, its message, and the resulting OIDs. An `accepted:` comment names damage git can only detect
  after it happened.

A test never removes a real `index.lock`.

## Races

`race` (`test/fx.js`) runs an actor at one adapter boundary (before or after `run`, `sh` or `readFile`); `inside`
runs it at one git command inside the operation's own child process, through a PATH shim. Each race asserts that the actor
fired once and succeeded. Nothing relies on sleeps.

## Known gaps

Kept as `todo` tests, reported separately by node, not counted as passes:

- **Save's last window.** A writer that changes the file after Save's final hash and before its write is overwritten. Closing it
  needs file locking that `sh` does not offer.

Pull is plain `git pull`: its fetch may move remote-tracking refs and git writes ORIG_HEAD before the merge refuses over local
edits. For pull, refused means the local branch, index and files are kept; the test compares with `git pull` on a copy.

## Views

Decisions that views make (file-menu repository and revision, when a menu closes, Conflict Save / Take / Commit arguments)
live in `lib/view-decisions.js` and are tested there. View methods are loaded in a VM with Herdr stubbed (`test/vm-load.js`).
Rendering and input are not tested automatically; check them in Herdr.
