import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fx.js";
import { createGgit, herdrAdapter, UNSET } from "../mods/git-grapher/lib/core.js";


// Every real write must isolate repository-selecting environment variables.
for (const poisonKey of [...UNSET, null]) for (const [method, invoke, expected] of [
  ["run", async (adapter, d) => (await createGgit(adapter).stage({ root: d }, ["new"])).outcome, "completed"],
  ["sh", async (adapter, d) => (await adapter.sh('git --literal-pathspecs add -- "$1"', ["new"], { cwd: d })).code, 0],
]) test(`herdrAdapter.${method}: ${poisonKey ?? "all Git selectors"} poisoned → only requested repository staged`, async () => {
  const d = F.repo(), victim = F.repo(), before = F.snap(victim), head = F.git(d, "rev-parse", "HEAD"); F.put(d, "new", "approved\n");
  const values = { ...Object.fromEntries(UNSET.map(k => [k, "1"])), GIT_DIR: `${victim}/.git`, GIT_WORK_TREE: victim, GIT_COMMON_DIR: `${victim}/.git`, GIT_INDEX_FILE: `${victim}/.git/index` };
  const poison = poisonKey ? { [poisonKey]: values[poisonKey] } : values;
  const adapter = herdrAdapter((cmd, args, options) => F.exec(cmd, args, { ...options, env: poison }), null);
  assert.equal(await invoke(adapter, d), expected);
  F.same(victim, before); assert.equal(F.git(d, "rev-parse", "HEAD"), head);
  assert.equal(F.raw(d, "show", ":new"), "approved\n");
  assert.equal(F.raw(d, "ls-files", "-s", "--", "new"), `100644 ${F.git(d, "hash-object", "new")} 0\tnew\n`);
});

// adapter boundary options and noninteractive authentication stay attached to every request
 test("herdrAdapter: host calls → cwd and machine routing preserved", async () => {
  const calls = [], on = { machine: "fixture" }, cwd = "/requested";
  const adapter = herdrAdapter(async (cmd, args, options) => { calls.push({ cmd, args, options }); return { code: 0, stdout: "bytes\n", stderr: "" }; }, on);
  await adapter.run(["status"], { cwd }); await adapter.sh("git status", [], { cwd });
  assert.equal(await adapter.readFile("-file", { cwd }), "bytes\n"); assert.equal(await adapter.testPath("-file", { cwd }), true);
  for (const call of calls) assert.deepEqual(call.options, { cwd, on });
  for (const { args } of calls.slice(0, 2)) {
    for (const key of UNSET) { const i = args.indexOf(key); assert.ok(i > 0); assert.equal(args[i - 1], "-u"); }
    assert.ok(args.includes("GIT_TERMINAL_PROMPT=0")); assert.ok(args.includes("SSH_ASKPASS_REQUIRE=never"));
    assert.equal(args.some(x => x.startsWith("core.sshCommand=")), false);
  }
  assert.ok(calls[0].args.includes("credential.interactive=false"));
  assert.deepEqual(calls[2].args, ["--", "-file"]); assert.deepEqual(calls[3].args, ["-e", "-file"]);
});
