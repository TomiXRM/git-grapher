import * as decisions from "../mods/git-grapher/lib/view-decisions.js";
// Capture commit-pane targets and join the shared write queue at the click so later UI actions cannot overtake them.
// Load the class without herdr-dependent imports; use a serial promise chain as the store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadView } from "./vm-load.js";

const load = (file, expression, globals = {}) => loadView(file, expression, { ...decisions, ...globals });
const CommitPane = load("commit-pane.js", "CommitPane");
const tick = () => new Promise((r) => setImmediate(r));
const cx = { notify() {}, spawn(fn) { return Promise.resolve().then(() => fn(cx)); } };
const chain = (log) => { let q = Promise.resolve(); return { write(name, fn) { const j = q.then(async () => { log.push(name); return fn({}); }); q = j.catch(() => {}); return j; } }; };

test("a write keeps the worktree it was clicked in, even if the pane moves to another before it runs", async () => {
  const log = [], store = chain(log), cp = Object.create(CommitPane.prototype), targets = [];
  let open; const gate = new Promise((r) => (open = r));
  cp.ctx = { c: { path: "/A" }, store, reload: async () => {} };
  cp.op("stage", async () => { await gate; return { outcome: "completed" }; }, cx);
  cp.op("discard", async (_g, t) => { targets.push(t.root); return { outcome: "completed" }; }, cx);
  cp.ctx = { ...cp.ctx, c: { path: "/B" } };
  open(); await tick(); await tick(); await tick();
  assert.deepEqual(targets, ["/A"]);
});

test("writes run in click order across the pane and others using the same store", async () => {
  const log = [], store = chain(log), cp = Object.create(CommitPane.prototype);
  let open; const gate = new Promise((r) => (open = r));
  cp.ctx = { c: { path: "/repo" }, store, reload: async () => {} };
  cp.op("stage", async () => { await gate; return { outcome: "completed" }; }, cx);
  cp.op("amend", async () => ({ outcome: "completed" }), cx);
  store.write("switch", async () => ({ outcome: "completed" })); // the header's Switch, clicked last
  open(); await tick(); await tick(); await tick();
  assert.deepEqual(log, ["stage", "amend", "switch"]);
});

test("a WIP reload begun before a pane write ends does not land, nor one older than a reload that landed", async () => {
  const DetailView = load("detail-view.js", "DetailView");
  const dv = Object.create(DetailView.prototype), gates = [];
  dv.key = "k"; dv.sel = { repo: "/r", sha: "wip:/r" }; dv.c = { wip: true, v: 0 };
  dv.cp = { clicks: 0, written: 0, snapshot() {}, splice() {}, ctx: {} };
  dv.load = () => new Promise((r) => gates.push(r));
  const reload = () => dv.reload(cx);
  const a = reload();                       // begins before the click: its read can predate the write
  dv.cp.clicks = 1;                         // Stage clicked
  const b = reload();                       // begins while the write runs
  dv.cp.written = 1;                        // the write ends
  const c = reload();                       // the reload after the write
  gates[2]({ wip: true, v: 3 }); await c;   // the newest lands
  gates[0]({ wip: true, v: 1 }); await a;   // older: dropped
  gates[1]({ wip: true, v: 2 }); await b;   // began during the write: dropped
  assert.equal(dv.c.v, 3);
});

// Text-field stand-in and a pane with Amend enabled.
const field = (v = "") => ({ v, value() { return this.v; }, set_value(x) { this.v = x; } });
const deferred = () => { let resolve; const promise = new Promise((r) => (resolve = r)); return { promise, resolve }; };
const pane = () => { const p = Object.create(CommitPane.prototype); p.summary = field(); p.desc = field(); p.amend = true; p.ctx = { c: { path: "/r", staged: [{}] }, machine: null, reload: async () => {} }; return p; };

test("Amend's message load keeps a draft typed in Description only", async () => {
  const p = pane(), gate = deferred(); p.git = () => ({ lastMessage: () => gate.promise });
  const job = p.amendFill(cx); p.desc.v = "User draft"; gate.resolve("Old subject\n\nOld body"); await job;
  assert.deepEqual([p.summary.v, p.desc.v], ["", "User draft"]);
});

test("a commit's success keeps a draft typed while it ran", async () => {
  const p = pane(), gate = deferred(); p.amend = false; p.summary.v = "submitted";
  p.ctx.store = { write: () => gate.promise };
  p.commit(cx); p.summary.v = "next draft"; gate.resolve({ outcome: "completed", head: "abcdef1" }); await tick(); await tick();
  assert.equal(p.summary.v, "next draft");
});

test("Amend's message load does not fill the pane once it shows another machine", async () => {
  const p = pane(), gate = deferred(); p.git = () => ({ lastMessage: () => gate.promise });
  const job = p.amendFill(cx); p.ctx = { ...p.ctx, machine: "remote" }; gate.resolve("Local message"); await job;
  assert.equal(p.summary.v, "");
});

test("a bare pane's write uses the adapter of the click, not of a later context", async () => {
  const p = pane(), gate = deferred(), seen = []; p.chain = gate.promise; p.ctx.store = undefined;
  p.git = () => ({ machine: p.ctx.machine });
  p.op("discard", async (g) => { seen.push(g.machine); return { outcome: "completed" }; }, cx);
  p.ctx = { ...p.ctx, machine: "remote" }; gate.resolve(); await tick(); await tick(); await tick();
  assert.deepEqual(seen, [null]);
});

test("when writes on two stores end, the pane shown is reloaded once the last ends", async () => {
  const p = Object.create(CommitPane.prototype), a = deferred(), b = deferred(), reloaded = [];
  // A reload lands only if no clicked write is unfinished (DetailView.reload's guard).
  const land = (name) => async () => { if (p.clicks === p.written) reloaded.push(name); };
  p.ctx = { c: { path: "/A" }, store: { write: () => a.promise }, reload: land("A") };
  p.op("stage", () => {}, cx);
  p.ctx = { c: { path: "/B" }, store: { write: () => b.promise }, reload: land("B") };
  p.op("stage", () => {}, cx);
  b.resolve({ outcome: "refused", stderr: "index.lock" }); await tick(); await tick();
  a.resolve({ outcome: "completed" }); await tick(); await tick();
  assert.deepEqual(reloaded, ["B"]);
});

test("a slow fetch does not hold a Stage, and a pull waits for it", async () => {
  const Header = load("header.js", "Header");
  const log = [], store = chain(log), h = Object.create(Header.prototype), fetch = deferred();
  h.st = { ...store, state: { pending: 0 }, refresh() {} }; h.t = { root: "/r" }; h.h = { branch: "main" }; h.setSnack = () => {};
  h.g = { fetch: () => fetch.promise, pull: async () => { log.push("pull ran"); return { outcome: "completed" }; } };
  const f = h.fetchTask(cx, true);
  store.write("stage", async () => ({ outcome: "completed" }));     // not behind the fetch
  await tick(); assert.deepEqual(log, ["stage"]);
  h.op("pull", () => h.g.pull(h.t), cx); await tick(); await tick();
  assert.deepEqual(log, ["stage", "pull"], "pull entered the queue but waits");
  fetch.resolve({ outcome: "noop" }); await f; await tick(); await tick();
  assert.deepEqual(log, ["stage", "pull", "pull ran"]);
});

test("a Fetch clicked during a pull waits for it", async () => {
  const Header = load("header.js", "Header");
  const log = [], store = chain(log), h = Object.create(Header.prototype), pull = deferred();
  h.st = { ...store, state: { pending: 0 }, refresh() {} }; h.t = { root: "/r" }; h.h = { branch: "main" }; h.setSnack = () => {};
  h.g = { fetch: async () => { log.push("fetch ran"); return { outcome: "noop" }; }, pull: async () => { log.push("pull ran"); await pull.promise; return { outcome: "completed" }; } };
  h.op("pull", () => h.g.pull(h.t), cx); await tick(); await tick(); await tick();
  const f = h.fetchTask(cx, false); await tick(); await tick();
  assert.deepEqual(log, ["pull", "pull ran"], "the fetch waits in the queue (the chain logs a job when it starts)");
  pull.resolve(); await f;
  assert.deepEqual(log, ["pull", "pull ran", "fetch", "fetch ran"]);
});

// Push -> Push -> Fetch: the fetch queues behind the pushes. The second push must not await that queued fetch
// or the queue deadlocks.
test("push, push, fetch: the queue still drains", async () => {
  const Header = load("header.js", "Header");
  const log = [], store = chain(log), hd = Object.create(Header.prototype);
  let open; const gate = new Promise((r) => (open = r));
  let pushes = 0;
  Object.assign(hd, { st: { ...store, state: { pending: 0 } }, h: { branch: "main" }, t: {}, setSnack() {}, refresh() {},
    g: { push: async () => { if (++pushes === 1) await gate; return { outcome: "completed" }; }, fetch: async () => ({ outcome: "noop" }) } });
  hd.st.write = store.write;
  hd.op("push", () => hd.g.push(), cx);
  await tick();
  hd.op("push", () => hd.g.push(), cx);
  hd.fetch(cx, false);
  await tick();
  const stage = hd.st.write("stage", async () => ({ outcome: "completed" }));
  open();
  const done = await Promise.race([stage.then(() => "drained"), new Promise((r) => setTimeout(() => r("stuck"), 500))]);
  assert.equal(done, "drained"); assert.deepEqual(log, ["push", "push", "fetch", "stage"]);
});

// Generated messages fill only the originating worktree's unchanged draft on the same machine.
test("Generate does not fill another machine's draft at the same path", async () => {
  const Pane = load("commit-pane.js", "CommitPane", { generate: async () => ({ message: "Local message", ai: true }) });
  const cp = Object.create(Pane.prototype);
  cp.summary = field(); cp.desc = field();
  cp.ctx = { c: { path: "/same", staged: [{ path: "a", status: "M" }] }, machine: null };
  const cx2 = { notify() {}, spawn(fn) { return (cp.job = Promise.resolve().then(() => fn(cx2))); } };
  cp.generate(cx2);
  cp.ctx = { c: { path: "/same", staged: [] }, machine: "remote" };
  await cp.job;
  assert.equal(cp.summary.value(), "");
});

// Sidebar clicks select and close; they must not double-click switch a branch.
test("sidebar: a branch click → its commit selected and the list closed; nothing switched", () => {
  const GraphView = load("graph.js", "GraphView");
  const gv = Object.create(GraphView.prototype), picked = [], switched = [], cx3 = { notify() {}, spawn() {} };
  Object.assign(gv, { side: "local", sidePinned: true, off: 0, graph: { rows: [{ commit: "s1" }] }, scroll: { scroll_to_item() {} },
    select: (sha) => picked.push(sha), switchTo: (ref) => switched.push(ref.name) });
  gv.sidePick({ ref: "local", name: "topic", sha: "s1" }, cx3);
  assert.deepEqual(picked, ["s1"]); assert.equal(gv.side, null); assert.deepEqual(switched, []);
});

// Use the branch's configured tag-push remote even if its name contains a slash.
test("Push tag picks the branch's configured remote, slash and all", async () => {
  const Header = load("header.js", "Header");
  const hd = Object.create(Header.prototype);
  const answers = { config: "team/upstream\n", remote: "origin\nteam/upstream\n", "rev-parse": "abc\n" };
  Object.assign(hd, { h: { branch: "main", upstream: "team/upstream/main" }, t: { root: "/r" },
    ad: { run: async (args) => ({ code: 0, stdout: answers[args[0]] }) } });
  let job; const cx4 = { notify() {}, spawn(fn) { job = fn(cx4); } };
  hd.openTagPush(cx4, "v1", "abc"); await job;
  assert.equal(hd.dialog.remote, "team/upstream"); assert.equal(hd.dialog.oid, "abc");
});

// After restart, prefer this tab's saved repository over focus in another tab.
test("locate: a restored graph opens its tab's repo, not the focused pane's in another tab", async () => {
  const store = new Map();
  const env = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    panes: () => [{ tab: "T1", terminal: "t1", cwd: "/repoA/sub" }, { tab: "T2", terminal: "t2", cwd: "/repoB", focused: true }],
    spaces: () => [{ tabs: [{ id: "T1" }, { id: "T2" }], machine: null }],
    gitRun: async (_c, _a, { cwd }) => ({ code: 0, stdout: cwd.startsWith("/repoA") ? "/repoA\n" : cwd.startsWith("/kept") ? "/kept\n" : "/repoB\n" }),
  };
  const GraphView = load("graph.js", "GraphView", env);
  const gv = Object.create(GraphView.prototype); gv.p = {}; const cx5 = { sleep: async () => {} };
  // fresh: opened from the terminal in its own tab
  Object.assign(gv, { tab: "T1", origin: { tab: "T1", terminal: "t1", cwd: "/repoA/sub" } });
  assert.equal((await gv.locate(cx5)).dir, "/repoA");
  // restored: focus in T2; T1 last showed /kept
  store.set("repo.T1", JSON.stringify({ dir: "/kept", on: null }));
  Object.assign(gv, { tab: "T1", origin: { tab: "T2", terminal: "t2", cwd: "/repoB" } });
  assert.equal((await gv.locate(cx5)).dir, "/kept");
  // restored with nothing kept: its own tab's terminal, not T2's
  store.clear();
  assert.equal((await gv.locate(cx5)).dir, "/repoA");
});

// actual ConflictView Save routing must snapshot the editor draft before its queued job
 test("ConflictView.save: draft changes after click → queued Save receives clicked text", async () => {
  let job, got;
  const C = { saveFile: async (_ad, cwd, request) => { got = { cwd, request }; return { outcome: "completed" }; } };
  const View = load("conflict-view.js", "ConflictView", { C });
  const view = Object.create(View.prototype); view.gv = { st: { adapter: {}, state: { root: "/repo" } } }; view.c = { rev: "shown" };
  view.write = (name, fn) => { assert.equal(name, "conflict-save"); job = fn; };
  let text = "clicked\n"; const draft = { ed: { value: () => text }, f: { path: "f", workId: "hash" }, file: { e: { s2: { mode: "100755" } } } };
  view.save(draft, {}); text = "later draft\n"; draft.f.workId = "later-hash"; view.c = { rev: "later-revision" };
  await job(); assert.deepEqual(JSON.parse(JSON.stringify(got)), { cwd: "/repo", request: { rev: "shown", path: "f", text: "clicked\n", workId: "hash", mode: "100755" } });
});

// An empty message must reach the library's commit validation.
test("ConflictView.finish: empty merge message → library decision blocks queued commit", async () => {
  let decisionsCalled = 0;
  const C = { blockers: async () => [] };
  const View = load("conflict-view.js", "ConflictView", { C, conflictMergeRequest: (...args) => {
    decisionsCalled++; assert.equal(args[1], " \n"); return decisions.conflictMergeRequest(...args);
  } });
  const view = Object.create(View.prototype);
  view.gv = { st: { state: { root: "/repo" }, adapter: { run: async args => { assert.deepEqual(Array.from(args), ["write-tree"]); return { code: 0, stdout: "tree\n" }; } } } };
  view.c = { op: "merge", rev: "shown" }; view.msg = { value: () => " \n" }; view.write = () => assert.fail("empty message must not queue a commit");
  await view.finish({ notify() {} }); assert.equal(decisionsCalled, 1); assert.deepEqual(Array.from(view.blocked), ["Write a merge message"]);
});

// Pause the 60 s automatic fetch while a Pull preview or its confirmation dialog is active.
test("auto fetch: Pull being previewed or its dialog open → not started; otherwise started", () => {
  const Header = load("header.js", "Header"), h = Object.create(Header.prototype);
  h.st = { state: { pending: 0 } };
  assert.equal(h.autoFetchOk(), true);
  h.busy = "pull"; assert.equal(h.autoFetchOk(), false);
  h.busy = null; h.dialog = { kind: "pull" }; assert.equal(h.autoFetchOk(), false);
  h.dialog = { kind: "tag" }; assert.equal(h.autoFetchOk(), true);
});

// Exercise DetailView's file-menu action wiring.
test("DetailView.fileMenu: linked-worktree WIP row → its own path copied, File History from its HEAD", () => {
  const View = load("detail-view.js", "DetailView", { contextMenu: (_t, o) => o, exec: async () => null });
  const dv = Object.create(View.prototype); let clip, hist;
  Object.assign(dv, { sel: { repo: "/main" }, c: { wip: true, path: "/linked" }, fmenu: { f: { path: "a/f" }, k: "s", x: 0, y: 0 }, cp: null, os: "Darwin", onHistory: (...a) => { hist = a; } });
  const items = dv.fileMenu({}).sections.flatMap((s) => s.items), item = (label) => items.find((i) => i[0] === label)[1];
  item("Copy full path")({ write_to_clipboard: (x) => { clip = x; } }); assert.equal(clip, "/linked/a/f");
  item("File History")("cx"); assert.deepEqual(JSON.parse(JSON.stringify([hist[0], hist[2]])), ["a/f", { rev: "HEAD", cwd: "/linked" }]);
});
// A stale file menu must not act on the next selection.
test("DetailView.sync: selection changes → open file menu and Discard confirm closed; same selection → kept", () => {
  const View = load("detail-view.js", "DetailView", { contextMenu: (_t, o) => o, exec: async () => null });
  const dv = Object.create(View.prototype), cxs = { spawn() {}, notify() {} };
  Object.assign(dv, { opt: {}, key: decisions.detailSelectionKey({ sha: "a" }), sel: { sha: "a" }, fmenu: { f: { path: "f" } }, cp: { ask: { files: [] } } });
  dv.sync({ sha: "a" }, cxs); assert.ok(dv.fmenu && dv.cp.ask, "same selection keeps them");
  dv.sync({ sha: "b" }, cxs); assert.equal(dv.fmenu, null); assert.equal(dv.cp.ask, null);
});

// Display Save's partial-write reason when staging fails, rather than generic timeout text.
test("result text: unknown with its own reason → that reason; a timeout or kill → the wait-a-minute text", () => {
  const text = load("header.js", "resultText");
  assert.equal(text({ operation: "conflict-save", outcome: "unknown", stderr: "f: Result written, but staging failed; inspect the file and index. fatal: lock" }),
    "Result unknown: f: Result written, but staging failed; inspect the file and index. fatal: lock");
  assert.match(text({ operation: "push", outcome: "unknown", reason: "timeout-or-not-started" }), /^Result unknown \(timed out after 30 s/);
  assert.match(text({ operation: "commit", outcome: "unknown", reason: "killed", stderr: "x" }), /^Result unknown \(timed out after 30 s/);
});
