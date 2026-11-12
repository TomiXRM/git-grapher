// Refresh triggers call store.refresh(); the store serializes reads.
// - Watch every local worktree root. On macOS a root watch sees .git; linked worktree metadata lives in the main .git.
//   Remote roots cannot be watched because watchFolder has no machine selector.
// - Poll slowly as a fallback: competing watches can miss batches, and folders can disappear.
// - Mod copies have independent modules and stores. A ref change or completed write stamps "ggit.bump.<root>"
//   so other tabs and detached details refresh.
import { watchFolder, shared, setShared } from "herdr";

const QUIET = 300, MOST = 1000; // read 300 ms after the last batch, but at least once a second during a flood
const POLL = { local: 45_000, remote: 10_000 };
// our own reads use READ flags and make no events; these are git's own bookkeeping, never a change we show.
// .git/lfs/: git-lfs writes .git/lfs/tmp files while our status / diff run its filter on a modified LFS file, so
// counting them made every read start the next one.
const NOISE = /(\.lock$|\/objects\/|\/logs\/|\/\.git\/lfs\/|COMMIT_EDITMSG$|AUTO_MERGE$|\/FETCH_HEAD$)/;
export const relevant = (batch, root) => batch.some((p) => p === root || !NOISE.test(p));

export function drive(store, { machine = null, pollMs = null } = {}, cx) {
  const root = store.state.root, bumpKey = "ggit.bump." + (machine ?? "") + ":" + root, me = Math.random().toString(36).slice(2);
  let last = 0, first = 0, armed = false, tell = false;
  // Stamp the bump when the debounced read starts, at most once per 0.3–1 s rather than once per event batch.
  const kick = (alsoTell = false) => {
    last = Date.now(); tell ||= alsoTell;
    if (armed) return;
    armed = true; first = last;
    cx.spawn(async (cx) => {
      while (Date.now() - last < QUIET && Date.now() - first < MOST) await cx.sleep(50);
      armed = false; if (tell) { tell = false; stamp(); } store.refresh();
    });
  };

  // Watches follow the worktree list: a loop per path, which ends when its path is no longer a worktree.
  const watching = new Set();
  const watch = (path) => {
    if (machine || watching.has(path)) return;
    watching.add(path);
    cx.spawn(async (cx) => {
      while (store.state.worktrees.some((w) => w.path === path) || path === root) {
        let batch;
        try { batch = await watchFolder(path); } catch { await cx.sleep(5000); continue; } // a deleted folder fails at once
        if (relevant(batch, path)) kick(true); // Notify other copies too: herdr can deliver a path's batch only to its newest waiter, and worktree-only
        // changes move no refs, so the subsequent read would not publish a bump on its own.
      }
      watching.delete(path);
    });
  };

  // Publish ref changes and completed writes. Consume unseen remote bumps before overwriting them with our stamp.
  // Polling covers lagging shared() reads. Identify each bump by copy + counter so changes in one millisecond stay distinct.
  const idOf = (b) => b?.id ?? b?.at ?? 0;
  let seen = idOf(shared(bumpKey)), count = 0;
  const stamp = () => {
    const b = shared(bumpKey);
    if (b && idOf(b) !== seen && b.by !== me) { seen = idOf(b); kick(); }
    const id = `${me}:${++count}`; seen = id; setShared(bumpKey, { at: Date.now(), by: me, id });
  };
  let sig = store.state.sig, pending = store.state.pending;
  store.on((s) => {
    for (const w of s.worktrees) watch(w.path);
    if ((s.sig !== sig && sig != null) || (s.pending < pending)) stamp();
    sig = s.sig; pending = s.pending;
  });
  watch(root);
  for (const w of store.state.worktrees) watch(w.path);

  // The others' news, and the slow poll. shared() is in memory, so checking it every 250 ms costs nothing.
  let polled = Date.now();
  cx.spawn(async (cx) => {
    for (;;) {
      await cx.sleep(250);
      const b = shared(bumpKey);
      if (b && idOf(b) !== seen) { seen = idOf(b); if (b.by !== me) kick(); }
      if (Date.now() - polled >= (pollMs ?? (machine ? POLL.remote : POLL.local))) { polled = Date.now(); store.refresh(); }
    }
  });
}
