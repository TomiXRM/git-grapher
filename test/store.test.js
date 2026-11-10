import { createGgit } from "../mods/git-grapher/lib/core.js";
import * as F from "./fx.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStore, limiter, parseWorktrees } from "../mods/git-grapher/lib/store.js";

const adapter = F.ad;
const exec = F.ad.run;
const sh = F.raw;
const repo = () => F.repo({ f: "1\n" }, { message: "one" });
const tick = () => Promise.resolve();

test("limiter: never more than n at once, all finish", async () => {
  const lim = limiter(3); let live = 0, peak = 0;
  await Promise.all(Array.from({ length: 20 }, () => lim(async () => { live++; peak = Math.max(peak, live); await tick(); live--; })));
  assert.equal(peak, 3);
});

test("refresh: reads history, worktree counts and head", async () => {
  const d = repo(), s = createStore(adapter, d);
  writeFileSync(join(d, "f"), "2\n"); writeFileSync(join(d, "u"), "u\n");
  await s.refresh();
  assert.equal(s.state.history.commits.length, 1); assert.equal(s.state.history.commits[0].subject, "one");
  assert.equal(s.state.headBranch, "main"); assert.equal(s.state.worktrees[0].n, 2); assert.equal(s.state.head.unstaged, 1);
});

test("refresh: asks during a read coalesce into one more read; history re-read only when refs move", async () => {
  const d = repo(); let logs = 0, gate = null;
  const counting = { ...adapter, run: async (args, o) => { if (args.includes("log")) logs++; if (gate) await gate.promise; return exec(args, o); } };
  const s = createStore(counting, d);
  await s.refresh(); assert.equal(logs, 1);
  gate = F.deferred(); const a = s.refresh(); const b = s.refresh(); const c = s.refresh(); gate.resolve();
  await Promise.all([a, b, c]); gate = null;
  assert.equal(s.state.gen, 3, "first read + one coalesced extra read"); assert.equal(logs, 1, "refs unchanged: no new log");
  sh(d, "commit", "-q", "--allow-empty", "-m", "two");
  await s.refresh(); assert.equal(logs, 2); assert.equal(s.state.history.commits[0].subject, "two");
});

test("write queue: writes run in order, none dropped, each ends with a refresh; a guess is settled only after", async () => {
  const d = repo(); for (const f of ["a", "b", "c"]) writeFileSync(join(d, f), f);
  const order = [];
  const recording = { ...adapter, run: (args, o) => { if (args.includes("add")) order.push(args.at(-1)); return adapter.run(args, o); } };
  const s = createStore(recording, d); s.need(d); await s.refresh();
  const seq = s.nextSeq();
  const rs = await Promise.all(["a", "b", "c"].map((f) => s.write("stage", (g, t) => g.stage(t, [f]))));
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(rs.map((r) => r.outcome), ["completed", "completed", "completed"]);
  assert.deepEqual(rs.map((r) => r.seq), [seq, seq + 1, seq + 2]);
  assert.ok(s.settled(seq + 2));
  assert.deepEqual(s.state.wip.get(d).staged.map((f) => f.path), ["a", "b", "c"]);
  assert.equal(s.state.pending, 0);
});

test("a refresh that began before a write finished does not settle that write's guess", async () => {
  const d = repo(); let gateOpen; const held = new Promise((r) => (gateOpen = r));
  const s = createStore(adapter, d); await s.refresh();
  const w = s.write("slow", async () => { await held; return { outcome: "completed" }; });
  const seq = s.nextSeq() - 1;
  await s.refresh(); assert.equal(s.settled(seq), false);
  gateOpen(); await w; assert.equal(s.settled(seq), true);
});

test("next(): resolves on the next applied read and on write start", async () => {
  const d = repo(), s = createStore(adapter, d);
  const n1 = s.next(), read = s.refresh(); assert.equal((await n1).gen, 1); await read;
  const n2 = s.next(), write = s.write("noop", async () => ({ outcome: "noop" })); assert.equal((await n2).pending, 1); await write;
});

test("more(): the first `limit` commits, omitted flagged; more() reads `more` further on the next refresh", async () => {
  const d = repo();
  for (const n of [2, 3, 4, 5]) { writeFileSync(join(d, "f"), `${n}\n`); sh(d, "commit", "-qam", `c${n}`); }
  const s = createStore(adapter, d, { limit: 2, more: 2 });
  await s.refresh();
  assert.deepEqual([s.state.history.commits.length, s.state.history.omitted], [2, true]);
  await s.more();
  assert.deepEqual([s.state.history.commits.length, s.state.history.omitted], [4, true]);
  await s.more();
  assert.deepEqual([s.state.history.commits.length, s.state.history.omitted], [5, false]);
});

test("parseWorktrees: the -z form keeps a path with a newline whole; the newline form still parses", async () => {
  const z = "worktree /tmp/a\nb\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /tmp/c\0HEAD 2222222222222222222222222222222222222222\0detached\0locked\0\0";
  assert.deepEqual(parseWorktrees(z).map((w) => [w.path, w.branch, w.locked]), [["/tmp/a\nb", "main", false], ["/tmp/c", null, true]]);
  const nl = "worktree /tmp/a\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n";
  assert.deepEqual(parseWorktrees(nl).map((w) => w.path), ["/tmp/a"]);
});

// A pagination request during an active read must take effect in the following read.
test("more() during a running read still counts: the next read uses the raised limit", async () => {
  const d = repo();
  for (const n of [2, 3, 4, 5]) { writeFileSync(join(d, "f"), `${n}\n`); sh(d, "commit", "-qam", `c${n}`); }
  let hold = null; const entered = F.deferred();
  const slow = { ...adapter, run: async (args, o) => { if (args.includes("log") && hold) { entered.resolve(); await hold; } return exec(args, o); } };
  const s = createStore(slow, d, { limit: 1, more: 2 });
  let open; hold = new Promise((r) => (open = r));
  const first = s.refresh();
  await entered.promise; const more = s.more(); open(); hold = null;
  await first; await more;
  assert.deepEqual([s.state.history.commits.length, s.state.history.omitted], [3, true]);
});

test("a repo with no commit yet: its worktree is kept (unborn) and its files counted", async () => {
  const d = F.repo({});
  writeFileSync(join(d, "a"), "1\n");
  const s = createStore(adapter, sh(d, "rev-parse", "--show-toplevel").trim());
  await s.refresh();
  assert.equal(s.state.error, null);
  assert.equal(s.state.history.commits.length, 0);
  assert.deepEqual(s.state.worktrees.map((w) => [w.unborn, w.n]), [[true, 1]]);
});

test("no commit yet but fetched refs: their history is read", async () => {
  const src = repo();
  const d = F.repo({});
  sh(d, "fetch", "-q", src, "+refs/heads/*:refs/remotes/origin/*");
  const s = createStore(adapter, sh(d, "rev-parse", "--show-toplevel").trim());
  await s.refresh();
  assert.equal(s.state.error, null);
  assert.equal(s.state.history.commits.length, 1);
});

test("a detached HEAD naming a missing commit is an error, not an empty history", async () => {
  const d = F.repo({});
  writeFileSync(join(d, ".git", "HEAD"), "1111111111111111111111111111111111111111\n");
  const s = createStore(adapter, d);
  await s.refresh();
  assert.match(s.state.error ?? "", /missing/);
});

test("history: false reads no log (a detached detail), but the worktrees and head", async () => {
  const d = repo(); let logs = 0;
  const counting = { ...adapter, run: async (args, o) => { if (args.includes("log")) logs++; return exec(args, o); } };
  const s = createStore(counting, d, { history: false });
  writeFileSync(join(d, "f"), "2\n");
  await s.refresh();
  assert.equal(logs, 0); assert.equal(s.state.history, null);
  assert.equal(s.state.headBranch, "main"); assert.equal(s.state.worktrees[0].n, 1);
});

test("WIP lists during a conflict: one Unstaged row per conflicted file, none in Staged", async () => {
  const d = F.conflict(); writeFileSync(join(d, "x"), "new\n");
  const st = createStore(adapter, d, { history: false }); st.need(d); await st.refresh();
  const w = st.state.wip.get(d);
  assert.deepEqual(w.unstaged.filter((f) => f.path === "f").map((f) => [f.status, f.conflict]), [["U", true]]);
  assert.equal(w.staged.some((f) => f.path === "f"), false);
  assert.equal((await createGgit(adapter).stage({ root: d }, [])).outcome, "noop", "an empty list stages nothing");
  assert.equal(F.processRun("git", ["ls-files", "-u"], { cwd: d, encoding: "utf8" }).stdout === "", false, "still unmerged");
});
