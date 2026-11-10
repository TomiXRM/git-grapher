// Trace validation: run the real code against real git, turn what happened into model states, and check that the
// sequence is a behaviour of the model (tla/tlc.mjs traceCheck). A code change that leaves the model's rules (for example
// dropping update-ref's expected old value) produces a trace the model rejects.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fx.js";
import * as C from "../mods/git-grapher/lib/conflict.js";
import { traceCheck } from "../tla/tlc.mjs";

// RefCas: the merge commit moves the branch from the tip it planned on. ref values: the planned tip 0, another program's
// commit 1, a commit whose first parent is the planned tip 10 (ggit's), anything else 99 (the model has no such step).
async function mergeCommitTrace({ race, stripOld = false }) {
  const d = F.conflict(); F.put(d, "f", "resolved\n"); F.git(d, "add", "f");
  const tree = F.git(d, "write-tree"), head = F.git(d, "rev-parse", "HEAD"), c = await C.readConflict(F.ad, d);
  const actor = F.git(d, "commit-tree", tree, "-p", head, "-m", "external commit");
  // stripOld: an adapter that drops update-ref's expected old value, standing in for code that lost its CAS.
  const base = stripOld ? { ...F.ad, run: (a, o) => F.ad.run(a[0] === "update-ref" ? a.slice(0, a.length - 1) : a, o) } : F.ad;
  const rc = race ? F.race({ cwd: d, base, when: (k, a) => k === "run" && a[0] === "update-ref",
    do: () => F.git(d, "update-ref", "refs/heads/main", actor, head) }) : null;
  const r = await C.commitMerge(rc?.ad ?? base, d, c, "Merge", tree);
  if (rc) F.fired(rc);
  const tip = F.git(d, "rev-parse", "refs/heads/main");
  const onTop = (x) => F.attempt(d, "rev-parse", "--verify", "-q", x + "^1").stdout?.trim() === head;
  const value = tip === head ? 0 : tip === actor ? 1 : onTop(tip) ? 10 : 99;
  const phase = r.outcome === "completed" ? "done" : r.outcome === "refused" ? "refused" : r.outcome;
  return [[0, "idle"], [0, "planned"], ...(rc ? [[1, "planned"]] : []), [value, phase]];
}
const refModel = (states, Cas = true) => traceCheck("RefCas", { constants: { Cas }, obs: "<<ref, phase>>", states });

test("trace RefCas: merge commit with nobody else committing → a behaviour of the model", async () => {
  const states = await mergeCommitTrace({ race: false });
  assert.deepEqual(states.at(-1), [10, "done"]); assert.equal((await refModel(states)).accepted, true);
});

test("trace RefCas: another commit lands before update-ref → refused, a behaviour of the model", async () => {
  const states = await mergeCommitTrace({ race: true });
  assert.deepEqual(states.at(-1), [1, "refused"]); assert.equal((await refModel(states)).accepted, true);
});

test("trace RefCas: code without the expected old value → rejected by the model, accepted by the model without the rule", async () => {
  const states = await mergeCommitTrace({ race: true, stripOld: true });
  assert.deepEqual(states.at(-1), [10, "done"]); // the other commit was overwritten
  assert.equal((await refModel(states)).accepted, false); assert.equal((await refModel(states, false)).accepted, true);
});

// ConflictSave: file "loaded" (the bytes Save expects), "edited" (another program wrote), "result" (Save wrote). Each
// state is read from the file, except the compare's own position: the compare step is placed at Save's hash-object (the
// shim for "between" runs right after it), and the file there is the one read just before Save started.
// blind: an adapter that removes SAVE's compare from the script, standing in for code that writes without checking.
async function saveTrace(when, { blind = false } = {}) {
  const fs = await import("node:fs"), { join } = await import("node:path");
  const d = F.conflict(), c = await C.readConflict(F.ad, d), f = await C.loadFile(F.ad, d, c.files[0]);
  const loaded = fs.readFileSync(join(d, "f"), "utf8"), states = [["loaded", "open"]];
  const file = () => { const s = fs.readFileSync(join(d, "f"), "utf8"); return s === loaded ? "loaded" : s === "chosen\n" ? "result" : "edited"; };
  const strip = (script) => script.replace(/\[ "\$now" = "\$want" \] \|\| \{[^}]*\}/, ":");
  let stripped = 0;
  const base = blind ? { ...F.ad, sh: (script, args, o) => { const t = strip(script); stripped += t !== script; return F.ad.sh(t, args, o); } } : F.ad;
  if (when === "before") { F.put(d, "f", "theirs\n"); states.push([file(), "open"]); }
  const race = when === "between" ? F.inside(d, "hash-object", ["restore", "--source=topic", "--worktree", "--", "f"], { after: true }) : null;
  const atStart = file(); states.push([atStart, "saving"]);
  const r = await C.saveFile(race?.ad ?? base, d, { rev: c.rev, path: "f", text: "chosen\n", workId: f.workId });
  if (race) F.fired(race);
  if (blind) assert.equal(stripped, 1, "the compare was found and removed");
  if (r.outcome === "completed") states.push([atStart, "checked"], ...(race ? [["edited", "checked"]] : []));
  states.push([file(), r.outcome === "completed" ? "done" : r.outcome]);
  return states;
}
const saveModel = (states, Check = true) => traceCheck("ConflictSave", { constants: { Check, OneStep: false }, obs: "<<file, phase>>", states });

test("trace ConflictSave: plain Save → a behaviour of the model", async () => {
  const states = await saveTrace(null);
  assert.deepEqual(states.at(-1), ["result", "done"]); assert.equal((await saveModel(states)).accepted, true);
});

test("trace ConflictSave: another program edited the file before Save → refused, a behaviour of the model", async () => {
  const states = await saveTrace("before");
  assert.deepEqual(states.at(-1), ["edited", "refused"]); assert.equal((await saveModel(states)).accepted, true);
});

test("trace ConflictSave: Save without the compare overwrites that edit → rejected by the model, accepted without the rule", async () => {
  const states = await saveTrace("before", { blind: true });
  assert.deepEqual(states.at(-1), ["result", "done"]);
  assert.equal((await saveModel(states)).accepted, false); assert.equal((await saveModel(states, false)).accepted, true);
});

test("trace ConflictSave: an edit right after the compare is overwritten — the model's known gap, and the code's", async () => {
  const states = await saveTrace("between");
  assert.deepEqual(states.at(-1), ["result", "done"]); assert.equal((await saveModel(states)).accepted, true);
});

// PullWindow: the real Header methods (loaded in a VM, the store a serial queue), a Fetch pressed while the confirm-time
// preview reads. Observed events become model states <<phase, track, af>>: track 0 = the upstream tip the preview saw,
// 1 = the one the Fetch brings.
import { loadView } from "./vm-load.js";
const tick = () => new Promise((r) => setImmediate(r));
async function pullTrace({ recheck = true, readFails = false } = {}) {
  let previewDone; const preview = new Promise((r) => (previewDone = r));
  const Header = loadView("header.js", "Header", { previewPull: () => preview, ggSettings: () => ({}), setShared() {} });
  const h = Object.create(Header.prototype), events = [];
  let q = Promise.resolve();
  h.st = { state: { pending: 0 }, refresh: async () => {}, write(name, fn) { const j = q.then(() => fn({})); q = j.catch(() => {}); return j; } };
  let up = "b", release, held = new Promise((r) => (release = r));
  h.g = { fetch: async () => { events.push("fetch-start"); await held; up = "c"; events.push("fetch-end"); return { outcome: "completed" }; },
          pull: async () => { events.push("pull-run"); return { outcome: "completed" }; } };
  h.ad = { run: async () => (readFails ? { code: 128, stdout: "", stderr: "fatal" } : { code: 0, stdout: `a\n${up}\n` }) };
  h.t = { root: "/r" }; h.h = { branch: "main" }; h.states = []; h.setSnack = (_c, o) => { if (o?.r?.reason === "stale") events.push("pull-stale"); };
  if (!recheck) h.pullAt = () => h.g.pull(h.t); // stands in for code without the check right before git pull
  const cx = { notify() {}, spawn(fn) { return Promise.resolve().then(() => fn(cx)); } };
  const confirm = h.pullTask(cx, { ok: true, basis: "a:b" }); await tick();
  const f = h.fetchTask(cx, false); await tick();
  previewDone({ ok: true, data: { basis: { headOid: "a", upstreamOid: "b" }, predicted: "clean" } }); await confirm; events.push("queued");
  release(); await f; for (let i = 0; i < 10; i++) await tick();
  // events → states
  const states = [["idle", 0, false], ["confirm", 0, false]]; let phase = "confirm", track = 0, af = false;
  for (const e of events) {
    if (e === "fetch-start") af = true;
    else if (e === "queued") phase = "checked";
    else if (e === "fetch-end") { af = false; track = 1; }
    else if (e === "pull-stale") phase = "idle";
    else if (e === "pull-run") { states.push(["dispatch", track, af]); phase = "fetching"; } // the check passed, then git pull starts
    else continue;
    states.push([phase, track, af]);
  }
  return { states, events };
}
const pullModel = (states, Recheck = true, ReadFails = false) => traceCheck("PullWindow", { obs: "<<phase, track, af>>", states, constants: {
  InitStale: true, RemoteMoves: false, External: false, Suspend: true, Serialize: true, Drain: true, Reverify: true, Manual: true, Recheck, ReadFails } });

test("trace PullWindow: a Fetch pressed while confirming moves upstream → the pull is refused as stale, a behaviour of the model", async () => {
  const { states, events } = await pullTrace();
  assert.deepEqual(events, ["fetch-start", "queued", "fetch-end", "pull-stale"]);
  assert.equal((await pullModel(states)).accepted, true);
});

test("trace PullWindow: code without the check right before git pull → the trace is rejected by the model", async () => {
  const { states, events } = await pullTrace({ recheck: false });
  assert.deepEqual(events, ["fetch-start", "queued", "fetch-end", "pull-run"]);
  assert.equal((await pullModel(states)).accepted, false);
  assert.equal((await pullModel(states, false)).accepted, true); // rejected for the missing check, nothing else
});

test("trace PullWindow: the last read fails → git pull decides (the stated fallback), a behaviour of the model with ReadFails", async () => {
  const { states, events } = await pullTrace({ readFails: true });
  assert.deepEqual(events, ["fetch-start", "queued", "fetch-end", "pull-run"]);
  assert.equal((await pullModel(states, true, true)).accepted, true);
  assert.equal((await pullModel(states, true, false)).accepted, false); // the model with only successful reads does not cover it
});
