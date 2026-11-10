// Git operations with no herdr or Node dependency. The adapter supplies:
//   run(args, {cwd}) -> Promise<{code, stdout, stderr}>; rejects on timeout or failure to start
//   testPath(path, {cwd}) -> Promise<boolean> for POSIX test -e
//   readFile(path, {cwd}) / sh(script, args, {cwd}) for Conflict Mode
// The adapter removes repository-selecting environment variables and disables interactive authentication.
// See herdrAdapter below.

export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const MIN_GIT = [2, 50];

// git's own state files. Order = priority when several exist.
const STATES = [
  ["merge", "MERGE_HEAD", { gitRefuses: true }],
  ["cherry-pick", "CHERRY_PICK_HEAD", { gitRefuses: true }],
  ["revert", "REVERT_HEAD"],
  ["rebase", "rebase-merge"],
  ["am", "rebase-apply/applying"],
  ["rebase", "rebase-apply"],
  ["sequencer", "sequencer"],
  ["bisect", "BISECT_LOG"],
  ["index-lock", "index.lock"], // Check only whether the lock exists; do not infer whether it is live or stale.
];

const lines = (s) => s.split("\n").filter(Boolean);

export function parseVersion(text) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [+m[1], +m[2], +(m[3] ?? 0)] : null;
}

export function parseHeader(text) {
  if (text && !text.endsWith("\0")) throw new Error("incomplete status output");
  const h = { oid: null, branch: null, upstream: null, ahead: null, behind: null, stash: 0, staged: 0, unstaged: 0, untracked: 0, unmerged: 0 };
  const recs = text.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith("# ")) {
      const [, key, ...rest] = r.split(" "), v = rest.join(" ");
      if (key === "branch.oid") h.oid = v === "(initial)" ? null : v;
      else if (key === "branch.head") h.branch = v === "(detached)" ? null : v;
      else if (key === "branch.upstream") h.upstream = v;
      else if (key === "branch.ab") { const [a, b] = v.split(" "); h.ahead = +a.slice(1); h.behind = +b.slice(1); }
      else if (key === "stash") h.stash = +v;
    } else if (r[0] === "?") h.untracked++;
    else if (r[0] === "u") h.unmerged++;
    else if (r[0] === "1" || r[0] === "2") {
      if (r[2] !== ".") h.staged++;
      if (r[3] !== ".") h.unstaged++;
      if (r[0] === "2") i++; // rename source record
    }
  }
  return h;
}

// `fetch --porcelain`: "<flag> <old> <new> <ref>"; flag " " ff, "+" forced, "-" pruned, "t" tag, "*" new, "!" rejected, "=" up to date
export function parseFetch(text) {
  return lines(text).map((l) => {
    const [old, nu, ref] = l.slice(2).split(" ");
    return { flag: l[0], old, new: nu, ref };
  }).filter((r) => r.ref);
}

export function createGgit({ run, testPath }) {
  const git = (args, cwd) => run(args, { cwd });

  async function version() {
    const r = await git(["version"]);
    const v = r.code === 0 ? parseVersion(r.stdout) : null;
    return { version: v, supported: !!v && (v[0] > MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] >= MIN_GIT[1])) };
  }

  // Detect bare repositories first, then resolve the worktree root. git supplies absolute paths.
  async function target(cwd) {
    const r = await git([...READ, "rev-parse", "--path-format=absolute", "--is-bare-repository", "--absolute-git-dir", "--git-common-dir"], cwd);
    if (r.code !== 0) return { ok: false, reason: "not-a-repo", stderr: r.stderr.trim() };
    const [bare, gitDir, commonDir] = lines(r.stdout);
    const t = { ok: true, bare: bare === "true", gitDir, commonDir, root: null };
    if (!t.bare) {
      const top = await git([...READ, "rev-parse", "--show-toplevel"], cwd);
      if (top.code === 0) t.root = top.stdout.trim();
    }
    return t;
  }

  async function header(t) {
    const r = await git([...READ, "status", "--porcelain=v2", "--branch", "--show-stash", "-z"], t.root);
    if (r.code !== 0) return { ok: false, stderr: r.stderr.trim() };
    return { ok: true, ...parseHeader(r.stdout) };
  }

  async function inProgress(t) {
    const args = [...READ, "rev-parse", "--path-format=absolute", ...STATES.flatMap(([, f]) => ["--git-path", f])];
    const r = await git(args, t.root ?? t.gitDir);
    if (r.code !== 0) return { ok: false, stderr: r.stderr.trim() };
    const paths = lines(r.stdout);
    // All checks at once (nine `test -e` one after another were the biggest part of a refresh in herdr).
    const here = await Promise.all(paths.slice(0, STATES.length).map((p) => testPath(p, { cwd: t.root ?? t.gitDir })));
    const found = [];
    for (let i = 0; i < STATES.length; i++) {
      const [kind, file, extra] = STATES[i];
      if (found.some((f) => f.kind === kind)) continue; // rebase-apply after am
      if (here[i]) found.push({ kind, file, ...(extra ?? {}) });
    }
    return { ok: true, states: found };
  }

  // --no-auto-maintenance; remote = the current branch's upstream remote.
  async function fetch(t, h) {
    const cwd = t.root ?? t.gitDir;
    let remote = null;
    if (h?.branch) {
      const c = await git(["config", "--get", `branch.${h.branch}.remote`], cwd);
      if (c.code === 0) remote = c.stdout.trim();
    }
    if (!remote) return { operation: "fetch", outcome: "refused", reason: "no-upstream" };
    let r;
    try { r = await git(["fetch", "--porcelain", "--no-auto-maintenance", remote], cwd); }
    catch (e) { return { operation: "fetch", remote, outcome: "unknown", reason: "timeout-or-not-started", error: String(e) }; }
    if (r.code === -1) return { operation: "fetch", remote, outcome: "unknown", reason: "killed", stderr: r.stderr };
    const refs = parseFetch(r.stdout);
    if (r.code !== 0) return { operation: "fetch", remote, outcome: refs.some((x) => x.flag !== "!" && x.flag !== "=") ? "partial" : "refused", exitCode: r.code, refs, stderr: r.stderr.trim() };
    const changed = refs.filter((x) => x.flag !== "=");
    return { operation: "fetch", remote, outcome: changed.length ? "completed" : "noop", refs: changed, stderr: r.stderr.trim() };
  }

  // Writes return { operation, outcome, ..., commands }; commands feed the Details disclosure.
  // Rejected execs and killed git processes have an unknown outcome because git may still be working. Never retry automatically.
  async function write(operation, steps) {
    const commands = [];
    const sh = async (args, cwd) => {
      let r;
      try { r = await git(args, cwd); } catch (e) { commands.push({ args, error: String(e) }); throw { unknown: "timeout-or-not-started" }; }
      commands.push({ args, code: r.code, stdout: r.stdout, stderr: r.stderr });
      if (r.code === -1) throw { unknown: "killed" };
      return r;
    };
    try { return { operation, ...(await steps(sh)), commands }; }
    catch (e) { if (e?.unknown) return { operation, outcome: "unknown", reason: e.unknown, commands }; throw e; }
  }
  const rev = async (sh, cwd, ref) => { const r = await sh([...READ, "rev-parse", "-q", "--verify", ref], cwd); return r.code === 0 ? r.stdout.trim() : null; };
  const statusOf = async (sh, cwd) => parseHeader((await sh([...READ, "status", "--porcelain=v2", "--branch", "--show-stash", "-z"], cwd)).stdout);

  // Stash uses git's defaults with optional -u / -a flags. Judge by refs/stash and working-tree changes, not exit code.
  const stashPush = (t, flags = []) => write("stash", async (sh) => {
    const cwd = t.root, before = await rev(sh, cwd, "refs/stash"), b = await statusOf(sh, cwd);
    const r = await sh(["stash", "push", ...flags], cwd);
    const after = await rev(sh, cwd, "refs/stash"), a = await statusOf(sh, cwd);
    if (r.code !== 0) return { outcome: "refused", exitCode: r.code, stderr: r.stderr.trim() };
    // The top stash can stay unchanged while work is saved; a cleaner worktree also counts as success.
    const moved = after !== before, cleaner = a.staged + a.unstaged + a.untracked < b.staged + b.unstaged + b.untracked;
    return { outcome: moved || cleaner ? "completed" : "noop", stash: after, left: { staged: a.staged, unstaged: a.unstaged, untracked: a.untracked } };
  });

  // Address stashes by OID. Apply accepts an OID, but drop requires stash@{n}, which can shift between lookup and deletion.
  // Verify the OID printed by drop and restore a wrongly dropped stash immediately.
  const stashList = async (sh, cwd) => lines((await sh([...READ, "stash", "list", "--format=%H%x1f%gs"], cwd)).stdout).map((l) => { const [oid, msg] = l.split("\x1f"); return { oid, msg }; });
  const stashOids = async (sh, cwd) => (await stashList(sh, cwd)).map((x) => x.oid);
  async function dropOid(sh, cwd, oid) {
    const list = await stashList(sh, cwd), n = list.findIndex((x) => x.oid === oid);
    if (n < 0) return { outcome: "refused", reason: "stash-gone" };
    const r = await sh(["stash", "drop", `stash@{${n}}`], cwd);
    if (r.code !== 0) return { outcome: "refused", exitCode: r.code, stderr: r.stderr.trim() };
    const gone = /\(([0-9a-f]{40,64})\)/.exec(r.stdout + r.stderr)?.[1] ?? null;
    if (gone === oid) return { outcome: "completed", oid, n };
    if (gone) await sh(["stash", "store", "-m", list.find((x) => x.oid === gone)?.msg ?? "ggit: restored", gone], cwd);
    return { outcome: "refused", reason: "stash-moved", stderr: gone ? "The stash list changed under the drop; the other stash was put back (at the top)" : "Could not tell which stash was dropped" };
  }
  const applyOid = async (sh, cwd, oid, flags) => {
    if (!(await stashOids(sh, cwd)).includes(oid)) return { r: null, refused: { outcome: "refused", reason: "stash-gone" } };
    return { r: await sh(["stash", "apply", ...flags, oid], cwd) };
  };
  // Pop = apply then drop, as git does, both by OID; a conflict keeps the stash (git's rule).
  const stashPop = (t, oid, flags = []) => write("pop", async (sh) => {
    const cwd = t.root, { r, refused } = await applyOid(sh, cwd, oid, flags);
    if (refused) return { ...refused, applied: "none", entryRemoved: false };
    const a = await statusOf(sh, cwd);
    if (a.unmerged) return { outcome: "conflict", applied: "some", entryRemoved: false, unmerged: a.unmerged, stderr: r.stderr.trim() };
    if (r.code !== 0) return { outcome: "refused", applied: "none", entryRemoved: false, exitCode: r.code, stderr: r.stderr.trim() };
    const d = await dropOid(sh, cwd, oid);
    return d.outcome === "completed" ? { outcome: "completed", applied: "all", entryRemoved: true } : { outcome: "unknown", applied: "all", entryRemoved: false, stderr: "Applied, but the stash was not dropped: " + (d.stderr ?? d.reason) };
  });
  const stashApply = (t, oid, flags = []) => write("apply", async (sh) => {
    const cwd = t.root, { r, refused } = await applyOid(sh, cwd, oid, flags);
    if (refused) return refused;
    const a = await statusOf(sh, cwd);
    if (a.unmerged) return { outcome: "conflict", unmerged: a.unmerged, stderr: r.stderr.trim() };
    return r.code === 0 ? { outcome: "completed" } : { outcome: "refused", exitCode: r.code, stderr: r.stderr.trim() };
  });
  const stashDrop = (t, oid) => write("drop", (sh) => dropOid(sh, t.root, oid));

  // off → `branch`, on → `switch -c` (one command; a refused switch creates nothing).
  const branchCreate = (t, name, { switchTo = false, from = "HEAD" } = {}) => write("branch", async (sh) => {
    const cwd = t.root;
    const ok = await sh(["check-ref-format", "--branch", name], cwd);
    if (ok.code !== 0) return { outcome: "refused", reason: "invalid-name", name };
    const r = await sh(switchTo ? ["switch", "-c", name, from] : ["branch", name, from], cwd);
    const oid = await rev(sh, cwd, `refs/heads/${name}`), a = await statusOf(sh, cwd);
    if (r.code !== 0) return { outcome: "refused", name, created: !!oid, exitCode: r.code, stderr: r.stderr.trim() };
    return { outcome: "completed", name, oid, head: a.branch };
  });

  // rename a local branch (`branch -m`; git refuses a name in use). The remote is not renamed.
  const branchRename = (t, from, to) => write("rename", async (sh) => {
    const cwd = t.root;
    if ((await sh(["check-ref-format", "--branch", to], cwd)).code !== 0) return { outcome: "refused", reason: "invalid-name", name: to };
    const r = await sh(["branch", "-m", "--", from, to], cwd);
    return r.code === 0 ? { outcome: "completed", from, name: to } : { outcome: "refused", from, name: to, exitCode: r.code, stderr: r.stderr.trim() };
  });

  // what deleting a local branch would lose — its commits that no other branch, remote, tag or HEAD has.
  async function branchOwn(t, name) {
    const r = await git([...READ, "rev-list", "--count", `refs/heads/${name}`, "--not", `--exclude=refs/heads/${name}`, "--all"], t.root);
    return r.code === 0 ? Number(r.stdout.trim()) : null;
  }
  // Delete only the displayed tip using update-ref -d <ref> <oid> compare-and-swap; branch -D lacks that guard.
  // First refuse the current branch or one checked out in another worktree. Back up unique commits under
  // refs/ggit/deleted/<oid>/<name> so reusing a name preserves earlier backups. On failure, remove only the backup
  // created by this attempt. A failed ownership count refuses deletion.
  const branchDelete = (t, name, expect = null) => write("delete-branch", async (sh) => {
    const cwd = t.root, ref = `refs/heads/${name}`, oid = await rev(sh, cwd, ref);
    if (!oid) return { outcome: "refused", name, stderr: `No branch ${name}` };
    if (expect && oid !== expect) return { outcome: "refused", name, reason: "moved", stderr: `${name} moved since you looked (now ${oid.slice(0, 7)})` };
    const wt = (await sh([...READ, "worktree", "list", "--porcelain", "-z"], cwd)).stdout.split("\0");
    if (wt.includes(`branch ${ref}`)) return { outcome: "refused", name, stderr: `${name} is checked out in a worktree` };
    const own = await branchOwn(t, name);
    if (own === null) return { outcome: "refused", name, stderr: "Could not tell which commits only it has" };
    const keep = own ? `refs/ggit/deleted/${oid}/${name}` : null;
    const made = keep && !(await rev(sh, cwd, keep));
    if (made && (await sh(["update-ref", keep, oid, ""], cwd)).code !== 0) return { outcome: "refused", name, stderr: "Could not keep a backup ref" };
    const r = await sh(["update-ref", "-m", "ggit: delete branch", "-d", ref, oid], cwd);
    if (r.code !== 0) { if (made) await sh(["update-ref", "-d", keep, oid], cwd); return { outcome: "refused", name, exitCode: r.code, stderr: r.stderr.trim() }; }
    await sh(["config", "--remove-section", `branch.${name}`], cwd); // as branch -D; none is fine
    return { outcome: "completed", name, oid, kept: keep, own };
  });

  // push one tag to a remote. The tag object the dialog showed (expect), by its OID, so a tag moved since is not
  // the one sent; an annotated tag stays annotated.
  const tagPush = (t, tag, remote, expect = null) => write("push-tag", async (sh) => {
    const cwd = t.root, oid = await rev(sh, cwd, `refs/tags/${tag}`);
    if (!oid) return { outcome: "refused", tag, remote, stderr: `No tag ${tag}` };
    if (expect && oid !== expect) return { outcome: "refused", tag, remote, stderr: `${tag} moved since you looked` };
    const r = await sh(["push", "--porcelain", remote, `${oid}:refs/tags/${tag}`], cwd);
    return r.code === 0 ? { outcome: "completed", tag, remote } : { outcome: "refused", tag, remote, exitCode: r.code, stderr: r.stderr.trim() };
  });

  // a tag at a commit. A message makes it annotated, none a lightweight one. git refuses a name in use (no -f).
  const tagCreate = (t, name, sha, message = "") => write("tag", async (sh) => {
    const cwd = t.root;
    if ((await sh(["check-ref-format", `refs/tags/${name}`], cwd)).code !== 0) return { outcome: "refused", reason: "invalid-name", name };
    const r = await sh(message ? ["tag", "-a", "-m", message, "--", name, sha] : ["tag", "--", name, sha], cwd);
    return r.code === 0 ? { outcome: "completed", name, sha } : { outcome: "refused", name, exitCode: r.code, stderr: r.stderr.trim() };
  });

  // Resolve a remote-tracking ref through the remote's fetch refspecs: origin/foo can map to release/foo.
  // Return exactly one refs/heads/ mapping, or null. local is git's name for the corresponding local branch.
  async function splitRemote(cwd, name) {
    const r = await git([...READ, "config", "--get-regexp", "^remote\\..*\\.fetch$"], cwd);
    const ref = `refs/remotes/${name}`, hits = [];
    for (const l of lines(r.stdout)) {
      const sp = l.indexOf(" "), key = l.slice(0, sp), spec = l.slice(sp + 1).replace(/^\+/, "");
      const remote = key.slice("remote.".length, -".fetch".length), [src, dst] = spec.split(":");
      if (!src || !dst || spec.startsWith("^")) continue;
      const i = dst.indexOf("*");
      if (i < 0) { if (dst === ref) hits.push({ remote, src }); continue; }
      const pre = dst.slice(0, i), post = dst.slice(i + 1);
      if (ref.length > pre.length + post.length && ref.startsWith(pre) && ref.endsWith(post)) hits.push({ remote, src: src.replace("*", ref.slice(pre.length, ref.length - post.length)) });
    }
    const u = [...new Map(hits.map((h) => [h.remote + "\0" + h.src, h])).values()];
    if (u.length !== 1 || !u[0].src.startsWith("refs/heads/")) return null;
    const { remote, src } = u[0];
    return { remote, src, branch: src.slice("refs/heads/".length), local: name.startsWith(remote + "/") ? name.slice(remote.length + 1) : src.slice("refs/heads/".length) };
  }
  // fetch one remote branch into its remote-tracking ref.
  const fetchBranch = (t, name) => write("fetch-branch", async (sh) => {
    const cwd = t.root, rb = await splitRemote(cwd, name);
    if (!rb) return { outcome: "refused", stderr: `No remote for ${name}` };
    const r = await sh(["fetch", "--porcelain", "--no-auto-maintenance", rb.remote, `+${rb.src}:refs/remotes/${name}`], cwd);
    return r.code === 0 ? { outcome: "completed", name } : { outcome: "refused", name, exitCode: r.code, stderr: r.stderr.trim() };
  });
  // delete a branch on its remote, only if the remote still has the commit we showed (--force-with-lease with that
  // commit: someone's push since is not deleted).
  const remoteBranchDelete = (t, name, expect) => write("delete-remote", async (sh) => {
    const cwd = t.root, rb = await splitRemote(cwd, name);
    if (!rb) return { outcome: "refused", name, stderr: `No remote for ${name}` };
    const r = await sh(["push", "--porcelain", `--force-with-lease=${rb.src}:${expect}`, rb.remote, `:${rb.src}`], cwd);
    return r.code === 0 ? { outcome: "completed", name, oid: expect } : { outcome: "refused", name, exitCode: r.code, stderr: (r.stderr || r.stdout).trim() };
  });
  // a local branch's upstream, only to a remote branch that has been fetched (its remote-tracking ref exists).
  const setUpstream = (t, branch, name) => write("upstream", async (sh) => {
    const cwd = t.root;
    if (!(await rev(sh, cwd, `refs/remotes/${name}`))) return { outcome: "refused", reason: "not-fetched", name, stderr: `${name} has not been fetched` };
    const r = await sh(["branch", `--set-upstream-to=refs/remotes/${name}`, "--", branch], cwd); // full ref: a local "origin/x" is not it
    return r.code === 0 ? { outcome: "completed", branch, name } : { outcome: "refused", branch, name, exitCode: r.code, stderr: r.stderr.trim() };
  });

  // Parse push --porcelain as "<flag>\t<from>:<to>\t<summary>". Push the click-time OID as <oid>:<ref> to the
  // configured upstream, not the job-time HEAD. Repeating after a timeout then sends the same commit even
  // if the first git process is still running. Without an upstream, use -u with the only remote or origin and the branch name.
  const push = (t, h) => write("push", async (sh) => {
    const cwd = t.root;
    if (!h?.branch || !h?.oid) return { outcome: "refused", reason: "detached-head" };
    const cfg = async (k) => { const r = await sh([...READ, "config", "--get", `branch.${h.branch}.${k}`], cwd); return r.code === 0 ? r.stdout.trim() : null; };
    let args = ["push", "--porcelain"], setUp = null;
    if (h.upstream) {
      const [remote, merge] = [await cfg("remote"), await cfg("merge")];
      if (!remote || !merge) return { outcome: "refused", reason: "no-upstream", stderr: `${h.branch} has no upstream in its config` };
      args = [...args, remote, `${h.oid}:${merge}`];
    } else {
      const remotes = lines((await sh(["remote"], cwd)).stdout);
      const remote = remotes.length === 1 ? remotes[0] : remotes.includes("origin") ? "origin" : null;
      if (!remote) return { outcome: "refused", reason: remotes.length ? "which-remote" : "no-remote", remotes };
      args = [...args, remote, `${h.oid}:refs/heads/${h.branch}`];
      setUp = remote; // -u sets no upstream for an <oid> source: set what it would, once the push went through
    }
    const r = await sh(args, cwd);
    const refs = r.stdout.split("\n").filter((l) => /^[ *+\-=!]\t/.test(l)).map((l) => { const [flag, spec, summary] = l.split("\t"); return { flag, spec, summary }; });
    if (!refs.length) return { outcome: r.code === 0 ? "unknown" : "refused", exitCode: r.code, stderr: r.stderr.trim() }; // A successful push with unparseable output has an unknown result.
    const rejected = refs.filter((x) => x.flag === "!"), changed = refs.filter((x) => x.flag !== "!" && x.flag !== "=");
    const outcome = !rejected.length ? (changed.length ? "completed" : "noop") : changed.length ? "partial" : "refused";
    if (setUp && (outcome === "completed" || outcome === "noop")) {
      const a = await sh(["config", `branch.${h.branch}.remote`, setUp], cwd), b = await sh(["config", `branch.${h.branch}.merge`, `refs/heads/${h.branch}`], cwd);
      if (a.code || b.code) return { outcome, refs, exitCode: r.code, stderr: `Pushed, but the upstream was not set: ${(a.stderr || b.stderr).trim()}` };
    }
    return { outcome, refs, exitCode: r.code, stderr: r.stderr.trim() };
  });

  // Run plain git pull. Classify integration effects only; fetching refs alone does not make a refusal a partial write.
  const pull = (t) => write("pull", async (sh) => {
    const cwd = t.root, before = await rev(sh, cwd, "HEAD");
    const kinds = async () => { const ip = await inProgress(t); return ip.ok ? ip.states.map((s) => s.kind).filter((k) => k !== "index-lock") : []; };
    const had = await kinds(); // An operation already stopped before Pull is not a conflict caused by this pull.
    const r = await sh(["pull"], cwd);
    const after = await rev(sh, cwd, "HEAD"), a = await statusOf(sh, cwd), states = (await kinds()).filter((k) => !had.includes(k));
    const base = { exitCode: r.code, headMoved: before !== after, unmerged: a.unmerged, states, stash: a.stash, stderr: r.stderr.trim() };
    if (a.unmerged || states.length) return { outcome: "conflict", ...base };
    if (r.code !== 0) return { outcome: before === after ? "refused" : "unknown", ...base };
    return { outcome: before === after ? "noop" : "completed", ...base };
  });

  // The OID Pop will act on, read with the header so a click pops what the user saw.
  async function stashTop(t) { const r = await git([...READ, "rev-parse", "-q", "--verify", "refs/stash"], t.root); return r.code === 0 ? r.stdout.trim() : null; }

  // `worktree add <path> [-b <branch>] <from>`: no branch name = detached at <from>.
  const worktreeAdd = (t, path, { branch = null, from = "HEAD" } = {}) => write("worktree", async (sh) => {
    const cwd = t.root ?? t.gitDir;
    if (branch && (await sh(["check-ref-format", "--branch", branch], cwd)).code !== 0) return { outcome: "refused", reason: "invalid-name", name: branch };
    // Not inside the repository: git would allow it and the repo would see the worktree as untracked files.
    const root = (t.root ?? "").replace(/\/$/, "");
    if (root && (path === root || path.startsWith(root + "/"))) return { outcome: "refused", reason: "inside-repo", path };
    const r = await sh(["worktree", "add", ...(branch ? ["-b", branch] : ["--detach"]), path, from], cwd);
    if (r.code !== 0) return { outcome: "refused", path, exitCode: r.code, stderr: r.stderr.trim() };
    return { outcome: "completed", path, branch };
  });

  // Worktree actions: remove without --force (git refuses dirty or locked worktrees), optionally delete its branch
  // with branch -d (refusing unmerged work), lock / unlock, prune and repair.
  const worktreeRemove = (t, path, { branch = null } = {}) => write("wt-remove", async (sh) => {
    const cwd = t.root;
    const r = await sh(["worktree", "remove", path], cwd);
    if (r.code !== 0) return { outcome: "refused", path, exitCode: r.code, stderr: r.stderr.trim() };
    if (!branch) return { outcome: "completed", path };
    const b = await sh(["branch", "-d", branch], cwd);
    return b.code === 0 ? { outcome: "completed", path, branch } : { outcome: "refused", path, exitCode: b.code, stderr: "Worktree removed; " + b.stderr.trim() };
  });
  // The result's operation names the action (header.js resultText): "worktree" is the create card.
  const worktreeCmd = (t, args, name) => write(name, async (sh) => {
    const r = await sh(["worktree", ...args], t.root);
    return r.code === 0 ? { outcome: "completed" } : { outcome: "refused", exitCode: r.code, stderr: r.stderr.trim() };
  });
  const worktreeLock = (t, path, lock) => worktreeCmd(t, [lock ? "lock" : "unlock", path], "wt-lock");
  const worktreePrune = (t) => worktreeCmd(t, ["prune"], "wt-prune");
  const worktreeRepair = (t) => worktreeCmd(t, ["repair"], "wt-repair");

  // `revert --no-edit <sha>`. A merge needs a mainline this UI does not ask for, so it is refused before running.
  const revert = (t, sha) => write("revert", async (sh) => {
    const cwd = t.root, parents = (await sh([...READ, "rev-list", "--parents", "-n", "1", sha], cwd)).stdout.trim().split(" ").length - 1;
    if (parents > 1) return { outcome: "refused", reason: "merge-commit" };
    const before = await rev(sh, cwd, "HEAD");
    const r = await sh(["revert", "--no-edit", sha], cwd);
    const after = await rev(sh, cwd, "HEAD"), a = await statusOf(sh, cwd);
    if (a.unmerged) return { outcome: "conflict", unmerged: a.unmerged, stderr: r.stderr.trim() };
    if (r.code !== 0) return { outcome: "refused", exitCode: r.code, stderr: r.stderr.trim() };
    return { outcome: before === after ? "noop" : "completed", head: after };
  });

  // `switch --detach <sha>`: git refuses when local changes would be overwritten, and then nothing moves.
  const checkoutDetached = (t, sha) => write("checkout", async (sh) => {
    const cwd = t.root, r = await sh(["switch", "--detach", sha], cwd);
    if (r.code !== 0) return { outcome: "refused", exitCode: r.code, stderr: r.stderr.trim() };
    return { outcome: "completed", head: await rev(sh, cwd, "HEAD") };
  });

  // Double-click a local branch to switch; a remote-only label creates a local tracking branch.
  // git refuses existing local names or changes that would be overwritten.
  // Stash and switch saves blocking local changes first, leaving the stash available for Pop.
  const switchBranch = (t, name, { remote = false, stash = false } = {}) => write("switch", async (sh) => {
    const cwd = t.root;
    if (stash) {
      const before = await rev(sh, cwd, "refs/stash"), s = await sh(["stash", "push", "-u", "-m", `ggit: before switching to ${name}`], cwd);
      if (s.code !== 0 || (await rev(sh, cwd, "refs/stash")) === before) return { outcome: "refused", name, remote, stderr: s.stderr.trim() || "Could not stash the changes" };
    }
    const r = await sh(remote ? ["switch", "--track", name] : ["switch", name], cwd);
    if (r.code !== 0) return { outcome: "refused", name, remote, stashed: stash, exitCode: r.code, stderr: r.stderr.trim() };
    return { outcome: "completed", name, stashed: stash, branch: (await statusOf(sh, cwd)).branch };
  });
  // a remote label's double click = "up to date with it": no local branch of that name → make one tracking it; one that
  // the remote is ahead of → switch to it and fast-forward; the same commit → switch; diverged → refused (no merge here).
  const syncRemote = (t, name) => write("sync", async (sh) => {
    const cwd = t.root, rb = await splitRemote(cwd, name);
    if (!rb) return { outcome: "refused", name, stderr: `No remote for ${name}` };
    const branch = rb.local, ref = `refs/heads/${branch}`;
    const local = await rev(sh, cwd, ref), far = await rev(sh, cwd, `refs/remotes/${name}`);
    if (!far) return { outcome: "refused", name, stderr: `${name} has not been fetched` };
    if (!local) { const r = await sh(["switch", "-c", branch, "--track", `refs/remotes/${name}`], cwd); return r.code === 0 ? { outcome: "completed", name, branch, made: true } : { outcome: "refused", name, stderr: r.stderr.trim() }; }
    if (local !== far && (await sh([...READ, "merge-base", "--is-ancestor", local, far], cwd)).code !== 0)
      return { outcome: "refused", name, branch, reason: "diverged", stderr: `${branch} has commits ${name} does not: pull or merge instead` };
    const head = async () => (await sh([...READ, "symbolic-ref", "-q", "HEAD"], cwd)).stdout.trim();
    const cur = await head();
    if (cur !== ref) {
      // Advance the target branch with compare-and-swap before switching, so a concurrent checkout cannot
      // redirect the fast-forward to an unrelated HEAD.
      if (local !== far) {
        const wt = await sh([...READ, "worktree", "list", "--porcelain"], cwd);
        if (wt.stdout.split("\n").includes(`branch ${ref}`)) return { outcome: "refused", name, branch, stderr: `${branch} is checked out in another worktree: update it there` };
        const u = await sh(["update-ref", "-m", `ggit: fast-forward to ${name}`, ref, far, local], cwd);
        if (u.code !== 0) return { outcome: "refused", name, branch, reason: "stale", stderr: `${branch} moved: look again` };
      }
      const s = await sh(["switch", branch], cwd);
      if (s.code !== 0) return { outcome: local !== far ? "unknown" : "refused", name, branch, stderr: (local !== far ? `${branch} now matches ${name}, but the switch failed: ` : "") + s.stderr.trim() };
    } else if (local !== far) {
      // ponytail: on the checked-out branch git merge is the only way to move it with its files; a switch elsewhere
      // landing just before it is caught below, not prevented.
      const m = await sh(["merge", "--ff-only", far], cwd);
      if (m.code !== 0) return { outcome: "refused", name, branch, stderr: m.stderr.trim() };
    }
    if ((await head()) !== ref || (await rev(sh, cwd, ref)) !== far) return { outcome: "unknown", name, branch, stderr: `HEAD or ${branch} moved while syncing: look at both` };
    return { outcome: "completed", name, branch, ...(local !== far ? { ff: true } : {}) };
  });

  // ---- the WIP commit pane. Paths are literal (no globs), and `--` keeps a "-name" from reading as an option.
  // Unborn HEAD (no commit yet): unstaging is `rm --cached`, since there is nothing to restore from.
  const LIT = "--literal-pathspecs";
  const born = async (sh, cwd) => (await rev(sh, cwd, "HEAD")) !== null;
  const done = (r, extra = {}) => (r.code === 0 ? { outcome: "completed", ...extra } : { outcome: "refused", exitCode: r.code, stderr: r.stderr.trim(), ...extra });
  // paths = null: every change.
  // An empty list stages nothing (`add -A --` with no path would take every change).
  const stage = (t, paths = null) => paths && !paths.length ? Promise.resolve({ operation: "stage", outcome: "noop", count: 0 }) : write("stage", async (sh) => done(await sh(paths ? [LIT, "add", "-A", "--", ...paths] : ["add", "-A"], t.root), { count: paths?.length ?? null }));
  const unstage = (t, paths = null) => write("unstage", async (sh) => {
    const cwd = t.root, b = await born(sh, cwd);
    const args = paths ? (b ? [LIT, "restore", "--staged", "--", ...paths] : [LIT, "rm", "--cached", "-r", "-q", "--", ...paths])
      : (b ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "."]);
    return done(await sh(args, cwd), { count: paths?.length ?? null });
  });
  // Unstaged changes go back to what the index has; untracked files are deleted. files: [{ path, untracked }] | null (all).
  const discard = (t, files = null) => write("discard", async (sh) => {
    const cwd = t.root, tracked = files?.filter((f) => !f.untracked).map((f) => f.path), others = files?.filter((f) => f.untracked).map((f) => f.path);
    if (!files || tracked.length) {
      const r = await sh(files ? [LIT, "restore", "--worktree", "--", ...tracked] : ["restore", "--worktree", "--", "."], cwd);
      if (r.code !== 0 && !(files === null && /did not match any file/.test(r.stderr))) return done(r);
    }
    if (!files || others.length) { const r = await sh(files ? [LIT, "clean", "-f", "-q", "--", ...others] : ["clean", "-f", "-d", "-q", "--", "."], cwd); if (r.code !== 0) return done(r); }
    return { outcome: "completed", count: files?.length ?? null };
  });
  // --cleanup=strip: a loaded template's "#" lines never reach the commit, as in git's editor.
  const commit = (t, message, { amend = false } = {}) => write(amend ? "amend" : "commit", async (sh) => {
    const cwd = t.root, r = await sh(["commit", "--cleanup=strip", ...(amend ? ["--amend"] : []), "-m", message], cwd);
    if (r.code !== 0) return { outcome: "refused", exitCode: r.code, stderr: (r.stderr.trim() || r.stdout.trim()) };
    return { outcome: "completed", head: await rev(sh, cwd, "HEAD") };
  });
  // Reads: the last commit's message (Amend) and commit.template's path (the file itself is read by the caller).
  const lastMessage = async (t) => { const r = await git([...READ, "log", "-1", "--format=%B"], t.root); return r.code === 0 ? r.stdout.replace(/\n+$/, "") : null; };
  const templatePath = async (t) => { const r = await git([...READ, "config", "--path", "--get", "commit.template"], t.root); return r.code === 0 ? r.stdout.trim() || null : null; };

  return { stage, unstage, discard, commit, lastMessage, templatePath,
    tagCreate, fetchBranch, remoteBranchDelete, setUpstream, syncRemote,
    version, target, header, inProgress, fetch, stashTop, worktreeAdd, worktreeRemove, worktreeLock, worktreePrune, worktreeRepair, revert, checkoutDetached, switchBranch, stashPush, stashPop, branchCreate, stashApply, stashDrop, branchRename, branchOwn, branchDelete, tagPush, push, pull };
}

// herdr adapter: pass environment changes through env because options.env is ignored. Remove repository-selecting
// variables and disable interactive authentication. Preserve core.sshCommand.
export const GIT_ENV = ["GIT_TERMINAL_PROMPT=0", "SSH_ASKPASS_REQUIRE=never"];
// The global pathspec modes too: the writes pass --literal-pathspecs, which git refuses beside any of them.
export const UNSET = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"];
export function herdrAdapter(exec, on) {
  return {
    run: (args, { cwd }) => exec("env", [...UNSET.flatMap((v) => ["-u", v]), ...GIT_ENV, "git", "-c", "credential.interactive=false", ...args], { cwd, on }),
    testPath: async (path, { cwd }) => (await exec("test", ["-e", path], { cwd, on })).code === 0,
    // Mods have no fs access: read git state with cat and perform checked writes in one shell process to avoid a gap
    // between separate execs. exec has no stdin, so pass text as arguments.
    // ponytail: ARG_MAX limits total argv to roughly 1–2 MB; Linux also caps individual arguments at 128 KiB.
    // Save splits arguments and refuses content over 600 KB; a streamed-input API would lift this limit.
    readFile: async (path, { cwd }) => { const r = await exec("cat", ["--", path], { cwd, on }); return r.code === 0 ? r.stdout : null; },
    sh: (script, args, { cwd }) => exec("env", [...UNSET.flatMap((v) => ["-u", v]), ...GIT_ENV, "sh", "-c", script, "sh", ...args], { cwd, on }),
  };
}
