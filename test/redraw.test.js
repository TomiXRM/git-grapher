import { test } from "node:test";
import assert from "node:assert/strict";
import { RedrawGate } from "../mods/git-grapher/lib/redraw.js";

test("background redraw: a burst has one short-delay notification with the latest data", async () => {
  const gate = new RedrawGate(), jobs = [], delays = [], rendered = []; let data = 0, release;
  const event = { spawn: f => jobs.push(f), notify: () => assert.fail("must use the task context") };
  const task = { sleep: ms => { delays.push(ms); return new Promise(r => { release = r; }); }, notify: () => rendered.push(data) };
  gate.request(event); const done = jobs[0](task);
  for (data = 1; data < 100; data++) gate.request(event);
  assert.equal(jobs.length, 1); assert.deepEqual(delays, [32]); assert.deepEqual(rendered, []);
  release(); await done; assert.deepEqual(rendered, [100]);
  gate.request(event); assert.equal(jobs.length, 2, "a later arrival is never lost");
});

test("background redraw: independent views and a rejected sleep cannot leave a stuck gate", async () => {
  const a = new RedrawGate(), b = new RedrawGate(), jobs = [], cx = { spawn: f => jobs.push(f) };
  a.request(cx); b.request(cx); assert.equal(jobs.length, 2);
  await assert.rejects(jobs[0]({ sleep: async () => { throw Error("closed"); } }), /closed/);
  a.request(cx); assert.equal(jobs.length, 3);
});
