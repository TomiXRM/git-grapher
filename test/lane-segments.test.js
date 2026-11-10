import { test } from "node:test";
import assert from "node:assert/strict";
import { solidVertical } from "../mods/git-grapher/lib/lane-segments.js";
import { LanePathCache } from "../mods/git-grapher/lib/lane-cache.js";
import { loadView } from "./vm-load.js";

test("lane segments: solid pass/into/out occupy the old stroke extents; dashes and bends stay paths", () => {
  const edge = (kind, from, to, dashed = false) => ({ kind, from, to, dashed });
  assert.deepEqual(solidVertical(edge("pass", 3, 3), 1, 29), { lane: 3, top: 0, bottom: 29 });
  assert.deepEqual(solidVertical(edge("into", 1, 1), 1, 29), { lane: 1, top: 0, bottom: 14.5 });
  assert.deepEqual(solidVertical(edge("out", 1, 1), 1, 29, 7.5), { lane: 1, top: 22, bottom: 29 });
  assert.deepEqual(solidVertical(edge("into", 1, 1), 1, 29, 7.5), { lane: 1, top: 0, bottom: 7 });
  for (const e of [edge("pass", 3, 3, true), edge("into", 1, 1, true), edge("out", 1, 1, true),
    edge("pass", 2, 1), edge("into", 2, 1), edge("out", 1, 2)]) assert.equal(solidVertical(e, 1, 29), null);
});

function drawing() {
  const built = [], elements = [];
  const PathBuilder = { stroke: (width) => {
    const commands = [], p = { build() { const result = { width, commands }; built.push(result); return result; } };
    for (const name of ["move_to", "line_to", "curve_to", "arc_to", "dash_array"])
      p[name] = (...args) => { commands.push([name, ...args]); return p; };
    return p;
  } };
  const element = (type) => (...args) => {
    const target = { type, args, kids: [], style: {} }; let el;
    el = new Proxy(target, { get: (o, k) => k === "child" ? c => { o.kids.push(c); return el; }
      : k === "children" ? cs => { o.kids.push(...cs); return el; }
        : k in o ? o[k] : (...v) => { o.style[k] = v; return el; } });
    elements.push(el); return el;
  };
  const view = loadView("lane-cell.js", "({buildGeometry,laneCell})", {
    PathBuilder, solidVertical, div: element("div"), image: element("image"), paint_path: element("path"),
  });
  return { ...view, built, elements };
}
const row = (node = "commit", edges = []) => ({ commit: "x", node, lane: 1, color: 0, avatar: { initial: "A", tint: "red" }, edges });

test("lane geometry: an ordinary straight row and connector need no native paths", () => {
  const d = drawing();
  const r = row("commit", [{ kind: "into", from: 1, to: 1, color: 0 }, { kind: "out", from: 1, to: 1, color: 0 }, { kind: "pass", from: 2, to: 2, color: 1 }]);
  const g = d.buildGeometry(r, true);
  assert.equal(d.built.length, 0);
  assert.equal(g.paths.flatMap(p => p.rects).length, 3);
});

test("lane rendering: a ref connector keeps its colour/dash group's original pass-layer slot", () => {
  // Colour 3 is reused by lane 4 before lane 5's colour 6.
  // The connector to lane 8 must remain underneath the later colour-6 pass.
  for (const node of ["commit", "wip"]) {
    const dashed = node === "wip", d = drawing();
    const r = { ...row(node), lane: 8, color: 3, edges: [
      { kind: "pass", from: 4, to: 4, color: 3, dashed },
      { kind: "pass", from: 5, to: 5, color: 6 },
    ] };
    const cell = d.laneCell(r, { lanes: 9, palette: Array.from({ length: 7 }, (_, i) => `c${i}`), connectFrom: 0 });
    const connector = cell.kids.findIndex(e => dashed ? "overflow_hidden" in e.style
      : e.style.top?.[0] === 13.5 && e.style.left?.[0] === 0);
    const laterPass = cell.kids.findIndex(e => e.style.left?.[0] === 126 && e.style.bg?.[0] === "c6");
    assert.ok(connector >= 0 && connector < laterPass, "later pass must paint above connector");
    const absent = d.laneCell({ ...r, edges: r.edges.slice(1) }, { lanes: 9, palette: Array.from({ length: 7 }, (_, i) => `c${i}`), connectFrom: 0 });
    assert.equal(absent.kids[0].style.bg[0], "c6", "new connector group appends after existing pass groups");
  }
});

test("lane geometry: curves, HEAD merge rings and WIP/stash dashes keep native geometry", () => {
  for (const node of ["merge", "head-merge", "wip", "stash"]) {
    const d = drawing(), dashed = node === "wip" || node === "stash";
    const r = { ...row(node, [{ kind: "out", from: 1, to: 2, color: 0, dashed }]), avatar: null };
    const g = d.buildGeometry(r, true);
    assert.ok(d.built.some(p => p.commands.some(c => c[0] === "curve_to")));
    assert.ok(d.built.some(p => p.commands.some(c => c[0] === "arc_to")), "ring");
    assert.equal(Boolean(g.connector), dashed);
    if (dashed) assert.ok(g.connector.commands.some(c => c[0] === "dash_array"));
  }
});

test("lane rendering: sx changes reuse paths but create fresh elements and clip the connector", () => {
  const d = drawing(), cache = new LanePathCache(); cache.configure(1, 1);
  const r = row("wip", [{ kind: "out", from: 1, to: 1, color: 0, dashed: true }]);
  const opts = { lanes: 3, palette: ["red"], cache, index: 0, connectFrom: 0 };
  const first = d.laneCell(r, opts), count = d.built.length;
  const second = d.laneCell(r, { ...opts, connectFrom: 12 });
  assert.notEqual(first, second); assert.equal(d.built.length, count);
  const connector = d.built.find(p => p.commands.some(c => c[0] === "move_to" && c[1] === 0 && c[2] === 14.5));
  assert.ok(connector, "connector geometry begins at zero, independent of scroll");
  assert.ok(d.elements.some(e => e.style.left?.[0] === 12 && e.style.w?.[0] === 19.5 && "overflow_hidden" in e.style));
});

test("lane rendering: downloaded avatars and new palette colours reuse paths with fresh image and paint elements", () => {
  const d = drawing(), cache = new LanePathCache(); cache.configure(1, 1);
  const r = row("commit", [{ kind: "out", from: 1, to: 2, color: 0 }]);
  const opts = { lanes: 3, palette: ["red"], cache, index: 0 };
  const tree = e => [e, ...e.kids.filter(c => typeof c === "object").flatMap(tree)];
  const first = tree(d.laneCell(r, opts)), count = d.built.length;
  assert.ok(first.some(e => e.kids.includes("A")), "initials shown before download");
  assert.ok(!first.some(e => e.type === "image"));
  const second = tree(d.laneCell({ ...r, avatar: { ...r.avatar, file: "avatars/downloaded.png" } }, { ...opts, palette: ["blue"] }));
  assert.ok(second.some(e => e.type === "image" && e.args[0] === "avatars/downloaded.png"));
  assert.ok(!second.some(e => e.kids.includes("A")), "download replaces initials");
  const oldPaint = first.filter(e => e.type === "path"), newPaint = second.filter(e => e.type === "path");
  assert.ok(oldPaint.length > 0, "normal commit has a curved edge to cache");
  assert.equal(newPaint.length, oldPaint.length); assert.equal(d.built.length, count);
  for (let i = 0; i < oldPaint.length; i++) {
    assert.equal(newPaint[i].args[0], oldPaint[i].args[0], "identical built Path");
    assert.equal(oldPaint[i].args[1], "red"); assert.equal(newPaint[i].args[1], "blue", "palette applied on repaint");
  }
  const oldElements = new Set(first);
  for (const e of second) assert.ok(!oldElements.has(e), "every native element is fresh across renders");
});
