import { test } from "node:test";
import assert from "node:assert/strict";
import { loadView } from "./vm-load.js";

test("zoom paths: shared methods follow replacement builders and scale coordinates/dashes", () => {
  const calls = [];
  const builder = (id = 0) => Object.fromEntries([
    ...["move_to", "line_to", "curve_to", "cubic_bezier_to", "arc_to", "close", "dash_array"].map(m => [m, (...a) => {
      calls.push([id, m, ...a]); return builder(id + 1);
    }]), ["build", () => ({ id })],
  ]);
  const z = loadView("ui/zoom.js", "({PathBuilder,setZoom})", {
    kit: { PathBuilder: { stroke: w => { calls.push(["stroke", w]); return builder(); }, fill: () => builder() } }, base: {},
  });
  z.setZoom(2);
  const p = z.PathBuilder.stroke(2), q = z.PathBuilder.fill();
  assert.equal(p.move_to, q.move_to, "methods are shared, not allocated per builder");
  assert.deepEqual(Object.keys(p), ["b"]);
  assert.equal(p.move_to(1, "3px").line_to(4, 5).dash_array([4, 3.25]).close(), p);
  assert.equal(p.build().id, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["stroke", 4], [0, "move_to", 2, "6px"], [1, "line_to", 8, 10], [2, "dash_array", [8, 6.5]], [3, "close"],
  ]);
  p.line_to.call(q, 6, 7);
  assert.equal(q.build().id, 1, "the method uses its receiver, not a captured wrapper");
  assert.equal(p.build().id, 4);
});

test("zoom paths: in-place native methods returning undefined keep their builder", () => {
  const b = { move_to() {}, close() {}, dash_array() {}, build: () => "geometry" };
  const z = loadView("ui/zoom.js", "({PathBuilder,setZoom})", { kit: { PathBuilder: { fill: () => b } }, base: {} });
  const p = z.PathBuilder.fill();
  assert.equal(p.move_to(0, 0).close().dash_array([1, 2]).build(), "geometry");
});
