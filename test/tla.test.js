// TLA+ models in tla/, checked with tla-ts. Each row: model + constants + property -> expected OK / VIOL.
// OK rows check the stated guarantees; VIOL rows preserve counterexamples, including failures of the current protocol.
// `via`: actions that must appear in the counterexample, so a VIOL row fails if the violation comes from somewhere else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tlc } from "../tla/tlc.mjs";

const T = true, F = false;
const rows = [
  // TabKey: the graph writes the tab key and the detail writes the file key. Host visibility is an assumption.
  ...["ordered", "equal"].flatMap((Clock) => {
    const c = (Sync, MaxWrites = 3, Seed = "empty") => ({ Sync, Clock, Seed, MaxWrites });
    return [
      // Immediate reads keep every displayed file attached to the selected commit and preserve graph selection.
      ["TabKey", c("atomic"), "DiffMatchesCommit", "OK"],
      ["TabKey", c("atomic"), "ShaFollowsGraph", "OK"],
      // With immediate reads, the latest file choice is shown once shared-state delivery is complete.
      ["TabKey", c("atomic"), "LatestActionWins", "OK"],
      // Back closes a file previously picked in the detached detail.
      ["TabKey", c("atomic"), "BackCloses", "OK"],
      // Selecting or revisiting a commit clears its previous file choice.
      ["TabKey", c("atomic", 5), "SelectionClears", "OK"],
      // Esc in the detached detail closes the graph's diff.
      ["TabKey", c("atomic"), "DetailEscCloses", "OK"],
      // Reading both current keys gives every write a counter greater than either key.
      ["TabKey", c("atomic"), "NoCounterCollision", "OK"],
      // Delayed reads still prevent a file from another commit and a detail click from changing graph selection.
      ["TabKey", c("replica"), "DiffMatchesCommit", "OK"],
      ["TabKey", c("replica"), "ShaFollowsGraph", "OK"],
      // A later detail click can be lost after delivery: its smaller counter or an exact tie keeps the earlier choice.
      ["TabKey", c("replica"), "LatestActionWins", "VIOL", ["DetailClick", "DeliverG", "DeliverD"]],
      // Back can close the diff temporarily, then an earlier detail choice reopens it when its larger counter arrives.
      ["TabKey", c("replica"), "BackCloses", "VIOL", ["DetailClick", "GraphBack", "DeliverG", "DeliverD"]],
      // Revisiting a commit can resurrect its old file when the selection write has not seen the detail's larger counter.
      ["TabKey", c("replica", 5), "SelectionClears", "VIOL", ["GraphSelect", "DetailClick", "DeliverG", "DeliverD"]],
      // Esc in the detail can leave the graph's diff open when its null write loses to the tab key.
      ["TabKey", c("replica"), "DetailEscCloses", "VIOL", ["DrawerClick", "DetailEsc", "DeliverG", "DeliverD"]],
      // Lagging views let the graph and detail allocate the same counter.
      ["TabKey", c("replica"), "NoCounterCollision", "VIOL", ["GraphSelect", "DetailClick"]],
    ];
  }),
  // A later timestamp resolves equal counters when the clock advances.
  ["TabKey", { Sync: "replica", Clock: "ordered", Seed: "empty", MaxWrites: 3 }, "TimestampOrdersCollision", "OK"],
  // Equal counters in the same millisecond keep the tab key, so a later detail click can be ignored.
  ["TabKey", { Sync: "replica", Clock: "equal", Seed: "empty", MaxWrites: 3 }, "TimestampOrdersCollision", "VIOL", ["DrawerClick", "DetailClick", "DeliverG", "DeliverD"]],
  // A higher-counter file from another repo or machine is filtered out before choosing the visible file.
  ...["atomic", "replica"].flatMap((Sync) => ["repo", "machine"].map((Seed) =>
    ["TabKey", { Sync, Clock: "ordered", Seed, MaxWrites: 2 }, "DiffMatchesCommit", "OK"])),

  // PullWindow — rules S(uspend) Z (seriali)ze D(rain); interferers
  ...(() => {
    const c = (InitStale, RemoteMoves, External, Suspend, Serialize, Drain) => ({ InitStale, RemoteMoves, External, Suspend, Serialize, Drain, Reverify: false, Manual: false, Recheck: false, ReadFails: false });
    return [
      ["PullWindow", c(F, F, F, F, F, F), "PullMatchesPreviewBasis", "OK"],            // nothing moves: preview = pull
      ["PullWindow", c(T, F, F, T, T, T), "PullMatchesPreviewBasis", "VIOL", ["PullFetch"]], // pull's own fetch
      ["PullWindow", c(F, T, F, T, T, T), "PullMatchesPreviewBasis", "VIOL", ["RemotePush"]],
      ["PullWindow", c(F, F, T, T, T, T), "PullMatchesPreviewBasis", "VIOL", ["ExtCommit"]],
      ["PullWindow", c(T, T, F, T, T, T), "ForkPointMatchesPreview", "OK"],            // all three rules, no external git
      ["PullWindow", c(T, T, F, T, T, T), "NoAppFetchInWindow", "OK"],
      ["PullWindow", c(T, F, F, F, F, F), "ForkPointMatchesPreview", "VIOL", ["AppFetchEnd"]],
      ["PullWindow", c(T, F, F, T, T, F), "ForkPointMatchesPreview", "VIOL", ["AppFetchStart", "Preview", "AppFetchEnd"]], // no Drain
      ["PullWindow", c(T, F, T, T, T, T), "ForkPointMatchesPreview", "VIOL", ["ExtFetch"]],
      ["PullWindow", c(T, F, F, T, T, F), "NoOverlap", "OK"],
      ["PullWindow", c(T, F, F, T, F, F), "NoOverlap", "VIOL", ["Confirm"]],
      // Reverify at confirm (re-read HEAD/@{upstream}; moved -> new preview) does not replace Drain: confirming does not
      // wait for a running fetch, which then lands before the pull. The check right before `git pull` (Recheck) does.
      ["PullWindow", { ...c(T, T, F, T, T, F), Reverify: T }, "ForkPointMatchesPreview", "VIOL", ["AppFetchEnd"]],
      ["PullWindow", { ...c(T, T, F, T, T, F), Reverify: T, Recheck: T, ReadFails: F }, "ForkPointMatchesPreview", "OK"],
      ["PullWindow", { ...c(T, T, F, F, F, F), Reverify: T }, "ForkPointMatchesPreview", "VIOL", ["Confirm", "AppFetchEnd", "StartPull"]],
      ["PullWindow", { ...c(T, T, T, T, T, F), Reverify: T }, "ForkPointMatchesPreview", "VIOL", ["Confirm", "ExtFetch", "StartPull"]],
      ["PullWindow", { ...c(F, T, F, T, T, T), Reverify: T }, "PullMatchesPreviewBasis", "VIOL", ["RemotePush"]],
    ];
  })(),

  // TimeoutRetry
  ["TimeoutRetry", { Policy: "autoretry", ServerSide: F }, "AtMostOnce", "VIOL", ["Timeout"]],
  ["TimeoutRetry", { Policy: "block", ServerSide: F }, "AtMostOnce", "VIOL", ["Timeout", "Reobserve"]],
  ["TimeoutRetry", { Policy: "block-cas", ServerSide: T }, "AtMostOnce", "OK"],
  ["TimeoutRetry", { Policy: "block-cas", ServerSide: T }, "NoOverlap", "VIOL", ["Reobserve"]],
  ["TimeoutRetry", { Policy: "groupkill", ServerSide: F }, "AtMostOnce", "OK"],
  ["TimeoutRetry", { Policy: "groupkill", ServerSide: F }, "NoOverlap", "OK"],
  ["TimeoutRetry", { Policy: "groupkill", ServerSide: T }, "AtMostOnce", "VIOL", ["Timeout"]],

  // Refresh — L: = liveness property (SPECIFICATION Spec with weak fairness)
  ...(() => {
    const c = (Buffer, Await, Seq, Poll, Coalesce) => ({ Buffer, Await, Seq, Poll, Coalesce });
    return [
      ["Refresh", c(T, T, F, F, F), "L:EventuallyFresh", "OK"],                       // buffered watch, awaited reload
      ["Refresh", c(F, T, F, F, F), "L:EventuallyFresh", "VIOL", ["Change"]],         // change lost during reload
      ["Refresh", c(F, T, F, F, F), "QuietIsFresh", "VIOL", ["Change"]],
      ["Refresh", c(T, F, F, F, F), "QuietIsFresh", "VIOL", ["Apply"]],               // out-of-order completion
      ["Refresh", c(T, F, F, F, F), "L:EventuallyFresh", "VIOL"],
      ["Refresh", c(F, T, F, T, F), "L:EventuallyFresh", "OK"],                       // poll rescues the lossy gap
      ["Refresh", c(T, F, T, T, F), "L:EventuallyFresh", "VIOL", ["Tick"]],           // newest-wins + poll: starvation
      ["Refresh", c(F, F, F, F, T), "L:EventuallyFresh", "OK"],                       // fire-and-forget + coalesce
      ["Refresh", c(F, F, F, T, T), "L:EventuallyFresh", "OK"],
      ["Refresh", c(T, F, T, T, T), "L:EventuallyFresh", "OK"],
    ];
  })(),

  // Drawer
  ["Drawer", { Design: "panes", SplitGuard: F, PanesRestored: T, IdsKept: T }, "NoDouble", "OK"],
  ["Drawer", { Design: "panes", SplitGuard: F, PanesRestored: F, IdsKept: T }, "NoneMissing", "OK"],
  ["Drawer", { Design: "panes", SplitGuard: F, PanesRestored: T, IdsKept: T }, "AtMostOneDetail", "VIOL", ["Detach"]],
  ["Drawer", { Design: "panes", SplitGuard: T, PanesRestored: T, IdsKept: T }, "AtMostOneDetail", "OK"],
  ["Drawer", { Design: "modekey", SplitGuard: T, PanesRestored: T, IdsKept: T }, "NoDouble", "VIOL", ["Quit", "Restart"]],
  ["Drawer", { Design: "modekey", SplitGuard: T, PanesRestored: F, IdsKept: T }, "NoneMissing", "VIOL", ["Restart"]],

  // ---- The code as it is: the constants Git Grapher has (see each model's header for where).
  // PullWindow: Suspend, Serialize, Drain and Reverify all hold in header.js. The first row is the variant without
  // Suspend (the 60 s auto fetch could run under the open dialog), kept as the contrast.
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: F, Serialize: T, Drain: T, Reverify: T, Manual: F, Recheck: T, ReadFails: F }, "NoAppFetchInWindow", "VIOL", ["AppFetchStart"]],
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: F, Recheck: T, ReadFails: F }, "ForkPointMatchesPreview", "OK"],
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: F, Recheck: T, ReadFails: F }, "NoOverlap", "OK"],
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: F, Recheck: T, ReadFails: F }, "NoAppFetchInWindow", "OK"],
  // The person may press Fetch while the dialog is open: that fetch lands in the window (NoAppFetchInWindow VIOL), and
  // Reverify catches it at confirm, so the pull still starts from the refs the preview showed.
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: T, Recheck: T, ReadFails: F }, "NoAppFetchInWindow", "VIOL", ["ManualFetchStart"]],
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: T, Recheck: T, ReadFails: F }, "ForkPointMatchesPreview", "OK"],
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: T, Recheck: T, ReadFails: F }, "NoOverlap", "OK"],
  // Without the check right before `git pull`, a Fetch pressed while confirming lands after the last check.
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: T, Recheck: F, ReadFails: F }, "ForkPointMatchesPreview", "VIOL", ["ManualFetchStart"]],
  // When the last read fails, or there was no basis, git pull decides: a fetch during confirm then reaches the pull.
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: F, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: T, Recheck: T, ReadFails: T }, "ForkPointMatchesPreview", "VIOL", ["ManualFetchStart"]],
  // Another program fetching between the last check and `git pull` starting is still possible (accepted; git pull decides).
  ["PullWindow", { InitStale: T, RemoteMoves: T, External: T, Suspend: T, Serialize: T, Drain: T, Reverify: T, Manual: T, Recheck: T, ReadFails: F }, "ForkPointMatchesPreview", "VIOL", ["StartPull", "ExtFetch", "Dispatch"]],
  // TimeoutRetry: block-cas for pushes, deletes and merges (see the model's header); block for stash and the other local
  // writes. A repeat of a plain write after an unknown result can apply twice (AtMostOnce VIOL).
  // NoOverlap is violated for every write: only groupkill holds it, and a mod cannot kill a process group (herdr exec
  // kills the direct child only). Accepted; the unknown result tells the user to wait a minute.
  ["TimeoutRetry", { Policy: "block", ServerSide: T }, "AtMostOnce", "VIOL"],
  ["TimeoutRetry", { Policy: "block-cas", ServerSide: T }, "AtMostOnce", "OK"],
  ["TimeoutRetry", { Policy: "block-cas", ServerSide: T }, "NoOverlap", "VIOL"],
  ["TimeoutRetry", { Policy: "block-cas", ServerSide: F }, "AtMostOnce", "OK"],
  ["TimeoutRetry", { Policy: "block-cas", ServerSide: F }, "NoOverlap", "VIOL"],
  ["TimeoutRetry", { Policy: "block", ServerSide: F }, "AtMostOnce", "VIOL"],
  // Refresh: watchFolder per worktree, kick() not awaited (drive.js), one read at a time + dirty (store.js refresh),
  // no newest-wins, a 45 s / 10 s poll; watchFolder buffering between calls is not measured (lost batches were seen): F.
  ["Refresh", { Buffer: F, Await: F, Seq: F, Poll: T, Coalesce: T }, "L:EventuallyFresh", "OK"],
  ["Refresh", { Buffer: F, Await: F, Seq: F, Poll: T, Coalesce: T }, "QuietIsFresh", "OK"],
  // Drawer: panes (the pane id in ggit.detail.<tab> still in panes()), SplitGuard (graph.js detach). Whether Herdr restores
  // the detail pane after a restart is not measured: both.
  ["Drawer", { Design: "panes", SplitGuard: T, PanesRestored: T, IdsKept: T }, "NoDouble", "OK"],
  ["Drawer", { Design: "panes", SplitGuard: T, PanesRestored: F, IdsKept: T }, "NoneMissing", "OK"],
  ["Drawer", { Design: "panes", SplitGuard: T, PanesRestored: T, IdsKept: T }, "AtMostOneDetail", "OK"],
  // Known limit: if a restored pane comes back with a new id, the graph cannot find it (panes() does not tell a copy's
  // role), so the drawer shows as well until the person uses the detail pane.
  ["Drawer", { Design: "panes", SplitGuard: T, PanesRestored: T, IdsKept: F }, "NoDouble", "VIOL", ["Restart"]],
  ["Drawer", { Design: "panes", SplitGuard: T, PanesRestored: T, IdsKept: F }, "NoneMissing", "OK"],
  // ... and Detach can start a second detail pane before the old one claims its key.
  ["Drawer", { Design: "panes", SplitGuard: T, PanesRestored: T, IdsKept: F }, "AtMostOneDetail", "VIOL", ["Restart", "Detach"]],

  // RefreshCopies: several copies on one repository; a change batch reaches one waiting copy (Single, observed).
  ["RefreshCopies", { N: 2, Single: T, Tell: F, Poll: F }, "QuietIsFresh", "VIOL", ["Change"]],          // no Tell: a worktree-only change stays in one copy
  ["RefreshCopies", { N: 2, Single: T, Tell: T, Poll: F }, "QuietIsFresh", "VIOL", ["Change", "Rearm"]],  // a change while no copy waits is lost ...
  ["RefreshCopies", { N: 2, Single: T, Tell: T, Poll: T }, "L:EventuallyAllFresh", "OK"],                 // ... until the 45 s poll
  ["RefreshCopies", { N: 3, Single: T, Tell: T, Poll: T }, "L:EventuallyAllFresh", "OK"],
  ["RefreshCopies", { N: 2, Single: T, Tell: F, Poll: T }, "L:EventuallyAllFresh", "OK"],                 // the poll alone gets there, 45 s late

  // RefCas: moving a branch from the tip ggit planned on (update-ref <ref> <new> <old>) while others commit on it.
  ["RefCas", { Cas: T }, "NoLostCommit", "OK"],
  ["RefCas", { Cas: F }, "NoLostCommit", "VIOL", ["Other", "Move"]],     // a plain update-ref drops the other commit

  // ConflictSave: Save compares the file with the blob it loaded, then writes.
  ["ConflictSave", { Check: T, OneStep: F }, "KeepsEarlierEdits", "OK"],
  ["ConflictSave", { Check: T, OneStep: F }, "KeepsAllEdits", "VIOL", ["CheckStep", "Edit", "WriteStep"]], // known gap: an edit between compare and write
  ["ConflictSave", { Check: F, OneStep: F }, "KeepsEarlierEdits", "VIOL"],                                  // without the compare
  ["ConflictSave", { Check: T, OneStep: T }, "KeepsAllEdits", "OK"],                                        // what a file lock would give
];

for (const [spec, constants, prop, want, via = []] of rows) {
  const live = prop.startsWith("L:");
  const name = `${spec} ${prop} ${JSON.stringify(constants)} -> ${want}`;
  test(name, async () => {
    const r = await tlc(spec, { constants, ...(live ? { properties: [prop.slice(2)], liveness: true } : { invariants: [prop] }) });
    const got = r.status === "success" ? "OK" : r.status.endsWith("violation") ? "VIOL" : `${r.status}: ${r.failure}`;
    assert.equal(got, want, (r.trace ?? []).join("\n"));
    const acts = (r.trace ?? []).map((l) => l.split(" ").find((w) => w.endsWith(":"))?.slice(0, -1).replace(/\(.*$/, ""));
    for (const a of via) assert.ok(acts.includes(a), `expected ${a} in trace:\n${r.trace.join("\n")}`);
  });
}

// The harness itself: a typo in a property name must not pass as OK.
test("harness: unknown invariant is not success", async () => {
  const r = await tlc("Drawer", { constants: { Design: "panes", SplitGuard: T, PanesRestored: T, IdsKept: T }, invariants: ["NoSuchThing"] }).catch(() => ({ status: "throw" }));
  assert.notEqual(r.status, "success");
});
