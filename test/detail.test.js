import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMeta, splitBody, parseDiffTree, summary, bar, buildTree, treeRows, isWide, refLabels, diffArgs } from "../mods/git-grapher/lib/detail.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as F from "./fx.js";
import { HISTORY_ARGS, HISTORY_NUMSTAT, parseHistory, parseNumstat, wipLists } from "../mods/git-grapher/lib/detail.js";

const US = "\x1f";

test("parseMeta: fields, trailers, body without trailer paragraph", () => {
  const out = ["9c04", "a1 b2", "tomixrm", "t@x", "2026-10-30 18:49", "docs: subj",
    "Verification\x1dcargo fmt\x1eSigned-off-by\x1dA <a@x>\x1e",
    "Line one\nline two\n\nVerification: cargo fmt\nSigned-off-by: A <a@x>\n\n"].join(US) + "\n";
  const m = parseMeta(out);
  assert.deepEqual(m.parents, ["a1", "b2"]);
  assert.equal(m.subject, "docs: subj");
  assert.deepEqual(m.trailers, [{ key: "Verification", value: "cargo fmt" }, { key: "Signed-off-by", value: "A <a@x>" }]);
  assert.deepEqual(m.body, ["Line one", "line two"]);
});

test("parseMeta: root commit, empty body, no trailers", () => {
  const m = parseMeta(["r00t", "", "n", "e", "d", "init", "", ""].join(US) + "\n");
  assert.deepEqual(m.parents, []);
  assert.deepEqual(m.trailers, []);
  assert.deepEqual(m.body, []);
});

test("splitBody keeps the last paragraph when git found no trailers", () => {
  assert.deepEqual(splitBody("a\n\nb: c\n", false), ["a", "b: c"]);
  assert.deepEqual(splitBody("a\n\nb: c\n", true), ["a"]);
});

test("diffArgs: merge -> first parent, root -> --root", () => {
  assert.deepEqual(diffArgs("m", ["p1", "p2"]).slice(-2), ["p1", "m"]);
  assert.deepEqual(diffArgs("r", []).slice(-2), ["--root", "r"]);
});

test("parseDiffTree: M/A/D, rename and binary", () => {
  const z = [
    ":100644 100644 aaa bbb M", "src/a.js",
    ":000000 100644 000 ccc A", "docs/new.md",
    ":100644 000000 ddd 000 D", "gone.txt",
    ":100644 100644 eee fff R087", "old/name.rs", "new/name.rs",
    ":100644 100644 ggg hhh M", "img.png",
    "8\t3\tsrc/a.js", "115\t0\tdocs/new.md", "0\t4\tgone.txt", "2\t1\t", "old/name.rs", "new/name.rs", "-\t-\timg.png", "",
  ].join("\0");
  const f = parseDiffTree(z);
  assert.deepEqual(f.map((x) => [x.status, x.path, x.add, x.del]), [
    ["M", "src/a.js", 8, 3], ["A", "docs/new.md", 115, 0], ["D", "gone.txt", 0, 4], ["R", "new/name.rs", 2, 1], ["M", "img.png", 0, 0],
  ]);
  assert.equal(f[3].old, "old/name.rs");
  assert.equal(f[4].binary, true);
  assert.deepEqual(parseDiffTree(""), []);
});

test("summary counts in a fixed status order", () => {
  const f = (status) => ({ status });
  assert.equal(summary([f("M"), f("A"), f("M"), f("M"), f("M")]), "4 modified · 1 added");
  assert.equal(summary([f("D"), f("R")]), "1 deleted · 1 renamed");
  assert.equal(summary([]), "No file changes");
});

test("bar: own share, a non-zero side keeps a square", () => {
  assert.deepEqual(bar(1, 0), ["a", "a", "a", "a", "a"]);
  assert.deepEqual(bar(0, 0), ["n", "n", "n", "n", "n"]);
  assert.deepEqual(bar(8, 3), ["a", "a", "a", "a", "d"]);
  assert.deepEqual(bar(1000, 1), ["a", "a", "a", "a", "d"]);
  assert.deepEqual(bar(1, 1000), ["a", "d", "d", "d", "d"]);
});

test("buildTree + treeRows: dirs first, fold by path", () => {
  const files = ["AGENTS.md", ".github/PULL_REQUEST_TEMPLATE.md", "docs/agents/pstack-distillation.md", "docs/agents/workflow.md", "docs/decisions.md"].map((path) => ({ path, status: "M" }));
  const rows = treeRows(buildTree(files));
  assert.deepEqual(rows.map((r) => "  ".repeat(r.depth) + r.name), [
    ".github", "  PULL_REQUEST_TEMPLATE.md", "docs", "  agents", "    pstack-distillation.md", "    workflow.md", "  decisions.md", "AGENTS.md",
  ]);
  assert.equal(rows[1].file.path, ".github/PULL_REQUEST_TEMPLATE.md");
  const folded = treeRows(buildTree(files), new Set(["docs/"]));
  assert.deepEqual(folded.map((r) => r.name), [".github", "PULL_REQUEST_TEMPLATE.md", "docs", "AGENTS.md"]);
  assert.equal(folded[2].open, false);
});

test("isWide: ref sizes and the threshold", () => {
  assert.equal(isWide(1000, 357), true); // ref-wide.png at 1x
  assert.equal(isWide(322, 660), false); // ref-tall.png at 1x
  assert.equal(isWide(900, 800), false); // landscape but under 1.3
  assert.equal(isWide(700, 300), false); // columns would be under 360
  assert.equal(isWide(1040, 800), true);
});

test("refLabels: local+origin merge, worktree, head first, tags", () => {
  const text = "refs/heads/feat\nrefs/remotes/origin/feat\nrefs/remotes/origin/HEAD\nrefs/heads/main\nrefs/tags/v1\nrefs/remotes/up/other\n";
  const r = refLabels(text, new Set(["refs/heads/feat"]), (n) => n === "main");
  assert.deepEqual(r.map((x) => [x.kind, x.name, !!x.head, !!x.tree, !!x.remote]), [
    ["local", "main", true, false, false], ["local", "feat", false, true, true], ["remote", "up/other", false, false, false], ["tag", "v1", false, false, false],
  ]);
});

test("parseDiffTree: a name with a tab keeps its numstat", () => {
  const out = ":100644 100644 aaa bbb M\0a\tb.txt\0" + "1\t2\ta\tb.txt\0";
  assert.deepEqual(parseDiffTree(out).map((f) => [f.path, f.add, f.del]), [["a\tb.txt", 1, 2]]);
});

// Follow a file through renames, using its historical name at each commit.
test("parseHistory follows a rename", async () => {
  const d = F.repo({}), sh = (...a) => F.raw(d, ...a);
  writeFileSync(join(d, "old.txt"), "a\nb\nc\nd\n"); sh("add", "."); sh("commit", "-qm", "add");
  writeFileSync(join(d, "other"), "x"); sh("add", "."); sh("commit", "-qm", "unrelated");
  sh("mv", "old.txt", "new.txt"); sh("commit", "-qm", "rename");
  writeFileSync(join(d, "new.txt"), "a\nb\nc\nd\ne\n"); sh("commit", "-qam", "edit");
  const out = (await F.ad.run(HISTORY_ARGS("new.txt"), { cwd: d })).stdout;
  const h = parseHistory(out);
  assert.deepEqual(h.map((e) => [e.subject, e.status, e.path, e.old]), [["edit", "M", "new.txt", null], ["rename", "R", "new.txt", "old.txt"], ["add", "A", "old.txt", null]]);
  assert.equal(h[0].name, "Fixture");
});


// Start File History at the requested commit.
test("File History: opened from another commit → history starts at that OID", async () => {
  const d = F.repo(); F.git(d, "switch", "-qc", "topic"); const top = F.commit(d, "only", "t\n"); F.git(d, "switch", "-q", "main");
  const out = await F.ad.run(HISTORY_ARGS("only", { rev: top }), { cwd: d }); assert.equal(out.code, 0);
  assert.deepEqual(parseHistory(out.stdout).map(x => x.sha), [top]);
});
// NUL framing must preserve filenames containing newlines or record separators.
for (const name of ["\n", "rs\x1ename"]) test(`File History: path ${JSON.stringify(name)} → exact filename and commit`, async () => {
  const d = F.repo(), oid = F.commit(d, name, "own text\n", "odd name");
  const out = await F.ad.run(HISTORY_ARGS(name), { cwd: d }); assert.equal(out.code, 0);
  assert.deepEqual(parseHistory(out.stdout).map(x => [x.path, x.sha]), [[name, oid]]);
});
// Include merge resolutions by comparing merges with their first parent.
test("File History: unique merge resolution → merge OID and numstat included", async () => {
  const d = F.conflict(); F.put(d, "f", "unique\n"); F.git(d, "add", "f"); F.git(d, "commit", "-qm", "merge");
  const oid = F.git(d, "rev-parse", "HEAD"), out = await F.ad.run(HISTORY_ARGS("f"), { cwd: d }), stats = await F.ad.run(HISTORY_NUMSTAT("f"), { cwd: d });
  assert.equal(parseHistory(out.stdout)[0].sha, oid); assert.deepEqual(parseNumstat(stats.stdout).get(oid), { add: 1, del: 1 });
});

// direct WIP transform must deduplicate conflicts from both diff streams
 test("wipLists: conflict appears in both lists → one unstaged conflict row", async () => {
  const unmerged = ":000000 100644 0000000 abcdef0 U\0f\0", modified = ":100644 100644 abcdef0 bcdef01 M\0f\0";
  const result = wipLists(unmerged, unmerged + modified);
  assert.deepEqual(result.staged, []); assert.deepEqual(result.unstaged, [{ path: "f", status: "U", add: 0, del: 0, binary: false, conflict: true }]);
});
// staged renames and untracked files retain their separate action lists
 test("wipLists: rename modification and untracked rows → exact staged and unstaged paths", async () => {
  const cached = ":100644 100644 aaa bbb R100\0old\0new\0", work = ":100644 100644 bbb ccc M\0new\0";
  const result = wipLists(cached, work, [{ path: "untracked", status: "?", untracked: true }]);
  assert.deepEqual(result.staged.map(f => [f.old, f.path, f.status]), [["old", "new", "R"]]);
  assert.deepEqual(result.unstaged.map(f => [f.path, f.status]), [["new", "M"], ["untracked", "?"]]);
});
