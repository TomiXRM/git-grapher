import { test } from "node:test";
import assert from "node:assert/strict";
import { loadView } from "./vm-load.js";

// sidebar.js imports zoom.js (herdr); sideRows is pure, so it is loaded without its imports.
const sideRows = loadView("sidebar.js", "sideRows");
const US = "\x1f";
const refs = ["a" + US + US + "refs/heads/main", "b" + US + US + "refs/heads/feat/x", "c" + US + US + "refs/heads/feat/y",
  "d" + US + US + "refs/remotes/origin/main", "e" + US + US + "refs/remotes/origin/HEAD", "f" + US + "g" + US + "refs/tags/v1"].join("\n");
const base = { refs, headBranch: "main", worktrees: [{ path: "/r", main: true, branch: "main", head: "a" }, { path: "/r-wt", branch: "side", head: "b", n: 1 }],
  stashes: [{ oid: "s0", msg: "WIP on main" }], atOf: () => null };
const shape = (rows) => [...rows].map((r) => (r.kind === "head" ? `${r.label}/(${r.count})${r.open ? "" : "+"}` : `${"  ".repeat(r.depth ?? 0)}${r.head ? "✓" : ""}${r.label}`));

test("local: folded by the first /, the current branch marked, a group can close", () => {
  assert.deepEqual(shape(sideRows("local", base, "", new Set())), ["feat/(2)", "  x", "  y", "✓main"]);
  assert.deepEqual(shape(sideRows("local", base, "", new Set(["local:feat"]))), ["feat/(2)+", "✓main"]);
});
test("remote: grouped by remote, origin/HEAD left out; tags use the peeled commit", () => {
  assert.deepEqual(shape(sideRows("remote", base, "", new Set())), ["origin/(1)", "  main"]);
  assert.equal(sideRows("tag", base, "", new Set())[0].sha, "g");
});
test("filter matches and opens folded groups; worktrees leave out the main one; stashes numbered", () => {
  assert.deepEqual(shape(sideRows("local", base, "Y", new Set(["local:feat"]))), ["feat/(1)", "  y"]);
  assert.deepEqual(shape(sideRows("worktree", base, "", new Set())), ["side"]);
  assert.deepEqual(shape(sideRows("stash", base, "", new Set())), ["stash@{0}: WIP on main"]);
});
