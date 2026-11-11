// Conflict Mode reads native git state, tested against real repositories in temporary directories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as C from "../mods/git-grapher/lib/conflict.js";
import * as fs from "node:fs";
import * as F from "./fx.js";

const { ad, commit } = F;
const sh = F.raw;
const git = F.attempt;

function conflicted() {
  const d = F.repo({ "f.md": "a\nb\nc\nd\ne\n" }, { message: "base" }); commit(d, "other", "1\n");
  sh(d, "switch", "-qc", "topic"); commit(d, "f.md", "a\nB topic\nc\nd\nE topic\n", "topic"); commit(d, "t-only", "x\n");
  sh(d, "switch", "-q", "main"); commit(d, "f.md", "a\nB main\nc\nd\ne\n", "main");
  assert.equal(git(d, "merge", "--no-edit", "topic").code, 1);
  return d;
}

test("parseMerged / assemble / applyChoice", () => {
  const t = "a\n<<<<<<< Current\nX\n||||||| Base\nb\n=======\nY\n>>>>>>> Incoming\nc\n";
  const segs = C.parseMerged(t);
  assert.deepEqual(segs.map((s) => s.t), ["same", "hunk", "same"]);
  assert.deepEqual([segs[1].ours, segs[1].base, segs[1].theirs], ["X\n", "b\n", "Y\n"]);
  assert.equal(C.assemble(segs, [null]), t, "no choice: the markers as git wrote them");
  assert.equal(C.assemble(segs, ["current"]), "a\nX\nc\n");
  assert.equal(C.assemble(segs, ["both"]), "a\nX\nY\nc\n");
  assert.equal(C.assemble(segs, ["both-r"]), "a\nY\nX\nc\n");
  assert.equal(C.applyChoice("edited\n" + t, segs[1], "incoming"), "edited\na\nY\nc\n");
  assert.equal(C.applyChoice("gone\n", segs[1], "incoming"), null);
  assert.equal(C.markerLines(t), 3); assert.equal(C.markerLines("a\nb\n"), 0);
  assert.deepEqual(C.listedConflicts("Merge branch 'x'\n\n# Conflicts:\n#\ta\n#\tb c\n"), ["a", "b c"]);
  assert.equal(C.mergeMessage("Merge branch 'x'\n\n# Conflicts:\n#\ta\n"), "Merge branch 'x'");
});

test("readConflict: merge conflict → labels files hunks and blockers", async () => {
  const d = conflicted();
  const c = await C.readConflict(ad, d);
  assert.equal(c.op, "merge"); assert.equal(c.title, "Merging topic into main");
  assert.deepEqual([c.current, c.incoming], ["main", "topic"]);
  assert.deepEqual(c.files.map((f) => [f.path, f.kind, f.saved]), [["f.md", "content", false]]);
  const f = await C.loadFile(ad, d, c.files[0]);
  assert.equal(f.segs.filter((s) => s.t === "hunk").length, 1);
  assert.match(f.merged, /E topic/, "the clean part is merged already");
  assert.deepEqual(await C.blockers(ad, d, c), ["1 file(s) not resolved yet"]);
});

// unresolved markers must not be written or staged
test("saveFile: conflict markers remain → refused without mutation", async () => {
  const d = conflicted(), c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]), before = F.snap(d);
  assert.equal((await C.saveFile(ad, d, { rev: c.rev, path: "f.md", text: f.merged, workId: f.workId })).outcome, "refused"); F.same(d, before);
});
// approved text cannot overwrite a later external edit
test("saveFile: loaded text edited on disk → refused without mutation", async () => {
  const d = conflicted(), c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]); F.put(d, "f.md", "someone else\n");
  const before = F.snap(d), r = await C.saveFile(ad, d, { rev: c.rev, path: "f.md", text: C.assemble(f.segs, ["both"]), workId: f.workId });
  assert.deepEqual([r.outcome, r.reason], ["refused", "edited"]); F.same(d, before);
});
// completed Save removes blockers and preserves clean merged lines
test("saveFile: both hunk sides chosen → exact Result staged and blockers cleared", async () => {
  const d = conflicted(), c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]);
  const text = C.assemble(f.segs, ["both"]), r = await C.saveFile(ad, d, { rev: c.rev, path: "f.md", text, workId: f.workId });
  assert.equal(r.outcome, "completed"); assert.equal(text, "a\nB main\nB topic\nc\nd\nE topic\n");
  assert.equal(F.raw(d, "show", ":f.md"), text); assert.equal(readFileSync(join(d, "f.md"), "utf8"), text);
  const now = await C.readConflict(ad, d); assert.deepEqual(now.files.map(x => [x.path, x.saved]), [["f.md", true]]); assert.deepEqual(await C.blockers(ad, d, now), []);
});
// a revision predating a staged resolution cannot write again
test("saveFile: old conflict revision → refused without mutation", async () => {
  const d = conflicted(), c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]); F.put(d, "f.md", "resolved\n"); F.git(d, "add", "f.md");
  const before = F.snap(d), r = await C.saveFile(ad, d, { rev: c.rev, path: "f.md", text: "chosen\n", workId: f.workId });
  assert.deepEqual([r.outcome, r.reason], ["refused", "stale"]); F.same(d, before);
});


test("abortOp: edit outside merge conflict → refused with all state preserved", async () => {
  const d = conflicted(), c = await C.readConflict(ad, d); F.put(d, "other", "my edit\n");
  const r = await F.refused(d, () => C.abortOp(ad, d, c)); assert.equal(r.reason, "edits"); assert.match(r.stderr, /other/);
});
test("abortOp: only conflicted file staged → original HEAD tree restored", async () => {
  const d = conflicted(), head = F.git(d, "rev-parse", "HEAD"), tree = F.git(d, "rev-parse", "HEAD^{tree}");
  F.put(d, "f.md", "half resolved\n"); F.git(d, "add", "f.md"); const c = await C.readConflict(ad, d);
  assert.equal((await C.abortOp(ad, d, c)).outcome, "completed"); assert.equal(await C.readConflict(ad, d), null);
  assert.equal(F.git(d, "rev-parse", "HEAD"), head); assert.equal(F.git(d, "write-tree"), tree); assert.equal(F.git(d, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(d, "f.md"), "utf8"), "a\nB main\nc\nd\ne\n"); assert.equal(fs.existsSync(join(d, "t-only")), false);
});

test("continueOp: resolved rebase → remaining commit replayed and state cleared", async () => {
  const d = F.repo({});
  commit(d, "f", "0\n"); commit(d, "g", "0\n");
  sh(d, "switch", "-qc", "mine"); commit(d, "f", "mine1\n", "m1"); commit(d, "h", "mine2\n", "m2");
  sh(d, "switch", "-q", "main"); commit(d, "f", "theirs\n", "t1");
  assert.equal(git(d, "rebase", "main", "mine").code, 1);
  const c = await C.readConflict(ad, d);
  assert.equal(c.op, "rebase"); assert.equal(c.title, "Rebasing mine (1/2)"); assert.equal(c.current, "New base"); assert.match(c.incoming, /Your commit .* m1/);
  assert.equal((await F.refused(d, () => C.continueOp(ad, d, c))).outcome, "refused", "unresolved: git refuses, nothing moved");
  const f = await C.loadFile(ad, d, c.files[0]);
  assert.equal((await C.saveFile(ad, d, { rev: c.rev, path: "f", text: C.assemble(f.segs, ["incoming"]), workId: f.workId })).outcome, "completed");
  assert.equal((await C.continueOp(ad, d, await C.readConflict(ad, d))).outcome, "completed");
  assert.equal(await C.readConflict(ad, d), null);
  assert.equal(sh(d, "log", "--format=%s", "-3").trim(), "m2\nm1\nt1");
});
// skipping a cherry-pick removes its step
test("skipOp: cherry-pick deletion conflict → original HEAD and files retained", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "del"); F.git(d, "rm", "f"); F.git(d, "commit", "-qm", "delete"); const deleted = F.git(d, "rev-parse", "HEAD");
  F.git(d, "switch", "-q", "main"); const head = F.commit(d, "f", "changed\n"); assert.equal(F.attempt(d, "cherry-pick", deleted).code, 1);
  const c = await C.readConflict(ad, d); assert.equal(c.op, "cherry-pick"); assert.equal(c.files[0].kind, "deleted-incoming");
  const r = await C.skipOp(ad, d, c); assert.equal(r.outcome, "completed");
  assert.equal(await C.readConflict(ad, d), null); assert.equal(F.git(d, "rev-parse", "HEAD"), head); assert.equal(F.raw(d, "show", ":f"), "changed\n");
});
// Incoming can represent deletion of the entire file
test("takeSide: incoming deletion → file and index entry removed", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "del"); F.git(d, "rm", "f"); F.git(d, "commit", "-qm", "delete"); const deleted = F.git(d, "rev-parse", "HEAD");
  F.git(d, "switch", "-q", "main"); const head = F.commit(d, "f", "changed\n"); assert.equal(F.attempt(d, "cherry-pick", deleted).code, 1);
  const c = await C.readConflict(ad, d); assert.equal(c.op, "cherry-pick"); assert.equal(c.files[0].kind, "deleted-incoming");
  const loaded = await C.loadFile(ad, d, c.files[0]), r = await C.takeSide(ad, d, { rev: c.rev, f: c.files[0], side: "incoming", workId: loaded.workId });
  assert.equal(r.outcome, "completed"); assert.equal(fs.existsSync(join(d, "f")), false); assert.equal(F.raw(d, "ls-files", "-s", "--", "f"), "");
  assert.equal(F.git(d, "rev-parse", "HEAD"), head); assert.equal(F.git(d, "rev-parse", "CHERRY_PICK_HEAD"), deleted);
});


function stashConflict() {
  const d = F.repo(); F.put(d, "f", "stashed\n"); F.git(d, "stash", "-q"); F.commit(d, "f", "committed\n");
  assert.equal(F.attempt(d, "stash", "pop").code, 1); return d;
}
test("readConflict: stash apply conflict → stash labels and one unresolved file", async () => {
  const d = stashConflict(), before = F.snap(d), c = await C.readConflict(ad, d);
  assert.deepEqual([c.op, c.incoming, c.files.length], ["stash", "Stash", 1]); F.same(d, before);
});
test("abortOp: stash conflict → refused with stash and resolution state preserved", async () => {
  const d = stashConflict(), c = await C.readConflict(ad, d), stashes = F.raw(d, "stash", "list", "--format=%H");
  await F.refused(d, () => C.abortOp(ad, d, c)); assert.equal(F.raw(d, "stash", "list", "--format=%H"), stashes);
});
test("askContext: stash conflict → exact file and stashed text in resolution instructions", async () => {
  const d = stashConflict(), c = await C.readConflict(ad, d), before = F.snap(d);
  const ctx = C.askContext(c, await C.loadFile(ad, d, c.files[0]), d);
  assert.match(ctx, /## Conflict 1/); assert.match(ctx, /git add -- f/); assert.match(ctx, /stashed/); F.same(d, before);
});

test("kinds: rename/rename, both deleted, dir/file, binary, submodule (scripts/conflict-fixture.sh)", async () => {
  const d = complexConflict(), c = await C.readConflict(ad, d);
  const kinds = Object.fromEntries(c.files.map((f) => [f.path, f.kind]));
  assert.deepEqual(kinds, { "added-both.txt": "content", "big-rewrite.ts": "content", "checkout.ts": "content", "dir-vs-file~HEAD": "deleted-incoming", "image.png": "content",
    "long-policy.txt": "content", "renamed-a.ts": "added-current", "renamed-b.ts": "added-incoming", "renamed-src.ts": "deleted-both",
    "to-delete.txt": "deleted-current", "vendor/sub": "submodule" });
  assert.equal((await C.loadFile(ad, d, c.files.find((f) => f.path === "image.png"))).kind, "binary");
  assert.equal((await C.loadFile(ad, d, c.files.find((f) => f.path === "long-policy.txt"))).segs.filter((s) => s.t === "hunk").length, 2);

});

test("line selections: picked lines of the side picked first, then the other's", () => {
  const h = C.parseMerged("<<<<<<< Current\na\nb\nc\n||||||| Base\nx\n=======\nd\ne\n>>>>>>> Incoming\n")[0];
  assert.equal(C.pickText(h, { cur: [true, false, true], inc: [false, true], first: "current" }), "a\nc\ne\n");
  assert.equal(C.pickText(h, { cur: [true], inc: [true, true], first: "incoming" }), "d\ne\na\n");
  assert.equal(C.pickText(h, { cur: [], inc: [], first: "current" }), h.raw, "nothing picked: the markers stay");
  assert.equal(C.assemble([h], [{ cur: [true, true, true], inc: [] }]), "a\nb\nc\n");
});

test("alignLines pairs changed lines between equal ones; splitChange finds the changed middle", () => {
  assert.deepEqual(C.alignLines(["a", "x1", "b", "c"], ["a", "y1", "y2", "b"]), [
    { t: "same", c: 0, i: 0 }, { t: "pair", c: 1, i: 1 }, { t: "pair", c: null, i: 2 }, { t: "same", c: 2, i: 3 }, { t: "pair", c: 3, i: null }]);
  const big = C.alignLines(Array.from({ length: 100 }, (_, k) => `step(${k}, "current");`), Array.from({ length: 100 }, (_, k) => `step(${k}, "incoming");`));
  assert.equal(big.length, 100); assert.deepEqual(big[5], { t: "pair", c: 5, i: 5 }, "a 100-line rewrite: line 5 beside line 5");
  assert.deepEqual(C.splitChange('step(5, "current");', 'step(5, "incoming");'), ['step(5, "', "current", '");']);
});


// Preserve external partial resolutions instead of rebuilding them from index stages.
test("The Result starts from the file as it is, so an editor's resolution is not replaced", async () => {
  const d = F.conflict(); F.put(d, "f", "external resolution\n");
  const c = await C.readConflict(F.ad, d), f = await C.loadFile(F.ad, d, c.files[0]);
  assert.equal(f.merged, "external resolution\n");
});

// Refuse Save through a symlink so it cannot overwrite an outside file.
test("saveFile: symlink replaces loaded file → refused and victim preserved", async () => {
  const d = F.conflict(), c = await C.readConflict(F.ad, d), f = await C.loadFile(F.ad, d, c.files[0]);
  const victim = d + "-outside"; fs.writeFileSync(victim, f.work); fs.unlinkSync(join(d, "f")); fs.symlinkSync(victim, join(d, "f"));
  const before = F.snap(d), bytes = fs.readFileSync(victim);
  const r = await C.saveFile(F.ad, d, { rev: c.rev, path: "f", text: "chosen\n", workId: f.workId });
  assert.deepEqual(fs.readFileSync(victim), bytes, "victim bytes preserved");
  assert.equal(r.outcome, "refused"); F.same(d, before);
});

// Refuse Save if an external edit changed the loaded file.
test("saveFile: external edit before write process → refused and actor state preserved", async () => {
  const d = F.conflict(), c = await C.readConflict(F.ad, d), f = await C.loadFile(F.ad, d, c.files[0]);
  const race = F.race({ cwd: d, when: k => k === "sh", do: () => F.put(d, "f", "racing external edit\n") });
  const r = await C.saveFile(race.ad, d, { rev: c.rev, path: "f", text: "chosen\n", workId: f.workId }); F.fired(race);
  assert.equal(fs.readFileSync(join(d, "f"), "utf8"), "racing external edit\n");
  // Unreachable hash-object -w blobs are excluded from snapshots; this exit-4 guard runs before the object write.
  assert.deepEqual([r.outcome, r.reason], ["refused", "edited"]); F.same(d, race.record.snapshot);
});

// approved Result blob is staged, including final newline
test("saveFile: approved Result → completed with exact stage-zero blob", async () => {
  const d = F.conflict(), c = await C.readConflict(F.ad, d), f = await C.loadFile(F.ad, d, c.files[0]);
  const r = await C.saveFile(F.ad, d, { rev: c.rev, path: "f", text: "chosen\n", workId: f.workId });
  assert.equal(r.outcome, "completed");
  const oid = F.git(d, "hash-object", "f");
  assert.equal(F.raw(d, "show", ":f"), "chosen\n");
  assert.equal(F.raw(d, "ls-files", "-s", "--", "f"), `100644 ${oid} 0\tf\n`);
  assert.equal(fs.readFileSync(join(d, "f"), "utf8"), "chosen\n");
  assert.equal(F.raw(d, "ls-files", "-u"), "");
});

// Taking a side must not overwrite an external edit made after loading.
test("Taking a side refuses when the file was edited after it was loaded", async () => {
  const d = F.conflict({ del: true }); const c = await C.readConflict(F.ad, d), f = await C.loadFile(F.ad, d, c.files[0]);
  F.put(d, "f", "outside edit\n");
  const before = F.snap(d);
  const r = await C.takeSide(F.ad, d, { rev: c.rev, f: c.files[0], side: "current", workId: f.workId });
  assert.equal(r.outcome, "refused"); F.same(d, before);
  assert.equal(r.reason, "edited"); assert.equal(fs.readFileSync(join(d, "f"), "utf8"), "outside edit\n");
});

// Skip removes the sequencer step while preserving unrelated edits.
test("Skip refuses when a file beside the conflict was edited", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "topic"); F.commit(d, "f", "topic\n"); F.git(d, "switch", "-q", "main"); F.commit(d, "f", "main\n");
  assert.equal(F.attempt(d, "rebase", "main", "topic").code, 1);
  const c = await C.readConflict(F.ad, d); F.put(d, "other", "precious outside edit\n");
  const before = F.snap(d);
  const r = await C.skipOp(F.ad, d, c);
  assert.equal(r.outcome, "refused"); F.same(d, before);
  assert.equal(r.reason, "edits"); assert.equal(fs.readFileSync(join(d, "other"), "utf8"), "precious outside edit\n");
});

// Abort must detect staged edits even when working-tree bytes match the clean result.
test("Abort refuses a staged edit hidden by restoring the working tree", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "topic"); F.commit(d, "f", "topic\n"); F.git(d, "switch", "-q", "main"); F.commit(d, "f", "main\n");
  assert.equal(F.attempt(d, "rebase", "main", "topic").code, 1);
  const c = await C.readConflict(F.ad, d); F.put(d, "other", "staged precious\n"); F.git(d, "add", "other"); F.put(d, "other", "unchanged\n");
  const before = F.snap(d);
  assert.equal((await C.abortOp(F.ad, d, c)).reason, "edits"); F.same(d, before); assert.equal(F.git(d, "show", ":other"), "staged precious");
});

// Commit only the approved merge state and staged tree.
test("commitMerge: operation replaced after display → refused with new state preserved", async () => {
  const d = F.conflict(); F.put(d, "f", "resolved\n"); F.git(d, "add", "f");
  const c = await C.readConflict(ad, d), tree = F.git(d, "write-tree");
  F.git(d, "merge", "--abort"); F.commit(d, "after", "someone else\n"); F.put(d, "unrelated", "x\n"); F.git(d, "add", "unrelated");
  const before = F.snap(d), r = await C.commitMerge(ad, d, c, "Merge", tree);
  assert.deepEqual([r.outcome, r.reason], ["refused", "stale"]); F.same(d, before);
});
// A normal merge commit records the approved tree and both parents.
test("commitMerge: approved resolution → exact tree parents and cleared merge state", async () => {
  const d = F.conflict(); F.put(d, "f", "resolved\n"); F.git(d, "add", "f");
  const c = await C.readConflict(ad, d), tree = F.git(d, "write-tree"), head = F.git(d, "rev-parse", "HEAD"), incoming = F.git(d, "rev-parse", "MERGE_HEAD");
  const r = await C.commitMerge(ad, d, c, "Merge", tree); assert.equal(r.outcome, "completed");
  assert.equal(F.git(d, "rev-parse", "HEAD^{tree}"), tree); assert.equal(F.git(d, "rev-parse", "HEAD^1"), head); assert.equal(F.git(d, "rev-parse", "HEAD^2"), incoming);
  assert.equal(F.raw(d, "show", ":f"), "resolved\n"); assert.equal(fs.readFileSync(join(d, "f"), "utf8"), "resolved\n");
  assert.equal(fs.existsSync(join(d, ".git/MERGE_HEAD")), false); assert.equal(F.git(d, "status", "--porcelain"), "");
});

// A rebase merge step remains a rebase operation even with MERGE_HEAD present.
test("A merge step inside a rebase is read as the rebase", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "left"); F.commit(d, "f", "left\n"); F.git(d, "switch", "-qc", "right", "main"); F.commit(d, "f", "right\n");
  F.git(d, "switch", "-q", "left"); assert.equal(F.attempt(d, "merge", "--no-edit", "right").code, 1); F.put(d, "f", "resolved\n"); F.git(d, "add", "f"); F.git(d, "commit", "-qm", "original merge");
  F.git(d, "switch", "-q", "main"); F.commit(d, "extra", "upstream\n");
  assert.equal(F.attempt(d, "rebase", "--rebase-merges", "main", "left").code, 1);
  const c = await C.readConflict(F.ad, d);
  assert.equal(c.op, "rebase");
});

// A staged resolution is part of the conflict, not an unrelated edit blocking Abort.
test("A rebase step's saved resolution is not taken for an edit by Abort", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "topic"); F.commit(d, "f", "topic\n"); F.git(d, "switch", "-q", "main"); F.commit(d, "f", "main\n");
  assert.equal(F.attempt(d, "rebase", "main", "topic").code, 1); F.put(d, "f", "resolved\n"); F.git(d, "add", "f");
  const c = await C.readConflict(F.ad, d);
  assert.deepEqual(await C.abortGuard(F.ad, d, c), { ok: true });
});

// Refuse ambiguous duplicate hunks instead of replacing the first matching block.
test("Two identical conflicts in an edited Result: the choice is refused, not given to the first", () => {
  const h = C.parseMerged("<<<<<<< Current\nx\n=======\ny\n>>>>>>> Incoming\n")[0];
  assert.equal(C.applyChoice("manual header\n" + h.raw + "middle\n" + h.raw, h, "incoming"), null);
});

// Preserve a side's missing final newline.
test("A side without a final newline is taken as it is", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "topic"); F.commit(d, "f", "incoming"); F.git(d, "switch", "-q", "main"); F.commit(d, "f", "current");
  assert.equal(F.attempt(d, "merge", "--no-edit", "topic").code, 1);
  const c = await C.readConflict(F.ad, d), f = await C.loadFile(F.ad, d, c.files[0]);
  assert.equal(C.assemble(f.segs, ["current"]), "current");
});

// Refuse Save through a symlinked parent directory.
test("Save refuses a path whose folder became a link to outside the repository", async () => {
  const d = F.repo(); fs.mkdirSync(join(d, "dir")); F.commit(d, "dir/f", "base\n");
  F.git(d, "switch", "-qc", "topic"); F.commit(d, "dir/f", "incoming\n"); F.git(d, "switch", "-q", "main"); F.commit(d, "dir/f", "current\n");
  assert.equal(F.attempt(d, "merge", "--no-edit", "topic").code, 1);
  const c = await C.readConflict(F.ad, d), f = await C.loadFile(F.ad, d, c.files.find((x) => x.path === "dir/f"));
  const out = d + "-outside"; fs.renameSync(join(d, "dir"), out); fs.symlinkSync(out, join(d, "dir"));
  const before = F.snap(d), outside = fs.readFileSync(join(out, "f"));
  const r = await C.saveFile(F.ad, d, { rev: c.rev, path: "dir/f", text: "chosen\n", workId: f.workId });
  assert.equal(r.outcome, "refused"); assert.deepEqual(fs.readFileSync(join(out, "f")), outside); F.same(d, before);
});

test("loadFile: editor changes before first hash → matching text and OID", async () => {
  const d = F.conflict(), c = await C.readConflict(F.ad, d);
  const race = F.race({ cwd: d, when: (k, a) => k === "run" && a.includes("hash-object"), do: () => F.put(d, "f", "editor resolution\n") });
  const f = await C.loadFile(race.ad, d, c.files[0]); F.fired(race);
  assert.equal(f.work, "editor resolution\n"); assert.equal(f.workId, F.git(d, "hash-object", "f"));
  F.same(d, race.record.snapshot);
});

// If a file changes during loading, reread it so displayed text matches its workId.
test("loadFile: editor changes after read → retries to matching text and OID", async () => {
  const d = F.conflict(), c = await C.readConflict(F.ad, d);
  const race = F.race({ cwd: d, at: "after", when: (k, p) => k === "readFile" && p === `${d}/f`, do: () => F.put(d, "f", "new resolution\n") });
  const f = await C.loadFile(race.ad, d, c.files[0]); F.fired(race);
  assert.equal(f.work, "new resolution\n"); assert.equal(f.workId, F.git(d, "hash-object", "f"));
  F.same(d, race.record.snapshot);
});

test("takeSide: untouched symlink → incoming target and stage-zero link", async () => {
  const d = F.repo(); fs.symlinkSync("base", join(d, "l")); F.git(d, "add", "l"); F.git(d, "commit", "-qm", "l");
  F.git(d, "switch", "-qc", "topic"); fs.unlinkSync(join(d, "l")); fs.symlinkSync("incoming", join(d, "l")); F.git(d, "commit", "-qam", "i");
  F.git(d, "switch", "-q", "main"); fs.unlinkSync(join(d, "l")); fs.symlinkSync("current", join(d, "l")); F.git(d, "commit", "-qam", "c");
  assert.equal(F.attempt(d, "merge", "--no-edit", "topic").code, 1);
  const c = await C.readConflict(F.ad, d), lf = c.files.find((x) => x.path === "l"), f = await C.loadFile(F.ad, d, lf);
  assert.equal(lf.kind, "symlink");
  assert.equal((await C.takeSide(F.ad, d, { rev: c.rev, f: lf, side: "incoming", workId: f.workId })).outcome, "completed", "an untouched link is taken");
  assert.equal(fs.readlinkSync(join(d, "l")), "incoming");
  assert.equal(F.raw(d, "ls-files", "-s", "--", "l"), `120000 ${lf.e.s3.oid} 0\tl\n`);
});
// Taking a symlink side must refuse a regular file substituted after loading.
test("takeSide: link replaced by regular file → refused without mutation", async () => {
  const d2 = F.repo(); fs.symlinkSync("base", join(d2, "l")); F.git(d2, "add", "l"); F.git(d2, "commit", "-qm", "l");
  F.git(d2, "switch", "-qc", "topic"); fs.unlinkSync(join(d2, "l")); fs.symlinkSync("incoming", join(d2, "l")); F.git(d2, "commit", "-qam", "i");
  F.git(d2, "switch", "-q", "main"); fs.unlinkSync(join(d2, "l")); fs.symlinkSync("current", join(d2, "l")); F.git(d2, "commit", "-qam", "c");
  assert.equal(F.attempt(d2, "merge", "--no-edit", "topic").code, 1);
  const c2 = await C.readConflict(F.ad, d2), lf2 = c2.files.find((x) => x.path === "l"), f2 = await C.loadFile(F.ad, d2, lf2);
  fs.unlinkSync(join(d2, "l")); F.put(d2, "l", "precious replacement\n");
  const before = F.snap(d2);
  assert.equal((await C.takeSide(F.ad, d2, { rev: c2.rev, f: lf2, side: "current", workId: f2.workId })).reason, "edited");
  assert.equal(fs.readFileSync(join(d2, "l"), "utf8"), "precious replacement\n");
  F.same(d2, before);
});

// Commit the approved tree even if the index changes before commit creation.
test("commitMerge: index changes after check → commits approved tree and ordered parents", async () => {
  const d = F.conflict(); F.put(d, "f", "resolved\n"); F.git(d, "add", "f");
  const c = await C.readConflict(F.ad, d), tree = F.git(d, "write-tree"), head = F.git(d, "rev-parse", "HEAD"), incoming = F.git(d, "rev-parse", "MERGE_HEAD");
  const race = F.race({ cwd: d, when: (k, a) => k === "run" && ["commit-tree", "commit"].includes(a[0]), do: () => {
    F.git(d, "merge", "--abort"); F.put(d, "unrelated", "x\n"); F.git(d, "add", "unrelated");
  } });
  const r = await C.commitMerge(race.ad, d, c, "Merge branch 'topic'\n# a comment\n", tree); F.fired(race);
  assert.equal(F.git(d, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(r.outcome, "completed");
  assert.equal(F.git(d, "rev-parse", "HEAD^1"), head); assert.equal(F.git(d, "rev-parse", "HEAD^2"), incoming);
  assert.equal(F.git(d, "log", "-1", "--format=%B"), "Merge branch 'topic'");
  assert.equal(F.raw(d, "ls-files", "-s", "-z"), race.record.snapshot.index);
  assert.deepEqual(F.snap(d).files, race.record.snapshot.files);
  assert.equal(F.raw(d, "ls-tree", "--name-only", "HEAD", "unrelated"), "");
  assert.equal(fs.existsSync(join(d, ".git/MERGE_HEAD")), false);
});

function resolvedMerge() {
  const d = F.conflict(); F.put(d, "f", "resolved\n"); F.git(d, "add", "f");
  return { d, tree: F.git(d, "write-tree"), head: F.git(d, "rev-parse", "HEAD"), incoming: F.git(d, "rev-parse", "MERGE_HEAD") };
}
// A commit-tree failure must leave refs unchanged.
 test("commitMerge: commit-tree fails → refused with merge state and index preserved", async () => {
  const { d, tree } = resolvedMerge(), c = await C.readConflict(ad, d); let calls = 0;
  const fault = { ...ad, run: (args, o) => { if (args[0] === "commit-tree") { calls++; return Promise.resolve({ code: 1, stdout: "", stderr: "fixture commit-tree failure" }); } return ad.run(args, o); } };
  const r = await F.refused(d, () => C.commitMerge(fault, d, c, "Merge", tree)); assert.equal(calls, 1); assert.match(r.stderr, /commit-tree failure/);
});
// Refuse a merge commit if compare-and-swap cannot advance the approved HEAD.
 test("commitMerge: branch moves before update-ref → refused with actor state preserved", async () => {
  const { d, tree, head } = resolvedMerge(), c = await C.readConflict(ad, d);
  const actor = F.git(d, "commit-tree", tree, "-p", head, "-m", "external commit");
  const race = F.race({ cwd: d, when: (k, a) => k === "run" && a[0] === "update-ref", do: () => F.git(d, "update-ref", "refs/heads/main", actor, head) });
  const r = await C.commitMerge(race.ad, d, c, "Merge", tree); F.fired(race);
  // commit-tree may leave an unreachable commit before CAS refuses; snapshots exclude these harmless, GC-eligible objects.
  assert.deepEqual([r.outcome, r.reason], ["refused", "stale"]); F.same(d, race.record.snapshot);
  assert.equal(F.git(d, "rev-parse", "HEAD"), actor); assert.equal(fs.existsSync(join(d, ".git/MERGE_HEAD")), true);
});
// Report a partial write if merge state cleanup fails after creating the commit.
 test("commitMerge: merge quit fails after commit → unknown with committed OID and remaining state", async () => {
  const { d, tree, head, incoming } = resolvedMerge(), c = await C.readConflict(ad, d); let calls = 0;
  const fault = { ...ad, run: (args, o) => { if (args[0] === "merge" && args[1] === "--quit") { calls++; return Promise.resolve({ code: 1, stdout: "", stderr: "fixture quit failure" }); } return ad.run(args, o); } };
  const r = await C.commitMerge(fault, d, c, "Merge", tree); assert.equal(calls, 1);
  assert.equal(r.outcome, "unknown"); assert.match(r.stderr, /main/); assert.match(r.stderr, /quit failure/);
  assert.equal(r.head, F.git(d, "rev-parse", "main"));
  // accepted: cleanup failed after the branch CAS had already committed the approved tree.
  assert.equal(F.git(d, "rev-parse", "HEAD^{tree}"), tree); assert.equal(F.git(d, "rev-parse", "HEAD^1"), head); assert.equal(F.git(d, "rev-parse", "HEAD^2"), incoming);
  assert.equal(F.git(d, "rev-parse", "MERGE_HEAD"), incoming); assert.equal(F.raw(d, "show", ":f"), "resolved\n");
});
// Report a partial write if Save updates the worktree but staging fails.
 test("saveFile: index lock blocks staging after file write → unknown with exact partial state", async () => {
  const d = F.conflict(), c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]);
  F.put(d, ".git/index.lock", "other writer\n"); const before = F.snap(d);
  const r = await C.saveFile(ad, d, { rev: c.rev, path: "f", text: "chosen\n", workId: f.workId });
  assert.equal(r.outcome, "unknown"); assert.match(r.stderr, /^f: Result written, but staging failed/);
  // accepted: index.lock prevents staging after the approved Result has been written to disk.
  assert.equal(fs.readFileSync(join(d, "f"), "utf8"), "chosen\n");
  assert.equal(F.git(d, "hash-object", "f"), F.processRun("git", ["hash-object", "--stdin"], { cwd: d, input: "chosen\n" }).stdout.trim());
  // hash-object -w wrote the Result blob before staging failed; that unreachable object is harmless and GC-eligible.
  const after = F.snap(d); assert.equal(after.head, before.head); assert.equal(after.refs, before.refs); assert.equal(after.index, before.index); assert.deepEqual(after.states, before.states);
  assert.equal(fs.readFileSync(join(d, ".git/index.lock"), "utf8"), "other writer\n");
});

// Taking a binary side must preserve non-UTF-8 bytes.
for (const side of ["current", "incoming"]) test(`takeSide: binary ${side} → exact blob bytes and stage-zero mode`, async () => {
  const d = F.repo(), current = Buffer.from([0, 255, 10, 1]), incoming = Buffer.from([0, 254, 13, 2]);
  F.commit(d, "f", Buffer.from([0, 128])); F.git(d, "switch", "-qc", "topic"); F.commit(d, "f", incoming);
  F.git(d, "switch", "-q", "main"); F.commit(d, "f", current); assert.equal(F.attempt(d, "merge", "--no-edit", "topic").code, 1);
  const c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]), stage = c.files[0].e[side === "current" ? "s2" : "s3"];
  assert.equal(f.kind, "binary"); assert.equal((await C.takeSide(ad, d, { rev: c.rev, f: c.files[0], side, workId: f.workId })).outcome, "completed");
  assert.deepEqual(fs.readFileSync(join(d, "f")), side === "current" ? current : incoming);
  assert.equal(F.raw(d, "ls-files", "-s", "--", "f"), `${stage.mode} ${stage.oid} 0\tf\n`); assert.equal(F.raw(d, "ls-files", "-u"), "");
});
// Save's byte cap includes the exact boundary
 test("saveFile: 600000 ASCII bytes → completed with exact blob", async () => {
  const d = F.conflict(), c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]), text = "x".repeat(600000);
  assert.equal((await C.saveFile(ad, d, { rev: c.rev, path: "f", text, workId: f.workId })).outcome, "completed");
  assert.equal(F.raw(d, "show", ":f"), text); assert.equal(fs.readFileSync(join(d, "f"), "utf8"), text);
});
// Split Save arguments below Linux's 128 KiB per-argument cap without cutting surrogate pairs.
test("saveFile: multi-byte text with an emoji across a piece boundary → exact blob", async () => {
  const d = F.conflict(), c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]);
  const text = "界".repeat(29999) + "😀" + "é".repeat(40000) + "\n";
  assert.equal((await C.saveFile(ad, d, { rev: c.rev, path: "f", text, workId: f.workId })).outcome, "completed");
  assert.equal(F.raw(d, "show", ":f"), text); assert.equal(fs.readFileSync(join(d, "f"), "utf8"), text);
});
// Save caps UTF-8 bytes, not JS character count
for (const [label, text] of [["ASCII", "x".repeat(600001)], ["UTF-8", "界".repeat(200001)]]) test(`saveFile: oversized ${label} Result → refused without mutation`, async () => {
  const d = F.conflict(), c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]);
  const r = await F.refused(d, () => C.saveFile(ad, d, { rev: c.rev, path: "f", text, workId: f.workId })); assert.match(r.stderr, /Too big/);
});
// Save must retain executable mode in the index and worktree
 test("saveFile: executable conflict → completed with mode 100755", async () => {
  const d = F.repo(); fs.chmodSync(join(d, "f"), 0o755); F.git(d, "commit", "-qam", "executable");
  F.git(d, "switch", "-qc", "topic"); F.commit(d, "f", "topic\n"); F.git(d, "switch", "-q", "main"); F.commit(d, "f", "main\n"); assert.equal(F.attempt(d, "merge", "--no-edit", "topic").code, 1);
  const c = await C.readConflict(ad, d), f = await C.loadFile(ad, d, c.files[0]); assert.equal(c.files[0].e.s2.mode, "100755");
  assert.equal((await C.saveFile(ad, d, { rev: c.rev, path: "f", text: "chosen\n", workId: f.workId, mode: "100755" })).outcome, "completed");
  const oid = F.git(d, "hash-object", "f"); assert.equal(F.raw(d, "ls-files", "-s", "--", "f"), `100755 ${oid} 0\tf\n`);
  assert.equal(fs.statSync(join(d, "f")).mode & 0o777, 0o755); assert.equal(F.raw(d, "show", ":f"), "chosen\n");
});
// bounded repeated-read defense refuses a continuously changing file
 test("loadFile: edit on every read attempt → changing sentinel and Save refused", async () => {
  const d = F.conflict(), c = await C.readConflict(ad, d); const races = [];
  let adapter = ad;
  // Three one-shot boundary hooks: the outer hook fires after the inner first read.
  // Select different numbered read invocations so every retry gets exactly one actor.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let reads = 0;
    const race = F.race({ base: adapter, cwd: d, at: "after", when: (k, p) => k === "readFile" && p === `${d}/f` && ++reads === attempt, do: () => F.put(d, "f", `external ${attempt}\n`) });
    races.push(race); adapter = race.ad;
  }
  const f = await C.loadFile(adapter, d, c.files[0]); for (const race of races) F.fired(race);
  assert.equal(f.workId, "changing"); const before = F.snap(d);
  const r = await C.saveFile(ad, d, { rev: c.rev, path: "f", text: "chosen\n", workId: f.workId });
  assert.deepEqual([r.outcome, r.reason], ["refused", "edited"]); F.same(d, before); assert.equal(fs.readFileSync(join(d, "f"), "utf8"), "external 3\n");
});

function revertStop() {
  const d = F.repo(), changed = F.commit(d, "f", "changed\n"), head = F.commit(d, "f", "later\n");
  assert.equal(F.attempt(d, "revert", "--no-edit", changed).code, 1); return { d, head, changed };
}
// revert conflicts use the revert sequencer and preserve outside paths
for (const action of ["continue", "skip", "abort"]) test(`${action}Op: revert conflict → correct tree and cleared REVERT_HEAD`, async () => {
  const { d, head, changed } = revertStop(); let c = await C.readConflict(ad, d);
  assert.equal(c.op, "revert"); assert.equal(F.git(d, "rev-parse", "REVERT_HEAD"), changed);
  if (action === "continue") { F.put(d, "f", "resolved revert\n"); F.git(d, "add", "f"); c = await C.readConflict(ad, d); }
  const r = await C[action + "Op"](ad, d, c); assert.equal(r.outcome, "completed"); assert.equal(await C.readConflict(ad, d), null);
  assert.equal(F.attempt(d, "rev-parse", "-q", "--verify", "REVERT_HEAD").code, 1);
  assert.equal(F.git(d, "rev-parse", action === "continue" ? "HEAD^" : "HEAD"), head);
  assert.equal(F.raw(d, "show", ":f"), action === "continue" ? "resolved revert\n" : "later\n");
  assert.equal(fs.readFileSync(join(d, "other"), "utf8"), "unchanged\n"); assert.equal(F.git(d, "status", "--porcelain"), "");
});
// Continue must report the next conflicting rebase step rather than completion
 test("continueOp: next rebase commit conflicts → stopped with new step and preserved files", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "topic"); F.commit(d, "f", "topic one\n"); const tip = F.commit(d, "f", "topic two\n");
  F.git(d, "switch", "-q", "main"); const base = F.commit(d, "f", "main\n"); assert.equal(F.attempt(d, "rebase", "main", "topic").code, 1);
  F.put(d, "f", "resolved first\n"); F.git(d, "add", "f"); const c = await C.readConflict(ad, d), tree = F.git(d, "write-tree");
  const r = await C.continueOp(ad, d, c); assert.deepEqual([r.outcome, r.unmerged], ["stopped", 1]);
  const next = await C.readConflict(ad, d); assert.notEqual(next.rev, c.rev); assert.match(next.title, /2\/2/);
  assert.equal(F.git(d, "rev-parse", "HEAD^"), base); assert.equal(F.git(d, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(F.git(d, "rev-parse", "REBASE_HEAD"), tip); assert.equal(fs.readFileSync(join(d, "other"), "utf8"), "unchanged\n");
});

// revert Skip and Abort must preserve edits beside the conflict
for (const action of ["skip", "abort"]) test(`${action}Op: unrelated edit during revert → refused with all state preserved`, async () => {
  const { d } = revertStop(); F.put(d, "other", "external edit\n"); const c = await C.readConflict(ad, d);
  const r = await F.refused(d, () => C[action + "Op"](ad, d, c)); assert.equal(r.reason, "edits"); assert.match(r.stderr, /other/);
});

// Report partial Take when the index changes or the file is removed before checkout fails.
test("takeSide: incoming blob unavailable during checkout → unknown with exact partial state", async () => {
  const d = F.conflict(), c = await C.readConflict(ad, d), loaded = await C.loadFile(ad, d, c.files[0]);
  const selected = c.files[0].e.s3;
  fs.renameSync(join(d, ".git/objects", selected.oid.slice(0, 2), selected.oid.slice(2)), join(F.dir("missing-blob"), "saved"));
  const before = F.snap(d), otherIndex = F.raw(d, "ls-files", "-s", "--", "other");
  const r = await C.takeSide(ad, d, { rev: c.rev, f: c.files[0], side: "incoming", workId: loaded.workId });
  assert.equal(r.outcome, "unknown"); assert.match(r.stderr, /^f: Index updated, but checkout failed/); assert.equal(r.path, "f");
  // accepted: checkout cannot read the selected blob after update-index installed it; Git has removed the old file.
  assert.equal(F.raw(d, "ls-files", "-s", "--", "f"), `${selected.mode} ${selected.oid} 0\tf\n`);
  assert.equal(F.raw(d, "ls-files", "-u", "--", "f"), ""); assert.equal(fs.existsSync(join(d, "f")), false);
  assert.equal(F.raw(d, "ls-files", "-s", "--", "other"), otherIndex);
  const after = F.snap(d); const { f: removed, ...remaining } = before.files;
  assert.ok(removed.bytes.length); assert.deepEqual(after.files, remaining);
  assert.equal(after.head, before.head); assert.equal(after.branch, before.branch); assert.equal(after.refs, before.refs); assert.deepEqual(after.states, before.states);
});

function complexConflict() {
  const root = F.dir("complex-conflict");
  const r = F.processRun("bash", [new URL("../scripts/conflict-fixture.sh", import.meta.url).pathname, root]);
  assert.equal(r.code, 0, r.stderr); return join(root, "repo");
}

// Verify Delete actually removes the unmerged index entry.
test("takeSide: delete renamed source already absent on disk → unmerged index entry removed", async () => {
  const d = complexConflict(), c = await C.readConflict(ad, d), f = c.files.find(x => x.path === "renamed-src.ts"), before = F.snap(d);
  assert.equal(f.kind, "deleted-both"); assert.equal(fs.existsSync(join(d, f.path)), false); assert.ok(F.raw(d, "ls-files", "-u", "--", f.path));
  const r = await C.takeSide(ad, d, { rev: c.rev, f, side: "delete" }); assert.equal(r.outcome, "completed");
  assert.equal(F.raw(d, "ls-files", "-s", "--", f.path), ""); assert.equal(F.raw(d, "ls-files", "-u", "--", f.path), "");
  assert.equal(fs.existsSync(join(d, f.path)), false); assert.equal((await C.readConflict(ad, d)).files.some(x => x.path === f.path && !x.saved), false);
  const omit = entries => entries.split("\0").filter(row => !row.endsWith(`\t${f.path}`)).join("\0");
  F.same(d, { ...before, index: omit(before.index), unmerged: omit(before.unmerged) });
});
test("takeSide: incoming submodule → exact stage-zero gitlink and other state preserved", async () => {
  const d = complexConflict(), c = await C.readConflict(ad, d), f = c.files.find(x => x.path === "vendor/sub"), before = F.snap(d);
  const r = await C.takeSide(ad, d, { rev: c.rev, f, side: "incoming" }); assert.equal(r.outcome, "completed");
  assert.equal(F.raw(d, "ls-files", "-s", "--", f.path), `160000 ${f.e.s3.oid} 0\t${f.path}\n`);
  assert.equal(F.raw(d, "ls-files", "-u", "--", f.path), "");
  const after = F.snap(d), omit = entries => entries.split("\0").filter(row => !row.endsWith(`\t${f.path}`)).join("\0");
  assert.equal(omit(after.index), omit(before.index)); assert.equal(omit(after.unmerged), omit(before.unmerged));
  assert.deepEqual(after.files, before.files); assert.deepEqual(after.states, before.states); assert.equal(after.refs, before.refs); assert.equal(after.head, before.head);
});
