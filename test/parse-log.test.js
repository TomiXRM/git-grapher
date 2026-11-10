import * as F from "./fx.js";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLog, orphanTips, ORPHAN_REFLOG } from "../mods/git-grapher/lib/parse-log.js";

test("orphanTips: commits made on a detached HEAD and then left are found (the 2026-11-08 case)", async () => {
  const d = F.repo({}), g = (...a) => F.raw(d, ...a);
  const commit = (m) => { writeFileSync(join(d, "f"), m); g("commit", "-qam", m, "--allow-empty"); return g("rev-parse", "HEAD").trim(); };
  writeFileSync(join(d, "f"), "0"); g("add", "f"); commit("base");
  g("switch", "-q", "--detach", "HEAD");
  commit("x"); const y = commit("y");
  g("switch", "-q", "main");
  const out = await F.ad.run(ORPHAN_REFLOG, { cwd: d }); assert.equal(out.code, 0, out.stderr);
  const tips = orphanTips(out.stdout);
  assert.deepEqual(tips, [y]);
  const lost = g("rev-list", "--ignore-missing", ...tips, "--not", "--branches", "--remotes", "--tags", "HEAD").trim().split("\n");
  assert.equal(lost.length, 2);
  g("branch", "keep", y); // a branch on it: no longer lost
  assert.equal(g("rev-list", "--ignore-missing", ...tips, "--not", "--branches", "--remotes", "--tags", "HEAD").trim(), "");
});

test('parser: empty, root, merge, Unicode and embedded separators', () => {
  assert.deepEqual(parseLog(''), []);
  assert.deepEqual(parseLog('a\x1fb c\x1f題名\x1f残す\n文字\0d\x1f\x1f\0'), [
    { id: 'a', parents: ['b','c'], subject: '題名\x1f残す\n文字' }, { id: 'd', parents: [], subject: '' },
  ]);
});
test('parser: final NUL optional and malformed records rejected', () => {
  assert.deepEqual(parseLog('a\x1f\x1fs'), [{ id: 'a', parents: [], subject: 's' }]);
  for (const bad of ['abc', '\x1f\x1fs', 'a\x1fp', 'a\x1f\x1fs\0\0']) assert.throws(() => parseLog(bad), SyntaxError);
});
