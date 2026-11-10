import { test } from "node:test";
import assert from "node:assert/strict";
import { fileMenuContext, closesFileMenu, detailSelectionKey, conflictSaveRequest, conflictTakeRequest, conflictMergeRequest } from "../mods/git-grapher/lib/view-decisions.js";

// File History starts at the file row's displayed commit
for (const [label, commit, expected] of [
  ["commit", { sha: "shown" }, { rev: "shown" }],
  ["comparison", { cmp: true, head: "branch-tip", sha: "base" }, { rev: "branch-tip" }],
  ["linked WIP", { wip: true, path: "/linked" }, { rev: "HEAD", cwd: "/linked" }],
]) test(`fileMenuContext: ${label} row → displayed history revision and correct file path`, () => {
  const result = fileMenuContext(commit, { repo: "/main" }, "dir/a\nb");
  assert.deepEqual(result.history, expected);
  assert.equal(result.absolutePath, `${commit.wip ? "/linked" : "/main"}/dir/a\nb`);
});
// file menu belongs to its selection including repository and machine
 test("closesFileMenu: selection changes → close only the stale menu", () => {
  const selection = { repo: "/r", sha: "a", machine: null }, key = detailSelectionKey(selection);
  assert.equal(closesFileMenu(key, { ...selection }), false);
  for (const changed of [{ ...selection, sha: "b" }, { ...selection, repo: "/other" }, { ...selection, machine: "remote" }, null]) assert.equal(closesFileMenu(key, changed), true);
});
// Conflict Save uses the loaded work ID and current side's mode
 test("conflictSaveRequest: edited draft → captured text revision hash and executable mode", () => {
  const c = { rev: "shown-revision" }, draft = { f: { path: "f", workId: "shown-hash" }, file: { e: { s2: { mode: "100755" }, s3: { mode: "100644" } } } };
  assert.deepEqual(conflictSaveRequest(c, draft, "edited\n"), { rev: "shown-revision", path: "f", workId: "shown-hash", text: "edited\n", mode: "100755" });
  delete draft.file.e.s2; assert.equal(conflictSaveRequest(c, draft, "").mode, "100644");
  delete draft.file.e.s3; assert.equal(conflictSaveRequest(c, draft, "").mode, "100644");
});
// Take passes the loaded file identity to the checked writer
 test("conflictTakeRequest: selected side → shown revision file and loaded hash", () => {
  const c = { rev: "shown" }, f = { path: "f", e: { s3: { oid: "incoming" } } };
  assert.deepEqual(conflictTakeRequest(c, f, "incoming", { f: { workId: "hash" } }), { rev: "shown", f, side: "incoming", workId: "hash" });
  assert.equal(conflictTakeRequest(c, f, "incoming", null).workId, null);
});
// Commit uses the staged tree read at the click and the displayed merge
 test("conflictMergeRequest: message and staged tree → captured merge arguments", () => {
  const c = { rev: "shown", mergeHead: "incoming" };
  assert.deepEqual(conflictMergeRequest(c, "  Merge\n", { code: 0, stdout: "tree\n" }), { conflict: c, message: "Merge", tree: "tree" });
  assert.deepEqual(conflictMergeRequest(c, " \n", { code: 0, stdout: "tree\n" }), { blocked: "Write a merge message" });
  assert.deepEqual(conflictMergeRequest(c, "Merge", null), { blocked: "Could not read what is staged" });
});
