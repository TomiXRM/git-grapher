// Repository header and grouped toolbar with icons above labels. Actions use the ggit core.
// Width stages (measured width, or props.headerW):
//   >= 500: icons above labels; Pop shows a stash-count badge, Fetch a dot when automatic fetching stops
//   >= 340: icons only, with tooltips
//   < 340: keep Pull / Push; move Branch / Stash / Pop into the overflow menu

import { Input, div, h_flex, svg, v_flex } from "./ui/zoom.js";
import { Popup, InputState } from "gpui-base";
import { exec, settings, pickFolder } from "herdr";
import { createGgit, herdrAdapter } from "./lib/core.js";
import { previewPull } from "./lib/preview-pull.js";
import { mergePlan, runMerge, shortName } from "./lib/merge.js";
import { modal, modalButton, modalCheck, modalField } from "./modal.js";
import { settingsView } from "./settings.js";
import { updateState, runUpdate } from "./update.js";
import { disclosure, codeBlock } from "./disclosure.js";
import { settings as ggSettings, setSetting } from "./themes.js";

// Icons are read from the installed mod folder; herdr does not read svg through a symlinked one, so scripts/dev-link.sh copies.
const ICON = (n) => `mods/git-grapher/icons/${n}.svg`;
const AUTO_MS = 60_000;
const STAGE = [[640, "full"], [500, "labels"], [340, "icons"], [0, "overflow"]];
const alpha = (c, a) => (c && c.length === 7 ? c + a : c);
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// gitRefuses marks merge / cherry-pick states where git rejects pulling; do not offer Continue anyway.
const STATE_TEXT = {
  "merge": "A merge is in progress. Git will refuse to pull",
  "cherry-pick": "A cherry-pick is in progress. Git will refuse to pull",
  "index-lock": "index.lock exists (another git is running, or it was left behind)",
};
const stateText = (s) => STATE_TEXT[s.kind] ?? `A ${s.kind} is in progress. Pulling moves HEAD under it`;

// Shell-quoted for a command shown to copy (a legal branch name can hold; or $).
const q = (s) => (/^[\w./@:+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const first = (s) => (s || "").split("\n").find((l) => /^(error|fatal):/.test(l)) ?? (s || "").split("\n").find(Boolean) ?? "";
const BUSY = { worktree: "Creating the worktree…", revert: "Reverting…", checkout: "Checking out…", pull: "Pulling…", preview: "Checking what the pull will do…", push: "Pushing…", stash: "Stashing…", pop: "Popping the stash…",
  branch: "Creating the branch…", fetch: "Fetching…", switch: "Switching…",
  apply: "Applying the stash…", drop: "Dropping the stash…",
  rename: "Renaming the branch…", tag: "Creating the tag…", "fetch-branch": "Fetching the branch…", "delete-remote": "Deleting on the remote…", upstream: "Setting the upstream…", "delete-branch": "Deleting the branch…", "push-tag": "Pushing the tag…",
  merge: "Merging…", commit: "Committing…", "conflict-save": "Saving the result…", "conflict-take": "Taking that side…",
  "conflict-continue": "Continuing…", "conflict-skip": "Skipping this step…", "conflict-abort": "Aborting…",
  "wt-remove": "Removing the worktree…", "wt-lock": "Locking…", "wt-prune": "Pruning worktrees…", "wt-repair": "Repairing worktrees…" };
// Result cards: success for completed work, info for no-op results, error for failures until dismissed.
// A merge stopped on conflicts opens Conflict Mode and uses an info card.
const outcomeKind = (r) => (!r ? "info" : r.outcome === "completed" ? "success" : r.outcome === "noop" || (r.operation === "merge" && r.outcome === "conflict") ? "info" : "error");
const UNKNOWN = "Result unknown (timed out after 30 s, or git was killed). Git may still be running: wait a minute before running it again. State reloaded";
// Show the outcome in plain language, with technical details in a disclosure.
function resultText(r) {
  // Show a known reason for uncertain results, such as partial writes or a moved HEAD.
  // Use timeout wording only for timeouts or killed processes.
  if (r.outcome === "unknown") return r.operation === "pull" && r.exitCode != null ? `Could not tell what the pull did: ${first(r.stderr)}`
    : r.stderr && !["timeout-or-not-started", "killed"].includes(r.reason) ? `Result unknown: ${first(r.stderr)}` : UNKNOWN;
  const err = first(r.stderr);
  switch (r.operation) {
    case "fetch": return r.outcome === "completed" ? `Fetched ${r.refs.length} ref${r.refs.length === 1 ? "" : "s"} from ${r.remote}`
      : r.outcome === "noop" ? `Nothing new on ${r.remote}` : r.reason === "no-upstream" ? "No upstream to fetch from" : `Fetch failed: ${err}`;
    case "note": return r.text;
    case "worktree": return r.outcome === "completed" ? `Created worktree ${r.path.split("/").pop()}${r.branch ? ` on ${r.branch}` : " (detached)"}`
      : r.reason === "invalid-name" ? `"${r.name}" is not a valid branch name` : r.reason === "inside-repo" ? "The worktree folder must be outside the repository"
      : `Could not create the worktree: ${err}`;
    case "apply": return r.outcome === "completed" ? "Applied (the stash is kept)" : r.outcome === "conflict" ? `Apply stopped with conflicts in ${r.unmerged} file(s)`
      : r.reason === "stash-gone" ? "That stash no longer exists" : `Apply failed: ${err}`;
    case "drop": return r.outcome === "completed" ? `Dropped stash@{${r.n}} (git stash apply ${r.oid.slice(0, 12)} brings it back until git prunes it)`
      : r.reason === "stash-gone" ? "That stash no longer exists" : r.reason === "stash-moved" ? `Not dropped: ${err}` : `Drop failed: ${err}`;
    case "tag": return r.outcome === "completed" ? `Created tag ${r.name} at ${r.sha.slice(0, 7)}` : r.reason === "invalid-name" ? `"${r.name}" is not a valid tag name` : `Could not create the tag: ${err}`;
    case "fetch-branch": return r.outcome === "completed" ? `Fetched ${r.name}` : `Fetch failed: ${err}`;
    case "delete-remote": return r.outcome === "completed" ? `Deleted ${r.name} on the remote (it was at ${r.oid.slice(0, 7)})`
      : /stale info|rejected/.test(r.stderr ?? "") ? `Not deleted: ${r.name} moved on the remote since you looked` : `Could not delete ${r.name}: ${err}`;
    case "upstream": return r.outcome === "completed" ? `${r.branch} now tracks ${r.name}` : r.reason === "not-fetched" ? `${r.name} has not been fetched: fetch it first` : `Could not set the upstream: ${err}`;
    case "rename": return r.outcome === "completed" ? `Renamed ${r.from} to ${r.name}` : r.reason === "invalid-name" ? `"${r.name}" is not a valid branch name` : `Could not rename: ${err}`;
    case "delete-branch": return r.outcome === "completed"
      ? `Deleted ${r.name}${r.kept ? ` — its ${r.own} commit${r.own === 1 ? "" : "s"} kept as ${r.kept} (git branch -- ${q(r.name)} ${q(r.kept)} brings it back)` : ""}`
      : `Could not delete ${r.name}: ${err}`;
    case "push-tag": return r.outcome === "completed" ? `Pushed tag ${r.tag} to ${r.remote}` : `Could not push ${r.tag}: ${err}`;
    case "wt-remove": return r.outcome === "completed" ? `Removed worktree ${r.path.split("/").pop()}${r.branch ? ` and branch ${r.branch}` : ""}` : `Could not remove: ${err}`;
    case "wt-lock": return r.outcome === "completed" ? "Done" : `Could not change the lock: ${err}`;
    case "wt-prune": return r.outcome === "completed" ? "Pruned stale worktrees" : `Prune failed: ${err}`;
    case "wt-repair": return r.outcome === "completed" ? "Repaired worktrees" : `Repair failed: ${err}`;
    case "revert": return r.outcome === "completed" ? "Reverted" : r.outcome === "conflict" ? `Revert stopped: ${r.unmerged} unresolved file(s)`
      : r.reason === "merge-commit" ? "Merge commits are not reverted here" : r.outcome === "noop" ? "Nothing to revert" : `Revert failed: ${err}`;
    case "switch": return r.outcome === "completed" ? `Switched to ${r.branch ?? r.name}${r.stashed ? " (your changes are in the stash: Pop brings them back)" : ""}` : `Switch refused: ${err}`;
    case "sync": return r.outcome === "completed" ? (r.made ? `Made ${r.branch}, tracking ${r.name}` : r.ff ? `${r.branch} fast-forwarded to ${r.name}` : `Switched to ${r.branch} (up to date with ${r.name})`)
      : `Not updated: ${err}`;
    case "checkout": return r.outcome === "completed" ? `HEAD is now detached at ${r.head?.slice(0, 7)}` : `Checkout refused: ${err}`;
    case "stash": return r.outcome === "completed" ? "Stashed" : r.outcome === "noop"
      ? (r.left?.untracked ? "No local changes to stash (for new files, right-click → Include untracked files)" : "No local changes to stash") : `Stash failed: ${err}`;
    case "pop": return r.outcome === "completed" ? "Popped" : r.outcome === "conflict" ? `Pop stopped with conflicts in ${r.unmerged} file(s). The stash is kept`
      : r.reason === "stash-gone" ? "That stash no longer exists" : `Pop failed: ${err}`;
    case "branch": return r.outcome === "completed" ? `Created branch ${r.name}${r.head === r.name ? " and switched to it" : ""}`
      : r.reason === "invalid-name" ? `"${r.name}" is not a valid branch name`
      : /overwritten/.test(r.stderr) ? "Local changes would be overwritten, so it did not switch (no branch was created)" : `Could not create the branch: ${err}`;
    case "push": return r.outcome === "completed" ? "Pushed" : r.outcome === "noop" ? "Everything up-to-date"
      : r.reason === "which-remote" ? `Several remotes (${r.remotes.join(", ")}) and no upstream: choose one in a terminal`
      : r.reason === "no-remote" ? "No remote" : r.reason === "detached-head" ? "Detached HEAD: nothing to push"
      : r.refs?.some((x) => /fetch first|non-fast-forward/.test(x.summary)) ? "Rejected: the remote has commits you do not have. Pull first"
      : `Push ${r.outcome === "partial" ? "partly " : ""}rejected: ${err || r.refs?.find((x) => x.flag === "!")?.summary || ""}`;
    case "merge": return r.outcome === "completed" ? (r.kind === "ff" ? `${r.into} fast-forwarded to ${r.source}` : `Merged ${r.source} into ${r.into}`)
      : r.outcome === "conflict" ? `Merge stopped with conflicts in ${r.unmerged} file(s): resolve them below` : r.reason === "stale" ? `Not merged: ${err}` : `Merge refused: ${err}`;
    case "commit": return r.outcome === "completed" ? "Committed" : `Commit refused: ${err}`;
    case "conflict-save": return r.outcome === "completed" ? `Saved ${r.path} (staged)` : `Not saved: ${err}`;
    case "conflict-take": return r.outcome === "completed" ? `Resolved ${r.path}` : `Could not resolve: ${err}`;
    case "conflict-continue": return r.outcome === "completed" ? "Continued" : r.outcome === "stopped" ? `Stopped again: ${r.unmerged} file(s) conflict in the next step` : `Continue refused: ${err}`;
    case "conflict-skip": return r.outcome === "completed" ? "Skipped that step" : r.outcome === "stopped" ? `Skipped; the next step conflicts in ${r.unmerged} file(s)` : `Skip refused: ${err}`;
    case "conflict-abort": return r.outcome === "completed" ? `Aborted the ${r.op}: back to where it started` : `Not aborted: ${err}`;
    case "pull": return r.outcome === "completed" ? "Pulled" : r.outcome === "noop" ? "Already up to date"
      : r.outcome === "conflict" ? `Pull stopped: ${r.unmerged} unresolved file(s)${r.states.length ? ` (${r.states.join(", ")} in progress)` : ""}` : `Pull refused: ${err}`;
  }
  return r.outcome;
}
// The preview says "nothing found" rather than claiming a clean merge.
const AXES = [["history", "History"], ["localOverwrite", "Local changes"], ["stashRestore", "Autostash restore"]];
// Show each conflict or refusal once. Combine unpredicted cases into one sentence; retain all axes and codes in Details.
const WHY = {
  "upstream-unavailable": "This branch has no upstream, so there is nothing to compare with.",
  "detached-head": "HEAD is detached; there is no branch to pull into.",
  "unborn": "The branch has no commits yet.",
  "already-unmerged": "There are unresolved conflicts already.",
  "unmodelled-pull-settings": "Your pull settings are not ones the prediction models.",
  "rebase-semantics-not-modelled": "This pull rebases; rebase results are not predicted.",
  "divergent-pull-mode-unspecified": "The histories diverged and pull.rebase is not set.",
  "observed-basis-changed": "The repo changed while predicting.",
  "checkout-semantics-not-modelled": "Local changes may block the checkout.",
  "overlapping-local-paths": "Local changes overlap incoming changes.",
  "autostash-restore-not-modelled": "Restoring the autostash is not predicted.",
};
const AXIS_FOUND = { history: "Conflict in", localOverwrite: "Local changes would be overwritten in", stashRestore: "Autostash would conflict in" };
const names = (paths) => `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
// By what was found, not by the overall verdict: an unknown axis makes the verdict unknown even when another axis found a conflict.
const found = (p, r) => p.ok && AXES.some(([k]) => p.data[k].result === r);
const predicted = (p) => p.ok && AXES.some(([k]) => p.data[k].result !== "unknown");
function predictionTitle(p) {
  return found(p, "refused") ? "Git will likely refuse this pull" : found(p, "conflict") ? "Pull will likely conflict" : "Can't predict this pull";
}
function predictionLines(p, warn) {
  if (!p.ok) return [div().child("The prediction failed to run.")];
  const d = p.data, axes = AXES.map(([k]) => [k, d[k]]);
  const found = axes.filter(([, a]) => a.result === "conflict" || a.result === "refused")
    .map(([k, a]) => div().text_color(warn).child(a.paths?.length ? `${AXIS_FOUND[k]} ${names(a.paths)}` : a.result === "refused" ? "Git will refuse it." : "A conflict is likely."));
  const why = [...new Set(axes.filter(([, a]) => a.result === "unknown").map(([, a]) => WHY[a.reason] ?? "Part of it cannot be predicted."))];
  const out = [...found, ...why.map((w) => div().child(found.length ? `Also: ${w}` : w))];
  if (d.externalCode?.length) out.push(div().child("This repo configures a merge driver; it also ran during the prediction."));
  return out;
}
// Expose the same prediction as structured data in the verbose disclosure.
function predictionCode(p) {
  if (!p.ok) return [`error: ${p.error?.kind ?? ""} ${p.error?.message ?? ""}`];
  const d = p.data;
  return [`basis: HEAD ${d.basis?.headOid?.slice(0, 10) ?? "?"}  upstream ${d.basis?.upstreamRef ?? ""} ${d.basis?.upstreamOid?.slice(0, 10) ?? "?"}`, `mode: ${d.mode ?? "?"}`,
    ...AXES.map(([k]) => `${k}: ${d[k].result}${d[k].reason ? ` (${d[k].reason})` : ""}${d[k].paths?.length ? `  ${d[k].paths.join(" ")}` : ""}`),
    ...(d.externalCode?.length ? [`externalCode: ${d.externalCode.join(", ")}`] : [])];
}

// "From <oid chip> subject…": the commit a popup acts on, labelled, one line.
function fromLine(t, head, label = "From") {
  const fg = t.foreground;
  return h_flex().min_w(0).gap(6).items_center().text_size(12).text_color(t.muted ?? alpha(fg, "99"))
    .child(div().flex_none().child(label))
    .child(div().flex_none().px(6).py(1).rounded(5).bg(alpha(fg, "14")).text_color(fg).font_family(settings().font_family ?? "Menlo").child(head?.oid ?? ""))
    .child(div().min_w(0).truncate().child(head?.subject ?? ""));
}

const MENUS = {
  pop: [["Restore staged state too", "--index"]],
};

export class Header {
  // The header reads the repo store (lib/store.js) and writes through its queue; it runs no git of its own except
  // the network ones (fetch, the pull preview), which stay outside the write queue so a slow network never holds a stage.
  constructor(p) {
    this.p = p;
    this.busy = null; this.dialog = p.dialog ?? null; this.stashOid = null; // props.dialog: drawn open (screenshots)
    // props.snack: a card drawn as-is (screenshots), e.g. { busy: "pull" } or { r: {operation, outcome, commands}, open: true }
    this.snack = p.snack ? { id: 0, in: true, out: false, hover: false, open: false, ms: Infinity, ...p.snack } : null;
    this.nameInput = InputState.new({ placeholder: "Branch name" });
    this.renameInput = InputState.new({ placeholder: "New name" });
    this.tagInput = InputState.new({ placeholder: "Tag name" });
    this.tagMsg = InputState.new({ placeholder: "Message (optional: makes it annotated)" });
    this.upInput = InputState.new({ placeholder: "origin/branch" });
    for (const st of [this.tagInput, this.tagMsg, this.upInput]) st.on("change", (_e, cx) => cx.notify());
    // Settings → Generate command, kept in ggit.settings as typed.
    this.genInput = InputState.new({ placeholder: "claude -p", value: ggSettings().genCommand ?? "" });
    this.genInput.on("change", () => setSetting("genCommand", this.genInput.value().trim()));
    this.renameInput.on("submit", (_e, cx) => this.renameBranch(cx));
    this.nameInput.on("submit", (_e, cx) => this.createBranch(cx));
    // the name is checked as it is typed (git's own rule, and a name in use); the error shows once something was typed.
    this.nameInput.on("change", (_e, cx) => {
      const v = (this.typed = this.nameInput.value()).trim(), d = this.dialog; this.nameErr = null; cx.notify();
      if (!v || !this.ad) return;
      cx.spawn(async (cx) => {
        const run = (args) => this.ad.run(args, { cwd: this.t.root }).catch(() => ({ code: 1 }));
        const [ok, used] = await Promise.all([run(["check-ref-format", "--branch", v]), run(["rev-parse", "-q", "--verify", `refs/heads/${v}`])]);
        if (this.dialog !== d || this.nameInput.value().trim() !== v) return;
        this.nameErr = ok.code !== 0 ? `"${v}" is not a valid branch name` : used.code === 0 ? `${v} already exists` : null; cx.notify();
      });
    });
    this.msgInput = InputState.new({ placeholder: "Message (optional)" });
    this.pathInput = InputState.new({ placeholder: "Folder" });
    this.wtBranch = InputState.new({ placeholder: "New branch (optional; empty = detached)" });
    this.pathInput.on("submit", (_e, cx) => this.createWorktree(cx)); this.wtBranch.on("submit", (_e, cx) => this.createWorktree(cx));
    this.pathInput.on("change", () => { if (!this.settingPath) this.pathEdited = true; });
    this.wtBranch.on("change", (_e, cx) => { // the default folder follows the branch name
      const d = this.dialog; if (d?.kind !== "worktree" || this.pathEdited) return;
      this.setPath(this.wtDefault(this.wtBranch.value().trim().replace(/\//g, "-") || d.short)); cx.notify();
    });
    this.msgInput.on("submit", (_e, cx) => this.runStash(cx));
    // The ring follows the keyboard (Input reports focus/blur; there is no is_focused on InputState).
    for (const st of [this.nameInput, this.msgInput, this.pathInput, this.wtBranch]) {
      st.on("focus", (_e, cx) => { this.focusIn = st; cx.notify(); });
      st.on("blur", (_e, cx) => { if (this.focusIn === st) this.focusIn = null; cx.notify(); });
    }
    this.w = 0; this.menu = p.menu ?? null; // props.menu: "stash" | "pop" | "more" drawn open (screenshots)
    this.h = null; this.states = []; this.name = ""; this.err = null;
    this.fetching = false; this.lastFetch = null; this.autoStopped = false; this.fetchErr = null;
  }

  attach(store, cx) {
    this.st = store; this.g = store.g; this.t = { ok: true, root: store.state.root }; this.ad = store.adapter;
    this.name = store.state.root.split("/").filter(Boolean).pop();
    this.sync(store.state);
    ({ branch: this.nameInput, worktree: this.pathInput, stash: this.msgInput })[this.p.dialog?.kind]?.focus(); // props.dialog: as if opened
    // once on open, then every minute while this pane lives; a failure stops it until a manual Fetch succeeds.
    // Not while writes wait or run: an auto fetch must not delay or overlap them (a pull or push in particular).
    cx.spawn(async (cx) => { for (;;) { if (this.autoFetchOk()) await this.fetchTask(cx, true); await cx.sleep(AUTO_MS); } });
    this.checkUpdate(cx, false); // the gear's ↑ when a newer release exists (cached for a day)
  }
  // Settings → Updates. upd: { version, latest, available, helper, dev, busy?, text? }
  checkUpdate(cx, force) {
    cx.spawn(async (cx) => { const s = await updateState(force); this.upd = { ...this.upd, ...s }; cx.notify(); });
  }
  runUpdate(mode, cx) {
    const tag = this.upd?.latest; if (!tag || this.upd.busy) return;
    this.upd = { ...this.upd, busy: mode, text: null }; cx.notify();
    cx.spawn(async (cx) => { const r = await runUpdate(mode, tag); this.upd = { ...this.upd, busy: null, text: r.text, ...(r.ok && mode === "helper" ? { helper: true } : {}) }; cx.notify(); });
  }
  // Pause automatic fetching from the start of a Pull preview until that pull settles (previewing, dialog open, queued or
  // running), so the shown prediction stays true. `pulling` counts Pull requests: `busy` is shared by every operation.
  // This keeps the dialog steady; what makes the pull safe is the basis check right before `git pull` (pullAt).
  autoFetchOk() { return !this.autoStopped && !this.fetching && !(this.st?.state.pending > 0) && !(this.pulling > 0) && this.dialog?.kind !== "pull"; }
  // From the store after each read (the graph calls it).
  // git refuses a pull now: a merge or cherry-pick in progress, or files still unmerged.
  pullRefused() { return this.states.some((s) => s.gitRefuses) || (this.h?.unmerged ?? 0) > 0; }
  sync(s) { this.h = s.head; this.states = s.states; this.stashOid = s.stashes[0]?.oid ?? null; this.err = s.error; }
  refresh() { return this.st?.refresh(); }

  // Start a task for click actions: a handler's cx expires after a host call.
  fetch(cx, auto) { cx.spawn((cx) => this.fetchTask(cx, auto)); }
  async fetchTask(cx, auto) {
    if (this.fetching || !this.h) return;
    if (auto && (this.netRunning || this.netQueued)) return;
    this.fetching = true; if (!auto) this.setSnack(cx, { busy: "fetch" }); cx.notify();
    // Fetch stays outside the write queue so its 30 s exec limit cannot block staging. It touches refs, not the index.
    // Network jobs cannot overlap: Pull / Push await an active fetch; a Fetch clicked during either queues behind it.
    let r;
    try {
      // A Pull / Push already queued counts as running: a Fetch slipping in before it would move the refs it was planned on.
      const queued = !!(this.netRunning || this.netQueued), job = queued ? this.st.write("fetch", () => this.g.fetch(this.t, this.h)) : this.g.fetch(this.t, this.h);
      this.fetchJob = job.catch(() => null);
      // Pull / Push await only an outside-queue fetch. Waiting for a fetch queued behind them would deadlock
      // a Push -> Push -> Fetch sequence.
      if (!queued) this.freeFetch = this.fetchJob;
      r = await job;
    } catch (e) { r = { operation: "fetch", outcome: "unknown", reason: String(e?.message ?? e) }; } // a throw must not leave "fetching" set
    finally { this.fetchJob = null; this.freeFetch = null; this.fetching = false; }
    this.refresh();
    if (!auto) this.setSnack(cx, { busy: null, r }); // auto fetch stays quiet: its state is the status block
    if (r.outcome === "completed" || r.outcome === "noop") { this.lastFetch = new Date(); this.autoStopped = false; this.fetchErr = null; }
    else if (r.reason === "no-upstream") this.fetchErr = "No upstream";
    else { this.fetchErr = (r.stderr || r.reason || r.outcome).split("\n")[0]; if (auto) this.autoStopped = true; }
    cx.notify();
  }

  // All views share the store's write queue; a click waits its turn rather than being dropped.
  op(name, fn, cx) {
    if (!this.st) return;
    this.busy = name; this.menu = null; this.setSnack(cx, { busy: name });
    // Await an active outside-queue fetch before Pull / Push so network jobs cannot overlap.
    const net = name === "pull" || name === "push";
    if (net) this.netQueued = (this.netQueued ?? 0) + 1;
    cx.spawn(async (cx) => {
      const r = await this.st.write(name, async () => {
        if (!net) return fn();
        if (this.freeFetch) await this.freeFetch;
        this.netRunning = true;
        try { return await fn(); } finally { this.netRunning = false; }
      }).finally(() => { if (net) this.netQueued--; if (name === "pull") this.pulling = Math.max(0, (this.pulling ?? 0) - 1); });
      if (this.busy === name) this.busy = null;
      // git refused to switch over local changes → the choice to stash them first, instead of a red card.
      if (r?.operation === "switch" && r.outcome === "refused" && !r.stashed && /would be overwritten/.test(r.stderr ?? "")) {
        this.snack = null; this.dialog = { kind: "switch-dirty", name: r.name, remote: r.remote, files: (r.stderr.match(/^\t(.+)$/gm) ?? []).map((l) => l.trim()) }; cx.notify(); return;
      }
      this.setSnack(cx, { busy: null, r });
    });
  }

  // Warn about existing in-progress operations, then ask before plain `git pull` if the preview reports anything to check.
  pull(cx, confirmed = null) { cx.spawn((cx) => this.pullTask(cx, confirmed)); }
  async pullTask(cx, confirmed) {
    if (!confirmed && this.states.length) { this.dialog = { kind: "states" }; cx.notify(); return; }
    this.busy = "pull"; this.pulling = (this.pulling ?? 0) + 1; this.dialog = null; this.setSnack(cx, { busy: "preview" });
    if (this.fetchJob) await this.fetchJob; // predict on the refs a running fetch brings, not the ones before it
    const p = await previewPull(this.ad.run, { cwd: this.t.root }).catch((e) => ({ ok: false, error: { message: String(e) } }));
    this.busy = null; this.snack = null;
    const basis = p.ok ? `${p.data.basis.headOid}:${p.data.basis.upstreamOid}` : null;
    // Re-read HEAD and upstream when confirming; if the prediction's basis changed, show a fresh prediction instead.
    // A change the preview saw while it read (observed-basis-changed) is stale too, even if HEAD and upstream look the same.
    const moved = p.ok && p.data.history?.reason === "observed-basis-changed";
    const stale = !!confirmed && ((confirmed.basis && basis !== confirmed.basis) || moved);
    if (!stale && (confirmed?.ok || (p.ok && p.data.predicted === "clean"))) return this.op("pull", () => this.pullAt(basis), cx);
    this.pulling = Math.max(0, this.pulling - 1); // the dialog keeps auto fetch paused from here (dialog.kind)
    this.dialog = { kind: "pull", p, basis, stale, at: new Date(), open: ggSettings().verbose }; cx.notify();
  }

  // Run inside the write queue, after any fetch running outside it has finished: pull only if HEAD and upstream are still
  // what the preview read. Any fetch (automatic, pressed, another copy's, another program's) that moved them makes it stale.
  // It refuses only when it read both refs and they differ. With no basis to compare (no upstream, detached or unborn
  // HEAD: "Pull anyway") or a read that fails, git pull decides, as on the command line.
  // ponytail: a ref moving between this check and git pull's own start is still possible; git pull itself is the last word.
  async pullAt(basis) {
    const r = /^[0-9a-f]+:[0-9a-f]+$/.test(basis ?? "") ? await this.ad.run(["rev-parse", "HEAD", "@{upstream}"], { cwd: this.t.root }).catch(() => null) : null;
    const now = r?.code === 0 ? r.stdout.trim().split("\n").join(":") : null;
    if (now && now !== basis) return { operation: "pull", outcome: "refused", reason: "stale",
      stderr: "The branch or its upstream moved after the preview. Pull again to see what it would do now." };
    return this.g.pull(this.t);
  }

  createBranch(cx) {
    const name = this.nameInput.value().trim();
    if (!name) return;
    const switchTo = !!this.dialog?.switchTo, from = this.dialog?.from ?? "HEAD";
    this.dialog = null;
    this.op("branch", () => this.g.branchCreate(this.t, name, { switchTo, from }), cx);
  }

  // Worktree creation takes a folder and optional new branch; without a branch it detaches at the commit.
  // Default to ../<repo>-worktrees/<branch or short sha>, following the branch name until the folder is edited.
  // Choose opens the folder picker and places the worktree inside that folder. git creates missing parents.
  wtDefault(name) { const root = this.t.root, i = root.lastIndexOf("/"); return `${root.slice(0, i)}/${root.slice(i + 1)}-worktrees/${name}`; }
  setPath(v) { this.settingPath = true; this.pathInput.set_value(v); this.settingPath = false; }
  openWorktree(cx, at) {
    const short = at.sha.slice(0, 7);
    this.wtBranch.set_value(""); this.typed = ""; this.pathEdited = false; this.setPath(this.wtDefault(short));
    this.dialog = { kind: "worktree", from: at.sha, short, head: { oid: short, subject: at.subject } }; this.menu = null; cx.notify(); this.wtBranch.focus();
  }
  chooseWorktreeFolder(cx) {
    const d = this.dialog;
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Choose where the worktree goes" }).catch(() => null);
      if (!dir || this.dialog !== d) return;
      this.pathEdited = true; this.setPath(`${dir.replace(/\/$/, "")}/${this.wtBranch.value().trim().replace(/\//g, "-") || d.short}`); cx.notify();
    });
  }
  createWorktree(cx) {
    const path = this.pathInput.value().trim(), branch = this.wtBranch.value().trim() || null, from = this.dialog?.from;
    if (!path || !from) return;
    this.dialog = null;
    this.op("worktree", () => this.g.worktreeAdd(this.t, path, { branch, from }), cx);
  }
  // Revert / detached checkout ask first (they change the branch or the working tree).
  // The revert / checkout dialog's OK: its button only.
  confirmed(cx) {
    const d = this.dialog;
    if (d?.kind !== "revert" && d?.kind !== "checkout") return;
    this.dialog = null;
    this.op(d.kind, () => (d.kind === "revert" ? this.g.revert(this.t, d.sha) : this.g.checkoutDetached(this.t, d.sha)), cx);
  }
  // Branch deletion asks once when no unique commits are lost, otherwise again naming commits backed up under
  // refs/ggit/deleted/. Tag creation shows its commit; pushing a tag names the target and remote.
  openTag(cx, at) { this.tagInput.set_value(""); this.tagMsg.set_value(""); this.dialog = { kind: "tag", sha: at.sha, head: { oid: at.sha.slice(0, 7), subject: at.subject } }; this.menu = null; cx.notify(); this.tagInput.focus(); }
  // deleting a remote branch asks twice (it cannot be taken back from here), bound to the commit shown.
  openRemoteDelete(cx, name, sha) { this.dialog = { kind: "delete-remote", name, sha, step: 1 }; this.menu = null; cx.notify(); }
  // the upstream, prefilled with the current one or <its remote>/<branch>.
  openUpstream(cx, branch) {
    const d = (this.dialog = { kind: "upstream", branch }); this.menu = null; this.upInput.set_value(""); cx.notify(); this.upInput.focus();
    cx.spawn(async (cx) => {
      const run = (args) => this.ad.run(args, { cwd: this.t.root }).catch(() => ({ code: 1, stdout: "" }));
      const [u, rl] = await Promise.all([run(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]), run(["remote"])]);
      const list = rl.code === 0 ? rl.stdout.split("\n").filter(Boolean) : [];
      const guess = u.code === 0 ? u.stdout.trim() : `${list.includes("origin") ? "origin" : list[0] ?? "origin"}/${branch}`;
      if (this.dialog === d && !this.upInput.value()) { this.upInput.set_value(guess); cx.notify(); }
    });
  }
  openRename(cx, name) { this.renameInput.set_value(name); this.dialog = { kind: "rename", name }; this.menu = null; cx.notify(); this.renameInput.focus(); }
  renameBranch(cx) {
    const d = this.dialog, to = this.renameInput.value().trim();
    if (d?.kind !== "rename" || !to || to === d.name) return;
    this.dialog = null; this.op("rename", () => this.g.branchRename(this.t, d.name, to), cx);
  }
  openDelete(cx, name) {
    // The tip read with the count: the delete acts on that commit only.
    const d = (this.dialog = { kind: "delete-branch", name, own: undefined, oid: null, step: 1 }); this.menu = null; cx.notify();
    cx.spawn(async (cx) => {
      const tip = await this.ad.run(["rev-parse", "-q", "--verify", `refs/heads/${name}`], { cwd: this.t.root }).catch(() => null);
      const own = await this.g.branchOwn(this.t, name).catch(() => null);
      if (this.dialog === d) { d.oid = tip?.code === 0 ? tip.stdout.trim() : null; d.own = d.oid ? own : null; cx.notify(); }
    });
  }
  // Show current and planned merge states, warnings and blockers; recheck the plan before running Merge.
  openMerge(cx, source, into) {
    const d = (this.dialog = { kind: "merge", source, into, plan: undefined }); this.menu = null; cx.notify();
    cx.spawn(async (cx) => {
      const p = await mergePlan(this.ad, this.t.root, source, into).catch((e) => ({ title: `Merge ${shortName(source)}`, blockers: [String(e?.message ?? e)], warnings: [], files: [] }));
      if (this.dialog === d) { d.plan = p; cx.notify(); }
    });
  }
  // dropping a stash asks first (its changes go; its OID can bring it back for a while).
  openDrop(cx, x) { this.dialog = { kind: "drop", x }; this.menu = null; cx.notify(); }
  openTagPush(cx, tag, sha) {
    const d = (this.dialog = { kind: "push-tag", tag, sha, remote: undefined, oid: null }); this.menu = null; cx.notify();
    cx.spawn(async (cx) => { // Use the branch's configured remote (names may contain "/"), else origin, else the sole remote.
      const run = (args) => this.ad.run(args, { cwd: this.t.root }).catch(() => ({ code: 1, stdout: "" }));
      const [cfg, rl, tg] = await Promise.all([this.h?.branch ? run(["config", "--get", `branch.${this.h.branch}.remote`]) : { code: 1 }, run(["remote"]), run(["rev-parse", "-q", "--verify", `refs/tags/${tag}`])]);
      const up = cfg.code === 0 ? cfg.stdout.trim() : null, list = rl.code === 0 ? rl.stdout.split("\n").filter(Boolean) : [];
      if (this.dialog === d) {
        d.oid = tg.code === 0 ? tg.stdout.trim() : null; // the tag object pushed, whatever the tag names by then
        d.remote = up && list.includes(up) ? up : list.includes("origin") ? "origin" : list.length === 1 ? list[0] : null; cx.notify();
      }
    });
  }

  // removing a worktree asks first (its files go; the branch too when asked). Its own button only.
  confirmRemove(cx, w, withBranch) { this.dialog = { kind: "wt-remove", w, withBranch }; this.menu = null; cx.notify(); }
  confirm(cx, kind, at) { this.dialog = { kind, sha: at.sha, head: { oid: at.sha.slice(0, 7), subject: at.subject } }; this.menu = null; cx.notify(); }
  // A small "done" card for menu actions that are not git writes.
  note(cx, text) { this.setSnack(cx, { busy: null, r: { operation: "note", outcome: "completed", text, commands: [] } }); }

  stage() {
    const w = this.p.headerW ?? this.w;
    return STAGE.find(([min]) => w >= min)[1];
  }

  render(t, cx) {
    const fg = t.foreground, dim = t.muted ?? alpha(fg, "99"), line = alpha(fg, "1f"), warn = t.ansi3 ?? "#d4a017";
    const st = this.stage(), h = this.h, stash = h?.stash ?? 0;
    const close = (_e, cx) => { if (this.menu) { this.menu = null; cx.notify(); } };

    // One toolbar button. icon over label, or icon only with the label as tooltip.
    const button = (id, icon, label, fn, { disabled = false, badge = 0, menu = null } = {}) => {
      if (this.busy === id) label += "…";
      const labels = st === "full" || st === "labels";
      const glyph = div().relative().child(svg(ICON(icon)).size(labels ? 17 : 16).text_color(disabled ? dim : fg))
        .children(badge ? [div().absolute().top(-5).left(11).h(13).min_w(13).px(3).rounded_full().bg(t.accent ?? fg)
          .text_color(t.accent_foreground ?? t.background).text_size(9).font_semibold().flex().items_center().justify_center().child(String(badge))] : []);
      let b = (labels ? v_flex().h(40).min_w(46).px(6).gap(3).justify_center() : h_flex().size(28).justify_center())
        .id("hb-" + id).flex_none().items_center().rounded(7).child(glyph)
        .when(labels, (e) => e.child(div().text_size(11).whitespace_nowrap().text_color(disabled ? dim : fg).child(label)))
        .when(!labels, (e) => e.tooltip(label))
        .when(disabled, (e) => e.opacity(0.45).cursor_default())
        .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover ?? t.raised)).on_click((_e, cx) => fn(cx)));
      if (menu) {
        b = b.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu = menu; cx.notify(); })
          .when(this.menu === menu, (e) => e.bg(t.selected ?? t.hover));
        return Popup.new("menu-" + menu, b).anchor("top_left")
          .when(this.menu === menu, (e) => e.content(this.menuView(menu, t, close)));
      }
      return b;
    };
    const sep = () => div().flex_none().w(1).h(st === "full" || st === "labels" ? 26 : 18).mx(5).bg(line);

    // Repo block: Fetch (the refresh icon, spins while fetching) + name + branch → upstream ↑ ↓.
    // The names truncate; ↑n ↓m never do (they are the point of the line at any width).
    const sub = !h ? (this.err ?? div().mt(2).h(8).w(110).rounded(4).bg(alpha(fg, "26"))) // loading: a skeleton bar
      : !h.branch ? `detached HEAD ${h.oid?.slice(0, 7) ?? ""}`
      : !h.upstream ? `${h.branch} · no upstream`
      : `${h.branch} → ${h.upstream}`;
    const ab = h?.upstream ? ` ↑${h.ahead} ↓${h.behind}` : "";
    const fetchTip = this.fetching ? "Fetching…" : this.autoStopped ? `Auto fetch stopped: ${this.fetchErr}. Fetch to resume`
      : `Fetch${this.lastFetch ? ` (last ${hhmm(this.lastFetch)}, auto every 1 min)` : ""}`;
    const fetchBtn = div().id("hb-fetch").relative().size(21.6).flex_none().flex().items_center().justify_center().rounded(7)
      .cursor_pointer().hover((s) => s.bg(t.hover ?? t.raised)).tooltip(fetchTip).on_click((_e, cx) => this.fetch(cx, false))
      .child(svg(ICON("refresh-cw")).size(14.4).text_color(fg).when(this.fetching, (e) => e.spin(900)))
      // ponytail: herdr redraws a pane with only spin() at ~6/s. An invisible 33 ms frames() ticker drives smooth motion
      // while spinning; remove it if spin() starts driving its own frames.
      .children(this.fetching ? [div().absolute().size(0).overflow_hidden().frames([" ", " "], 33).child(" ")] : [])
      .children(this.autoStopped ? [div().absolute().top(4).right(4).size(7).rounded_full().bg(warn).border_1().border_color(t.background)] : []);
    // At 100% zoom: 14.4 px icon in a 21.6 px box with a 7.2 px gap; repository text 12.6 px with 14.4 px line height;
    // branch text 10.8 px with 11.7 px line height. Use herdr's Geist font, which has no bold face.
    const repo = h_flex().flex_1().min_w(0).gap(7.2).items_center()
      .child(fetchBtn)
      .child(v_flex().min_w(0)
        .child(div().text_size(12.6).line_height("14.4px").truncate().child(this.name || "…"))
        .child(h_flex().min_w(0).text_size(10.8).line_height("11.7px").text_color(dim).child(div().min_w(0).truncate().child(sub))
          .children(ab ? [div().flex_none().whitespace_nowrap().child(ab)] : [])));

    const off = !this.t?.ok || !h;
    // A merge or cherry-pick in progress, or files still unmerged: git refuses a pull, so Pull is off from the start
    // instead of a banner saying so.
    const refused = this.pullRefused();
    const pull = button("pull", "arrow-down", "Pull", (cx) => this.pull(cx), { disabled: off || refused });
    const push = button("push", "arrow-up", "Push", (cx) => { const h = this.h; this.op("push", () => this.g.push(this.t, h), cx); }, { disabled: off });
    const branch = button("branch", "plus", "Branch", (cx) => this.openBranch(cx), { disabled: off });
    const stashB = button("stash", "inbox", "Stash", (cx) => this.openStash(cx), { disabled: off });
    const pop = button("pop", "folder-open", "Pop", (cx) => this.pop(cx, []), { disabled: off || stash === 0, badge: stash, menu: stash ? "pop" : null });
    const tools = h_flex().flex_none().items_center().gap(st === "full" || st === "labels" ? 2 : 1);
    if (st === "overflow") {
      const more = button("more", "ellipsis", "More", (cx) => { this.menu = this.menu === "more" ? null : "more"; cx.notify(); });
      const moreBtn = Popup.new("menu-more", more)
        .anchor("top_left").when(this.menu === "more", (e) => e.content(this.moreView(t, close, stash)));
      tools.child(pull).child(push).child(sep()).child(moreBtn);
    } else tools.child(pull).child(push).child(sep()).child(branch).child(stashB).child(pop);

    // WIP and stash rows carry status in the graph. Fetch time lives in its tooltip; a dot marks stopped automatic fetching.

    // Equal flex sides centre the toolbar on wide panes. Use plain flow on narrower panes to keep repository text readable.
    const centered = (this.p.headerW ?? this.w) >= 760; // Keep plain flow below 760 px to avoid truncating the upstream label.
    const gear = button("settings", "settings", "Settings", (cx) => { this.dialog = { kind: "settings" }; this.menu = null; this.checkUpdate(cx, true); cx.notify(); },
      { badge: this.upd?.available && !this.upd.dev ? "↑" : 0 });
    const bar = h_flex().h(st === "full" || st === "labels" ? 48 : 38).px(8).gap(6).items_center()
      .child(repo).child(tools)
      .when(centered, (e) => e.child(div().flex_1().min_w(0)))
      .child(gear);
    return v_flex().id("p13-header").flex_none().when(this.p.headerW != null, (e) => e.w(this.p.headerW)).when(this.p.headerW == null, (e) => e.w_full())
      .overflow_hidden().border_b(1).border_color(line).bg(t.background)
      .on_size_change((sz, cx) => { if (sz.width !== this.w) { this.w = sz.width; cx.notify(); } })
      .child(bar)
      ;
  }

  // Stash dialog: optional message and untracked / ignored checkboxes. Both off gives default `git stash push` behaviour.
  openStash(cx) { this.msgInput.set_value(""); this.dialog = { kind: "stash", untracked: false, ignored: false }; this.menu = null; cx.notify(); this.msgInput.focus(); }
  runStash(cx) {
    const d = this.dialog, msg = this.msgInput.value().trim();
    const flags = [...(d.ignored ? ["-a"] : d.untracked ? ["-u"] : []), ...(msg ? ["-m", msg] : [])];
    this.dialog = null;
    this.op("stash", () => this.g.stashPush(this.t, flags), cx);
  }
  // Capture the displayed stash OID at the click so repeated Pops cannot consume the next stash.
  pop(cx, flags) { const oid = this.stashOid; if (oid) this.op("pop", () => this.g.stashPop(this.t, oid, flags), cx); }
  // at: a commit ({ sha }) from the graph's menu or the detail's "Branch here"; none = HEAD.
  openBranch(cx, at = null) {
    this.nameInput.set_value(""); this.typed = ""; this.dialog = { kind: "branch", switchTo: false, head: null, from: at?.sha ?? "HEAD" }; this.menu = null; cx.notify(); this.nameInput.focus();
    cx.spawn((cx) => this.branchHead(cx, at));
  }
  async branchHead(cx, at) {
    const r = await this.ad.run(["--no-optional-locks", "log", "-1", "--format=%h%x00%s", at?.sha ?? "HEAD"], { cwd: this.t.root }).catch(() => null);
    if (r?.code === 0 && this.dialog?.kind === "branch") { const [oid, subject] = r.stdout.trim().split("\0"); this.dialog.head = { oid, subject }; cx.notify(); }
  }

  // Snackbar: bottom-left, 460 px wide, 12 px inset. Show a spinner during git and replace it with the result.
  // Routine results leave after 4 s without hover; errors and expanded Details remain until closed.
  // Animate in over 240 ms and out over 220 ms with 12 px travel.
  setSnack(cx, next) {
    const s = this.snack && !this.snack.out ? Object.assign(this.snack, next, { ms: 4000 })
      : (this.snack = { id: (this.seq = (this.seq ?? 0) + 1), in: false, out: false, hover: false, open: ggSettings().verbose, ms: 4000, ...next }); // Verbose mode starts with Details expanded.
    const id = s.id;
    cx.notify();
    if (!s.in) cx.spawn(async (cx) => { await cx.sleep(16); if (this.snack?.id === id) { this.snack.in = true; cx.notify(); } });
    if (s.busy || this.stays(s)) return;
    cx.spawn(async (cx) => {
      for (;;) {
        await cx.sleep(200);
        const c = this.snack;
        if (c?.id !== id || c.busy || this.stays(c)) return;
        if (!c.hover && (c.ms -= 200) <= 0) return this.closeSnack(cx);
      }
    });
  }
  stays(s) { return s.open || outcomeKind(s.r) === "error"; }
  closeSnack(cx) {
    const s = this.snack; if (!s || s.out) return;
    s.out = true; cx.notify();
    cx.spawn(async (cx) => { await cx.sleep(220); if (this.snack === s) { this.snack = null; cx.notify(); } });
  }

  // Drawn by the graph view inside its relative content box, so the card floats over the graph, not the header.
  snackView(t) {
    const s = this.snack; if (!s) return [];
    const fg = t.foreground, dim = t.muted ?? alpha(fg, "99");
    const kind = s.busy ? "busy" : outcomeKind(s.r);
    const accent = { busy: t.accent, success: t.ansi2, info: t.accent, error: t.ansi1 }[kind] ?? fg;
    const shown = s.in && !s.out, motion = { duration: s.out ? 220 : 240, easing: "ease-out" };
    const icon = s.busy
      ? div().relative().size(24).flex_none().flex().items_center().justify_center()
        .child(svg(ICON("refresh-cw")).size(22).text_color(accent).spin(700))
        .child(div().absolute().size(0).overflow_hidden().frames([" ", " "], 33).child(" ")) // see the Fetch icon: spin() alone redraws at ~6/s
      : div().flex_none().w(14).text_color(accent).font_bold().child({ success: "✓", info: "•", error: "✕" }[kind]);
    const r = s.r;
    const lines = (r?.commands ?? []).flatMap((c) => [
      // The command alone on its line, so a copy of it pastes into a terminal as-is; the result on the next line.
      `$ git ${c.args.filter((a, i, all) => !(a === "-c" || all[i - 1] === "-c")).join(" ")}`, `# ${c.error ?? `exit ${c.code}`}`,
      ...`${c.stdout ?? ""}\n${c.stderr ?? ""}`.trim().split("\n").filter(Boolean).slice(0, 12)]);
    const link = (id, label, fn) => div().id(id).flex_none().text_size(12).text_color(accent).cursor_pointer().hover((x) => x.opacity(0.75))
      .on_click((_e, cx) => fn(cx)).child(label);
    const card = h_flex().id("hd-snack").absolute().bottom(30) /* clears the stats line */.left(shown ? 12 : 0).w(Math.max(200, Math.min(460, (this.w || 480) - 24)))
      .opacity(shown ? 1 : 0).transition("opacity", motion).transition("left", motion)
      .px(16).py(12).gap(s.busy ? 12 : 8).when(Boolean(s.busy), (e) => e.items_center()).when(!s.busy, (e) => e.items_start())
      .rounded(8).bg(t.popover ?? t.raised ?? t.background).border_1().border_color(alpha(accent, "80")).shadow_lg()
      .text_size(13).text_color(fg)
      .on_hover((h, _cx) => { s.hover = h; })
      .on_scroll_wheel((_e, cx) => cx.stop_propagation()) // a wheel over the card scrolls its Details, not the graph under it
      .child(icon)
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().min_w(0).when(kind !== "error", (e) => e.truncate()).child(s.busy ? BUSY[s.busy] ?? "Working…" : resultText(r)))
        .children(!s.busy && lines.length ? [disclosure(t, "hd-snack-more", { open: s.open, onToggle: (cx) => { s.open = !s.open; this.setSnack(cx, {}); },
          body: codeBlock(t, "hd-snack-cmds", lines) })] : [])
        .children(s.busy ? [] : [h_flex().child(link("hd-snack-x", "Close", (cx) => this.closeSnack(cx)))]));
    return [card];
  }

  // The open popup (modal.js), drawn by the graph view at its root so it covers the graph and the drawer.
  modalView(t, paneW) {
    const d = this.dialog; if (!d) return [];
    const warn = t.ansi3 ?? "#d4a017", h = this.h;
    const cancel = modalButton(t, "dlg-cancel", "Cancel", (cx) => { this.dialog = null; cx.notify(); });
    if (d.kind === "branch") {
      const name = (this.typed ?? "").trim(), fg = t.foreground;
      return [modal(t, { icon: ICON("plus"), color: t.ansi2, title: "Create branch", paneW,
        // Label the start commit on one line so it reads as a field value.
        subtitle: fromLine(t, d.head ?? { oid: h?.oid?.slice(0, 7) ?? "" }),
        body: [
          modalField(t, Input.new(this.nameInput), this.focusIn === this.nameInput),
          ...(this.nameErr && name ? [div().text_size(12).text_color(t.ansi1 ?? warn).child(this.nameErr)] : []),
          modalCheck(t, "dlg-switch", d.switchTo, "Switch to it after creating", (cx) => { d.switchTo = !d.switchTo; cx.notify(); }),
        ],
        actions: [cancel, modalButton(t, "dlg-ok", "Create", (cx) => this.createBranch(cx), { primary: true, disabled: !name || Boolean(this.nameErr) })] })];
    }
    if (d.kind === "worktree") {
      const fg = t.foreground;
      return [modal(t, { icon: ICON("folder-open"), color: t.ansi4, title: "Create worktree", paneW,
        subtitle: fromLine(t, d.head),
        body: [modalField(t, Input.new(this.wtBranch), this.focusIn === this.wtBranch),
          h_flex().gap(6).items_center().child(div().flex_1().min_w(0).child(modalField(t, Input.new(this.pathInput), this.focusIn === this.pathInput)))
            .child(modalButton(t, "wt-choose", "Choose…", (cx) => this.chooseWorktreeFolder(cx)))],
        actions: [cancel, modalButton(t, "dlg-ok", "Create", (cx) => this.createWorktree(cx), { primary: true })] })];
    }
    if (d.kind === "switch-dirty") {
      const list = d.files.slice(0, 5).join(", ") + (d.files.length > 5 ? ` and ${d.files.length - 5} more` : "");
      return [modal(t, { icon: ICON("git-branch"), color: warn, title: `Switch to ${d.name}`, paneW,
        body: [div().whitespace_normal().child(`Your changes${list ? ` to ${list}` : ""} would be overwritten. Stash them (untracked files too), then switch; Pop brings them back.`)],
        actions: [cancel, modalButton(t, "dlg-ok", "Stash and switch", (cx) => { this.dialog = null; this.op("switch", () => this.g.switchBranch(this.t, d.name, { remote: d.remote, stash: true }), cx); }, { primary: true })] })];
    }
    if (d.kind === "checkout") { // detaching is warned, and a branch here offered instead
      return [modal(t, { icon: ICON("git-commit"), color: warn, title: "Check out this commit", paneW, subtitle: fromLine(t, d.head, "At"),
        body: [div().whitespace_normal().child("HEAD will be detached: commits made here belong to no branch and are easy to lose. Create a branch here to keep them.")],
        actions: [cancel, modalButton(t, "dlg-branch", "Create branch here…", (cx) => { this.openBranch(cx, { sha: d.sha, subject: d.head.subject }); this.dialog.switchTo = true; cx.notify();
          cx.spawn(async (cx) => { await cx.sleep(0); this.nameInput.focus(); }); }),
          modalButton(t, "dlg-ok", "Check out", (cx) => this.confirmed(cx), { primary: true })] })];
    }
    if (d.kind === "revert" || d.kind === "checkout") {
      const rv = d.kind === "revert";
      return [modal(t, { icon: ICON(rv ? "undo" : "git-commit"), color: rv ? warn : t.ansi4, title: rv ? "Revert this commit" : "Check out this commit", paneW,
        subtitle: fromLine(t, d.head, rv ? "Commit" : "At"),
        body: [div().child(rv ? `Adds a new commit on ${h?.branch ?? "HEAD"} that undoes it.` : "HEAD will be detached; your branches do not move.")],
        actions: [cancel, modalButton(t, "dlg-ok", rv ? "Revert" : "Check out", (cx) => this.confirmed(cx), { primary: true })] })];
    }
    if (d.kind === "drop") {
      return [modal(t, { icon: ICON("trash"), color: t.ansi1 ?? warn, title: `Drop ${d.x.ref ?? "the stash"}`, paneW,
        body: [div().whitespace_normal().child(`"${d.x.msg}" — its changes are thrown away. Until git prunes it, git stash apply ${d.x.oid.slice(0, 12)} brings it back.`)],
        actions: [cancel, modalButton(t, "dlg-ok", "Drop", (cx) => { this.dialog = null; this.op("drop", () => this.g.stashDrop(this.t, d.x.oid), cx); }, { primary: true })] })];
    }
    if (d.kind === "tag") {
      const name = this.tagInput.value().trim(), msg = this.tagMsg.value().trim();
      const go = (cx) => { if (!name) return; this.dialog = null; this.op("tag", () => this.g.tagCreate(this.t, name, d.sha, msg), cx); };
      return [modal(t, { icon: ICON("tag"), color: warn, title: "Create tag", paneW, subtitle: fromLine(t, d.head, "At"),
        body: [modalField(t, Input.new(this.tagInput), true), modalField(t, Input.new(this.tagMsg), false)],
        actions: [cancel, modalButton(t, "dlg-ok", "Create", go, { primary: true, disabled: !name })] })];
    }
    if (d.kind === "delete-remote") {
      const sure = d.step === 2;
      return [modal(t, { icon: ICON("trash"), color: t.ansi1 ?? warn, title: `Delete ${d.name} on the remote`, paneW,
        body: [div().whitespace_normal().child(sure ? `Really delete it? Others lose it at their next fetch, and ggit cannot bring it back. Only if the remote still has ${d.sha.slice(0, 7)}.`
          : `Deletes the branch on the remote for everyone. Your local branches and this commit (${d.sha.slice(0, 7)}) stay.`)],
        actions: [cancel, modalButton(t, "dlg-ok", sure ? "Delete" : "Continue…", (cx) => {
          if (!sure) { d.step = 2; cx.notify(); return; }
          this.dialog = null; this.op("delete-remote", () => this.g.remoteBranchDelete(this.t, d.name, d.sha), cx);
        }, { primary: true })] })];
    }
    if (d.kind === "upstream") {
      const name = this.upInput.value().trim();
      return [modal(t, { icon: ICON("cloud"), color: t.ansi4, title: `Set upstream of ${d.branch}`, paneW,
        body: [modalField(t, Input.new(this.upInput), true), div().text_size(12).text_color(t.muted ?? t.foreground).whitespace_normal().child("A remote branch that has been fetched (remote/branch).")],
        actions: [cancel, modalButton(t, "dlg-ok", "Set", (cx) => { this.dialog = null; this.op("upstream", () => this.g.setUpstream(this.t, d.branch, name), cx); }, { primary: true, disabled: !name })] })];
    }
    if (d.kind === "rename") {
      const to = this.renameInput.value().trim();
      return [modal(t, { icon: ICON("pencil-line"), color: t.ansi4, title: `Rename ${d.name}`, paneW,
        body: [modalField(t, Input.new(this.renameInput), true), div().text_size(12).text_color(t.muted ?? t.foreground).whitespace_normal().child("Only the local branch is renamed; a remote branch of the old name stays.")],
        actions: [cancel, modalButton(t, "dlg-ok", "Rename", (cx) => this.renameBranch(cx), { primary: true, disabled: !to || to === d.name })] })];
    }
    if (d.kind === "delete-branch") {
      const lose = d.own > 0, sure = !lose || d.step === 2;
      const text = d.own === undefined ? "Checking what it holds…" : d.own === null ? "Could not tell what would be lost."
        : !lose ? "Every commit on it is also on another branch, a tag or HEAD: nothing is lost."
        : d.step === 1 ? `${d.own} commit${d.own === 1 ? " is" : "s are"} only on ${d.name}. Deleting it hides ${d.own === 1 ? "it" : "them"} from every branch.`
        : `Really delete it? A ref refs/ggit/deleted/${d.name} keeps ${d.own === 1 ? "that commit" : "those commits"}, so it can be brought back.`;
      return [modal(t, { icon: ICON("trash"), color: t.ansi1 ?? warn, title: `Delete ${d.name}`, paneW,
        body: [div().whitespace_normal().child(text)],
        actions: [cancel, modalButton(t, "dlg-ok", sure ? "Delete" : "Continue…", (cx) => {
          if (!sure) { d.step = 2; cx.notify(); return; }
          this.dialog = null; this.op("delete-branch", () => this.g.branchDelete(this.t, d.name, d.oid), cx);
        }, { primary: true, disabled: d.own === undefined || d.own === null })] })]; // a failed count never deletes
    }
    if (d.kind === "push-tag") {
      return [modal(t, { icon: ICON("tag"), color: warn, title: `Push tag ${d.tag}`, paneW,
        body: [div().whitespace_normal().child(d.remote === undefined ? "Finding the remote…" : d.remote === null ? "No remote to push to (add one, or set the branch's upstream)."
          : `Pushes ${d.tag} (→ ${d.sha.slice(0, 7)}) to ${d.remote}. Once others fetch it, a tag is hard to take back.`)],
        actions: [cancel, modalButton(t, "dlg-ok", "Push", (cx) => { this.dialog = null; this.op("push-tag", () => this.g.tagPush(this.t, d.tag, d.remote, d.oid), cx); },
          { primary: true, disabled: !d.remote || !d.oid })] })];
    }
    if (d.kind === "wt-remove") {
      const w = d.w, b = d.withBranch && w.branch;
      return [modal(t, { icon: ICON("folder-open"), color: warn, title: b ? "Remove worktree and branch" : "Remove worktree", paneW,
        body: [div().whitespace_normal().child(`Deletes the folder ${w.path}${b ? ` and the branch ${b} (only if it is merged)` : ""}. Git refuses when it has changes or is locked.`)],
        actions: [cancel, modalButton(t, "dlg-ok", "Remove", (cx) => { this.dialog = null; this.op("wt-remove", () => this.g.worktreeRemove(this.t, w.path, { branch: b || null }), cx); }, { primary: true })] })];
    }
    if (d.kind === "merge") {
      const p = d.plan, dimC = t.muted ?? alpha(t.foreground, "99"), red = t.ansi1 ?? warn;
      const row = (k, v) => h_flex().gap(8).text_size(12).child(div().w(44).flex_none().text_color(dimC).child(k)).child(div().flex_1().min_w(0).whitespace_normal().child(v));
      const files = p?.files ?? [], conf = new Set(p?.conflicts ?? []);
      const body = !p ? [div().child("Checking what the merge will do…")] : [
        ...(p.current ? [row("Now", p.current)] : []), ...(p.after ? [row("After", p.after)] : []),
        ...p.blockers.map((b) => div().text_size(12).text_color(red).whitespace_normal().child(b)),
        ...p.warnings.map((w) => div().text_size(12).text_color(warn).whitespace_normal().child(w)),
        ...(files.length ? [v_flex().gap(1).text_size(11).font_family(settings().font_family ?? "Menlo")
          .children(files.slice(0, 8).map((f) => h_flex().gap(6).child(div().w(12).flex_none().text_color(conf.has(f.path) ? warn : dimC).child(conf.has(f.path) ? "!" : f.status)).child(div().min_w(0).truncate().child(f.path))))
          .children(files.length > 8 ? [div().text_color(dimC).child(`and ${files.length - 8} more`)] : [])] : []),
        ...(p.recovery && !p.blockers.length ? [div().text_size(11).text_color(dimC).whitespace_normal().child(`Undo: ${p.recovery}`)] : []),
      ];
      return [modal(t, { icon: ICON("git-merge"), color: t.ansi5 ?? t.ansi4, title: p?.title ?? `Merge ${shortName(d.source)}`, paneW, body,
        actions: [cancel, modalButton(t, "dlg-ok", p?.kind === "conflict" ? "Merge and resolve" : "Merge", (cx) => { this.dialog = null; this.op("merge", () => runMerge(this.ad, this.t.root, p), cx); },
          { primary: true, disabled: !p || p.blockers.length > 0 || !p.kind })] })];
    }
    if (d.kind === "settings") return [settingsView(t, { g: ggSettings(), icon: ICON("settings"), paneW, genInput: this.genInput,
      upd: this.upd ?? null, onUpdate: (mode, cx) => this.runUpdate(mode, cx),
      set: (k, v, cx) => { setSetting(k, v); cx.notify(); }, done: (cx) => { this.dialog = null; cx.notify(); } })];
    if (d.kind === "stash") {
      const n = (k) => h?.[k] ?? 0, dimC = t.muted ?? alpha(t.foreground, "99");
      const parts = [["staged", n("staged")], ["unstaged", n("unstaged")], ["untracked", n("untracked")]].filter(([, x]) => x).map(([k, x]) => `${x} ${k}`);
      return [modal(t, { icon: ICON("inbox"), color: t.ansi3, title: "Stash changes", paneW,
        subtitle: h_flex().gap(6).text_size(12).text_color(dimC).child(div().flex_none().child("Changes")).child(div().text_color(t.foreground).child(parts.join(" · ") || "none")),
        body: [
          modalField(t, Input.new(this.msgInput), this.focusIn === this.msgInput),
          modalCheck(t, "dlg-u", d.untracked || d.ignored, "Include untracked files", (cx) => { d.untracked = !d.untracked; if (!d.untracked) d.ignored = false; cx.notify(); }),
          modalCheck(t, "dlg-a", d.ignored, "Include ignored files too", (cx) => { d.ignored = !d.ignored; cx.notify(); }),
        ],
        actions: [cancel, modalButton(t, "dlg-ok", "Stash", (cx) => this.runStash(cx), { primary: true })] })];
    }
    if (d.kind === "states") {
      const refuses = this.states.some((s) => s.gitRefuses);
      return [modal(t, { icon: ICON("arrow-down"), color: warn, title: `${this.states.map((s) => s.kind).join(", ")} in progress`, paneW,
        body: this.states.map((s) => div().child(stateText(s))),
        actions: refuses ? [cancel] : [cancel, modalButton(t, "dlg-ok", "Pull anyway", (cx) => this.pull(cx, { ok: false, basis: null }), { primary: true })] })];
    }
    // "pull": the prediction, and which observation it is for
    return [modal(t, { icon: ICON("arrow-down"), color: warn, title: predictionTitle(d.p), paneW,
      subtitle: !predicted(d.p) ? null : `Predicted against your local ${h?.upstream ?? "upstream"} (${this.lastFetch ? `fetched ${hhmm(this.lastFetch)}` : "not fetched"}); the pull's own fetch can change it.`,
      body: [...(d.stale ? [div().text_color(warn).child("HEAD or the upstream changed while you were deciding; predicted again.")] : []), ...predictionLines(d.p, warn),
        disclosure(t, "dlg-more", { open: !!d.open, onToggle: (cx) => { d.open = !d.open; cx.notify(); }, body: codeBlock(t, "dlg-code", predictionCode(d.p)) })],
      actions: [cancel, modalButton(t, "dlg-ok", "Pull anyway", (cx) => this.pull(cx, { ok: true, basis: d.basis }), { primary: true })] })];
  }

  // Context menu labels describe each action, with its git argument alongside. Visual only.
  menuView(which, t, close) {
    return this.menuBox(t, close, MENUS[which].map(([text, arg]) => [text, arg, (cx) => this.pop(cx, [arg])]));
  }
  moreView(t, close, stash) {
    return this.menuBox(t, close, [["Branch", "", (cx) => this.openBranch(cx)], ["Stash", "", (cx) => this.openStash(cx)],
      ["Pop", stash ? "" : "no stash", stash ? (cx) => this.pop(cx, []) : null]]);
  }
  menuBox(t, close, items) {
    const dim = t.muted ?? alpha(t.foreground, "99");
    return v_flex().id("p13-menu").mt(4).min_w(210).p(4).gap(1).rounded(9).bg(t.popover ?? t.raised).border_1().border_color(t.border ?? alpha(t.foreground, "26"))
      .shadow_lg().text_size(12).text_color(t.foreground).on_mouse_down_out(close)
      .children(items.map(([text, arg, fn], i) => h_flex().id("mi-" + i).h(26).px(8).gap(10).items_center().rounded(6)
        .when(!fn, (e) => e.opacity(0.45))
        .when(Boolean(fn), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover ?? t.selected)).on_click((_e, cx) => { close(_e, cx); fn(cx); }))
        .child(div().flex_1().whitespace_nowrap().child(text))
        .child(div().flex_none().text_size(11).text_color(dim).child(arg))));
  }
}
