import { test } from "node:test";
import assert from "node:assert/strict";
import { loadView } from "./vm-load.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let now = 1000, stopped = false, watcher;
  const sleepers = [], jobs = [], shared = new Map(), events = { stamps: 0, refreshes: 0 };
  const stop = new Error("test clock disposed");
  const cx = {
    sleep(ms) { return stopped ? Promise.reject(stop) : new Promise((resolve, reject) => sleepers.push({ at: now + ms, resolve, reject })); },
    spawn(fn) { const job = fn(cx).catch(e => { if (e !== stop) throw e; }); jobs.push(job); return job; },
  };
  const host = {
    Date: { now: () => now }, Math, console,
    shared: k => shared.get(k), setShared: (k, v) => { events.stamps++; shared.set(k, v); },
    watchFolder: () => stopped ? Promise.reject(stop) : new Promise((resolve, reject) => { watcher = { resolve, reject }; }),
  };
  const drive = loadView("drive.js", "drive", host);
  const store = { state: { root: "/r", worktrees: [], sig: "s", pending: 0 }, refresh() { events.refreshes++; }, on() {} };
  return { shared, events, start: () => drive(store, { pollMs: 1e9 }, cx),
    async batch() { assert.ok(watcher, "watch is waiting"); const w = watcher; watcher = null; w.resolve(["/r/src/a.js"]); await tick(); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        sleepers.sort((a, b) => a.at - b.at);
        if (!sleepers.length || sleepers[0].at > end) break;
        now = sleepers[0].at;
        const ready = sleepers.filter(s => s.at <= now);
        for (const s of ready) { sleepers.splice(sleepers.indexOf(s), 1); s.resolve(); }
        await tick();
      }
      now = end; await tick();
    },
    async dispose() { stopped = true; watcher?.reject(stop); for (const s of sleepers.splice(0)) s.reject(stop); await Promise.all(jobs); },
  };
}

// Debounce watch events before publishing a shared bump.
test("drive: 100 batches inside quiet interval → one shared stamp and refresh", async t => {
  const h = harness(); t.after(() => h.dispose()); h.start();
  for (let n = 0; n < 100; n++) await h.batch();
  assert.equal(h.events.stamps, 0); await h.advance(299); assert.equal(h.events.stamps, 0);
  await h.advance(1); assert.deepEqual(h.events, { stamps: 1, refreshes: 1 });
});

// Distinguish bump IDs even when their timestamps are equal.
test("drive: second bump has same timestamp and new ID → one refresh", async t => {
  const h = harness(); t.after(() => h.dispose()); const key = "ggit.bump.:/r";
  h.shared.set(key, { at: 1000, by: "other", id: "other:1" }); h.start();
  h.shared.set(key, { at: 1000, by: "other", id: "other:2" });
  await h.advance(550); assert.deepEqual(h.events, { stamps: 0, refreshes: 1 });
  await h.advance(500); assert.equal(h.events.refreshes, 1);
});

test("relevant: git-lfs's .git/lfs/tmp files from our own reads are not a change", () => {
  const relevant = loadView("drive.js", "relevant");
  assert.equal(relevant(["/r/.git/lfs/tmp/123"], "/r"), false);
  assert.equal(relevant(["/r/.git/lfs/tmp/123", "/r/a.txt"], "/r"), true);
});
