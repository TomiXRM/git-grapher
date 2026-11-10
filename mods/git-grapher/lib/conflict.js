// Conflict state comes from git on each read: MERGE_HEAD, rebase-merge, CHERRY_PICK_HEAD or REVERT_HEAD identify
// the operation; ls-files -u identifies unmerged files; MERGE_MSG's conflicts list identifies saved files.
// The view retains only unsaved Result text. Each write rechecks a fingerprint of the operation files and refuses stale state.
// Use Current / Incoming for side labels. ad is core.js's adapter: { run, testPath, readFile, writeFile }.
import { READ } from "./core.js";
import { stateFiles, parseMergeTree } from "./merge.js";

const short = (s) => (s ?? "").slice(0, 7);
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

// `ls-files -u -z`: "<mode> <oid> <stage>\t<path>\0" → [{ path, s1?, s2?, s3? }] in path order.
export function parseUnmerged(out) {
  const m = new Map();
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t"); if (tab < 0) continue;
    const [mode, oid, stage] = rec.slice(0, tab).split(" "), path = rec.slice(tab + 1);
    if (!m.has(path)) m.set(path, { path });
    m.get(path)["s" + stage] = { mode, oid };
  }
  return [...m.values()];
}

// What kind of choice a file needs. content: hunks; the rest: one side, whole.
export function kindOf(e) {
  const modes = [e.s1, e.s2, e.s3].filter(Boolean).map((s) => s.mode);
  if (modes.includes("160000")) return "submodule";
  if (modes.includes("120000")) return "symlink";
  if (!e.s2 && !e.s3) return "deleted-both";  // both sides removed it (a rename on each side: DD at the old name)
  if (!e.s1 && !e.s3) return "added-current";  // only Current has it here (added, or renamed to here: AU)
  if (!e.s1 && !e.s2) return "added-incoming"; // only Incoming has it here (UA)
  if (!e.s2) return "deleted-current";         // Current deleted it, Incoming changed it
  if (!e.s3) return "deleted-incoming";        // the other way round
  return "content";                             // also add/add (no base): an empty base
}

// MERGE_MSG's "# Conflicts:" block (git writes it for merge, cherry-pick and revert).
export function listedConflicts(msg) {
  const out = []; let on = false;
  for (const l of (msg ?? "").split("\n")) {
    if (/^# Conflicts:/.test(l)) { on = true; continue; }
    if (!on) continue;
    const m = /^#\t(.*)$/.exec(l);
    if (m) out.push(m[1]); else if (l !== "#") on = false;
  }
  return out;
}
// The message to commit a merge with: git's, without the comment lines.
export const mergeMessage = (msg) => (msg ?? "").split("\n").filter((l) => !l.startsWith("#")).join("\n").replace(/\n+$/, "");

// → null (no conflict to resolve and no operation stopped) or
//   { op, title, current, incoming, files: [{ path, kind, saved, e }], rev, msg }
export async function readConflict(ad, cwd) {
  const git = (args) => ad.run([...READ, ...args], { cwd });
  const [ops, u] = await Promise.all([stateFiles(ad, cwd), git(["ls-files", "-u", "-z"])]);
  const unmerged = u.code === 0 ? parseUnmerged(u.stdout) : [];
  if (!ops.length && !unmerged.length) return null;
  // A sequencer stopped on a merge step also leaves MERGE_HEAD; use the rebase / cherry-pick / revert operation
  // so Abort, Skip and Continue target the sequence. Unmerged files with no operation indicate a stopped stash apply/pop.
  const op = ["rebase", "cherry-pick", "revert", "merge"].find((k) => ops.includes(k)) ?? "stash";
  const gp = await git(["rev-parse", "--path-format=absolute", "--git-path", "MERGE_MSG", "--git-path", "rebase-merge"]);
  const [msgPath, rb] = gp.stdout.split("\n");
  const file = (p) => ad.readFile(p, { cwd }).then((s) => s ?? null, () => null);
  const heads = await git(["rev-parse", "-q", "--verify", "--symbolic-full-name", "HEAD"]);
  const ids = await Promise.all(["HEAD", "MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "ORIG_HEAD"].map((r) => git(["rev-parse", "-q", "--verify", r]).then((x) => (x.code === 0 ? x.stdout.trim() : ""))));
  const [head, mergeHead, rebaseHead, pickHead, revertHead] = ids;
  const msg = await file(msgPath);
  const branch = heads.code === 0 && heads.stdout.trim().startsWith("refs/heads/") ? heads.stdout.trim().slice(11) : null;
  const subject = async (oid) => (oid ? (await git(["log", "-1", "--format=%s", oid])).stdout.trim() : "");
  let title, current, incoming, step = "";
  if (op === "merge") {
    const m = /^Merge (?:remote-tracking )?(?:branch|tag|commit) '([^']+)'/.exec(msg ?? "");
    const from = m?.[1] ?? short(mergeHead);
    title = `Merging ${from} into ${branch ?? short(head)}`; current = branch ?? short(head); incoming = from;
  } else if (op === "rebase") {
    const [name, num, end] = await Promise.all(["head-name", "msgnum", "end"].map((f) => file(`${rb}/${f}`)));
    step = num && end ? ` (${num.trim()}/${end.trim()})` : "";
    title = `Rebasing ${(name ?? "").trim().replace(/^refs\/heads\//, "") || "HEAD"}${step}`;
    current = "New base"; incoming = rebaseHead ? `Your commit ${short(rebaseHead)} ${await subject(rebaseHead)}` : "Your commit";
  } else if (op === "cherry-pick") {
    title = `Cherry-picking ${short(pickHead)}`; current = branch ?? short(head); incoming = `${short(pickHead)} ${await subject(pickHead)}`;
  } else if (op === "revert") {
    title = `Reverting ${short(revertHead)}`; current = branch ?? short(head); incoming = `Revert of ${short(revertHead)} ${await subject(revertHead)}`;
  } else { title = "Applying a stash"; current = branch ?? short(head); incoming = "Stash"; }
  const here = new Set(unmerged.map((e) => e.path));
  const saved = op === "rebase" ? [] : listedConflicts(msg).filter((p) => !here.has(p));
  const files = [...unmerged.map((e) => ({ path: e.path, kind: kindOf(e), saved: false, e })), ...saved.map((p) => ({ path: p, kind: "content", saved: true }))];
  // Fingerprint the state a write was planned against; any change means another operation acted.
  const rev = [op, heads.stdout.trim(), ...ids, step, u.stdout].join("\n");
  return { op, title, current, incoming, files, rev, msg, mergeHead, unmerged: unmerged.length };
}

// ---- one file's hunks
// merge-file's zdiff3 output → [{ t: "same", text } | { t: "hunk", ours, base, theirs, raw }] (text pieces keep their "\n").
export function parseMerged(text) {
  const segs = [], ls = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let cur = null, same = "";
  for (const l of ls) {
    const s = l.replace(/\r?\n$/, "");
    if (!cur && s.startsWith("<<<<<<< ")) { if (same) segs.push({ t: "same", text: same }); same = ""; cur = { t: "hunk", ours: "", base: "", theirs: "", raw: l, at: "ours" }; continue; }
    if (cur) {
      cur.raw += l;
      if (cur.at === "ours" && s.startsWith("||||||| ")) { cur.at = "base"; continue; }
      if ((cur.at === "ours" || cur.at === "base") && s === "=======") { cur.at = "theirs"; continue; }
      if (cur.at === "theirs" && s.startsWith(">>>>>>> ")) { delete cur.at; segs.push(cur); cur = null; continue; }
      cur[cur.at] += l; continue;
    }
    same += l;
  }
  if (cur) same += cur.raw; // an unterminated block is plain text
  if (same) segs.push({ t: "same", text: same });
  return segs;
}
// choices[i] selects a hunk: null keeps markers; "current" or "incoming" takes a side.
// "both" places Current first; "both-r" places Incoming first.
// A line selection is { cur: [bool per line], inc: [bool per line], first: "current" | "incoming" }.
// Emit the first-picked side's selected lines, then the other's. No selected lines keeps markers.
// ponytail: an empty resolution must be typed in Result; add an explicit empty choice if needed.
export const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
export function pickText(h, c) {
  if (c === "current") return h.ours;
  if (c === "incoming") return h.theirs;
  if (c === "both") return h.ours + h.theirs;
  if (c === "both-r") return h.theirs + h.ours;
  if (!c || typeof c !== "object") return h.raw;
  const cur = linesOf(h.ours).filter((_, k) => c.cur?.[k]).join(""), inc = linesOf(h.theirs).filter((_, k) => c.inc?.[k]).join("");
  if (!cur && !inc) return h.raw;
  return c.first === "incoming" ? inc + cur : cur + inc;
}
const pick = pickText;
export function assemble(segs, choices) {
  let i = 0;
  return segs.map((s) => (s.t === "same" ? s.text : pick(s, choices[i++] ?? null))).join("");
}
// Replace a hunk's surviving marker block in hand-edited Result text, or return null if absent.
// Refuse indistinguishable duplicate blocks so choosing one cannot replace the other.
export function applyChoice(text, hunk, choice) {
  const at = text.indexOf(hunk.raw);
  if (at < 0 || text.indexOf(hunk.raw, at + 1) >= 0) return null;
  return text.slice(0, at) + pick(hunk, choice) + text.slice(at + hunk.raw.length);
}
// Detect lines that still look like conflict markers.
export const markerLines = (text) => (text.match(/^(<<<<<<< |>>>>>>> |=======$)/gm) ?? []).length;

// Load { kind, segs, merged, initial, work, workId }; kind can become "binary".
// Parse hunks from working-tree text to preserve external partial resolutions and marker styles. Marker-free text
// is already resolved. Rebuild via merge-file only when working-tree text is unavailable.
// Write Current / Incoming markers without a Base section. Preserve each side's missing final newline at EOF,
// even though git inserts a newline before its closing marker.
const nl = (s) => (!s || s.endsWith("\n") ? s : s + "\n");
const rawOf = (h) => `<<<<<<< Current\n${nl(h.ours)}=======\n${nl(h.theirs)}>>>>>>> Incoming\n`;
export async function loadFile(ad, cwd, f) {
  const git = (args) => ad.run([...READ, ...args], { cwd });
  const e = f.e, out = { path: f.path, kind: f.kind };
  // Hash before and after reading and retry on mismatch so workId identifies the bytes displayed.
  // Hash a symlink's target text, not the file it points to.
  const hash = f.kind === "symlink"
    ? () => ad.sh(`[ -L "$1" ] && printf %s "$(readlink -- "$1")" | git hash-object --stdin`, [f.path], { cwd }).then((r) => (r.code === 0 ? r.stdout.trim() : null))
    : () => git(["hash-object", "--", f.path]).then((r) => (r.code === 0 ? r.stdout.trim() : null));
  let work = null, workId = null;
  for (let i = 0; i < 3; i++) {
    const h0 = await hash();
    work = await ad.readFile(`${cwd}/${f.path}`, { cwd }).catch(() => null);
    workId = await hash();
    if (h0 === workId) break;
    workId = "changing"; // never equal to a real hash: Save refuses until it is loaded again
  }
  Object.assign(out, { work, workId });
  if (f.kind !== "content") return out;
  if (work?.includes("\0")) return { ...out, kind: "binary" };
  let text = work;
  if (text == null) {
    let base = e.s1?.oid;
    if (!base) { const r = await ad.run(["hash-object", "-w", "/dev/null"], { cwd }); base = r.code === 0 ? r.stdout.trim() : EMPTY_BLOB; } // add/add
    const r = await git(["merge-file", "-p", "--zdiff3", "--object-id", "-L", "Current", "-L", "Base", "-L", "Incoming", e.s2.oid, base, e.s3.oid]);
    if (r.code < 0 || r.code > 127 || /binary/i.test(r.stderr) || r.stdout.includes("\0")) return { ...out, kind: "binary" };
    text = r.stdout;
  }
  const segs = parseMerged(text);
  const last = segs[segs.length - 1];
  if (last?.t === "hunk") {
    const ends = async (s) => (s ? (await git(["cat-file", "blob", s.oid])).stdout.endsWith("\n") : true);
    const [o, t] = await Promise.all([ends(e.s2), ends(e.s3)]);
    if (!o) last.ours = last.ours.replace(/\n$/, "");
    if (!t) last.theirs = last.theirs.replace(/\n$/, "");
  }
  out.segs = segs.map((x) => (x.t === "hunk" ? { ...x, raw: rawOf(x) } : x));
  out.merged = assemble(out.segs, []);
  return out;
}

// ---- writes. Each re-reads the revision first; a change → { outcome: "refused", reason: "stale" }.
async function fresh(ad, cwd, rev) {
  const now = await readConflict(ad, cwd);
  return now && now.rev === rev ? now : null;
}
const stale = (operation) => ({ operation, outcome: "refused", reason: "stale", stderr: "The conflict changed outside ggit: look again" });

// Save content in one shell script only if the path is still a regular file matching the loaded workId, and its
// parent is inside the worktree rather than a symlink elsewhere. Write the approved blob to git first and stage
// that exact object, preserving Current's executable mode even if the worktree changes afterwards.
// ponytail: without a file lock, an edit between hashing and writing can still be overwritten; the window is
// one process start. A temporary file plus rename does not close it; cooperating writers would need locking.
const INSIDE = `d=$(dirname -- "$p"); r=$(pwd -P); if [ "$d" = . ]; then e=$r; else e=$r/$d; fi
[ "$(cd -P -- "$d" 2>/dev/null && pwd -P)" = "$e" ] || { echo "$d is not a folder inside this repository" >&2; exit 3; }`;
const SAVE = `p=$1; want=$2; mode=$3; shift 3
${INSIDE}
if [ -L "$p" ] || { [ -e "$p" ] && [ ! -f "$p" ]; }; then echo "$p is not a regular file" >&2; exit 3; fi
now=$(git hash-object -- "$p" 2>/dev/null) || now=-
[ "$now" = "$want" ] || { echo "$p was changed on disk since it was loaded" >&2; exit 4; }
oid=$(printf %s "$@" | git hash-object -w --stdin --path "$p") || exit 5
printf %s "$@" > "$p" || exit 6
git update-index --cacheinfo "$mode,$oid,$p" || exit 7`;
const bytes = (s) => unescape(encodeURIComponent(s)).length;
// The text goes as several arguments: Linux caps one argument at 128 KiB (MAX_ARG_STRLEN; macOS has no such cap). 30,000
// UTF-16 units are at most 90 KB of UTF-8; a cut never splits a surrogate pair. The script prints them back to back.
const pieces = (s, n = 30_000) => {
  const out = [];
  for (let i = 0; i < s.length;) { let j = Math.min(i + n, s.length); if (j < s.length && /[\uD800-\uDBFF]/.test(s[j - 1])) j++; out.push(s.slice(i, j)); i = j; }
  return out.length ? out : [""];
};
export async function saveFile(ad, cwd, { rev, path, text, workId, mode = "100644" }) {
  const op = "conflict-save";
  if (markerLines(text)) return { operation: op, outcome: "refused", stderr: "Conflict markers are still in the result" };
  if (bytes(text) > 600_000) return { operation: op, outcome: "refused", stderr: "Too big to save from ggit; edit it in an editor" };
  if (!(await fresh(ad, cwd, rev))) return stale(op);
  const r = await ad.sh(SAVE, [path, workId ?? "-", mode, ...pieces(text)], { cwd });
  if (r.code === 4) return { operation: op, outcome: "refused", reason: "edited", stderr: r.stderr.trim() };
  // The checked write may already have changed the file; refused would promise no side effects.
  if (r.code === 6 || r.code === 7) return { operation: op, outcome: "unknown", path, exitCode: r.code,
    stderr: `${path}: ${r.code === 7 ? "Result written, but staging failed" : "Writing the Result did not finish"}; inspect the file and index. ${r.stderr.trim()}` };
  return r.code === 0 ? { operation: op, outcome: "completed", path } : { operation: op, outcome: "refused", stderr: r.stderr.trim() || "Could not save" };
}

// Take an entire side (binary, symlink, submodule or deletion): "current" | "incoming" | "base" | "delete".
// One script checks the loaded workId before writing; "-" means absent and "*" skips that check for submodules or links.
const TAKE = `p=$1; want=$2
${INSIDE}
if [ "$want" = "-" ]; then { [ ! -e "$p" ] && [ ! -L "$p" ]; } || { echo "$p was created on disk since it was loaded" >&2; exit 4; }
elif [ "\${want#link:}" != "$want" ]; then { [ -L "$p" ] && [ "$(printf %s "$(readlink -- "$p")" | git hash-object --stdin)" = "\${want#link:}" ]; } || { echo "$p was changed on disk since it was loaded" >&2; exit 4; }
elif [ "$want" != "*" ]; then { [ -f "$p" ] && [ ! -L "$p" ] && [ "$(git hash-object -- "$p")" = "$want" ]; } || { echo "$p was changed on disk since it was loaded" >&2; exit 4; }; fi
case $3 in
  rm) git --literal-pathspecs rm -q -f -- "$p" ;;
  set) git update-index --cacheinfo "$4,$5,$p" || exit 5
    [ "$4" = 160000 ] || git --literal-pathspecs checkout -- "$p" || exit 6 ;;
esac`;
export async function takeSide(ad, cwd, { rev, f, side, workId }) {
  const op = "conflict-take";
  if (!(await fresh(ad, cwd, rev))) return stale(op);
  const s = side === "current" ? f.e.s2 : side === "incoming" ? f.e.s3 : side === "base" ? f.e.s1 : null;
  // Verify a symlink by its target text and type; submodules are not checked this way.
  const want = f.kind === "submodule" ? "*" : f.kind === "symlink" ? (workId ? `link:${workId}` : "-") : workId ?? "-";
  const r = await ad.sh(TAKE, s ? [f.path, want, "set", s.mode, s.oid] : [f.path, want, "rm"], { cwd });
  if (r.code === 6) return { operation: op, outcome: "unknown", path: f.path, exitCode: r.code,
    stderr: `${f.path}: Index updated, but checkout failed; inspect the file and index. ${r.stderr.trim()}` };
  if (r.code === 4) return { operation: op, outcome: "refused", reason: "edited", stderr: r.stderr.trim() };
  return r.code === 0 ? { operation: op, outcome: "completed", path: f.path } : { operation: op, outcome: "refused", stderr: r.stderr.trim() };
}

// Continue blockers: files still unmerged or conflict markers remaining in staged content.
export async function blockers(ad, cwd, c) {
  const out = [];
  if (c.unmerged) out.push(`${c.unmerged} file(s) not resolved yet`);
  const chk = await ad.run([...READ, "diff", "--cached", "--check"], { cwd });
  const left = chk.stdout.split("\n").filter((l) => /leftover conflict marker/.test(l)).map((l) => l.split(":")[0]);
  if (left.length) out.push(`Conflict markers staged in ${[...new Set(left)].join(", ")}`);
  return out;
}

// Before committing a merge, recheck the conflict revision, displayed MERGE_HEAD, blockers and click-time staged tree.
// commit-tree creates exactly that tree with the two approved parents; update-ref moves the branch only from the
// checked HEAD. This prevents committing unrelated staged work after an abort. merge --quit then clears merge state.
// ponytail: commit-tree skips pre-commit / commit-msg hooks; plain git commit could consume a changed index.
// Supporting hooks here requires preserving the approved-tree guarantee.
export const stripMessage = (m) => m.split("\n").filter((l) => !l.startsWith("#")).map((l) => l.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
export async function commitMerge(ad, cwd, c, message, tree) {
  const operation = "commit";
  const now = await fresh(ad, cwd, c.rev);
  if (!now || now.op !== "merge" || !now.mergeHead || now.mergeHead !== c.mergeHead) return stale(operation);
  const b = await blockers(ad, cwd, now);
  if (b.length) return { operation, outcome: "refused", stderr: b[0] };
  const [w, h, ref] = await Promise.all([ad.run(["write-tree"], { cwd }), ad.run([...READ, "rev-parse", "-q", "--verify", "HEAD"], { cwd }), ad.run([...READ, "symbolic-ref", "-q", "HEAD"], { cwd })]);
  if (w.code !== 0 || w.stdout.trim() !== tree) return { operation, outcome: "refused", reason: "stale", stderr: "What is staged changed since you pressed Commit merge: look again" };
  const head = h.stdout.trim(), branch = ref.stdout.trim();
  if (h.code !== 0 || !branch) return { operation, outcome: "refused", stderr: "HEAD is not on a branch" };
  const msg = stripMessage(message);
  if (!msg) return { operation, outcome: "refused", stderr: "The message is empty" };
  const ct = await ad.run(["commit-tree", tree, "-p", head, "-p", c.mergeHead, "-m", msg], { cwd });
  if (ct.code !== 0) return { operation, outcome: "refused", exitCode: ct.code, stderr: ct.stderr.trim() };
  const nu = ct.stdout.trim();
  const u = await ad.run(["update-ref", "-m", `commit (merge): ${msg.split("\n")[0]}`, branch, nu, head], { cwd });
  if (u.code !== 0) return { operation, outcome: "refused", reason: "stale", stderr: (u.stderr.trim() || "The branch moved") + ": look again" };
  const quit = await ad.run(["merge", "--quit"], { cwd });
  if (quit.code !== 0) return { operation, outcome: "unknown", head: nu,
    stderr: `${branch} now points to ${nu}, but merge cleanup failed; inspect the merge state before continuing. ${quit.stderr.trim()}` };
  return { operation, outcome: "completed", head: nu };
}

// Continue rebase / cherry-pick / revert with git's prepared message and no editor.
// Judge resulting state, not exit code: gone means done, another stop means the next conflict, otherwise refused.
export async function continueOp(ad, cwd, c) {
  return sequencer(ad, cwd, c, "--continue", "conflict-continue");
}
// Skip drops the current rebase, cherry-pick or revert step. A zero exit with unchanged state is not success.
export async function skipOp(ad, cwd, c) {
  return sequencer(ad, cwd, c, "--skip", "conflict-skip");
}
async function sequencer(ad, cwd, c, flag, operation) {
  if (!["rebase", "cherry-pick", "revert"].includes(c.op)) return { operation, outcome: "refused", stderr: `Nothing to ${flag.slice(2)} for a ${c.op}` };
  if (!(await fresh(ad, cwd, c.rev))) return stale(operation);
  if (flag === "--skip") { // the step is dropped, not edits beside it
    const g = await abortGuard(ad, cwd, c, "Skip");
    if (!g.ok) return { operation, outcome: "refused", reason: "edits", stderr: g.why };
  }
  const r = await ad.run(["-c", "core.editor=true", "-c", "sequence.editor=true", c.op, flag], { cwd });
  const after = await readConflict(ad, cwd);
  if (!after) return { operation, outcome: "completed", stderr: r.stderr.trim() };
  if (after.rev !== c.rev && after.unmerged) return { operation, outcome: "stopped", unmerged: after.unmerged, stderr: r.stderr.trim() };
  if (after.rev !== c.rev) return { operation, outcome: "completed", partial: true, stderr: r.stderr.trim() };
  return { operation, outcome: "refused", exitCode: r.code, stderr: (r.stderr || r.stdout).trim() || "Nothing moved" };
}

// Refuse Abort when files outside the conflict changed after the stop; git --abort could discard those edits.
// Rebuild the operation's clean result with merge-tree so its own changes and saved conflict resolutions
// do not count as unrelated edits.
export async function abortGuard(ad, cwd, c, what = "Abort") {
  const git = (args) => ad.run([...READ, ...args], { cwd });
  const rv = async (r) => { const x = await git(["rev-parse", "-q", "--verify", r]); return x.code === 0 ? x.stdout.trim() : null; };
  let args;
  if (c.op === "merge") args = ["HEAD", await rv("MERGE_HEAD")];
  else if (c.op === "cherry-pick" || c.op === "rebase") { const p = await rv(c.op === "rebase" ? "REBASE_HEAD" : "CHERRY_PICK_HEAD"); args = p && ["--merge-base", `${p}^`, "HEAD", p]; }
  else if (c.op === "revert") { const p = await rv("REVERT_HEAD"); args = p && ["--merge-base", p, "HEAD", `${p}^`]; }
  if (!args || args.some((x) => !x)) return { ok: false, why: "Could not rebuild what the operation changed, so edits outside the conflict cannot be checked" };
  const mt = await git(["merge-tree", "--write-tree", "--name-only", "-z", ...args]);
  if (mt.code !== 0 && mt.code !== 1) return { ok: false, why: "Could not rebuild what the operation changed" };
  // Include conflicts from the rebuilt merge as well as git's lists: after staging the final file in a rebase step,
  // git can list none, but the saved resolution still belongs to the conflict.
  const { tree, files: rebuilt } = parseMergeTree(mt.stdout);
  const conflicted = new Set([...c.files.map((f) => f.path), ...rebuilt]);
  // Compare both worktree and index against the clean result so staged edits cannot hide behind restored working files.
  // Allow an index refresh here; cached stat data can otherwise classify an unchanged, merely touched file as an edit.
  const [w, i] = await Promise.all([ad.run(["diff", "--name-only", "-z", tree], { cwd }), ad.run(["diff", "--cached", "--name-only", "-z", tree], { cwd })]);
  if (w.code !== 0 || i.code !== 0) return { ok: false, why: "Could not compare the files with what the operation changed" };
  const edits = [...new Set([...w.stdout.split("\0"), ...i.stdout.split("\0")])].filter((p) => p && !conflicted.has(p));
  return edits.length ? { ok: false, edits, why: `${what} would throw away your changes to ${edits.slice(0, 3).join(", ")}${edits.length > 3 ? ` and ${edits.length - 3} more` : ""}` } : { ok: true };
}
export async function abortOp(ad, cwd, c) {
  const operation = "conflict-abort";
  if (c.op === "stash") return { operation, outcome: "refused", stderr: "A stash conflict has no abort: the stash is kept; resolve or discard the files" };
  if (!(await fresh(ad, cwd, c.rev))) return stale(operation);
  const g = await abortGuard(ad, cwd, c);
  if (!g.ok) return { operation, outcome: "refused", reason: "edits", stderr: g.why };
  const r = await ad.run([c.op, "--abort"], { cwd });
  const after = await readConflict(ad, cwd);
  return !after ? { operation, outcome: "completed", op: c.op } : { operation, outcome: "refused", exitCode: r.code, stderr: r.stderr.trim() || "The operation is still in progress" };
}

// Ask AI: the conflict as text to paste into any AI, or to send to an agent pane — the file, which side
// is which, and each hunk with its three versions. A human can still edit the Result by hand.
export function askContext(c, file, root) {
  const parts = [`In the git repo ${root}: ${c.title}. The file ${file.path} has ${(file.segs ?? []).filter((s) => s.t === "hunk").length} conflict(s).`,
    `"Current" is ${c.current}; "Incoming" is ${c.incoming}.`,
    `Resolve it: edit ${file.path} so no conflict markers remain, keeping what both sides meant, then run: git add -- ${file.path}`,
    `Do not commit, continue or abort the ${c.op}.`];
  let n = 0;
  for (const s of file.segs ?? []) {
    if (s.t !== "hunk") continue;
    n++;
    parts.push(`\n## Conflict ${n}\n### Current\n\`\`\`\n${s.ours}\`\`\`\n### Base\n\`\`\`\n${s.base}\`\`\`\n### Incoming\n\`\`\`\n${s.theirs}\`\`\``);
  }
  return parts.join("\n");
}

// Align hunk sides with whole-line LCS. Pair changed lines between equal anchors in order.
// Return [{ t: "same", c, i } | { t: "pair", c: idx | null, i: idx | null }].
// ponytail: above 160,000 cells (400 x 400 lines), pair by position; use a bounded diff algorithm for larger hunks if needed.
export function alignLines(a, b) {
  const n = a.length, m = b.length, out = [];
  const pairRun = (cs, is) => { for (let k = 0; k < Math.max(cs.length, is.length); k++) out.push({ t: "pair", c: cs[k] ?? null, i: is[k] ?? null }); };
  if (n * m > 160_000) { pairRun([...Array(n).keys()], [...Array(m).keys()]); return out; }
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) L[x][y] = a[x] === b[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
  let x = 0, y = 0, cs = [], is = [];
  while (x < n || y < m) {
    if (x < n && y < m && a[x] === b[y]) { pairRun(cs, is); cs = []; is = []; out.push({ t: "same", c: x++, i: y++ }); }
    else if (y >= m || (x < n && L[x + 1][y] >= L[x][y + 1])) cs.push(x++);
    else is.push(y++);
  }
  pairRun(cs, is);
  return out;
}
// The part of a line that differs from its pair: [prefix, middle, suffix] by common prefix and suffix.
export function splitChange(s, other) {
  if (other == null) return ["", s, ""];
  let p = 0; while (p < s.length && p < other.length && s[p] === other[p]) p++;
  let q = 0; while (q < s.length - p && q < other.length - p && s[s.length - 1 - q] === other[other.length - 1 - q]) q++;
  return [s.slice(0, p), s.slice(p, s.length - q), s.slice(s.length - q)];
}
