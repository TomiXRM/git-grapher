// Pure helpers for ggx-detail (no herdr import: `node --test mods/ggx-detail/lib/`).

// Reads write nothing under .git (from mods/changes): no optional locks, no fsmonitor, no index refresh.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// One commit, fields split by US. %b keeps the trailer paragraph; splitBody() drops it.
// Trailers come from git itself (the same parser as `git interpret-trailers --parse`), unfolded,
// RS between trailers and GS between key and value, so no stdin is needed.
export const META_FORMAT = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%(trailers:only,unfold,separator=%x1e,key_value_separator=%x1d)%x1f%b";
export const DATE = "--date=format-local:%Y-%m-%d %H:%M";

export function parseMeta(stdout) {
  const [sha, parents, name, email, date, subject, trailers, ...rest] = stdout.split("\x1f");
  const tr = trailers ? trailers.split("\x1e").filter(Boolean).map((t) => { const [key, ...v] = t.split("\x1d"); return { key, value: v.join("\x1d").trim() }; }) : [];
  return { sha, parents: parents ? parents.split(" ") : [], name, email, date, subject, trailers: tr, body: splitBody(rest.join("\x1f"), tr.length > 0) };
}

// Body lines without the trailer paragraph (git only takes trailers from the last paragraph).
export function splitBody(body, hasTrailers) {
  const paras = body.replace(/\s+$/, "").split(/\n\s*\n/);
  if (hasTrailers) paras.pop();
  return paras.join("\n\n").split("\n").filter((l) => l.trim() !== "");
}

// Diff-tree args: merges against the 1st parent, roots against the empty tree.
export const diffArgs = (sha, parents) => ["diff-tree", "-r", "-z", "-M", "--raw", "--numstat", "--no-commit-id", ...(parents.length ? [parents[0], sha] : ["--root", sha])];

// Parse diff-tree -z --raw --numstat into [{ path, old?, status, add, del, binary }] in raw order.
// Raw rename: ":<modes> <shas> R100\0old\0new\0"; numstat: "a\td\tpath\0" or "a\td\t\0old\0new\0".
// Combine cached / worktree diffs and untracked files into the commit pane's lists. Unmerged files appear as U
// in both streams, sometimes also M: deduplicate into one conflict row in Unstaged, never Staged.
// Shared by the store and standalone detail WIP reads.
export function wipLists(cachedOut, worktreeOut, untracked = []) {
  const st = parseDiffTree(cachedOut), wt = parseDiffTree(worktreeOut);
  const un = new Set([...st, ...wt].filter((f) => f.status === "U").map((f) => f.path));
  const conflicts = [...un].map((p) => ({ path: p, status: "U", add: 0, del: 0, binary: false, conflict: true }));
  return { staged: st.filter((f) => !un.has(f.path)), unstaged: [...conflicts, ...wt.filter((f) => !un.has(f.path)), ...untracked] };
}

export function parseDiffTree(stdout) {
  const tok = stdout.split("\0"), files = [], stat = new Map();
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    if (t[0] === ":") {
      const status = t.split(" ").pop()[0];
      const two = status === "R" || status === "C";
      const f = two ? { old: tok[i + 1], path: tok[i + 2], status } : { path: tok[i + 1], status };
      i += two ? 2 : 1;
      files.push(f);
    } else {
      // Only the first two tabs separate: a name may hold tabs itself.
      const k1 = t.indexOf("\t"), k2 = t.indexOf("\t", k1 + 1), a = t.slice(0, k1), d = t.slice(k1 + 1, k2), p = t.slice(k2 + 1);
      const path = p === "" ? tok[(i += 2)] : p;
      stat.set(path, { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" });
    }
  }
  return files.map((f) => ({ ...f, ...(stat.get(f.path) ?? { add: 0, del: 0, binary: false }) }));
}

// "4 modified · 1 added"
const WORD = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "unmerged", "?": "untracked" };
export function summary(files) {
  if (!files.length) return "No file changes";
  const n = new Map();
  for (const f of files) n.set(f.status, (n.get(f.status) ?? 0) + 1);
  return [..."MADRCTU", "?"].filter((s) => n.has(s)).map((s) => `${n.get(s)} ${WORD[s]}`).join(" · ");
}

// Untracked files ("ls-files --others -z" output) as added rows with real line counts: one
// "diff --no-index --numstat /dev/null <path>" each ("-" = binary). read(args) runs git in the worktree root.
// ponytail: only the first 50 are counted (16 at a time, exec caps near 49 open); the rest show 0 until staged.
export async function untrackedFiles(read, others, cap = 50) {
  const files = others.split("\0").filter(Boolean).map((p) => ({ path: p, status: "A", add: 0, del: 0, binary: false, untracked: true }));
  const some = files.slice(0, cap);
  for (let i = 0; i < some.length; i += 16) await Promise.all(some.slice(i, i + 16).map(async (f) => {
    const r = await Promise.resolve().then(() => read(["diff", "--no-index", "--no-color", "--no-ext-diff", "--numstat", "--", "/dev/null", f.path])).catch(() => null);
    const m = /^(-|\d+)\t(-|\d+)\t/.exec(r?.stdout ?? "");
    if (m?.[1] === "-") f.binary = true; else if (m) { f.add = +m[1]; f.del = +m[2]; }
  }));
  return files;
}

// 5-square bar per file, own share only (as the ref: +1 is five greens). Any side that is non-zero keeps >= 1 square.
export function bar(add, del, n = 5) {
  const tot = add + del;
  if (!tot) return Array(n).fill("n");
  let g = Math.round((n * add) / tot);
  if (add && !g) g = 1;
  if (del && g === n) g = n - 1;
  return [...Array(g).fill("a"), ...Array(n - g).fill("d")];
}

// Paths -> tree. Dirs first, then files, each by name (as the ref). No single-child folding.
export function buildTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { name: d, path: node.path + d + "/", dirs: new Map(), files: [] });
      node = node.dirs.get(d);
    }
    node.files.push({ name: parts[parts.length - 1], file: f });
  }
  return root;
}

// Tree -> visible rows; `closed` holds dir paths ("docs/") that are folded.
export function treeRows(node, closed = new Set(), depth = 0, out = []) {
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const d of [...node.dirs.values()].sort(byName)) {
    const open = !closed.has(d.path);
    out.push({ kind: "dir", depth, name: d.name, path: d.path, open });
    if (open) treeRows(d, closed, depth + 1, out);
  }
  for (const f of [...node.files].sort(byName)) out.push({ kind: "file", depth, name: f.name, path: f.file.path, file: f.file });
  return out;
}

// Use side-by-side columns only when each gets at least 360 px and the pane is clearly landscape.
export const WIDE_RATIO = 1.3, MIN_COL = 360;
export const isWide = (w, h) => w >= 2 * MIN_COL && w >= WIDE_RATIO * h;

// Refs pointing at the commit, as graph labels: local + its origin twin merge into one.
// lines: "refname" per line; trees: Set of "refs/heads/x" checked out in a worktree.
export function refLabels(text, trees, isHead) {
  const names = text.split("\n").filter((l) => l && !l.endsWith("/HEAD"));
  const locals = new Set(names.filter((n) => n.startsWith("refs/heads/")).map((n) => n.slice(11)));
  const out = [];
  for (const n of names) {
    if (n.startsWith("refs/heads/")) {
      const name = n.slice(11);
      out.push({ kind: "local", name, tree: trees.has(n), head: isHead(name), remote: names.some((o) => o.startsWith("refs/remotes/") && o.slice(13).replace(/^[^/]+\//, "") === name) });
    } else if (n.startsWith("refs/tags/")) out.push({ kind: "tag", name: n.slice(10) });
    else if (n.startsWith("refs/remotes/")) {
      const name = n.slice(13);
      if (!locals.has(name.replace(/^[^/]+\//, ""))) out.push({ kind: "remote", name });
    }
  }
  const rank = (r) => (r.head ? 0 : { local: 1, remote: 2, tag: 3 }[r.kind]);
  return out.sort((a, b) => rank(a) - rank(b));
}

// A branch review starts at the first commit on its first-parent line shared by another local or remote branch,
// excluding its own upstream. git(args, okCodes) returns stdout; the result is { base, n } or null, with n own commits
// and the empty tree as base for a root.
// ponytail: a branch forked from this one can shadow its earlier fork; consult the "Created from" reflog for stacked branches.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export async function forkPoint(git, tip, name) {
  const up = (await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${name}@{upstream}`], [0, 128])).trim();
  const not = ["--not", `--exclude=${name}`, "--branches", ...(up && up !== `${name}@{upstream}` ? [`--exclude=${up}`] : []), "--remotes"];
  const own = (await git(["rev-list", "--first-parent", tip, ...not])).trim().split("\n").filter(Boolean);
  if (!own.length) return null;
  const p = (await git(["rev-parse", "--verify", "-q", own.at(-1) + "^"], [0, 1])).trim();
  return { base: p || EMPTY_TREE, n: own.length, not }; // not: `git log tip ...not` = the branch's own commits
}

// File History reads newest-first changes from the selected commit or WIP HEAD, follows renames, and compares merges
// with their first parent so merge resolutions appear. Frame fields with NUL and start records with an empty token
// so newlines and record separators in filenames remain intact:
// "\0<sha>\0<name>\0<email>\0<time>\0<subject>\0", then "\n<status>\0<path>[\0<new path>]\0".
// The status's leading newline is git's separator after the format.
const LOG = (rev, path, limit, fmt, kind) => ["log", "--follow", "-M", "--diff-merges=first-parent", `--max-count=${limit}`, "-z", kind, fmt, rev, "--", path];
export const HISTORY_ARGS = (path, { rev = "HEAD", limit = 500 } = {}) => LOG(rev, path, limit, "--format=%x00%H%x00%an%x00%ae%x00%at%x00%s", "--name-status");
// The same commits' line counts: `--numstat` beside the same log from the same commit id.
export const HISTORY_NUMSTAT = (path, { rev = "HEAD", limit = 500 } = {}) => LOG(rev, path, limit, "--format=%x00%H", "--numstat");
const STATUS = /^\n?([A-Z])\d*$/, COUNTS = /^\n?(\d+|-)\t(\d+|-)\t/s, SHA = /^[0-9a-f]{40,64}$/;
export function parseNumstat(stdout) {
  const out = new Map(), t = stdout.split("\0");
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "" || !SHA.test(t[i + 1] ?? "")) continue;
    const sha = t[i + 1], m = COUNTS.exec(t[i + 2] ?? "");
    out.set(sha, m ? { add: m[1] === "-" ? null : +m[1], del: m[2] === "-" ? null : +m[2] } : { add: 0, del: 0 });
    i += 1 + (m ? (t[i + 2].slice(m[0].length) === "" ? 3 : 1) : 0); // a rename's counts name both paths after them
  }
  return out;
}
export function parseHistory(stdout) {
  const out = [], t = stdout.split("\0");
  for (let i = 0; i < t.length;) {
    if (t[i] !== "" || !SHA.test(t[i + 1] ?? "")) { i++; continue; }
    const [sha, name, email, at, subject] = t.slice(i + 1, i + 6); i += 6;
    const m = STATUS.exec(t[i] ?? ""), e = { sha, name, email, at: Number(at), subject, status: "M", path: null, old: null };
    if (m) {
      e.status = m[1];
      if (m[1] === "R" || m[1] === "C") { e.old = t[i + 1]; e.path = t[i + 2]; i += 3; } else { e.path = t[i + 1]; i += 2; }
    }
    out.push(e);
  }
  return out;
}
