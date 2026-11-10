// Plan merges from git state, then re-read and refuse if the plan's basis changed.
// Leave native conflict state (MERGE_HEAD and index stages) for Conflict Mode.
// No herdr dependency; ad is core.js's { run, testPath } adapter.
import { READ } from "./core.js";

const lines = (s) => s.split("\n").filter(Boolean);
const short = (s) => (s ?? "").slice(0, 7);

// `merge-tree --write-tree --name-only -z A B`: "<tree>\0<path>\0…\0\0<messages>". exit 0 clean, 1 conflicts.
export function parseMergeTree(out) {
  const parts = out.split("\0"), tree = parts[0], files = [];
  for (let i = 1; i < parts.length && parts[i]; i++) files.push(parts[i]);
  return { tree, files };
}

// Plan merging source into into (null means the checked-out branch). Prefer full refs to distinguish branches
// from same-named tags; short names remain accepted for callers that only have them.
export const shortName = (ref) => ref.replace(/^refs\/(heads|remotes|tags)\//, "");
// git's own message for the merge (fmt-merge-msg): by the kind of ref, " into <branch>" except for main / master.
export function mergeMessage(ref, into) {
  const n = shortName(ref), kind = ref.startsWith("refs/remotes/") ? "remote-tracking branch" : ref.startsWith("refs/tags/") ? "tag" : "branch";
  return `Merge ${kind} '${n}'${into && into !== "main" && into !== "master" ? ` into ${into}` : ""}`;
}
// → { title, kind: "ff" | "merge" | "conflict" | null, current, after, blockers[], warnings[], files[], conflicts[], recovery, basis }
export async function mergePlan(ad, cwd, source, into = null) {
  const run = ad.run;
  const git = (args) => run(args, { cwd });
  const rd = (args) => git([...READ, ...args]);
  const oid = async (ref) => { const r = await rd(["rev-parse", "-q", "--verify", `${ref}^{commit}`]); return r.code === 0 ? r.stdout.trim() : null; };
  const sym = await rd(["symbolic-ref", "-q", "--short", "HEAD"]);
  const head = sym.code === 0 ? sym.stdout.trim() : null;
  const target = into ?? head;
  const p = { source, name: shortName(source), into: target, title: `Merge ${shortName(source)} into ${target ?? "HEAD"}`, kind: null, blockers: [], warnings: [], files: [], conflicts: [], current: "", after: "", basis: null };
  const src = await oid(source);
  if (!src) { p.blockers.push(`${p.name} names no commit`); return p; }
  const offBranch = into !== null && into !== head;

  let tgt;
  if (!offBranch) {
    if (!head) { p.blockers.push("HEAD is detached: check out the branch to merge into first"); return p; }
    tgt = await oid("HEAD");
    if (!tgt) { p.blockers.push(`${head} has no commit yet`); return p; }
    const [st, ops] = await Promise.all([rd(["status", "--porcelain=v2", "-z"]), stateFiles(ad, cwd)]);
    const recs = st.stdout.split("\0").filter(Boolean);
    const unmerged = recs.filter((r) => r[0] === "u").length;
    const dirty = recs.filter((r) => r[0] === "1" || r[0] === "2").length;
    const untracked = recs.filter((r) => r[0] === "?").length;
    if (ops.length) p.blockers.push(`A ${ops[0]} is in progress: finish or abort it first`);
    else if (unmerged) p.blockers.push(`${unmerged} file(s) are unmerged`);
    // Tracked changes block merging because the result is hard to undo; untracked files only warn.
    if (dirty) p.blockers.push("You have uncommitted changes: commit or stash them first");
    if (untracked) p.warnings.push(`${untracked} untracked file(s); git refuses if the merge would overwrite one`);
    p.current = `${head} at ${short(tgt)}`;
  } else {
    tgt = await oid(`refs/heads/${into}`);
    if (!tgt) { p.blockers.push(`No local branch ${into}`); return p; }
    const wt = await rd(["worktree", "list", "--porcelain", "-z"]);
    const out = wt.stdout.split("\0\0").find((b) => b.split("\0").includes(`branch refs/heads/${into}`));
    if (out) p.blockers.push(`${into} is checked out in ${out.split("\0")[0].replace(/^worktree /, "")}: merge there`);
    p.current = `${into} at ${short(tgt)}`;
    p.warnings.push(`Only ${into} moves; ${head ? `${head}, ` : ""}your working tree and index are not touched`);
  }
  if (src === tgt || (await git([...READ, "merge-base", "--is-ancestor", src, tgt])).code === 0) { p.blockers.push(`${target} already contains ${source}`); return p; }
  const base = await rd(["merge-base", tgt, src]);
  if (base.code !== 0) { p.blockers.push(`${source} and ${target} share no history`); return p; }
  p.basis = { head, into: target, tgt, src };
  p.recovery = offBranch ? `git branch -f ${target} ${short(tgt)}` : "git reset --hard ORIG_HEAD (right after), or git revert -m 1 <merge>";

  if ((await git([...READ, "merge-base", "--is-ancestor", tgt, src])).code === 0) {
    p.kind = "ff"; p.after = `${target} fast-forwards to ${source} (${short(src)})`;
    p.files = await nameStatus(rd, tgt, src);
    if (offBranch) p.warnings.push("Fast-forward: no merge commit");
    return p;
  }
  const mt = await git([...READ, "merge-tree", "--write-tree", "--name-only", "-z", tgt, src]);
  if (mt.code !== 0 && mt.code !== 1) { p.blockers.push(`Could not predict the merge: ${mt.stderr.trim().split("\n")[0]}`); return p; }
  const { tree, files } = parseMergeTree(mt.stdout);
  p.files = await nameStatus(rd, tgt, tree);
  if (mt.code === 1) {
    p.conflicts = files;
    if (offBranch) { p.blockers.push(`It would conflict in ${files.length} file(s); conflicts can only be resolved on a checked-out branch`); return p; }
    p.kind = "conflict"; p.after = `merge ${source} (${short(src)}) — with conflicts`;
    p.warnings.push(`${files.length} conflicted file(s): ggit opens Conflict Mode to resolve them`);
  } else {
    p.kind = "merge"; p.after = `+1 merge commit from ${source} (${short(src)})`; p.tree = tree;
  }
  const id = await git(["var", "GIT_COMMITTER_IDENT"]);
  if (id.code !== 0) p.blockers.push("Git has no user.name / user.email: set them to commit");
  return p;
}

async function nameStatus(rd, a, b) {
  const r = await rd(["diff", "--no-renames", "--name-status", "-z", a, b]);
  const parts = r.code === 0 ? r.stdout.split("\0") : [], out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) out.push({ status: parts[i], path: parts[i + 1] });
  return out;
}

// merge / rebase / cherry-pick / revert in progress, from git's own files (the names core.js's inProgress reads).
export async function stateFiles({ run, testPath }, cwd) {
  const names = [["merge", "MERGE_HEAD"], ["rebase", "rebase-merge"], ["rebase", "rebase-apply"], ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"]];
  const r = await run([...READ, "rev-parse", "--path-format=absolute", ...names.flatMap(([, f]) => ["--git-path", f])], { cwd });
  if (r.code !== 0) return [];
  const paths = lines(r.stdout);
  const here = await Promise.all(paths.map((p) => testPath(p, { cwd })));
  return names.filter((_, i) => here[i]).map(([k]) => k);
}

// Run a plan. Everything the plan saw is read again first; a change → refused with "stale" (the dialog plans again).
export async function runMerge(ad, cwd, plan) {
  const run = ad.run;
  const git = (args) => run(args, { cwd });
  const commands = [];
  const sh = async (args) => { const r = await git(args); commands.push({ args, code: r.code, stdout: r.stdout, stderr: r.stderr }); return r; };
  const op = { operation: "merge", source: plan.name ?? shortName(plan.source), into: plan.into, kind: plan.kind };
  const again = await mergePlan(ad, cwd, plan.source, plan.basis?.head === plan.into ? null : plan.into);
  const b = plan.basis, a = again.basis;
  if (!a || again.blockers.length || a.tgt !== b.tgt || a.src !== b.src || a.head !== b.head || again.kind !== plan.kind)
    return { ...op, outcome: "refused", reason: "stale", stderr: again.blockers[0] ?? "The branches moved since the plan: look again", commands };
  const offBranch = plan.into !== b.head;
  if (offBranch) {
    // Update only refs/heads/<into> with compare-and-swap against the planned tip. In the same script, refuse
    // if any worktree has that branch checked out, preventing its index from falling behind a moved ref.
    let nu = b.src;
    if (plan.kind === "merge") {
      const c = await sh(["commit-tree", again.tree, "-p", b.tgt, "-p", b.src, "-m", `${mergeMessage(plan.source, null)} into ${plan.into}`]);
      if (c.code !== 0) return { ...op, outcome: "refused", exitCode: c.code, stderr: c.stderr.trim(), commands };
      nu = c.stdout.trim();
    }
    const u = await ad.sh(INTO, [`refs/heads/${plan.into}`, nu, b.tgt, `ggit: merge ${plan.name ?? shortName(plan.source)}`], { cwd });
    commands.push({ args: ["update-ref", `refs/heads/${plan.into}`, nu, b.tgt], code: u.code, stdout: u.stdout, stderr: u.stderr });
    if (u.code !== 0) return { ...op, outcome: "refused", exitCode: u.code, stderr: u.stderr.trim(), commands };
    // ponytail: git has no lock across worktrees; a checkout between the check and update-ref is detected only
    // afterwards and reported as uncertain. Stronger guarantees require coordination across worktrees.
    const wt = await git([...READ, "worktree", "list", "--porcelain"]);
    if (wt.stdout.split("\n").includes(`branch refs/heads/${plan.into}`))
      return { ...op, outcome: "unknown", head: nu, old: b.tgt, stderr: `${plan.into} was checked out while ggit moved it: its files show the old commit; check git status there`, commands };
    return { ...op, outcome: "completed", head: nu, old: b.tgt, commands };
  }
  // On the checked-out branch, run git merge on the planned source OID with git's own message and conflict state.
  // The same script first verifies HEAD still names the planned branch, preventing stale names from redirecting the merge.
  const r = await ad.sh(ON, [`refs/heads/${plan.into}`, mergeMessage(plan.source, plan.into), plan.kind === "ff" ? "--ff-only" : "--no-ff", b.src], { cwd });
  commands.push({ args: ["merge", "--no-edit", plan.kind === "ff" ? "--ff-only" : "--no-ff", b.src], code: r.code, stdout: r.stdout, stderr: r.stderr });
  if (r.code === 5) return { ...op, outcome: "refused", reason: "stale", stderr: r.stderr.trim(), commands };
  const st = await git([...READ, "status", "--porcelain=v2", "-z"]);
  const unmerged = st.stdout.split("\0").filter((x) => x[0] === "u").length;
  if (unmerged) return { ...op, outcome: "conflict", unmerged, stderr: r.stderr.trim(), commands };
  if (r.code !== 0) return { ...op, outcome: "refused", exitCode: r.code, stderr: (r.stderr || r.stdout).trim(), commands };
  // ponytail: a switch between checking HEAD and git merge is detected only afterwards; report uncertainty.
  // Preventing the race requires coordinating concurrent writers.
  const now = (await git([...READ, "symbolic-ref", "-q", "HEAD"])).stdout.trim();
  if (now !== `refs/heads/${plan.into}`) return { ...op, outcome: "unknown", stderr: `HEAD moved to ${now.replace("refs/heads/", "") || "a detached commit"} while merging: check which branch got the merge`, commands };
  return { ...op, outcome: "completed", head: (await revOf(git, "HEAD")), commands };
}
const ON = `[ "$(git symbolic-ref -q HEAD)" = "$1" ] || { echo "HEAD is no longer \${1#refs/heads/}: look again" >&2; exit 5; }
git merge --no-edit -m "$2" "$3" "$4"`;
const INTO = `if git worktree list --porcelain | grep -qxF "branch $1"; then echo "\${1#refs/heads/} is checked out now: merge there" >&2; exit 5; fi
git update-ref -m "$4" "$1" "$2" "$3"`;
const revOf = async (git, ref) => { const r = await git([...READ, "rev-parse", "-q", "--verify", `${ref}^{commit}`]); return r.code === 0 ? r.stdout.trim() : null; };
