import { test } from "node:test";
import assert from "node:assert/strict";
import { fileFor, nextN } from "../mods/git-grapher/lib/tabkey.js";

const sel = { repo: "/r", sha: "B", machine: null };
const k = (o) => ({ repo: "/r", sha: "B", machine: null, ...o });
test("fileFor: the later of the two keys (by n) that name the selected commit", () => {
  assert.equal(fileFor(k({ file: { path: "g.js" }, n: 1 }), k({ file: { path: "d.js" }, n: 2 }), sel), "d.js");
  assert.equal(fileFor(k({ file: null, n: 3 }), k({ file: { path: "d.js" }, n: 2 }), sel), null, "Back after it");
});
test("fileFor: order is n, not the clock", () => {
  assert.equal(fileFor(k({ file: null, n: 3, at: 100 }), k({ file: { path: "d.js" }, n: 2, at: 200 }), sel), null);
});
test("fileFor: another commit, repo or machine is not shown", () => {
  assert.equal(fileFor(k({ file: null, n: 1 }), k({ sha: "A", file: { path: "d.js" }, n: 9 }), sel), null);
  assert.equal(fileFor(null, k({ repo: "/x", file: { path: "d.js" }, n: 9 }), sel), null);
  assert.equal(fileFor(null, k({ file: { path: "d.js" }, n: 9 }), { ...sel, machine: "remote" }), null);
});
test("nextN: one past both keys", () => { assert.equal(nextN({ n: 4 }, { n: 7 }), 8); assert.equal(nextN(null, null), 1); });
