import * as F from "./fx.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { forkPoint, EMPTY_TREE } from "../mods/git-grapher/lib/detail.js";

const pick = (r) => r && { base: r.base, n: r.n };
function forkFixture() {
  const dir = F.repo({});
  const run = (...a) => { return { code: 0, stdout: F.raw(dir, ...a) }; };
  const commit = m => F.commit(dir, m, m, m);
  const git = async (args, ok = [0]) => { const r = await F.ad.run(args, { cwd: dir }); if (!ok.includes(r.code)) throw new Error(args.join(" ")); return r.stdout; };
  return { run, commit, git };
}

test("forkPoint: a branch off dev (not main) → dev's commit; main moving on does not matter", async () => {
  const { run, commit, git } = forkFixture();
  commit("m1"); run("checkout", "-qb", "dev"); const d1 = commit("d1");
  run("checkout", "-qb", "feat"); commit("f1"); const f2 = commit("f2");
  run("checkout", "-q", "main"); commit("m2");
  assert.deepEqual(pick(await forkPoint(git, f2, "feat")), { base: d1, n: 2 });
});

test("forkPoint: merging main into the branch keeps the base at the fork", async () => {
  const { run, commit, git } = forkFixture();
  const m1 = commit("m1"); run("checkout", "-qb", "feat"); commit("f1");
  run("checkout", "-q", "main"); commit("m2"); run("checkout", "-q", "feat"); run("merge", "-q", "--no-edit", "main");
  const tip = (await git(["rev-parse", "HEAD"])).trim();
  assert.deepEqual(pick(await forkPoint(git, tip, "feat")), { base: m1, n: 2 });
});

test("forkPoint: nothing of its own → null; the only branch → the empty tree", async () => {
  const { run, commit, git } = forkFixture();
  const m1 = commit("m1"); run("branch", "same");
  assert.equal(await forkPoint(git, m1, "same"), null);
  const { commit: c2, git: g2 } = forkFixture();
  const r1 = c2("r1");
  assert.deepEqual(pick(await forkPoint(g2, r1, "main")), { base: EMPTY_TREE, n: 1 });
});
