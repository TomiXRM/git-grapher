import { test } from "node:test";
import assert from "node:assert/strict";
import { LanePathCache, laneShapeKey } from "../mods/git-grapher/lib/lane-cache.js";

const row = (commit = "a", changes = {}) => ({ commit, lane: 1, color: 2, node: "commit", ...changes });
test("lane cache: redraw and sx changes reuse geometry; context and row shape invalidate it", () => {
  const cache = new LanePathCache(); let builds = 0;
  const get = (r = row(), connected = true) => cache.get(5, r, connected, () => ({ build: ++builds }));
  cache.configure(1, 1);
  const first = get();
  assert.equal(get({ ...row(), sx: 600, subject: "new text" }), first);
  cache.configure(1, 1); assert.equal(get(), first);
  for (const args of [[2, 1], [2, 2]]) {
    const before = get(); cache.configure(...args); assert.notEqual(get(), before);
  }
  for (const r of [row("b"), row("b", { node: "head-merge" }), row("b", { node: "head-merge", avatar: { file: "a" } })]) {
    const before = builds; get(r); assert.equal(builds, before + 1);
  }
  const a = row("b", { node: "head-merge", avatar: { file: "a" } });
  const image = get(a);
  assert.equal(get({ ...a, avatar: { file: "downloaded.png" } }), image, "image arrival does not alter the lane geometry");
  assert.notEqual(get(a, false), image, "connector presence is geometry");
});

test("lane cache: opaque IDs, node shape and connector flag cannot alias", () => {
  const original = laneShapeKey(row(), true);
  for (const changed of [{ commit: "a:1" }, { lane: 2 }, { color: 3 }, { node: "merge" }, { avatar: {} }])
    assert.notEqual(laneShapeKey(row("a", changed), true), original);
  assert.notEqual(laneShapeKey(row(), false), original);
});

test("lane cache: moving viewport drops old references but pins the measured row", () => {
  const cache = new LanePathCache({ margin: 2 });
  const get = i => cache.get(i, row(String(i)), false, () => ({ i }));
  const measured = get(0), old = get(10); get(11); get(15);
  cache.retain(14, 17, 0);
  assert.deepEqual([...cache.entries.keys()], [0, 15]);
  cache.retain(0, 1, 0); assert.equal(cache.size, 2, "measurement callback does not clear the viewport");
  assert.equal(get(0), measured); assert.notEqual(get(10), old, "evicted geometry must be rebuilt");
  cache.clear(); assert.equal(cache.size, 0);
});

test("lane cache: hard limit and LRU apply even without a visible-range callback; views are independent", () => {
  const a = new LanePathCache({ limit: 3 }), b = new LanePathCache({ limit: 3 });
  const get = (c, i) => c.get(i, row(String(i)), false, () => ({ i }));
  for (let i = 0; i < 3; i++) get(a, i);
  const zero = get(a, 0); get(a, 3);
  assert.deepEqual([...a.entries.keys()], [2, 0, 3]);
  assert.notEqual(get(b, 0), zero);
  a.configure(2, .7); assert.equal(a.size, 0); assert.equal(b.size, 1);
});
