import { createHash } from "node:crypto";
import { cpSync } from "node:fs";
// Shared isolated Git fixtures. Races use a one-shot adapter boundary hook or a child-scoped Git shim.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readdirSync, lstatSync, readFileSync, readlinkSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import assert from "node:assert/strict";
import { herdrAdapter } from "../mods/git-grapher/lib/core.js";

export const ROOT = mkdtempSync(join(tmpdir(), "ggit-test-"));
process.on("exit", () => {
  if (process.env.GGIT_KEEP === "1") console.error(`GGIT_KEEP: ${ROOT}`);
  else rmSync(ROOT, { recursive: true, force: true });
});
export const env = {
  PATH: process.env.PATH, HOME: ROOT, TMPDIR: ROOT, LC_ALL: "C", TZ: "UTC",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
};
export const dir = (name = "repo") => mkdtempSync(join(ROOT, name + "-"));
export function processRun(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1e7, ...options, env: { ...env, ...options.env } });
  if (r.error) throw new Error(`${cmd} ${args.join(" ")}: ${r.error.message}\n${r.stderr}`, { cause: r.error });
  return { code: r.status ?? -1, status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
export const exec = async (cmd, args, options) => processRun(cmd, args, options);
export const ad = herdrAdapter(exec, null);
export const attempt = (d, ...args) => processRun("git", args, { cwd: d });
export function raw(d, ...args) {
  const r = attempt(d, ...args);
  if (r.code !== 0) throw Error(`git ${args.join(" ")} (${r.code}): ${r.stderr}`);
  return r.stdout;
}
export const git = (d, ...args) => raw(d, ...args).trim();
export const put = (d, p, s) => writeFileSync(join(d, p), s);
export const commit = (d, p, s, msg = p) => { put(d, p, s); git(d, "add", "--", p); git(d, "commit", "-qm", msg); return git(d, "rev-parse", "HEAD"); };
// One initializer for empty, seeded and bare repositories; scenarios add their own history.
export function repo(files = { f: "base\n", other: "unchanged\n" }, { root = dir("repo"), message, bare = false } = {}) {
  mkdirSync(root, { recursive: true }); const d = realpathSync(root);
  git(d, "-c", "init.templateDir=", "init", "-q", "-b", "main", ...(bare ? ["--bare"] : []));
  git(d, "config", "core.hooksPath", join(ROOT, "no-hooks"));
  for (const [path, bytes] of Object.entries(files)) commit(d, path, bytes, message ?? path);
  return d;
}
// A merge of topic into main stopped on f (del: main deleted f).
export function conflict({ del = false } = {}) {
  const d = repo(); git(d, "switch", "-qc", "topic"); commit(d, "f", "incoming\n"); git(d, "switch", "-q", "main");
  if (del) { git(d, "rm", "-q", "f"); git(d, "commit", "-qm", "delete"); } else commit(d, "f", "current\n");
  assert.equal(attempt(d, "merge", "--no-edit", "topic").code, 1);
  return d;
}
// Adapter boundary: a single selected call, with explicit actor success and post-actor state.
export function race({ when, at = "before", do: effect, cwd, base = ad }) {
  const record = { fired: 0, raceCode: null, snapshot: null, call: null };
  const wrapped = { ...base };
  for (const kind of ["run", "sh", "readFile"]) {
    wrapped[kind] = async (...args) => {
      const fire = async () => {
        if (record.fired || !when(kind, args[0], args)) return;
        record.fired++; record.call = { kind, args };
        const result = await effect(...args);
        record.raceCode = result?.code ?? 0;
        assert.equal(record.raceCode, 0, "external actor succeeded");
        if (cwd) record.snapshot = snap(cwd);
      };
      if (at === "before") await fire();
      const r = await base[kind](...args);
      if (at === "after") await fire();
      return r;
    };
  }
  return { ad: wrapped, record };
}
export const fired = (r) => {
  assert.equal(r.record.fired, 1, "race reached its selected boundary exactly once");
  assert.equal(r.record.raceCode, 0, "external actor exited successfully");
};
// Only this adapter's child processes see the shim. Setup/observation keep the real PATH.
export function inside(cwd, sub, actorArgs, { after = false } = {}) {
  const real = processRun("sh", ["-c", "command -v git"]).stdout.trim();
  const bin = dir("shim"), flag = join(bin, "fired"), code = join(bin, "code");
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`;
  const effect = `${q(real)} -C ${q(cwd)} ${actorArgs.map(q).join(" ")} >${q(join(bin, "out"))} 2>${q(join(bin, "err"))}; echo $? >${q(code)}`;
  writeFileSync(join(bin, "git"), `#!/bin/sh
# Peel only the prefixes used by ggit; preserve original argv for the real command.
sub=$(subcommand() {
  while [ "$1" = -c ]; do shift 2; done
  printf %s "$1"
}; subcommand "$@")
if [ "$SSH_ASKPASS_REQUIRE" = never ] && [ "$sub" = ${q(sub)} ] && mkdir ${q(flag)} 2>/dev/null; then
  ${after ? `${q(real)} "$@"; result=$?\n  ${effect}\n  exit "$result"` : effect}
fi
exec ${q(real)} "$@"
`);
  chmodSync(join(bin, "git"), 0o755);
  const scoped = herdrAdapter((cmd, args, options) => exec(cmd, args, { ...options, env: { PATH: `${bin}:${env.PATH}` } }), null);
  return { ad: scoped, get record() { return { fired: existsSync(flag) ? 1 : 0, raceCode: existsSync(code) ? Number(readFileSync(code, "utf8")) : null }; } };
}

export function pair() {
  const root = dir("pair"), remote = join(root, "remote.git"), a = join(root, "a"), b = join(root, "b");
  repo({}, { root: remote, bare: true });
  for (const w of [a, b]) git(root, "clone", "-q", remote, w);
  commit(a, "f", "1\n", "1"); git(a, "push", "-qu", "origin", "main");
  git(b, "pull", "-q", "origin", "main"); git(b, "branch", "-qu", "origin/main");
  return { dir: root, remote, a, b };
}
export function rebaseStop() {
  const d = repo(); git(d, "switch", "-qc", "topic"); commit(d, "f", "topic\n");
  git(d, "switch", "-q", "main"); commit(d, "f", "main\n");
  assert.equal(attempt(d, "rebase", "main", "topic").code, 1);
  return d;
}
function filesUnder(root, omitGit = false) {
  const files = {};
  if (!existsSync(root)) return null;
  function walk(path) {
    const st = lstatSync(path), key = relative(root, path);
    if (st.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (omitGit && path === root && name === ".git") continue;
        walk(join(path, name));
      }
    } else files[key] = st.isSymbolicLink() ? { link: readlinkSync(path), mode: st.mode & 0o777 } : { bytes: readFileSync(path), mode: st.mode & 0o777 };
  }
  walk(root); return files;
}
export function snap(d, { preview = false } = {}) {
  const out = (...args) => attempt(d, "--no-optional-locks", ...args).stdout;
  const states = {};
  const names = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "ORIG_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "SQUASH_MSG", "index.lock", "rebase-merge", "rebase-apply", "sequencer"];
  const paths = git(d, "rev-parse", "--path-format=absolute", ...names.flatMap(name => ["--git-path", name])).split("\n");
  for (let i = 0; i < names.length; i++) states[names[i]] = filesUnder(paths[i]);
  const state = { head: out("rev-parse", "--verify", "HEAD"), branch: out("symbolic-ref", "-q", "HEAD"),
    refs: raw(d, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: raw(d, "ls-files", "-s", "-z"), unmerged: raw(d, "ls-files", "-u", "-z"),
    files: git(d, "rev-parse", "--is-bare-repository") === "true" ? null : filesUnder(d, true), states };
  if (preview) {
    state.indexBytes = digest(readFileSync(git(d, "rev-parse", "--path-format=absolute", "--git-path", "index")));
    state.status = out("status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z");
    state.stash = raw(d, "stash", "list", "--format=%H");
  }
  return state;
}
export const same = (d, before) => assert.deepEqual(snap(d), before);
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function fixture(name, mode) {
  const root = dir("preview");
  const seed = join(root, 'seed'), hooks = join(root, 'empty-hooks');
  repo({}, { root: seed }); mkdirSync(hooks);
  const log = [];
  function git(cwd, args, check = true) {
    const r = processRun('git', args, { cwd });
    const out = { code: r.status, stdout: r.stdout, stderr: r.stderr };
    log.push({ cwd: relative(root, cwd), args, ...out });
    if (check && out.code !== 0) throw new Error(JSON.stringify({ args, ...out }));
    return out;
  }
  const g = (...args) => git(seed, args).stdout.trim();
  function put(path, text) { mkdirSync(join(seed, path, '..'), { recursive: true }); writeFileSync(join(seed, path), text); }
  function commit(message) { g('add', '--all'); g('commit', '-qm', message); }
  for (const [key, value] of Object.entries({
    'user.name': 'G2 fixture', 'user.email': 'g2@example.invalid', 'commit.gpgSign': 'false',
    'core.hooksPath': hooks, 'pull.rebase': mode === 'rebase' ? 'true' : 'false',
    'branch.main.remote': '.', 'branch.main.merge': 'refs/heads/upstream',
  })) g('config', key, value);
  put('f', 'base\n'); put('other', 'base\n');
  if (name === 'custom-driver') put('.gitattributes', 'f merge=fixture\n');
  if (name === 'newline-conflict') put('line\nspace 日本語\tfile', 'base\n');
  if (name === 'incoming-directory-local-file') put('path/old', 'base\n');
  commit('base'); g('branch', 'upstream');
  const divergent = ['clean', 'same-line', 'modify-delete', 'rename-modify', 'already-applied-patch', 'custom-driver', 'newline-conflict'].includes(name);
  if (divergent) {
    if (name === 'newline-conflict') put('line\nspace 日本語\tfile', 'local\n');
    else put('f', name === 'already-applied-patch' ? 'same\n' : 'local\n');
    commit('local change');
  }
  g('switch', '-q', 'upstream');
  if (name === 'clean' || name === 'dirty-unrelated') put('other', 'upstream\n');
  else if (name === 'modify-delete') g('rm', 'f');
  else if (name === 'rename-modify' || name === 'rename-untracked') g('mv', 'f', 'renamed');
  else if (name === 'incoming-file-local-directory') put('path', 'upstream file\n');
  else if (name === 'incoming-directory-local-file') put('path/new', 'upstream file\n');
  else if (name === 'already-applied-patch') {
    put('f', 'same\n'); commit('equivalent upstream patch'); put('f', 'newer\n');
  } else if (name === 'newline-conflict') put('line\nspace 日本語\tfile', 'upstream\n');
  else put('f', 'upstream\n');
  commit('upstream change'); g('switch', '-q', 'main');
  if (name === 'rename-untracked') put('renamed', 'untracked local\n');
  if (name === 'incoming-file-local-directory') put('path/local', 'untracked local\n');
  if (name === 'incoming-directory-local-file') {
    rmSync(join(seed, 'path'), { recursive: true }); put('path', 'local file\n');
  }
  if (name === 'dirty-unrelated') { put('f', 'staged local\n'); g('add', 'f'); }
  if (name === 'dirty-overlap' || name === 'autostash-conflict') put('f', 'dirty local\n');
  if (name === 'autostash-conflict') g('config', mode === 'merge' ? 'merge.autostash' : 'rebase.autostash', 'true');
  if (name === 'custom-driver') g('config', 'merge.fixture.driver', 'printf driver-ran > preview-driver-marker; true');
  const preview = join(root, 'preview'), oracle = join(root, 'oracle');
  cpSync(seed, preview, { recursive: true }); cpSync(seed, oracle, { recursive: true });
  return { root, seed, preview, oracle, git, run: ad.run, log, dispose: () => { if (process.env.GGIT_KEEP !== "1") rmSync(root, { recursive: true, force: true }); } };
}

export function objectCount(cwd) {
  let count = 0;
  const objects = join(cwd, '.git/objects');
  for (const dir of readdirSync(objects)) {
    if (/^[0-9a-f]{2}$/.test(dir)) count += readdirSync(join(objects, dir)).length;
  }
  return count;
}

export function actualResult(out, before, after) {
  if (after.unmerged) return 'conflict';
  if (out.code === 0) return 'clean';
  // Native Git may refresh stat-cache bytes even when it refuses the operation.
  if (before.head === after.head && before.index === after.index && JSON.stringify(before.files) === JSON.stringify(after.files)) return 'refused';
  return 'unknown';
}

export function gitVersion() { return processRun('git', ['--version']).stdout.trim(); }
export const markerExists = cwd => existsSync(join(cwd, 'preview-driver-marker'));

// A preflight refusal is a promise about state, not just a result label.
export async function refused(cwd, action) {
  const before = snap(cwd), result = await action();
  assert.equal(result.outcome, "refused"); same(cwd, before); return result;
}
