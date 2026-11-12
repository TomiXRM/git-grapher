// Repository store shared by views within one mod copy. No herdr dependency; core.js supplies the adapter:
// { run(args, {cwd}) -> {code, stdout, stderr}, testPath(path, {cwd}) }.
//
//   const s = createStore(adapter, root)
//   s.refresh()                     resolves after a read started after this request finishes
//   s.write(name, (g, t) => g.stage(t, paths))   queues a write and refreshes afterwards
//   s.need(path, on)                 retains worktree staged / unstaged lists in s.state.wip
//   s.on(fn) -> off                  reports applied reads and write starts / ends
//   s.state                         { gen, basis, root, sig, history, worktrees, head, states, stashes, wip, pending, error }
import { READ, createGgit, parseHeader } from "./core.js";
import { parseLog, LOG_ARGS, orphanTips, ORPHAN_REFLOG } from "./parse-log.js";
import { wipLists, untrackedFiles } from "./detail.js";

export const US = "\x1f";
// Load 2,000 commits initially; Load more adds 1,000. Every mod shares one ~47 MB JS heap and each Git Grapher copy holds
// its own history (10,000 commits of a real repository: ~18 MB), so three tabs on a big repository used to fill it, and
// a read whose result could not be stored never came back (the whole view stayed "loading…").
export const LOG_LIMIT = 2_000, LOG_MORE = 1_000;
export const MAX_GIT = 12; // Limit concurrency: Herdr fails execs above roughly 49 simultaneous calls, shared by all mods.
const FORMAT = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s";
// --ignore-missing allows an unborn HEAD without hiding other fetched history.
const LOG = (limit) => [...LOG_ARGS.filter((a) => !a.startsWith("--format=")), FORMAT, `--max-count=${limit + 1}`, "--ignore-missing", "--branches", "--remotes", "--tags", "HEAD"];

// At most n promises from fn at a time; the rest wait their turn.
export function limiter(n) {
  let live = 0; const wait = [];
  const next = () => { if (live < n && wait.length) { live++; wait.shift()(); } };
  return (fn) => new Promise((ok, no) => {
    wait.push(() => Promise.resolve().then(fn).then(ok, no).finally(() => { live--; next(); }));
    next();
  });
}

// `worktree list --porcelain -z` (fields end with NUL, records with an empty field) or, from a git before 2.36, the
// newline form. -z keeps a path with a newline in it whole.
export function parseWorktrees(porcelain) {
  const z = porcelain.includes("\0"), rec = z ? "\0\0" : "\n\n", field = z ? "\0" : "\n";
  return porcelain.split(rec).map((b, i) => {
    const kv = Object.fromEntries(b.split(field).filter(Boolean).map((l) => { const i = l.indexOf(" "); return i < 0 ? [l, true] : [l.slice(0, i), l.slice(i + 1)]; }));
    // unborn: no commit yet (HEAD all zeros). Kept, so a new repo's files show as a WIP row.
    return { path: kv.worktree, head: kv.HEAD, branch: typeof kv.branch === "string" ? kv.branch.replace(/^refs\/heads\//, "") : null, skip: kv.bare || kv.prunable, locked: Boolean(kv.locked), unborn: /^0+$/.test(kv.HEAD ?? ""), main: i === 0 }; // git lists the main one first
  }).filter((w) => w.path && !w.skip && w.head);
}

const sum = (r, i) => (r?.code === 0 ? r.stdout.split("\n").reduce((s, l) => s + (+l.split("\t")[i] || 0), 0) : 0);

// history: false skips git log for detached details, which need worktrees, HEAD and writes but no commit list.
// Duplicating large histories across repeatedly detached panes can exhaust the shared JS heap.
export function createStore(adapter, root, { limit: first = LOG_LIMIT, more: step = LOG_MORE, history: withHistory = true } = {}) { // limit / more: tests
  const gate = limiter(MAX_GIT);
  const run = (args, cwd = root) => gate(() => adapter.run(args, { cwd })).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
  const read = (args, cwd) => run([...READ, ...args], cwd);
  const g = createGgit({ run: (args, o) => gate(() => adapter.run(args, o)), testPath: adapter.testPath });
  const t = { root };

  const state = { gen: 0, basis: 0, root, sig: null, history: null, worktrees: [], head: null, states: [], stashes: [], wip: new Map(), pending: 0, error: null };
  const subs = new Set(), needed = new Map(); // path -> count of views wanting its lists
  let waiters = [];
  const emit = () => {
    for (const f of subs) { try { f(state); } catch {} }
    const w = waiters; waiters = []; for (const ok of w) ok(state);
  };

  // ---- reads
  let limit = first, readLimit = 0; // readLimit: the limit the history in state was read with
  async function readHistory() {
    const lim = limit; // Capture this read's limit; Load more requests arriving during it take effect on the next read.
    const rl = await read(ORPHAN_REFLOG);
    const cand = rl.code === 0 ? orphanTips(rl.stdout) : [];
    const lost = cand.length ? await read(["rev-list", "--ignore-missing", ...cand, "--not", "--branches", "--remotes", "--tags", "HEAD"]) : null;
    const orphans = new Set(lost?.code === 0 ? lost.stdout.split("\n").filter(Boolean) : []);
    const tips = cand.filter((x) => orphans.has(x));
    const [log, refs] = await Promise.all([read([...LOG(lim), ...tips]), read(["for-each-ref", "--format=%(objectname)%1f%(*objectname)%1f%(refname)", "refs/heads", "refs/remotes", "refs/tags"])]);
    if (log.code !== 0 && log.code !== 128) throw new Error(log.stderr.trim() || "git log failed");
    // An empty log is valid for an unborn HEAD; if HEAD names a missing commit, report repository damage
    // rather than letting --ignore-missing make it appear empty.
    if (log.code !== 0 || !log.stdout.trim()) {
      const [h, sym] = await Promise.all([read(["rev-parse", "-q", "--verify", "HEAD^{commit}"]), read(["symbolic-ref", "-q", "HEAD"])]); // ^{commit}: it must exist
      if (h.code !== 0 && sym.code !== 0) throw new Error("HEAD points to a commit that is missing");
    }
    const commits = log.code === 0 ? parseLog(log.stdout) : []; // 128: no commit yet
    const omitted = commits.length > lim;
    if (omitted) commits.length = lim;
    readLimit = lim;
    for (const c of commits) { const [an, ae, at, s] = c.subject.split(US); Object.assign(c, { an, ae, at: Number(at), subject: s }); }
    return { commits, omitted, orphans, tips, refs: refs.stdout };
  }

  async function readWorktree(w) {
    const st = await read(["status", "--porcelain=v2", "--branch", "--show-stash", "-z"], w.path);
    if (st.code !== 0) return null;
    const h = parseHeader(st.stdout), n = h.staged + h.unstaged + h.untracked + h.unmerged;
    let add = 0, del = 0;
    if (n) {
      const [a, b] = await Promise.all([read(["diff", "--cached", "--numstat", "--no-renames"], w.path), read(["diff", "--numstat", "--no-renames"], w.path)]);
      add = sum(a, 0) + sum(b, 0); del = sum(a, 1) + sum(b, 1);
    }
    return { ...w, current: w.path === root, h, n, add, del };
  }

  async function readWip(path) {
    const [cached, worktree, others] = await Promise.all([
      read(["diff", "--cached", "--no-color", "--no-ext-diff", "-r", "-z", "-M", "--raw", "--numstat"], path),
      read(["diff", "--no-color", "--no-ext-diff", "-r", "-z", "--raw", "--numstat"], path),
      read(["ls-files", "--others", "--exclude-standard", "-z"], path),
    ]);
    if (cached.code !== 0 || worktree.code !== 0) return null;
    const untracked = await untrackedFiles((args) => read(args, path), others.stdout);
    return wipLists(cached.stdout, worktree.stdout, untracked); // one conflict row per unmerged file (lib/detail.js)
  }

  async function load() {
    const basis = writeSeq;
    const [refs, head, sym] = await Promise.all([
      read(["for-each-ref", "--format=%(objectname)%(refname)", "refs/heads", "refs/remotes", "refs/tags", "refs/stash"]),
      read(["rev-parse", "-q", "--verify", "HEAD"]),
      read(["symbolic-ref", "-q", "HEAD"]),
    ]);
    if (refs.code !== 0) throw new Error(refs.stderr.trim() || "Not a git repository");
    const sig = refs.stdout + head.stdout + sym.stdout;
    const [history, wt, stash, ip] = await Promise.all([
      !withHistory ? null : sig === state.sig && state.history && readLimit === limit ? state.history : readHistory(),
      read(["worktree", "list", "--porcelain", "-z"]).then((r) => (r.code === 0 ? r : read(["worktree", "list", "--porcelain"]))),
      read(["stash", "list", "--format=%H%x1f%P%x1f%gd%x1f%gs%x1f%ct"]),
      g.inProgress(t),
    ]);
    const trees = await Promise.all(parseWorktrees(wt.stdout).map(readWorktree));
    const wip = new Map(await Promise.all([...needed.keys()].map(async (p) => [p, await readWip(p)])));
    const me = trees.find((w) => w?.current);
    Object.assign(state, {
      gen: state.gen + 1, basis, sig, history, error: null,
      headId: head.code === 0 ? head.stdout.trim() : null,
      headBranch: sym.code === 0 ? sym.stdout.trim().replace(/^refs\/heads\//, "") : null,
      worktrees: trees.filter(Boolean).sort((a, b) => b.current - a.current),
      head: me?.h ?? null, states: ip.ok ? ip.states : [],
      stashes: stash.code === 0 ? stash.stdout.split("\n").filter(Boolean).map((l) => { const [oid, parents, ref, msg, at] = l.split(US); return { oid, base: parents.split(" ")[0], ref, msg, at: +at }; }) : [],
      wip,
    });
  }

  // Serialize reads; a request during a read marks it dirty and schedules one more pass.
  let running = null, dirty = false;
  function refresh() {
    if (running) { dirty = true; return running; } // Read once more before settling.
    // Clear running in the same step that exits the loop; a later finally() could let an intervening refresh
    // reuse a finished promise without starting a read. herdr can deliver multiple results before draining JS jobs.
    running = (async () => {
      do {
        dirty = false;
        try { await load(); } catch (e) { state.error = String(e?.message ?? e); state.gen++; }
        emit();
      } while (dirty);
      running = null;
    })();
    return running;
  }

  // One write queue serves every view; refresh after each write.
  let queue = Promise.resolve(), writeSeq = 0, issued = 0;
  function write(name, fn) {
    const seq = ++issued;
    state.pending++; emit();
    const job = queue.then(async () => {
      let r;
      try { r = await fn(g, t); } catch (e) { r = { operation: name, outcome: "unknown", reason: String(e?.message ?? e) }; }
      writeSeq = seq; state.pending--;
      await refresh();
      return { ...r, seq };
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    state, g, t, adapter, refresh, write,
    // read LOG_MORE more commits on the next refresh (and every one after).
    more() { limit += step; return refresh(); },
    // Retire write seq's optimistic state only after applying a read that began after that write finished.
    settled: (seq) => state.basis >= seq,
    nextSeq: () => issued + 1,
    need(path) { needed.set(path, (needed.get(path) ?? 0) + 1); return () => { const n = needed.get(path) - 1; if (n > 0) needed.set(path, n); else { needed.delete(path); state.wip.delete(path); } }; },
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    // For a view's task: `for (;;) { await s.next(); …; cx.notify(); }` (a callback has no cx to notify with).
    next: () => new Promise((ok) => waiters.push(ok)),
  };
}

// Keep one store per repository and machine within a mod copy. Each tab or pane loads separate modules,
// so copies notify one another through setShared rather than sharing this map.
const stores = new Map();
export function storeFor(adapter, root, machine = null, opts = {}) { // opts: createStore's (props.logLimit: screenshots)
  const k = (machine ?? "") + "\0" + root + (opts.history === false ? "\0lite" : "");
  if (!stores.has(k)) stores.set(k, createStore(adapter, root, opts));
  return stores.get(k);
}
