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

- **Save's last window** (a `todo` test, reported separately by node, not counted as a pass). A writer that changes the
  file after Save's final hash and before its write is overwritten (`tla/ConflictSave.tla`, KeepsAllEdits). Closing it needs file locking that `sh` does not offer.
- **A change while no copy is watching.** Between a watch batch and the next `watchFolder` call nothing listens. If
  Herdr does not keep such a change (not measured), a worktree-only change in that gap shows at the next poll, 45 s by
  default (`tla/RefreshCopies.tla`).
- **Two drops of the same stash at once.** Drop finds the stash's index by oid and drops it; two drops racing can drop
  a neighbour and put it back on top, so the order changes. Plain `git stash drop` has the same race.
- **A detail pane restored with a new id.** The graph finds its detail pane by the id in shared state; `panes()` does
  not say a copy's role. Until the person uses the restored pane, the drawer can show as well, and Detach can open a
  second pane (`tla/Drawer.tla`, IdsKept).

Pull is plain `git pull`: its fetch may move remote-tracking refs and git writes ORIG_HEAD before the merge refuses over local
edits. For pull, refused means the local branch, index and files are kept; the test compares with `git pull` on a copy.

## Views

Decisions that views make (file-menu repository and revision, when a menu closes, Conflict Save / Take / Commit arguments)
live in `lib/view-decisions.js` and are tested there. View methods are loaded in a VM with Herdr stubbed (`test/vm-load.js`).
Rendering and input are not tested automatically; check them in Herdr.

## Models

`tla/*.tla` are TLA+ models of the timing-sensitive designs: which commit a tab shows (TabKey), the Pull preview window
(PullWindow), refreshing after changes (Refresh) and across copies (RefreshCopies), moving a branch with an expected old value (RefCas), saving a conflict Result (ConflictSave), the detail drawer (Drawer), and writes that time out (TimeoutRetry).
`test/tla.test.js` checks each with tla-ts (TLC in node), as part of `npm test`. Every row is a model, its constants and a
property with the expected result: OK rows guard the design; VIOL rows show the failure a rule prevents (the variant without it), or record a known
limit under its assumption (a restored pane with a new id, `shared()` reads that lag). The rows
under "The code as it is" pin the constants that describe Git Grapher; they are written by hand and do not read the
code, so change them with the code. The view tests in `test/views.test.js` check the guards those constants stand for. Each model's header says
where its mechanism lives. Print one check with its counterexample: `node tla/trace.mjs <Model> <Property> K=V ...`.

`test/tla-trace.test.js` ties models to the code (trace validation): it runs the real code (real git, or the real
Header methods in a VM), turns what happened into model states and asks the model whether that sequence is one of its
behaviours (`traceCheck` in `tla/tlc.mjs`). Each also runs a variant of the code without the rule (no expected old value on
update-ref, no compare before Save's write, no check right before `git pull`): the model must reject that trace and
the model without the rule must accept it. Covered: RefCas (the merge commit), ConflictSave, PullWindow (the Header's
methods are real; git, the preview and the store are stubs there).

What this shows and does not: that these recorded runs are behaviours of the model, seen through the variables each
trace records (others are left free), with a few positions placed by hand where nothing can be read (each test says
which). It does not prove every run of the code fits the model, and does not check the models' properties on the code.

## Not modelled

In rough order of what could hurt most, these have tests but no model:

- Multi-command writes end to end: the approved tree and parents of the merge commit, a checkout in another worktree
  between check and update, branch deletion with its backup ref, conflict writes that stop halfway (file written,
  index not). Each copy of the mod has its own write queue; the shared bump does not serialize writes across copies.
- Writes after an unknown result: processes still running after a timeout, clicks already queued behind it, effects a
  local refresh cannot see (a push the server applied late), stash apply / drop compensation.
- The bump's id scheme and lagging `shared()` views, reads that fail, stamps after the copy's own writes.
- Async view ownership: message drafts versus typing, stale selection callbacks, several graph or detail panes in one
  tab, overlapping dialogs.
- Pull's basis beyond HEAD and upstream OIDs (config, status, which upstream), several Pull requests at once.
