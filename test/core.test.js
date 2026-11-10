// Real git in temp dirs. Adapter mirrors herdrAdapter (env -u ..., non-interactive) with spawnSync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGgit, parseFetch, parseVersion } from "../mods/git-grapher/lib/core.js";
import * as fs from "node:fs";
import * as F from "./fx.js";

const { ad } = F;
const g = createGgit(ad);
const sh = F.raw;

const setup = F.pair;

test("version gate", async () => {
  assert.deepEqual(parseVersion("git version 2.50.1 (Apple Git-155)"), [2, 50, 1]);
  assert.equal((await g.version()).supported, true);
});

test("target: absolute paths, bare and linked worktree", async () => {
  const { remote, a, dir } = setup();
  const t = await g.target(a);
  assert.equal(t.bare, false); assert.ok(t.commonDir.startsWith("/")); assert.ok(t.root.endsWith("/a"));
  const tb = await g.target(remote);
  assert.equal(tb.bare, true); assert.equal(tb.root, null);
  sh(a, "worktree", "add", "-q", join(dir, "wt"), "-b", "wt");
  const tw = await g.target(join(dir, "wt"));
  assert.equal(tw.commonDir, t.commonDir); assert.notEqual(tw.gitDir, t.gitDir);
  assert.equal((await g.target(dir)).ok, false);
});

test("header + fetch: behind count updates only after fetch", async () => {
  const { a, b } = setup();
  writeFileSync(join(a, "f"), "2\n"); sh(a, "commit", "-qam", "2"); sh(a, "push", "-q");
  const t = await g.target(b);
  let h = await g.header(t);
  assert.equal(h.branch, "main"); assert.equal(h.upstream, "origin/main"); assert.equal(h.behind, 0);
  const expected = F.git(a, "rev-parse", "HEAD");
  const f = await g.fetch(t, h);
  assert.equal(F.git(b, "rev-parse", "origin/main"), expected);
  assert.equal(f.outcome, "completed"); assert.equal(f.refs[0].ref, "refs/remotes/origin/main");
  h = await g.header(t);
  assert.equal(h.behind, 1);
  assert.equal((await g.fetch(t, h)).outcome, "noop");
  writeFileSync(join(b, "new"), "x"); writeFileSync(join(b, "f"), "dirty\n");
  h = await g.header(t);
  assert.equal(h.untracked, 1); assert.equal(h.unstaged, 1);
});

test("fetch without upstream is refused before running", async () => {
  const { b } = setup();
  sh(b, "switch", "-qc", "solo");
  const t = await g.target(b);
  assert.equal((await F.refused(b, async () => g.fetch(t, await g.header(t)))).reason, "no-upstream");
});

test("in-progress: revert, merge (git refuses), none", async () => {
  const { a } = setup();
  const t = await g.target(a);
  assert.deepEqual((await g.inProgress(t)).states, []);
  writeFileSync(join(a, "f"), "2\n"); sh(a, "commit", "-qam", "2");
  sh(a, "revert", "--no-commit", "HEAD");
  assert.deepEqual((await g.inProgress(t)).states.map((s) => s.kind), ["revert"]);
  sh(a, "revert", "--abort");
  sh(a, "switch", "-qc", "x"); writeFileSync(join(a, "f"), "x\n"); sh(a, "commit", "-qam", "x");
  sh(a, "switch", "-q", "main"); writeFileSync(join(a, "f"), "m\n"); sh(a, "commit", "-qam", "m");
  assert.equal(F.attempt(a, "merge", "x").code, 1);
  const s = (await g.inProgress(t)).states;
  assert.equal(s[0].kind, "merge"); assert.equal(s[0].gitRefuses, true);
});

test("parseFetch", () => {
  assert.deepEqual(parseFetch("  aaa bbb refs/remotes/origin/main\n= ccc ccc refs/remotes/origin/x\n"),
    [{ flag: " ", old: "aaa", new: "bbb", ref: "refs/remotes/origin/main" }, { flag: "=", old: "ccc", new: "ccc", ref: "refs/remotes/origin/x" }]);
});

// ---- writes

for (const condition of ["clean", "untracked only"]) test(`stashPush: ${condition} without untracked flag → noop with state preserved`, async () => {
  const a = F.repo(); if (condition === "untracked only") F.put(a, "new", "x"); const before = F.snap(a);
  assert.equal((await g.stashPush({ root: a })).outcome, "noop"); F.same(a, before);
});
test("stashPush: untracked file included → exact third-parent bytes and clean worktree", async () => {
  const a = F.repo(), head = F.git(a, "rev-parse", "HEAD"), index = F.raw(a, "ls-files", "-s", "-z"); F.put(a, "new", "x");
  const r = await g.stashPush({ root: a }, ["-u"]); assert.deepEqual([r.outcome, r.left.untracked], ["completed", 0]);
  assert.equal(F.git(a, "rev-parse", "refs/stash"), r.stash); assert.equal(F.raw(a, "show", `${r.stash}^3:new`), "x");
  assert.equal(fs.existsSync(join(a, "new")), false); assert.equal(F.git(a, "rev-parse", "HEAD"), head); assert.equal(F.raw(a, "ls-files", "-s", "-z"), index);
});
test("stashPush: tracked edit → exact saved blob and original index restored", async () => {
  const a = F.repo(), before = F.snap(a); F.put(a, "f", "dirty\n"); const r = await g.stashPush({ root: a });
  assert.equal(r.outcome, "completed"); assert.equal(F.git(a, "rev-parse", "refs/stash"), r.stash); assert.equal(F.raw(a, "show", `${r.stash}:f`), "dirty\n");
  const after = F.snap(a); assert.equal(after.head, before.head); assert.equal(after.index, before.index); assert.deepEqual(after.files, before.files);
});

test("stashPop: selected top entry → its bytes applied and only that OID removed", async () => {
  const { a, top, older } = twoStashes(), before = F.snap(a), r = await g.stashPop({ root: a }, top);
  assert.deepEqual([r.outcome, r.entryRemoved, r.applied], ["completed", true, "all"]);
  assert.equal(readFileSync(join(a, "f"), "utf8"), "two\n"); assert.equal(F.raw(a, "stash", "list", "--format=%H"), `${older}\n`);
  const after = F.snap(a); assert.equal(after.head, before.head); assert.equal(after.index, before.index);
  assert.equal(after.refs, before.refs.replace(top, older)); assert.deepEqual(after.files.other, before.files.other);
});
test("stashPop: selected OID already gone → refused without touching next entry", async () => {
  const { a, top, older } = twoStashes(); F.git(a, "stash", "drop", "-q", "stash@{0}");
  assert.equal((await F.refused(a, () => g.stashPop({ root: a }, top))).reason, "stash-gone");
  assert.equal(F.raw(a, "stash", "list", "--format=%H"), `${older}\n`);
});
test("stashPop: selected entry conflicts → exact stages and stash entry retained", async () => {
  const { a, top, older } = twoStashes(), head = F.commit(a, "f", "committed\n");
  const base = F.git(a, "rev-parse", `${older}^1:f`), ours = F.git(a, "rev-parse", "HEAD:f"), theirs = F.git(a, "rev-parse", `${older}:f`);
  const r = await g.stashPop({ root: a }, older); assert.deepEqual([r.outcome, r.entryRemoved, r.applied], ["conflict", false, "some"]);
  assert.equal(F.raw(a, "stash", "list", "--format=%H"), `${top}\n${older}\n`); assert.equal(F.git(a, "rev-parse", "HEAD"), head);
  assert.equal(F.raw(a, "ls-files", "-u", "--", "f"), `100644 ${base} 1\tf\n100644 ${ours} 2\tf\n100644 ${theirs} 3\tf\n`);
  assert.equal(readFileSync(join(a, "f"), "utf8"), "<<<<<<< Updated upstream\ncommitted\n=======\none\n>>>>>>> Stashed changes\n");
});

// Verify branch creation by its resulting ref and OID.
test("branchCreate: create only → new ref at requested OID and caller preserved", async () => {
  const a = F.repo(), before = F.snap(a), oid = F.git(a, "rev-parse", "HEAD");
  const r = await g.branchCreate({ root: a }, "b1");
  assert.deepEqual([r.outcome, r.oid, r.head], ["completed", oid, "main"]);
  assert.equal(F.git(a, "rev-parse", "refs/heads/b1"), oid);
  F.same(a, { ...before, refs: `refs/heads/b1 ${oid}\n${before.refs}` });
});
test("branchCreate: create and switch → new branch selected at requested OID", async () => {
  const a = F.repo(), before = F.snap(a), oid = F.git(a, "rev-parse", "HEAD");
  const r = await g.branchCreate({ root: a }, "b2", { switchTo: true });
  assert.deepEqual([r.outcome, r.oid, r.head], ["completed", oid, "b2"]);
  assert.equal(F.git(a, "rev-parse", "refs/heads/b2"), oid);
  F.same(a, { ...before, branch: "refs/heads/b2\n", refs: `refs/heads/b2 ${oid}\n${before.refs}` });
});
test("branchCreate: invalid name → refused without mutation", async () => {
  const a = F.repo(); assert.equal((await F.refused(a, () => g.branchCreate({ root: a }, "bad..name"))).reason, "invalid-name");
});
test("branchCreate: switch would overwrite local edit → refused without creating branch", async () => {
  const a = F.repo(); F.commit(a, "f", "new base\n"); F.put(a, "f", "local\n");
  const r = await F.refused(a, () => g.branchCreate({ root: a }, "b3", { switchTo: true, from: "HEAD~1" }));
  assert.equal(r.created, false); assert.equal(F.attempt(a, "show-ref", "--verify", "--quiet", "refs/heads/b3").code, 1);
});

test("push: new branch → upstream configured and exact remote ref created", async () => {
  const { a, remote } = setup(); F.git(a, "switch", "-qc", "feat"); const oid = F.commit(a, "g", "1\n"), t = { root: a };
  const r = await g.push(t, await g.header(t)); assert.equal(r.outcome, "completed");
  assert.equal(F.git(remote, "rev-parse", "refs/heads/feat"), oid); assert.equal(F.git(a, "rev-parse", "refs/remotes/origin/feat"), oid);
  assert.equal(F.git(a, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feat"); assert.equal(F.raw(a, "show", ":g"), "1\n");
});
test("push: remote already matches → noop with both repositories preserved", async () => {
  const { a, remote } = setup(), localBefore = F.snap(a), remoteBefore = F.snap(remote), t = { root: a };
  assert.equal((await g.push(t, await g.header(t))).outcome, "noop"); F.same(a, localBefore); F.same(remote, remoteBefore);
});
test("push: remote diverged → refused with both repositories preserved", async () => {
  const { a, b, remote } = setup(); F.commit(a, "f", "a\n"); F.git(a, "push", "-q"); F.commit(b, "f", "b\n");
  const before = F.snap(remote), t = { root: b }, r = await F.refused(b, async () => g.push(t, await g.header(t)));
  assert.equal(r.refs[0].flag, "!"); F.same(remote, before);
});

// A push repeated after a timeout must send the original click-time OID, even if HEAD has advanced.
test("push: commit made after the click → the clicked commit pushed; the same push again → noop", async () => {
  const { a, remote } = setup(), t = { root: a }; const clicked = F.commit(a, "f", "clicked\n"), h = await g.header(t);
  F.commit(a, "f", "later\n");
  assert.equal((await g.push(t, h)).outcome, "completed"); assert.equal(F.git(remote, "rev-parse", "refs/heads/main"), clicked);
  const before = F.snap(remote);
  assert.equal((await g.push(t, h)).outcome, "noop"); F.same(remote, before);
});

// pull fast-forward advances the local branch to the remote tree
test("pull: fetched fast-forward → exact remote OID and bytes", async () => {
  const { a, b } = setup(), oid = F.commit(a, "f", "2\n"); F.git(a, "push", "-q");
  assert.equal((await g.pull({ root: b })).outcome, "completed"); assert.equal(F.git(b, "rev-parse", "HEAD"), oid);
  assert.equal(F.raw(b, "show", ":f"), "2\n"); assert.equal(readFileSync(join(b, "f"), "utf8"), "2\n");
});
// pull with no incoming commits is a no-op
test("pull: already current → noop with HEAD and files unchanged", async () => {
  const { b } = setup(); F.git(b, "remote", "set-head", "origin", "main"); const before = F.snap(b); assert.equal((await g.pull({ root: b })).outcome, "noop");
  const after = F.snap(b); assert.equal(after.head, before.head); assert.equal(after.refs, before.refs); assert.equal(after.index, before.index); assert.deepEqual(after.files, before.files);
});
// Git refuses integration over an overlapping local edit; fetch effects covered separately
test("pull: local edit after fetch → refused with meaningful state preserved", async () => {
  const { a, b } = setup(); F.commit(a, "f", "2\n"); F.git(a, "push", "-q"); F.git(b, "fetch", "-q");
  F.put(b, "f", "precious\n"); const before = F.snap(b); assert.equal(before.states.ORIG_HEAD, null);
  const r = await g.pull({ root: b }); assert.deepEqual([r.outcome, r.headMoved], ["refused", false]);
  // Native merge writes ORIG_HEAD before refusing; pin it, then compare other meaningful state.
  // Exclude FETCH_HEAD because plain git pull can fetch successfully before integration is refused.
  assert.equal(F.git(b, "rev-parse", "ORIG_HEAD"), before.head.trim());
  const after = F.snap(b); assert.deepEqual({ ...after, states: { ...after.states, ORIG_HEAD: null } }, before);
});
// divergent overlapping pull leaves native conflict state
test("pull: divergent edits → conflict with original HEAD and incoming MERGE_HEAD", async () => {
  const { a, b } = setup(); F.git(b, "config", "pull.rebase", "false"); const incoming = F.commit(a, "f", "a\n"); F.git(a, "push", "-q"); const head = F.commit(b, "f", "b\n");
  const r = await g.pull({ root: b }); assert.deepEqual([r.outcome, r.unmerged], ["conflict", 1]);
  assert.equal(F.git(b, "rev-parse", "HEAD"), head); assert.equal(F.git(b, "rev-parse", "MERGE_HEAD"), incoming);
});

// worktree creation pins the requested revision
for (const detached of [false, true]) test(`worktreeAdd: ${detached ? "detached" : "new branch"} → requested OID and clean index`, async () => {
  const { a, dir } = setup(), t = await g.target(a), oid = F.git(a, "rev-parse", "HEAD"), wt = join(dir, "wt");
  const r = await g.worktreeAdd(t, wt, detached ? { from: oid } : { branch: "side", from: oid });
  assert.equal(r.outcome, "completed"); assert.equal(F.git(wt, "rev-parse", "HEAD"), oid);
  assert.equal(F.git(wt, "branch", "--show-current"), detached ? "" : "side");
  assert.equal(F.raw(wt, "show", ":f"), "1\n"); assert.equal(readFileSync(join(wt, "f"), "utf8"), "1\n");
});
// worktree existing paths are never replaced
test("worktreeAdd: existing path → refused with repository preserved", async () => {
  const { a, dir } = setup(), wt = join(dir, "occupied"); mkdirSync(wt); F.put(wt, "precious", "keep\n");
  const before = F.snap(a), r = await g.worktreeAdd({ root: a }, wt);
  assert.equal(r.outcome, "refused"); F.same(a, before); assert.equal(readFileSync(join(wt, "precious"), "utf8"), "keep\n");
});
// revert records the inverse as a new commit
test("revert: ordinary commit → inverse tree and previous HEAD parent", async () => {
  const { a } = setup(), original = F.git(a, "rev-parse", "HEAD^{tree}"), tip = F.commit(a, "f", "2\n");
  const r = await g.revert({ root: a }, tip); assert.equal(r.outcome, "completed");
  assert.equal(F.git(a, "rev-parse", "HEAD^"), tip); assert.equal(F.git(a, "rev-parse", "HEAD^{tree}"), original);
  assert.equal(F.raw(a, "show", ":f"), "1\n"); assert.equal(readFileSync(join(a, "f"), "utf8"), "1\n");
});
// revert keeps native conflict state for resolution
test("revert: overlapping later edit → conflict with HEAD unchanged", async () => {
  const { a } = setup(), tip = F.commit(a, "f", "2\n"), head = F.commit(a, "f", "3\n");
  const r = await g.revert({ root: a }, tip); assert.equal(r.outcome, "conflict");
  assert.equal(F.git(a, "rev-parse", "HEAD"), head); assert.equal(F.git(a, "rev-parse", "REVERT_HEAD"), tip);
  assert.equal(F.raw(a, "ls-files", "-u").split("\n").filter(Boolean).length, 3);
});
// a merge revert needs a parent choice unavailable in this action
test("revert: merge commit → refused without mutation", async () => {
  const { a } = setup(); F.git(a, "switch", "-qc", "side"); F.commit(a, "g", "side\n"); F.git(a, "switch", "-q", "main"); F.git(a, "merge", "--no-ff", "-m", "merge", "side");
  const before = F.snap(a), r = await g.revert({ root: a }, "HEAD");
  assert.deepEqual([r.outcome, r.reason], ["refused", "merge-commit"]); F.same(a, before);
});
// detached checkout uses the requested commit
test("checkoutDetached: clean worktree → detached at requested OID", async () => {
  const { a } = setup(), oid = F.git(a, "rev-parse", "HEAD"); F.commit(a, "f", "2\n");
  assert.equal((await g.checkoutDetached({ root: a }, oid)).outcome, "completed");
  assert.equal(F.git(a, "rev-parse", "HEAD"), oid); assert.equal(F.attempt(a, "symbolic-ref", "-q", "HEAD").code, 1);
  assert.equal(F.raw(a, "show", ":f"), "1\n"); assert.equal(readFileSync(join(a, "f"), "utf8"), "1\n");
});
// detached checkout cannot discard an overlapping edit
test("checkoutDetached: dirty worktree → refused without mutation", async () => {
  const { a } = setup(), oid = F.git(a, "rev-parse", "HEAD"); F.commit(a, "f", "2\n"); F.put(a, "f", "precious\n");
  const before = F.snap(a); assert.equal((await g.checkoutDetached({ root: a }, oid)).outcome, "refused"); F.same(a, before);
});
// remote selection creates its local tracking branch
test("switchBranch: fetched remote branch → matching local branch and upstream", async () => {
  const { a } = setup(), oid = F.git(a, "rev-parse", "HEAD"); F.git(a, "update-ref", "refs/remotes/origin/r", oid);
  const r = await g.switchBranch({ root: a }, "origin/r", { remote: true });
  assert.deepEqual([r.outcome, r.branch], ["completed", "r"]); assert.equal(F.git(a, "rev-parse", "r"), oid);
  assert.equal(F.git(a, "rev-parse", "--abbrev-ref", "r@{u}"), "origin/r");
});
// remote switch must not overwrite a preexisting local branch
test("switchBranch: local name already exists → refused without mutation", async () => {
  const { a } = setup(); F.git(a, "branch", "r"); F.git(a, "update-ref", "refs/remotes/origin/r", "HEAD");
  const before = F.snap(a); assert.equal((await g.switchBranch({ root: a }, "origin/r", { remote: true })).outcome, "refused"); F.same(a, before);
});

// literal path staging must not interpret flags or globs
test("stage: literal unusual path → exact index blob and unchanged worktree", async () => {
  const { a } = setup(); F.put(a, "-n *", "x\n"); F.put(a, "u", "u\n");
  const before = F.snap(a); assert.equal((await g.stage({ root: a }, ["-n *"])).outcome, "completed");
  assert.equal(F.raw(a, "show", ":-n *"), "x\n"); assert.equal(F.attempt(a, "show", ":u").code, 128);
  assert.deepEqual(F.snap(a).files, before.files); assert.equal(F.snap(a).refs, before.refs);
});
// stage-all includes tracked and untracked paths
test("stage: all paths → exact staged blobs", async () => {
  const { a } = setup(); F.put(a, "f", "2\n"); F.put(a, "u", "u\n");
  assert.equal((await g.stage({ root: a })).outcome, "completed");
  assert.equal(F.raw(a, "show", ":f"), "2\n"); assert.equal(F.raw(a, "show", ":u"), "u\n");
  assert.equal(F.raw(a, "diff", "--name-only"), "");
});
// unstage preserves working bytes
for (const all of [false, true]) test(`unstage: ${all ? "all" : "one"} paths → index reset and work retained`, async () => {
  const { a } = setup(); F.put(a, "f", "2\n"); F.put(a, "u", "u\n"); F.git(a, "add", ".");
  const before = F.snap(a); assert.equal((await g.unstage({ root: a }, all ? null : ["f"])).outcome, "completed");
  assert.equal(F.raw(a, "show", ":f"), "1\n"); assert.deepEqual(F.snap(a).files, before.files);
  assert.equal(F.raw(a, "diff", "--cached", "--name-only"), all ? "" : "u\n");
});
// discard restores from index and removes only requested untracked files
for (const all of [false, true]) test(`discard: ${all ? "all" : "selected"} paths → index bytes restored`, async () => {
  const { a } = setup(); F.put(a, "f", "2\n"); F.put(a, "u", "u\n"); F.put(a, "keep", "k\n");
  const index = F.raw(a, "ls-files", "-s", "-z");
  assert.equal((await g.discard({ root: a }, all ? null : [{ path: "u", untracked: true }, { path: "f" }])).outcome, "completed");
  assert.equal(readFileSync(join(a, "f"), "utf8"), "1\n"); assert.equal(fs.existsSync(join(a, "u")), false);
  assert.equal(fs.existsSync(join(a, "keep")), !all); assert.equal(F.raw(a, "ls-files", "-s", "-z"), index);
});
// an empty staged change cannot create a commit
test("commit: nothing staged → refused without mutation", async () => {
  const { a } = setup(), before = F.snap(a); assert.equal((await g.commit({ root: a }, "nothing")).outcome, "refused"); F.same(a, before);
});
// commit strips template comments and records the staged tree
test("commit: staged change and template comments → exact tree parent and message", async () => {
  const { a } = setup(), parent = F.git(a, "rev-parse", "HEAD"); F.put(a, "f", "4\n"); F.git(a, "add", "f"); const tree = F.git(a, "write-tree");
  const r = await g.commit({ root: a }, "sub\n\nbody\n# a template comment"); assert.equal(r.outcome, "completed");
  assert.equal(F.git(a, "rev-parse", "HEAD^"), parent); assert.equal(F.git(a, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(F.raw(a, "show", ":f"), "4\n"); assert.equal(await g.lastMessage({ root: a }), "sub\n\nbody");
});
// amend replaces the tip without adding another parent
test("commit: amend → replacement message with same tree and parents", async () => {
  const { a } = setup(); F.commit(a, "f", "4\n"); const parent = F.git(a, "rev-parse", "HEAD^"), tree = F.git(a, "rev-parse", "HEAD^{tree}");
  assert.equal((await g.commit({ root: a }, "sub2", { amend: true })).outcome, "completed");
  assert.equal(F.git(a, "rev-parse", "HEAD^"), parent); assert.equal(F.git(a, "rev-parse", "HEAD^{tree}"), tree); assert.equal(await g.lastMessage({ root: a }), "sub2");
});
// Git expands the commit template path
test("templatePath: home-relative config → absolute private-home path", async () => {
  const { a } = setup(); F.git(a, "config", "commit.template", "~/tpl.txt"); assert.equal(await g.templatePath({ root: a }), join(F.ROOT, "tpl.txt"));
});

for (const paths of [["x"], null]) test(`unstage: unborn branch ${paths ? "selected path" : "all paths"} → exact remaining index entries`, async () => {
  const dir = F.repo({}); F.put(dir, "x", "1\n"); F.put(dir, "y", "2\n"); F.git(dir, "add", ".");
  const before = F.snap(dir), y = F.raw(dir, "ls-files", "-s", "-z", "--", "y");
  const r = await g.unstage({ root: dir }, paths ?? undefined); assert.equal(r.outcome, "completed");
  F.same(dir, { ...before, index: paths ? y : "" });
});

test("worktreeRemove: dirty linked worktree → refused with branch and files preserved", async () => {
  const { dir, a } = setup(), wt = join(dir, "wt"); F.git(a, "worktree", "add", "-q", "-b", "side", wt); F.put(wt, "f", "dirty\n");
  const before = F.snap(a); await F.refused(wt, () => g.worktreeRemove({ root: a }, wt, { branch: "side" })); F.same(a, before);
});
test("worktreeRemove: clean linked worktree → registration directory and merged branch removed", async () => {
  const { dir, a } = setup(), wt = join(dir, "wt"); F.git(a, "worktree", "add", "-q", "-b", "side", wt); const before = F.snap(a);
  const r = await g.worktreeRemove({ root: a }, wt, { branch: "side" }); assert.deepEqual([r.operation, r.outcome], ["wt-remove", "completed"]);
  assert.equal(fs.existsSync(wt), false); assert.equal(F.attempt(a, "show-ref", "--verify", "--quiet", "refs/heads/side").code, 1);
  assert.equal(F.raw(a, "worktree", "list", "--porcelain").includes(wt), false);
  F.same(a, { ...before, refs: before.refs.replace(/^refs\/heads\/side .*\n/m, "") });
});

for (const lock of [true, false]) test(`worktreeLock: ${lock ? "unlocked" : "locked"} worktree → ${lock ? "locked" : "unlocked"} registration`, async () => {
  const a = F.repo(), wt = join(F.dir("linked"), "wt"); F.git(a, "worktree", "add", "-q", "--detach", wt); if (!lock) F.git(a, "worktree", "lock", wt);
  const before = F.snap(a), linked = F.snap(wt), r = await g.worktreeLock({ root: a }, wt, lock);
  assert.deepEqual([r.operation, r.outcome], ["wt-lock", "completed"]); assert.equal(F.raw(a, "worktree", "list", "--porcelain").includes("\nlocked\n"), lock);
  F.same(a, before); F.same(wt, linked);
});

test("worktreeAdd: path inside repository → refused without mutation", async () => {
  const a = F.repo(); assert.equal((await F.refused(a, () => g.worktreeAdd({ root: a }, join(a, "inner"), { from: "HEAD" }))).reason, "inside-repo");
});
test("worktreeAdd: missing parent directories → new worktree at exact branch OID", async () => {
  const a = F.repo(), path = join(F.dir("parents"), "x", "y"), head = F.git(a, "rev-parse", "HEAD");
  assert.equal((await g.worktreeAdd({ root: a }, path, { branch: "y", from: "HEAD" })).outcome, "completed");
  assert.equal(F.git(path, "rev-parse", "HEAD"), head); assert.equal(F.git(path, "symbolic-ref", "HEAD"), "refs/heads/y");
  assert.equal(F.raw(path, "ls-files", "-s", "-z"), F.raw(a, "ls-files", "-s", "-z")); assert.deepEqual(F.snap(path).files, F.snap(a).files);
});

// worktree operation labels must not be confused with worktree creation results
test("worktreePrune: missing worktree directory → stale registration removed", async () => {
  const a = F.repo(), wt = join(F.dir("prune"), "wt"); F.git(a, "worktree", "add", "-q", "--detach", wt);
  const registration = F.git(wt, "rev-parse", "--absolute-git-dir"); F.git(a, "config", "gc.worktreePruneExpire", "now"); fs.rmSync(wt, { recursive: true });
  const before = F.snap(a), r = await g.worktreePrune({ root: a }); assert.deepEqual([r.operation, r.outcome], ["wt-prune", "completed"]);
  assert.equal(fs.existsSync(registration), false); F.same(a, before);
});

// Verify rename removes the old ref and creates the new one.
test("branchRename: available destination → old ref removed and new ref retains OID", async () => {
  const a = F.repo(); F.git(a, "branch", "old"); const before = F.snap(a), oid = F.git(a, "rev-parse", "old");
  assert.equal((await g.branchRename({ root: a }, "old", "new")).outcome, "completed");
  assert.equal(F.attempt(a, "show-ref", "--verify", "--quiet", "refs/heads/old").code, 1);
  assert.equal(F.git(a, "rev-parse", "refs/heads/new"), oid);
  F.same(a, { ...before, refs: before.refs.replace("refs/heads/old ", "refs/heads/new ") });
});
test("branchRename: invalid destination → refused without mutation", async () => {
  const a = F.repo(); F.git(a, "branch", "old");
  assert.equal((await F.refused(a, () => g.branchRename({ root: a }, "old", "bad name"))).reason, "invalid-name");
});
test("branchRename: occupied destination → refused with both refs preserved", async () => {
  const a = F.repo(); F.git(a, "branch", "old");
  await F.refused(a, () => g.branchRename({ root: a }, "old", "main"));
});

test("branchDelete: branch has no unique commits → ref removed without backup", async () => {
  const a = F.repo(); F.git(a, "branch", "side"); const before = F.snap(a), oid = F.git(a, "rev-parse", "side");
  const r = await g.branchDelete({ root: a }, "side"); assert.deepEqual([r.outcome, r.own, r.kept], ["completed", 0, null]);
  assert.equal(F.attempt(a, "show-ref", "--verify", "--quiet", "refs/heads/side").code, 1);
  F.same(a, { ...before, refs: before.refs.replace(`refs/heads/side ${oid}\n`, "") });
});
test("branchDelete: current branch → refused without mutation", async () => {
  const a = F.repo(); await F.refused(a, () => g.branchDelete({ root: a }, "main"));
});

// tag push updates the selected remote ref
test("tagPush: local tag → remote tag OID", async () => {
  const { a, remote } = setup(), t = { root: a };
  sh(a, "tag", "v1");
  assert.equal((await g.tagPush(t, "v1", "origin")).outcome, "completed");
  assert.match(sh(remote, "tag"), /v1/);  assert.equal(F.git(remote, "rev-parse", "v1"), F.git(a, "rev-parse", "v1"));
});

function twoStashes() {
  const a = F.repo(); F.put(a, "f", "one\n"); F.git(a, "stash", "-q"); F.put(a, "f", "two\n"); F.git(a, "stash", "-q");
  const [top, older] = F.git(a, "stash", "list", "--format=%H").split("\n"); return { a, top, older };
}
// Verify Apply restores the selected stash's bytes.
test("stashApply: older selected OID → its bytes applied and ordered stash list retained", async () => {
  const { a, top, older } = twoStashes(), before = F.snap(a);
  assert.equal((await g.stashApply({ root: a }, older)).outcome, "completed");
  assert.equal(readFileSync(join(a, "f"), "utf8"), "one\n");
  assert.equal(F.raw(a, "stash", "list", "--format=%H"), `${top}\n${older}\n`);
  const tree = F.git(a, "rev-parse", `${older}^{tree}`);
  assert.equal(F.git(a, "rev-parse", "AUTO_MERGE"), tree);
  F.same(a, { ...before, files: { ...before.files, f: { ...before.files.f, bytes: Buffer.from("one\n") } },
    states: { ...before.states, AUTO_MERGE: { "": { bytes: Buffer.from(`${tree}\n`), mode: before.files.f.mode } } } });
});
test("stashDrop: older selected OID → only that entry removed", async () => {
  const { a, top, older } = twoStashes(), before = F.snap(a);
  const r = await g.stashDrop({ root: a }, older); assert.deepEqual([r.outcome, r.n], ["completed", 1]);
  assert.equal(F.raw(a, "stash", "list", "--format=%H"), `${top}\n`); F.same(a, before);
});
test("stashDrop: selected OID already gone → refused with remaining entry preserved", async () => {
  const { a, top, older } = twoStashes(); F.git(a, "stash", "drop", "-q", "stash@{1}");
  assert.equal((await F.refused(a, () => g.stashDrop({ root: a }, older))).reason, "stash-gone");
  assert.equal(F.raw(a, "stash", "list", "--format=%H"), `${top}\n`);
});

// A reused branch name keeps both backups; a failed ownership count or moved tip prevents deletion.
function lone(a, message) {
  F.git(a, "switch", "-qc", "side"); const oid = F.commit(a, message, message); F.git(a, "switch", "-q", "main"); return oid;
}
// Retain separate backups for each deleted branch tip.
test("branchDelete: name reused at two tips → both backup OIDs retained", async () => {
  const { a } = setup(), t = { root: a }, A = lone(a, "A"); assert.equal(await g.branchOwn(t, "side"), 1); assert.equal((await g.branchDelete(t, "side", A)).outcome, "completed");
  const B = lone(a, "B"); assert.equal((await g.branchDelete(t, "side", B)).outcome, "completed");
  assert.equal(F.git(a, "rev-parse", `refs/ggit/deleted/${A}/side`), A); assert.equal(F.git(a, "rev-parse", `refs/ggit/deleted/${B}/side`), B);
  assert.equal(F.attempt(a, "show-ref", "--verify", "refs/heads/side").code, 128);
});
// Refuse deletion when ownership counting fails.
test("branchDelete: displayed tip moved → refused and state preserved", async () => {
  const { a } = setup(), oid = lone(a, "A"); F.git(a, "branch", "-f", "side", "main");
  const r = await F.refused(a, () => g.branchDelete({ root: a }, "side", oid)); assert.equal(r.reason, "moved");
});
// Refuse deletion when the branch tip moved after the dialog opened.
test("branchDelete: reachability count fails → refused and state preserved", async () => {
  const { a } = setup(), oid = lone(a, "A");
  // This deliberately malformed reference fixture requires Git's files ref backend.
  F.put(a, ".git/refs/heads/broken", "1".repeat(40) + "\n");
  await F.refused(a, () => g.branchDelete({ root: a }, "side", oid));
});

// Restore a wrongly dropped stash and report the index shift.
test("stashDrop: another stash arrives before drop → refused and both OIDs preserved", async () => {
  const { a } = setup(); F.put(a, "f", "one\n"); F.git(a, "stash", "push", "-qm", "mine");
  const mine = F.git(a, "rev-parse", "refs/stash"); let theirs;
  const race = F.race({ cwd: a, when: (k, args) => k === "run" && args[0] === "stash" && args[1] === "drop", do: () => {
    F.put(a, "f", "theirs\n"); F.git(a, "stash", "push", "-qm", "theirs"); theirs = F.git(a, "rev-parse", "refs/stash");
  } });
  const r = await createGgit(race.ad).stashDrop({ root: a }, mine); F.fired(race);
  assert.deepEqual([r.outcome, r.reason], ["refused", "stash-moved"]);
  F.same(a, race.record.snapshot);
  assert.equal(F.raw(a, "stash", "list", "--format=%H"), `${theirs}\n${mine}\n`);
});

// Pop the selected OID even if another stash is added meanwhile.
test("stashPop: another stash arrives before apply → selected OID applied and removed", async () => {
  const { a } = setup(); F.put(a, "f", "one\n"); F.git(a, "stash", "push", "-qm", "mine");
  const mine = F.git(a, "rev-parse", "refs/stash"), head = F.git(a, "rev-parse", "HEAD"); let theirs;
  const race = F.race({ cwd: a, when: (k, args) => k === "run" && args[0] === "stash" && ["apply", "pop"].includes(args[1]), do: () => {
    F.put(a, "f", "theirs\n"); F.git(a, "stash", "push", "-qm", "theirs"); theirs = F.git(a, "rev-parse", "refs/stash");
  } });
  const r = await createGgit(race.ad).stashPop({ root: a }, mine); F.fired(race);
  assert.equal(r.outcome, "completed");
  assert.equal(F.raw(a, "stash", "list", "--format=%H"), `${theirs}\n`);
  assert.equal(F.raw(a, "show", `${theirs}:f`), "theirs\n");
  assert.equal(readFileSync(join(a, "f"), "utf8"), "one\n");
  assert.equal(F.git(a, "rev-parse", "HEAD"), head);
  assert.equal(F.raw(a, "ls-files", "-s", "-z"), race.record.snapshot.index);
});

// Push the displayed tag object, preserving annotated tags on the remote.
test("tagPush: annotated tag → remote keeps exact tag object", async () => {
  const { a, remote } = setup(); F.git(a, "tag", "-a", "-m", "v2", "v2"); const oid = F.git(a, "rev-parse", "refs/tags/v2");
  assert.equal((await g.tagPush({ root: a }, "v2", "origin", oid)).outcome, "completed");
  assert.equal(F.git(remote, "cat-file", "-t", "refs/tags/v2"), "tag"); assert.equal(F.git(remote, "rev-parse", "refs/tags/v2"), oid);
});
// Refuse a tag push if the named tag moved before validation.
test("tagPush: tag moved since display → refused with both repos preserved", async () => {
  const { a, remote } = setup(); F.git(a, "tag", "v3"); const oid = F.git(a, "rev-parse", "v3"); F.commit(a, "g", "x"); F.git(a, "tag", "-f", "v3");
  const before = F.snap(remote); await F.refused(a, () => g.tagPush({ root: a }, "v3", "origin", oid)); F.same(remote, before);
});

for (const [kind, message] of [["lightweight", undefined], ["annotated", "notes"]]) test(`tagCreate: ${kind} tag → exact target object`, async () => {
  const a = F.repo(), head = F.git(a, "rev-parse", "HEAD");
  assert.equal((await g.tagCreate({ root: a }, "v9", head, message)).outcome, "completed");
  assert.equal(F.git(a, "rev-parse", "v9^{}"), head); assert.equal(F.git(a, "cat-file", "-t", "v9"), message ? "tag" : "commit");
  if (message) assert.match(F.raw(a, "cat-file", "tag", "v9"), /\n\nnotes\n$/); else assert.equal(F.git(a, "rev-parse", "v9"), head);
});
test("tagCreate: occupied name → refused with existing tag preserved", async () => {
  const a = F.repo(); F.git(a, "tag", "v9"); await F.refused(a, () => g.tagCreate({ root: a }, "v9", "HEAD"));
});
test("tagCreate: invalid name → refused without mutation", async () => {
  const a = F.repo(); assert.equal((await F.refused(a, () => g.tagCreate({ root: a }, "bad..name", "HEAD"))).reason, "invalid-name");
});

function remoteSide() {
  const pair = setup(); F.git(pair.b, "switch", "-qc", "side"); const oid = F.commit(pair.b, "s", "1\n"); F.git(pair.b, "push", "-q", "origin", "side");
  return { ...pair, oid };
}
test("fetchBranch: remote branch → exact tracking OID with caller files preserved", async () => {
  const { a, oid } = remoteSide(), before = F.snap(a);
  assert.equal((await g.fetchBranch({ root: a }, "origin/side")).outcome, "completed");
  assert.equal(F.git(a, "rev-parse", "origin/side"), oid); assert.equal(F.raw(a, "show", "origin/side:s"), "1\n");
  F.same(a, { ...before, refs: before.refs + `refs/remotes/origin/side ${oid}\n` });
});
test("setUpstream: branch not fetched → refused with existing configuration preserved", async () => {
  const { a } = setup(), old = F.raw(a, "config", "--get-regexp", "^branch\\.");
  assert.equal((await F.refused(a, () => g.setUpstream({ root: a }, "main", "origin/nope"))).reason, "not-fetched");
  assert.equal(F.raw(a, "config", "--get-regexp", "^branch\\."), old);
});
test("setUpstream: fetched branch → exact remote and merge configuration", async () => {
  const { a, oid } = remoteSide(); F.git(a, "fetch", "-q"); F.git(a, "branch", "local-side", "origin/side"); F.git(a, "branch", "--unset-upstream", "local-side");
  const before = F.snap(a); assert.equal((await g.setUpstream({ root: a }, "local-side", "origin/side")).outcome, "completed");
  assert.equal(F.git(a, "config", "branch.local-side.remote"), "origin"); assert.equal(F.git(a, "config", "branch.local-side.merge"), "refs/heads/side");
  assert.equal(F.git(a, "rev-parse", "local-side@{u}"), oid); F.same(a, before);
});

test("remoteBranchDelete: remote moved since display → refused with both repositories preserved", async () => {
  const { a, b, remote, oid } = remoteSide(); F.git(a, "fetch", "-q"); const newer = F.commit(b, "s", "2\n"); F.git(b, "push", "-q", "origin", "side");
  const before = F.snap(remote); await F.refused(a, () => g.remoteBranchDelete({ root: a }, "origin/side", oid)); F.same(remote, before);
  assert.equal(F.git(remote, "rev-parse", "refs/heads/side"), newer);
});
test("remoteBranchDelete: displayed OID still current → only selected remote branch removed", async () => {
  const { a, remote, oid } = remoteSide(); F.git(a, "fetch", "-q"); const before = F.snap(remote);
  assert.equal((await g.remoteBranchDelete({ root: a }, "origin/side", oid)).outcome, "completed");
  assert.equal(F.attempt(remote, "show-ref", "--verify", "--quiet", "refs/heads/side").code, 1);
  F.same(remote, { ...before, refs: before.refs.replace(`refs/heads/side ${oid}\n`, "") });
  assert.equal(F.attempt(a, "show-ref", "--verify", "--quiet", "refs/remotes/origin/side").code, 1);
});

function dirtySwitch() {
  const a = F.repo(); F.git(a, "switch", "-qc", "other"); const oid = F.commit(a, "f", "other\n"); F.git(a, "switch", "-q", "main"); F.put(a, "f", "dirty\n"); return { a, oid };
}
test("switchBranch: overlapping edit without stash → refused without mutation", async () => {
  const { a } = dirtySwitch(); await F.refused(a, () => g.switchBranch({ root: a }, "other"));
});
test("switchBranch: overlapping edit with stash → selected branch and dirty bytes retained in stash", async () => {
  const { a, oid } = dirtySwitch(); const r = await g.switchBranch({ root: a }, "other", { stash: true });
  assert.deepEqual([r.outcome, r.stashed], ["completed", true]); assert.equal(F.git(a, "symbolic-ref", "HEAD"), "refs/heads/other");
  assert.equal(F.git(a, "rev-parse", "HEAD"), oid); assert.equal(F.raw(a, "show", ":f"), "other\n"); assert.equal(readFileSync(join(a, "f"), "utf8"), "other\n");
  assert.equal(F.raw(a, "show", "stash@{0}:f"), "dirty\n"); assert.match(F.raw(a, "stash", "list"), /before switching to other/);
});

test("syncRemote: fetched fast-forward → local branch and files match remote OID", async () => {
  const { a, b } = setup(); F.git(a, "branch", "other"); const oid = F.commit(b, "f", "incoming\n"); F.git(b, "push", "-q"); F.git(a, "fetch", "-q"); F.git(a, "switch", "-q", "other");
  const r = await g.syncRemote({ root: a }, "origin/main"); assert.deepEqual([r.outcome, r.ff, r.branch], ["completed", true, "main"]);
  assert.equal(F.git(a, "rev-parse", "main"), oid); assert.equal(F.git(a, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(F.raw(a, "show", ":f"), "incoming\n"); assert.equal(readFileSync(join(a, "f"), "utf8"), "incoming\n");
});
test("syncRemote: local branch diverged → refused without mutation", async () => {
  const { a, b } = setup(); F.commit(a, "g", "local\n"); F.commit(b, "f", "remote\n"); F.git(b, "push", "-q"); F.git(a, "fetch", "-q");
  assert.equal((await F.refused(a, () => g.syncRemote({ root: a }, "origin/main"))).reason, "diverged");
});
test("syncRemote: local branch absent → created at remote OID with upstream and checkout", async () => {
  const { a, oid } = remoteSide(); F.git(a, "fetch", "-q"); const r = await g.syncRemote({ root: a }, "origin/side");
  assert.deepEqual([r.outcome, r.made], ["completed", true]); assert.equal(F.git(a, "symbolic-ref", "HEAD"), "refs/heads/side");
  assert.equal(F.git(a, "rev-parse", "side"), oid); assert.equal(F.git(a, "rev-parse", "--abbrev-ref", "side@{u}"), "origin/side");
  assert.equal(F.raw(a, "show", ":s"), "1\n"); assert.equal(readFileSync(join(a, "s"), "utf8"), "1\n");
});


// Map remote-tracking refs through fetch refspecs before deleting a remote branch.
test("Deleting origin/foo under a release/* fetch mapping deletes release/foo, not foo", async () => {
  const d = F.repo(), bare = d + "-remote.git";
  F.repo({}, { root: bare, bare: true }); F.git(d, "remote", "add", "origin", bare);
  F.git(d, "push", "-q", "origin", "HEAD:refs/heads/foo", "HEAD:refs/heads/release/foo");
  F.git(d, "config", "remote.origin.fetch", "+refs/heads/release/*:refs/remotes/origin/*"); F.git(d, "fetch", "-q", "origin");
  const g = createGgit(F.ad), oid = F.git(d, "rev-parse", "origin/foo");
  assert.equal((await g.remoteBranchDelete({ root: d }, "origin/foo", oid)).outcome, "completed");
  assert.equal(F.git(bare, "for-each-ref", "--format=%(refname)"), "refs/heads/foo", "foo stays, release/foo went");
});

// Set upstream by full remote ref even when a local branch has the same short name.
test("Set upstream to origin/topic when a local branch is also called origin/topic", async () => {
  const d = F.repo(), bare = d + "-remote.git";
  F.repo({}, { root: bare, bare: true }); F.git(d, "remote", "add", "origin", bare);
  F.git(d, "push", "-q", "origin", "HEAD:refs/heads/topic"); F.git(d, "fetch", "-q", "origin"); F.git(d, "branch", "origin/topic");
  assert.equal((await createGgit(F.ad).setUpstream({ root: d }, "main", "origin/topic")).outcome, "completed");
  assert.equal(F.git(d, "config", "branch.main.merge"), "refs/heads/topic");
});

// Remote synchronization must not advance a different branch checked out concurrently.
test("syncRemote: HEAD switches after checkout → unknown with only main advanced", async () => {
  const d = F.repo(), bare = d + "-remote.git", a = F.git(d, "rev-parse", "HEAD");
  F.repo({}, { root: bare, bare: true }); F.git(d, "remote", "add", "origin", bare);
  F.commit(d, "g", "b\n"); F.git(d, "push", "-q", "origin", "main"); F.git(d, "fetch", "-q", "origin");
  const b = F.git(d, "rev-parse", "HEAD"); F.git(d, "reset", "-q", "--hard", a); F.git(d, "switch", "-qc", "elsewhere");
  const race = F.race({ cwd: d, at: "after", when: (k, args) => k === "run" && args[0] === "switch", do: () => F.git(d, "switch", "-q", "elsewhere") });
  const r = await createGgit(race.ad).syncRemote({ root: d }, "origin/main"); F.fired(race);
  assert.equal(F.git(d, "rev-parse", "elsewhere"), a); assert.equal(F.git(d, "rev-parse", "main"), b);
  assert.equal(r.outcome, "unknown"); assert.match(r.stderr, /^HEAD or main moved while syncing/);
  // accepted: HEAD can switch after syncRemote's checkout; main was already advanced by CAS.
  assert.equal(F.git(d, "symbolic-ref", "HEAD"), "refs/heads/elsewhere");
  assert.deepEqual(F.snap(d).files, race.record.snapshot.files);
  assert.equal(F.raw(d, "ls-files", "-s", "-z"), race.record.snapshot.index);
});

// Transport exceptions leave write outcomes uncertain rather than proving refusal.
for (const kind of ["rejected", "killed"]) for (const afterWrite of [false, true]) test(`stage: ${kind} transport ${afterWrite ? "after" : "before"} write → unknown and one attempt`, async () => {
  const d = F.repo(); F.put(d, "new", "approved\n"); const before = F.snap(d); let calls = 0;
  const adapter = { ...F.ad, run: async (args, options) => {
    calls++; assert.ok(args.includes("add"));
    if (afterWrite) assert.equal((await F.ad.run(args, options)).code, 0);
    if (kind === "rejected") throw Error("fixture response lost");
    return { code: -1, stdout: "", stderr: "fixture killed" };
  } };
  const r = await createGgit(adapter).stage({ root: d }, ["new"]);
  assert.equal(r.outcome, "unknown"); assert.equal(r.reason, kind === "rejected" ? "timeout-or-not-started" : "killed");
  assert.equal(calls, 1); assert.equal(r.commands.length, 1); assert.deepEqual(r.commands[0].args, ["--literal-pathspecs", "add", "-A", "--", "new"]);
  if (afterWrite) {
    assert.equal(F.raw(d, "show", ":new"), "approved\n");
    assert.equal(F.raw(d, "ls-files", "-s", "--", "new"), `100644 ${F.git(d, "hash-object", "new")} 0\tnew\n`);
    const after = F.snap(d); assert.equal(after.refs, before.refs); assert.deepEqual(after.files, before.files); assert.deepEqual(after.states, before.states);
  } else F.same(d, before);
});

// a real lock must never be stolen to make staging succeed
 test("stage: index.lock owned by another writer → refused with lock and files preserved", async () => {
  const d = F.repo(); F.put(d, "new", "precious\n"); F.put(d, ".git/index.lock", "other writer\n");
  await F.refused(d, () => createGgit(F.ad).stage({ root: d }, ["new"]));
  assert.equal(readFileSync(join(d, ".git/index.lock"), "utf8"), "other writer\n");
});

// Report a partial synchronization if the target ref advances but switching fails.
 test("syncRemote: checkout fails after CAS → unknown with target advanced and local edit retained", async () => {
  const { a, b } = F.pair(); const base = F.git(a, "rev-parse", "HEAD"), incoming = F.commit(b, "f", "incoming\n"); F.git(b, "push", "-q"); F.git(a, "fetch", "-q");
  F.git(a, "switch", "-qc", "elsewhere"); F.put(a, "f", "precious local edit\n"); const before = F.snap(a);
  const r = await createGgit(F.ad).syncRemote({ root: a }, "origin/main");
  assert.equal(r.outcome, "unknown"); assert.match(r.stderr, /main.*switch failed/);
  // accepted: the branch CAS succeeded before Git refused checkout over local edits.
  assert.equal(F.git(a, "rev-parse", "main"), incoming); assert.equal(F.git(a, "rev-parse", "elsewhere"), base);
  const after = F.snap(a); assert.equal(after.branch, before.branch); assert.equal(after.index, before.index); assert.deepEqual(after.files, before.files);
});


// repair must reconnect a moved linked worktree without touching either tree
 test("worktreeRepair: linked worktree physically moved → repaired backlink and preserved OIDs", async () => {
  const d = F.repo(), root = F.dir("repair"), old = join(root, "old"), moved = join(root, "moved");
  F.git(d, "worktree", "add", "-q", "-b", "linked", old); const before = F.snap(d), linked = F.snap(old);
  const registration = F.git(old, "rev-parse", "--absolute-git-dir");
  fs.renameSync(old, moved); const actualPath = fs.realpathSync(moved);
  assert.equal(fs.existsSync(readFileSync(join(registration, "gitdir"), "utf8").trim()), false);
  const r = await createGgit(F.ad).worktreeRepair({ root: moved }); assert.deepEqual([r.operation, r.outcome], ["wt-repair", "completed"]);
  assert.equal(F.git(moved, "rev-parse", "--show-toplevel"), actualPath); assert.match(F.raw(d, "worktree", "list", "--porcelain"), new RegExp(actualPath));
  F.same(d, before); F.same(moved, linked);
  const gitDir = F.git(moved, "rev-parse", "--absolute-git-dir"); assert.equal(readFileSync(join(gitDir, "gitdir"), "utf8"), `${actualPath}/.git\n`);
});
// support gate covers malformed and unsupported versions independently of installed Git
 test("version: boundary and malformed output → exact support decision", async () => {
  for (const [text, supported] of [["git version 2.49.9", false], ["git version 2.50.0", true], ["git version 3.0.0", true], ["not git", false]]) {
    const r = await createGgit({ run: async () => ({ code: 0, stdout: text, stderr: "" }) }).version(); assert.equal(r.supported, supported, text);
  }
});

// Plain git pull can update remote-tracking refs and ORIG_HEAD before integration refuses.
// On that refusal, preserve the local branch, index and working files.
test("pull: refused over a local edit → the same end state as plain git pull; local branch, index and files kept", async () => {
  const { a, b } = F.pair(); const incoming = F.commit(a, "f", "incoming\n"); F.git(a, "push", "-q"); F.put(b, "f", "precious\n");
  const twin = b + "-git"; fs.cpSync(b, twin, { recursive: true });
  const before = F.snap(b), r = await createGgit(F.ad).pull({ root: b });
  F.attempt(twin, "pull");
  const ours = F.snap(b), git = F.snap(twin);
  assert.equal(r.outcome, "refused");
  assert.deepEqual(ours, git, "ggit leaves what git pull leaves");
  assert.equal(ours.head, before.head); assert.equal(ours.index, before.index); assert.deepEqual(ours.files, before.files);
  assert.equal(F.git(b, "rev-parse", "refs/remotes/origin/main"), incoming, "the fetch half went through, as in git pull");
});
