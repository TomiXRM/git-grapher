import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fx.js";

// race evidence must reject a selector that never fired
test("race: unmatched selector → firing assertion fails", async () => {
  const d = F.repo(), race = F.race({ when: () => false, do() { throw Error("unreachable"); } });
  await race.ad.run(["status", "--porcelain"], { cwd: d });
  assert.throws(() => F.fired(race), /race reached/);
});

// script injection is private to the operation's adapter
test("inside: setup uses real Git → only adapter command fires actor", async () => {
  const d = F.repo(), path = process.env.PATH, race = F.inside(d, "status", ["branch", "actor"]);
  F.git(d, "status", "--porcelain"); assert.equal(race.record.fired, 0);
  await race.ad.run(["status", "--porcelain"], { cwd: d }); F.fired(race);
  await race.ad.run(["status", "--porcelain"], { cwd: d }); F.fired(race);
  assert.equal(F.git(d, "rev-parse", "actor"), F.git(d, "rev-parse", "HEAD"));
  assert.equal(process.env.PATH, path);
});

// Match injected operations even when git arguments contain repeated config options.
test("inside: repeated Git config options → selected subcommand fires once", async () => {
  const d = F.repo(), race = F.inside(d, "status", ["branch", "actor"]);
  const args = ["-c", "core.editor=true", "-c", "sequence.editor=true", "status", "--porcelain"];
  assert.equal((await race.ad.run(args, { cwd: d })).code, 0); F.fired(race);
  assert.equal((await race.ad.run(args, { cwd: d })).code, 0); F.fired(race);
  assert.equal(F.git(d, "rev-parse", "actor"), F.git(d, "rev-parse", "HEAD"));
});
