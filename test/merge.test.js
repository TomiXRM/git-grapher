// Merge plans and execution tested against real git repositories in temporary directories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mergePlan, runMerge, parseMergeTree } from "../mods/git-grapher/lib/merge.js";
import * as fs from "node:fs";
import * as F from "./fx.js";

const { ad, commit } = F;
const sh = F.raw;

const repo = () => F.repo({ "f.md": "a\nb\nc\n" }, { message: "base" });

test("parseMergeTree", () => {
  assert.deepEqual(parseMergeTree("abc\0f.md\0g\0\0" + "1\0f.md\0CONFLICT\0msg\n\0"), { tree: "abc", files: ["f.md", "g"] });
  assert.deepEqual(parseMergeTree("abc\0"), { tree: "abc", files: [] });
});

test("mergePlan: source ahead → fast-forward with exact added path and source OID", async () => {
  const d = repo(); F.git(d, "switch", "-qc", "ff"); const oid = F.commit(d, "g", "1\n"); F.git(d, "switch", "-q", "main"); const before = F.snap(d);
  const p = await mergePlan(ad, d, "ff"); assert.deepEqual([p.kind, p.blockers, p.files], ["ff", [], [{ status: "A", path: "g" }]]); assert.equal(p.basis.src, oid); F.same(d, before);
});
test("mergePlan: disjoint divergent commits → merge commit planned", async () => {
  const { d, source } = divergent(), before = F.snap(d), p = await mergePlan(ad, d, "side");
  assert.equal(p.kind, "merge"); assert.match(p.after, /merge commit/); assert.equal(p.basis.src, source); F.same(d, before);
});
test("mergePlan: overlapping edits → conflict names without a blocker", async () => {
  const d = repo(); F.git(d, "switch", "-qc", "side"); F.commit(d, "f.md", "side\n"); F.git(d, "switch", "-q", "main"); F.commit(d, "f.md", "main\n"); const before = F.snap(d);
  const p = await mergePlan(ad, d, "side"); assert.deepEqual([p.kind, p.conflicts, p.blockers], ["conflict", ["f.md"], []]); F.same(d, before);
});
test("mergePlan: source already contained → blocked without mutation", async () => {
  const d = repo(), before = F.snap(d); assert.match((await mergePlan(ad, d, "main")).blockers[0], /already contains/); F.same(d, before);
});
test("mergePlan: tracked local edit → blocked without mutation", async () => {
  const { d } = divergent(); F.put(d, "f.md", "dirty\n"); const before = F.snap(d);
  assert.match((await mergePlan(ad, d, "side")).blockers.join(), /uncommitted/); F.same(d, before);
});
test("mergePlan: unrelated untracked file → warning without blocker", async () => {
  const { d } = divergent(); F.put(d, "new", "untracked\n"); const before = F.snap(d), p = await mergePlan(ad, d, "side");
  assert.deepEqual(p.blockers, []); assert.match(p.warnings.join(), /untracked/); F.same(d, before);
});
test("mergePlan: detached HEAD → blocked without mutation", async () => {
  const { d } = divergent(); F.git(d, "switch", "-q", "--detach"); const before = F.snap(d);
  assert.match((await mergePlan(ad, d, "side")).blockers[0], /detached/); F.same(d, before);
});

function divergent() {
  const d = repo(); sh(d, "switch", "-qc", "side"); const source = commit(d, "h", "1\n");
  sh(d, "switch", "-q", "main"); const head = commit(d, "i", "1\n"); return { d, source, head };
}
// stale merge plans must not write
test("runMerge: target moves after plan → refused and state preserved", async () => {
  const { d } = divergent(), plan = await mergePlan(ad, d, "side"); commit(d, "j", "1\n");
  const before = F.snap(d), r = await runMerge(ad, d, plan);
  assert.deepEqual([r.outcome, r.reason], ["refused", "stale"]); F.same(d, before);
});
// on-branch merge joins the two shown histories
test("runMerge: divergent branches → completed with exact parents and tree", async () => {
  const { d, head, source } = divergent(), tree = F.git(d, "merge-tree", "--write-tree", "HEAD", "side");
  const r = await runMerge(ad, d, await mergePlan(ad, d, "side"));
  assert.equal(r.outcome, "completed");
  assert.equal(F.git(d, "rev-parse", "HEAD^1"), head); assert.equal(F.git(d, "rev-parse", "HEAD^2"), source);
  assert.equal(F.git(d, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(F.raw(d, "show", ":h"), "1\n"); assert.equal(F.raw(d, "show", ":i"), "1\n");
  assert.equal(F.git(d, "status", "--porcelain"), "");
});
// native merge conflicts stay available to Conflict Mode
test("runMerge: overlapping edits → conflict with HEAD preserved and merge state", async () => {
  const d = repo(); F.git(d, "switch", "-qc", "side"); const source = commit(d, "f.md", "side\n");
  F.git(d, "switch", "-q", "main"); const head = commit(d, "f.md", "main\n");
  const r = await runMerge(ad, d, await mergePlan(ad, d, "side"));
  assert.deepEqual([r.outcome, r.unmerged], ["conflict", 1]);
  assert.equal(F.git(d, "rev-parse", "HEAD"), head); assert.equal(F.git(d, "rev-parse", "MERGE_HEAD"), source);
  assert.equal(F.raw(d, "ls-files", "-u").split("\n").filter(Boolean).length, 3);
  assert.match((await mergePlan(ad, d, "side")).blockers.join(), /merge is in progress/);
});
// off-branch fast-forward must leave caller files and index alone
test("runMerge: off-branch fast-forward → only target ref advances", async () => {
  const { d, source, head } = topic(), before = F.snap(d);
  const r = await runMerge(ad, d, await mergePlan(ad, d, "topic", "target"));
  assert.equal(r.outcome, "completed"); assert.equal(F.git(d, "rev-parse", "target"), source);
  const after = F.snap(d); assert.equal(F.git(d, "rev-parse", "HEAD"), head);
  assert.deepEqual(after.files, before.files); assert.equal(after.index, before.index); assert.deepEqual(after.states, before.states);
});
// off-branch merge must retain ordered parents and caller state
test("runMerge: off-branch divergence → exact merge tree with caller state preserved", async () => {
  const { d, source } = topic(); F.git(d, "switch", "-q", "target"); const target = F.commit(d, "target-file", "target\n"); F.git(d, "switch", "-q", "main");
  const before = F.snap(d), tree = F.git(d, "merge-tree", "--write-tree", "target", "topic");
  const r = await runMerge(ad, d, await mergePlan(ad, d, "topic", "target"));
  assert.equal(r.outcome, "completed");
  assert.equal(F.git(d, "rev-parse", "target^1"), target); assert.equal(F.git(d, "rev-parse", "target^2"), source);
  assert.equal(F.git(d, "rev-parse", "target^{tree}"), tree);
  const after = F.snap(d); assert.equal(after.head, before.head); assert.equal(after.branch, before.branch);
  assert.equal(after.index, before.index); assert.deepEqual(after.files, before.files); assert.deepEqual(after.states, before.states);
});
// a checked-out destination cannot be updated behind its worktree
test("mergePlan: target checked out in linked worktree → blocked", async () => {
  const { d } = topic(), wt = join(F.dir("linked"), "wt"); F.git(d, "worktree", "add", "-q", wt, "target");
  assert.match((await mergePlan(ad, d, "topic", "target")).blockers.join(), /checked out in/);
});
// an off-branch conflict cannot be left in the caller's index
test("mergePlan: off-branch overlapping edits → blocked", async () => {
  const { d } = topic(); F.git(d, "switch", "-q", "target"); F.commit(d, "f", "target\n");
  F.git(d, "switch", "-q", "topic"); F.commit(d, "f", "topic\n"); F.git(d, "switch", "-q", "main");
  assert.match((await mergePlan(ad, d, "topic", "target")).blockers.join(), /conflict/);
});

// The final diff in the fresh plan is shared by the pre-fix and current implementations.
// Inject after it returns, before either implementation begins the merge write.
const afterPlan = (d, effect) => F.race({ cwd: d, at: "after", when: (k, a) => k === "run" && a.includes("diff") && a.includes("--name-status"), do: effect });
function topic() {
  const d = F.repo(); F.git(d, "branch", "target"); F.git(d, "branch", "elsewhere");
  F.git(d, "switch", "-qc", "topic"); const source = F.commit(d, "new", "approved\n");
  F.git(d, "switch", "-q", "main");
  return { d, source, head: F.git(d, "rev-parse", "HEAD") };
}

// Merge the approved source OID even if its ref advances after planning.
test("runMerge: source moves after planning → completed with approved OID", async () => {
  const { d, source } = topic();
  F.git(d, "switch", "-q", "topic"); const newer = F.commit(d, "secret", "not approved\n");
  F.git(d, "reset", "--hard", source); F.git(d, "switch", "-q", "main");
  const plan = await mergePlan(F.ad, d, "refs/heads/topic");
  const race = afterPlan(d, () => F.git(d, "update-ref", "refs/heads/topic", newer));
  const r = await runMerge(race.ad, d, plan); F.fired(race);
  assert.equal(r.outcome, "completed");
  assert.equal(F.git(d, "rev-parse", "main"), source);
  assert.equal(F.git(d, "rev-parse", "topic"), newer);
  assert.equal(fs.existsSync(join(d, "secret")), false);
  assert.equal(F.raw(d, "show", ":new"), "approved\n");
  assert.equal(fs.readFileSync(join(d, "new"), "utf8"), "approved\n");
});

// Refuse an on-branch merge when HEAD switches after planning.
test("runMerge: HEAD switches after planning → refused with actor state preserved", async () => {
  const { d, head } = topic(), plan = await mergePlan(F.ad, d, "refs/heads/topic");
  const race = afterPlan(d, () => F.git(d, "switch", "-q", "elsewhere"));
  const r = await runMerge(race.ad, d, plan); F.fired(race);
  assert.equal(r.outcome, "refused"); F.same(d, race.record.snapshot);
  assert.equal(F.git(d, "rev-parse", "main"), head);
  assert.equal(F.git(d, "rev-parse", "elsewhere"), head);
});

// Refuse an off-branch merge if its destination becomes checked out.
test("runMerge: destination checked out after planning → refused with actor state preserved", async () => {
  const { d, head } = topic(), plan = await mergePlan(F.ad, d, "refs/heads/topic", "target");
  const race = afterPlan(d, () => F.git(d, "switch", "-q", "target"));
  const r = await runMerge(race.ad, d, plan); F.fired(race);
  assert.equal(r.outcome, "refused"); F.same(d, race.record.snapshot);
  assert.equal(F.git(d, "rev-parse", "target"), head);
});

// Use qualified branch refs to distinguish same-named tags.
test("mergePlan: branch and tag share a name → qualified branch OID", async () => {
  const { d, source, head } = topic(); F.git(d, "tag", "topic", head);
  const plan = await mergePlan(F.ad, d, "refs/heads/topic");
  assert.equal(plan.basis.src, source); assert.equal(plan.title, "Merge topic into main");
});

// Report uncertainty if HEAD switches inside the checked merge script.
test("runMerge: HEAD switches inside merge script → unknown with wrong-branch OID reported", async () => {
  const { d, source, head } = topic(), plan = await mergePlan(F.ad, d, "refs/heads/topic");
  const race = F.inside(d, "merge", ["switch", "-q", "elsewhere"]);
  const r = await runMerge(race.ad, d, plan); F.fired(race);
  assert.equal(r.outcome, "unknown"); assert.match(r.stderr, /elsewhere/);
  assert.equal(F.git(d, "rev-parse", "main"), head);
  // accepted: Git cannot lock HEAD against another terminal between the check and merge.
  assert.equal(F.git(d, "rev-parse", "elsewhere"), source);
  assert.equal(F.git(d, "symbolic-ref", "HEAD"), "refs/heads/elsewhere");
  assert.equal(F.raw(d, "show", ":new"), "approved\n");
  assert.equal(fs.readFileSync(join(d, "new"), "utf8"), "approved\n");
  assert.equal(F.raw(d, "ls-files", "-u"), "");
});

// Report uncertainty if a destination is checked out inside the update script.
test("runMerge: destination checked out inside CAS script → unknown with stale index", async () => {
  const { d, source, head } = topic(), plan = await mergePlan(F.ad, d, "refs/heads/topic", "target");
  const before = F.snap(d), race = F.inside(d, "update-ref", ["switch", "-q", "target"]);
  const r = await runMerge(race.ad, d, plan); F.fired(race);
  assert.equal(r.outcome, "unknown"); assert.match(r.stderr, /^target was checked out while ggit moved it/);
  // accepted: update-ref CAS cannot prevent another terminal checking out the target.
  assert.equal(F.git(d, "rev-parse", "target"), source);
  assert.equal(F.git(d, "rev-parse", "main"), head);
  assert.equal(F.git(d, "symbolic-ref", "HEAD"), "refs/heads/target");
  assert.equal(F.raw(d, "ls-files", "-s", "-z"), before.index);
  assert.deepEqual(F.snap(d).files, before.files);
  assert.equal(fs.existsSync(join(d, "new")), false);
});
