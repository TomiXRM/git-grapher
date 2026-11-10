import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff, patchArgs, cols, MAX_LINES } from "../mods/git-grapher/lib/diff.js";

test("parseDiff: hunk header + fn, numbering, no-newline marker", () => {
  const d = parseDiff([
    "diff --git a/x.rs b/x.rs", "index 1..2 100644", "--- a/x.rs", "+++ b/x.rs",
    "@@ -10,3 +10,4 @@ fn main() {", " keep", "-old", "+new", "+more", "", "\\ No newline at end of file",
    "@@ -40 +41 @@", "-a\tb", "+c",
  ].join("\n") + "\n");
  assert.deepEqual(d.rows.map((r) => [r.kind, r.old, r.new, r.text]), [
    ["@", undefined, undefined, "@@ -10,3 +10,4 @@"], [" ", 10, 10, "keep"], ["-", 11, undefined, "old"], ["+", undefined, 11, "new"], ["+", undefined, 12, "more"],
    [" ", 12, 13, ""], ["\\", undefined, undefined, "No newline at end of file"],
    ["@", undefined, undefined, "@@ -40 +41 @@"], ["-", 40, undefined, "a    b"], ["+", undefined, 41, "c"],
  ]);
  assert.equal(d.rows[0].fn, "fn main() {");
  assert.equal(d.rows[7].fn, "");
});

test("parseDiff: binary, empty (mode only), too many lines, too many bytes", () => {
  assert.match(parseDiff("diff --git a/i.png b/i.png\nnew file mode 100644\nBinary files /dev/null and b/i.png differ\n").note, /Binary/);
  assert.match(parseDiff("diff --git a/s b/s\nold mode 100644\nnew mode 100755\n").note, /No text changes/);
  assert.match(parseDiff("diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n").note, /No text changes/);
  assert.match(parseDiff("@@ -1 +1 @@\n" + "+x\n".repeat(MAX_LINES)).note, /lines, limit 5,000/);
  assert.match(parseDiff("@@ -1 +1 @@\n+" + "x".repeat(1_000_001)).note, /MB, limit 1 MB/);
});

test("parseDiff: long lines are clipped, width counts wide chars as 2", () => {
  const d = parseDiff("@@ -0,0 +1 @@\n+" + "y".repeat(3000) + "\n");
  assert.ok(d.rows[1].text.endsWith("(line truncated)"));
  assert.equal(cols("aあ😀"), 5);
  assert.equal(parseDiff("@@ -0,0 +1 @@\n+日本").cols, 13); // the hunk header is the widest
});

test("patchArgs: rename passes both paths; merge -> 1st parent; root -> --root", () => {
  assert.deepEqual(patchArgs("s", ["p1", "p2"], { path: "new", old: "old" }).slice(-5), ["p1", "s", "--", "old", "new"]);
  assert.deepEqual(patchArgs("r", [], { path: "a" }).slice(-4), ["--root", "r", "--", "a"]);
});

test("splitRows: context both sides, -/+ paired in order, longer side padded, headers whole", async () => {
  const { splitRows } = await import("../mods/git-grapher/lib/diff.js");
  const r = (kind, text) => ({ kind, text });
  const out = splitRows([r("@", "@@"), r(" ", "a"), r("-", "b"), r("-", "c"), r("+", "B"), r(" ", "d"), r("+", "e"), r("\\", "No newline")]);
  assert.deepEqual(out.map((x) => x.kind === "pair" ? [x.l?.text ?? null, x.r?.text ?? null] : x.kind),
    ["@", ["a", "a"], ["b", "B"], ["c", null], ["d", "d"], [null, "e"], "\\"]);
});

test("rowsText: code without +/-, headers dropped, split pairs left then right, context once", async () => {
  const { rowsText, splitRows } = await import("../mods/git-grapher/lib/diff.js");
  const r = (kind, text) => ({ kind, text });
  const rows = [r("@", "@@"), r(" ", "a"), r("-", "b"), r("+", "B"), r("\\", "No newline")];
  assert.equal(rowsText(rows, 4, 0), "a\nb\nB");
  assert.equal(rowsText(splitRows(rows), 0, 3), "a\nb\nB");
});
