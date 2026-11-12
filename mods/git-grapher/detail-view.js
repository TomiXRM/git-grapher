import { detailSelectionKey, closesFileMenu, fileMenuContext } from "./lib/view-decisions.js";
// DetailView owns the loaded commit, diff, list mode, folded directories and split position.
// The host keeps one instance and calls render() from its render method.
//
//   this.d = new DetailView(cx, { mode?: "path", file?: "path/opened" })
//   this.d.render(sel, { size, wide?, t, cx })
//     sel = { repo, sha, machine? } | null; size = {width, height}, or null before layout
//     wide forces side-by-side (true) or stacked (false); defaults to isWide(size)
//     file highlights the row whose diff the host displays
//     onFile(f | null, cx) delegates file clicks and Back to the host; without it the diff opens here
//   this.d.fileDiff(path, { t, cx, onBack }) renders a loaded commit's diff wherever the host places it.
import { gitRun } from "./run.js";
import { div, h_flex, image, svg, v_flex, v_virtual_list, list, Textarea } from "./ui/zoom.js";
import { Scrollbar, TextareaState, TextView, Popup } from "gpui-base";
import { exec, settings, panes, focused, hc, run } from "herdr";
import { READ, META_FORMAT, DATE, parseMeta, diffArgs, parseDiffTree, wipLists, untrackedFiles, summary, bar, buildTree, treeRows, isWide, refLabels, forkPoint, EMPTY_TREE } from "./lib/detail.js";
import { avatarFile, initial, tint } from "./avatar.js";

// "Co-authored-by: Name <email>" -> { name, email }; anything else -> null.
const coAuthor = (tr) => { const m = /^co-authored-by$/i.test(tr.key) && /^(.*?)\s*<([^>]+)>\s*$/.exec(tr.value); return m ? { name: m[1] || m[2], email: m[2] } : null; };
import { segmented } from "./ui/segmented.js";
import { parseDiff, patchArgs, splitRows, rowsText } from "./lib/diff.js";
import { colouredDiff } from "./colour.js";
import { diffRow, splitRow, DIFF_ROW_H } from "./ui/diffrow.js";
import { CommitPane } from "./commit-pane.js";
import { previewable, previewSide, previewPage } from "./preview.js";
import { askPicker, sendAsk } from "./ask.js";
import { contextMenu } from "./menu.js";

const CHAR_W = 7.3;
// what counts as generated — lockfiles, minified bundles, source maps. ponytail: by name only;.gitattributes
// linguist-generated when a repo marks its own.
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|Podfile\.lock|pubspec\.lock|flake\.lock)$|\.min\.(js|css)$|\.map$/;
const generated = (p) => GENERATED.test(p);
 // ponytail: Menlo-ish advance at 12px, for the scroll width; measure if a font overflows

const LABEL_GLASS = "40"; // as ggx-graph
const alpha = (c, a) => (c && c.length === 7 ? c + a : c);
// Row look + icons from herdr's shipped Files mod, referenced in place (real files under the app home,
// so they load; our own symlinked folder would not). ponytail: breaks if herdr renames them; copy into data/ then.
const ICON = (n) => svg(`mods/files/${n}.svg`);
const ROW = (id, depth, t) => h_flex().id(id).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7)
  .hover((s) => s.bg(t.hover ?? alpha(t.foreground, "10")));
// Info / Files share: wide defaults to 1:1, tall to 4:6. Dragging stores a separate ratio per orientation.
const SPLIT = { wide: 0.5, tall: 0.4 }, SPLIT_MIN = 0.15, SPLIT_MAX = 0.85, DIV = 5;
function load(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

// Loading skeleton follows the info block and file list shapes.
// ponytail: static bars, no shimmer; add a pulse if slow loads look frozen.
const SKELETON_MS = 200;
// email -> picture file | null (no picture: the initial on its tint). Per process, shared by every DetailView.
const faces = new Map();
const skBar = (fg, w, h = 10) => div().h(h).w(w).flex_none().rounded(4).bg(alpha(fg, "26")); // 15%: at 8% it read as black on a dark theme
const skeletonInfo = (fg) => v_flex().gap(10).p(10)
  .child(skBar(fg, "70%", 14))
  .child(h_flex().gap(6).items_center().child(div().size(18).flex_none().rounded_full().bg(alpha(fg, "26"))).child(skBar(fg, 90)).child(div().flex_1()).child(skBar(fg, 120)))
  .child(skBar(fg, 64, 18))
  .child(v_flex().gap(6).pt(4).child(skBar(fg, "92%")).child(skBar(fg, "80%")).child(skBar(fg, "55%")));
// Diff loading skeleton: file header followed by numbered code lines.
export const skeletonDiff = (fg) => v_flex().gap(9).p(10)
  .child(h_flex().gap(8).items_center().pb(4).child(skBar(fg, 120, 12)).child(div().flex_1()).child(skBar(fg, 28, 12)).child(skBar(fg, 120, 18)))
  .children([0.42, 0.68, 0.55, 0.3, 0.74, 0.6, 0.36, 0.5].map((f) => h_flex().gap(10).items_center().child(skBar(fg, 22)).child(skBar(fg, `${f * 100}%`))));
const skeletonFiles = (fg) => v_flex().gap(12).p(10)
  .child(skBar(fg, 110))
  .children([0.62, 0.45, 0.7, 0.38].map((f) => h_flex().gap(8).items_center().child(skBar(fg, 12)).child(skBar(fg, `${f * 100}%`)).child(div().flex_1()).child(skBar(fg, 36))));

// Pages 2.. of a multi-page PDF, one helper call each, in order; every arrival redraws. alive() = this diff is still shown.
const PAGES_MAX = 30; // ponytail: a cap so a 500-page PDF does not run 500 converts; page on demand if long PDFs matter
async function morePages(d, cx, alive) {
  for (const p of [d.preview?.before, d.preview?.after]) {
    if (!p?.raw || !(p.pages > 1)) continue;
    p.list = [p];
    for (let n = 2; n <= Math.min(p.pages, PAGES_MAX) && alive(); n++) { p.list.push(await previewPage(p.raw, n)); cx.notify(); }
  }
}

// TextView renders selectable commit messages as Markdown because its HTML mode drops <br> and <b>.
// Escape punctuation, use trailing backslashes for hard breaks, &nbsp; for indentation, and paragraphs for blank lines.
// Keep URLs as literal <autolinks>: escaping exposes backslashes, while bare links can absorb trailing punctuation.
// Click a URL to open it; its copy icon briefly becomes a check after copying.
let copiedUrl = null;
const esc = (x) => x.replace(/[\\`*_{}\[\]()#+\-.!|<>~&]/g, "\\$&");
const md = (x) => x.split(/(https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?])/).map((p, i) => (i % 2 ? `<${p}> [${copiedUrl === p ? "✓" : "⧉"}](ggit-copy:${encodeURIComponent(p)})` : esc(p))).join(""); // <url>: the link ends where the URL does
const mdLines = (lines) => lines.join("\n").split(/\n\s*\n/).map((para) => para.split("\n")
  .map((l) => l.replace(/^( +)(.*)$/, (_m, sp, rest) => "&nbsp;".repeat(sp.length) + md(rest)).replace(/^(?!&nbsp;)(.*)$/, (_m, x) => md(x)))
  .join("\\\n")).join("\n\n");
const selectable = (id, subject, lines, color) => {
  const text = [subject != null ? `**${md(subject)}**` : null, lines.some((l) => l.trim()) ? mdLines(lines) : null].filter(Boolean).join("\n\n");
  // Set TextView's colour explicitly: it does not inherit one, and its light-grey default disappears on light themes.
  return div().w_full().min_w(0).child(TextView.markdown(id, text).selectable(true).text_color(color)
    .on_link_click((u, cx) => {
      if (!u.startsWith("ggit-copy:")) return cx.open_url(u);
      const url = decodeURIComponent(u.slice(10)); cx.write_to_clipboard(url); copiedUrl = url; cx.notify();
      cx.spawn(async (cx) => { await cx.sleep(1200); if (copiedUrl === url) { copiedUrl = null; cx.notify(); } });
    }));
};

export class DetailView {
  constructor(cx, opt = {}) {
    this.opt = opt; this.key = undefined; this.diff = null; this.handle = cx.focus_handle(); this.c = null; this.error = null; this.drag = null;
    this.split = { wide: load("split-wide", SPLIT.wide), tall: load("split-tall", SPLIT.tall) };
    this.mode = opt.mode === "path" ? "path" : "tree"; // opt.mode: screenshots of the Path view
    this.closed = new Set(); this.size = null;
    this.cp = new CommitPane(); // the WIP row's commit pane (commit.js); its fields survive row changes
    this.diffWrap = opt.diffWrap ?? load("diff-wrap", false); // long lines wrap instead of scrolling sideways (kept)
    this.diffMode = opt.diffMode ?? load("diff-mode", "unified"); // "unified" | "split" (the choice is kept; opt: screenshots)
    // Pictures: "split" (Before | After) or "swap" (one at a time, flipped with Before / After, same place and scale).
    this.picMode = load("pic-mode", "split"); this.picSide = "After";
    this.ask = null; // { key, target: agent address | "new", sent? } while the Ask box is open
    this.askBox = TextareaState.new({ placeholder: "Ask the AI about this…", rows: 3 });
  }

  // Reload the current WIP without a skeleton after a pane write or WIP scan change.
  // Apply a read only if no newer read has landed and no pending pane write could make it predate the optimistic lists.
  async reload(cx) {
    const key = this.key, sel = this.sel, n = (this.reloadN = (this.reloadN ?? 0) + 1), w = this.cp.written ?? 0;
    if (!sel || !this.c?.wip) return;
    const c = await this.load(sel).catch(() => null);
    if (!c || this.key !== key) return;
    if (n <= (this.landedN ?? 0) || w !== (this.cp.clicks ?? 0)) return;
    this.landedN = n;
    const was = this.cp.snapshot(); // the commit pane's rows before, so they can move to where they are now
    this.c = c; this.cp.ctx = { ...this.cp.ctx, c }; this.cp.splice(was, cx); cx.notify();
  }

  // Reload when the selection changes (render runs on every shared-state change).
  sync(sel, cx) {
    const key = detailSelectionKey(sel);
    if (!closesFileMenu(this.key, sel)) return;
    this.cp.ask = null; this.fmenu = null; // Discard confirmations and file menus belong to the selection that opened them.
    // Keep the previous commit visible but untouchable while loading; show the skeleton only after SKELETON_MS.
    // With no previous commit, show the skeleton immediately.
    this.stale = this.c && !this.error ? this.c : null;
    this.key = key; this.sel = sel; this.c = null; this.error = null; this.diff = null; this.closed = new Set();
    if (!sel) { this.stale = null; return; }
    cx.spawn(async (cx) => { await cx.sleep(SKELETON_MS); if (this.key === key && !this.c) { this.stale = null; cx.notify(); } });
    cx.spawn(async (cx) => {
      try {
        if (this.opt.slow) await cx.sleep(this.opt.slow); // opt.slow: a slow load on purpose (screenshots of the skeleton)
        const w0 = this.cp.written ?? 0, k0 = this.cp.clicks ?? 0; // pane writes unfinished or ending during this load
        const c = await this.load(sel);
        if (this.key !== key) return;
        this.c = c; this.stale = null;
        // If a pane write overlapped the first load, read again: the write's own reload may have found no loaded WIP.
        // The reload guard determines whether the replacement can be applied.
        if (c.wip && (w0 !== k0 || (this.cp.written ?? 0) !== w0)) cx.spawn(async (cx) => this.reload(cx));
        // opt.autoStage: stage that path once on the first WIP load (measuring a write without synthetic input).
        if (c.wip && this.opt.autoStage && !this.autoStaged) { this.autoStaged = true; cx.spawn(async (cx) => { await cx.sleep(800); await this.cp.op("stage", (g, t) => g.stage(t, [this.opt.autoStage]), cx); }); }
        const f = this.opt.file && c.files.find((x) => x.path === this.opt.file); // screenshots open a diff directly
        if (f) this.diff = { file: f, ...(await this.patch(c, f).catch((e) => ({ note: String(e?.message ?? e) }))) };
      }
      catch (e) { if (this.key === key) this.error = String(e?.message ?? e); }
      cx.notify();
      if (this.key !== key || !this.c || this.c.wip || (this.c.cmp && !this.c.commits)) return;
      // Faces: the author, then co-authors, one by one. Known ones come from `faces` at once.
      // A branch review: every author of its commits.
      const emails = this.c.commits ? [...new Set(this.c.commits.map((k) => k.email))]
        : [this.c.email, ...this.c.trailers.map(coAuthor).filter(Boolean).map((m) => m.email)];
      for (const e of emails) {
        if (faces.has(e)) continue;
        faces.set(e, await avatarFile(e).catch(() => null));
        if (this.key === key) cx.notify();
      }
    });
  }

  async load({ repo, sha, machine }) {
    if (sha.startsWith("wip:")) return this.loadWip(sha.slice(4), machine);
    if (sha.startsWith("cmp:")) return this.loadCompare(repo, sha.slice(4), machine);
    if (sha.startsWith("br:")) return this.loadBranch(repo, sha.slice(3), machine);
    const opt = { cwd: repo, on: machine ?? undefined };
    const git = async (args) => {
      const r = await gitRun("git", [...READ, ...args], opt);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
      return r.stdout;
    };
    try { await git(["rev-parse", "--show-toplevel"]); }
    catch { throw new Error(`Not a git repository: ${repo}`); }
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error(`Not a commit id: ${sha}`);
    try { await git(["rev-parse", "--verify", "--quiet", sha + "^{commit}"]); }
    catch { throw new Error(`Commit ${sha.slice(0, 8)} is not in ${repo}`); }
    const c = parseMeta(await git(["log", "-1", "--no-walk", META_FORMAT, DATE, sha]));
    c.git = git;
    const [diff, refs, wt, head] = await Promise.all([
      git(diffArgs(c.sha, c.parents)),
      git(["for-each-ref", "--points-at", c.sha, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]),
      git(["worktree", "list", "--porcelain"]).catch(() => ""),
      git(["symbolic-ref", "-q", "HEAD"]).catch(() => ""),
    ]);
    const trees = new Set(wt.split("\n").filter((l) => l.startsWith("branch ")).map((l) => l.slice(7)));
    c.files = parseDiffTree(diff);
    c.tree = buildTree(c.files);
    c.refs = refLabels(refs, trees, (n) => head.trim() === "refs/heads/" + n);
    return c;
  }

  // WIP rows ("wip:<worktree path>") show changes against the worktree's HEAD, marking untracked files as added ("A").
  async loadWip(path, machine) {
    const opt = { cwd: path, on: machine ?? undefined };
    const run = (args) => gitRun("git", [...READ, ...args], opt);
    const git = async (args, ok = [0]) => {
      const r = await run(args);
      if (!ok.includes(r.code)) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
      return r.stdout;
    };
    // Before the first commit, compare against the empty tree instead of HEAD.
    const base = (await run(["rev-parse", "-q", "--verify", "HEAD"])).code === 0 ? "HEAD" : EMPTY_TREE;
    const [diff, others, branch, cached, worktree] = await Promise.all([
      // Use diff HEAD: diff-index trusts cached stat data and can report identical, merely touched files as modified.
      // diff rechecks content without writing the index.
      git(["diff", "--no-color", "--no-ext-diff", "-r", "-z", "-M", "--raw", "--numstat", base]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
      git(["symbolic-ref", "-q", "--short", "HEAD"], [0, 1]),
      // The commit pane's two lists: HEAD → index (staged) and index → worktree (unstaged; untracked files join it).
      git(["diff", "--cached", "--no-color", "--no-ext-diff", "-r", "-z", "-M", "--raw", "--numstat"]),
      git(["diff", "--no-color", "--no-ext-diff", "-r", "-z", "--raw", "--numstat"]),
    ]);
    const untracked = await untrackedFiles(run, others);
    const files = [...parseDiffTree(diff), ...untracked];
    return { wip: true, base, path, machine, ...wipLists(cached, worktree, untracked), branch: branch.trim() || null, sha: "", parents: [], subject: "Uncommitted changes", name: "", email: null, date: "",
      body: [], trailers: [], refs: [], files, tree: buildTree(files), git };
  }

  // Show tree comparisons like commits: "cmp:<sha>" compares that commit to HEAD;
  // "br:<tip>:<branch>" compares the branch's fork point to its tip, as a pull request would.
  gitAt(repo, machine) {
    const opt = { cwd: repo, on: machine ?? undefined };
    return async (args, ok = [0]) => {
      const r = await gitRun("git", [...READ, ...args], opt);
      if (!ok.includes(r.code)) throw new Error(r.stderr.trim() || `git ${args[0]} failed`);
      return r.stdout;
    };
  }
  async loadCompare(repo, sha, machine) {
    if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error(`Not a commit id: ${sha}`);
    const git = this.gitAt(repo, machine);
    // HEAD is read once: the file list and every diff opened later compare the same two commits.
    const [subject, head] = await Promise.all([git(["log", "-1", "--format=%s", sha]), git(["rev-parse", "--verify", "HEAD"])]);
    return this.treeDiff(git, { base: sha, head: head.trim(), headLabel: "HEAD", subject: "Compare with HEAD", from: subject.trim() });
  }
  async loadBranch(repo, rest, machine) {
    const i = rest.indexOf(":"), tip = rest.slice(0, i), name = rest.slice(i + 1);
    if (!/^[0-9a-f]{4,40}$/i.test(tip) || !name || name.startsWith("-")) throw new Error(`Not a branch: ${rest}`);
    const git = this.gitAt(repo, machine), fp = await forkPoint(git, tip, name);
    if (!fp) return this.treeDiff(git, { base: tip, head: tip, subject: `${name} since it branched`, from: "No commits of its own: every commit is on another branch too" });
    const from = fp.base === EMPTY_TREE ? "its first commit" : (await git(["log", "-1", "--format=%s", fp.base])).trim();
    // Every commit of its own, newest first, with its whole message.
    const commits = (await git(["log", DATE, "--format=%H%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1e", tip, ...fp.not])).split("\x1e").map((x) => x.trim()).filter(Boolean)
      .map((x) => { const [sha, name, email, date, subject, body = ""] = x.split("\x1f"); return { sha, name, email, date, subject, body: body.trim() }; });
    const r = await this.treeDiff(git, { base: fp.base, head: tip, headLabel: name, subject: `${name} since it branched`, from: `${commits.length} commit${commits.length === 1 ? "" : "s"} · from ${from}` });
    return { ...r, branch: name, commits };
  }
  async treeDiff(git, { base, head, headLabel = head, subject, from }) {
    const files = parseDiffTree(await git(["diff", "--raw", "--numstat", "-z", "-M", base, head]));
    return { cmp: true, base, head, headLabel, sha: "", parents: [], subject, from, name: "", email: null, date: "",
      body: [], trailers: [], refs: [], files, tree: buildTree(files), git };
  }

  // The helper colours the diff (≈0.5 s for a 20k-line file: it highlights from the top for context); plain git diff
  // takes ~10 ms. fill() shows the plain rows first and swaps in the coloured ones when they arrive.
  helped(c, f) { return !previewable(f.path) && !f.binary && !this.sel?.machine && !(c.wip && f.untracked); }
  async fill(c, f, d, cx, alive) {
    const err = (e) => ({ note: String(e?.message ?? e) });
    let done = false;
    const full = this.patch(c, f).catch(err).finally(() => { done = true; });
    if (this.helped(c, f)) {
      const p = await this.patch(c, f, true).catch(() => null);
      if (p && !done && alive()) { Object.assign(d, p); cx.notify(); }
    }
    const r = await full;
    for (const k of ["rows", "cols", "note"]) delete d[k];
    Object.assign(d, r);
    if (alive()) { cx.notify(); await morePages(d, cx, alive); }
  }

  async patch(c, f, plain = false) {
    // Pictures (and PDF / heic through the helper): before | after instead of a text diff, even when git calls the file text.
    if (previewable(f.path)) {
      const sel = this.sel ?? {}, cwd = c.wip ? c.path : sel.repo, on = sel.machine ?? null, gone = f.status === "D", added = f.status === "A" || f.untracked;
      const before = added ? null : c.wip ? { rev: "HEAD", path: f.old ?? f.path } : c.cmp ? { rev: c.base, path: f.old ?? f.path } : { rev: c.parents[0], path: f.old ?? f.path };
      const after = gone ? null : c.wip ? { work: f.path } : c.cmp ? { rev: c.head, path: f.path } : { rev: c.sha, path: f.path };
      const [b, a] = await Promise.all([before && previewSide(before, { cwd, on }), after && previewSide(after, { cwd, on })]);
      return { preview: { before: b, after: a } };
    }
    if (f.binary) return { note: "Binary file — no text diff" };
    // Coloured by the helper when it can; a plain git diff otherwise (no helper, another machine, untracked).
    const paths = ["--", ...(f.old ? [f.old, f.path] : [f.path])], sel = this.sel ?? {};
    const range = c.cmp ? [c.base, c.head] : c.wip ? (f.untracked ? null : [c.base ?? "HEAD"]) : [c.parents[0] ?? EMPTY_TREE, c.sha];
    if (range && !sel.machine && !plain) { const d = await colouredDiff(c.wip ? c.path : sel.repo, [...range, ...paths]); if (d) return d; }
    if (c.cmp) return parseDiff(await c.git(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", c.base, c.head, "--", ...(f.old ? [f.old, f.path] : [f.path])]));
    if (c.wip) { // exit 1 = "there are differences" for --no-index
      const args = f.untracked ? ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", f.path]
        : ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", c.base ?? "HEAD", "--", ...(f.old ? [f.old, f.path] : [f.path])];
      return parseDiff(await c.git(args, [0, 1]));
    }
    return parseDiff(await c.git(patchArgs(c.sha, c.parents, f)));
  }

  // Opening a diff preserves list mode and folded directories. When the host draws the diff elsewhere,
  // keep separate diff state so the file list remains unchanged.
  fileDiff(path, { t, cx, onBack }) {
    const c = this.c, dim = t.muted ?? alpha(t.foreground, "99"), mono = settings().font_family ?? "Menlo";
    const f = c?.files.find((x) => x.path === path);
    if (!f) return this.diffView({ file: { path, status: "" }, ...(c ? { note: `Not changed in ${c.sha.slice(0, 8)}` } : {}) }, t, dim, mono, onBack);
    if (this.ext?.file !== f) { // f is per loaded commit, so a new commit reloads too
      const d = (this.ext = { file: f });
      cx.spawn(async (cx) => this.fill(c, f, d, cx, () => this.ext === d));
    }
    return this.diffView(this.ext, t, dim, mono, onBack);
  }

  // Cmd+C copies selected diff rows without +/- prefixes. Return true when copied so the caller consumes the key.
  copyPicked(cx) {
    const d = this.diffRows, p = d?.pick;
    if (!p || (d !== this.diff && d !== this.ext)) return false;
    const text = rowsText(p.rows, p.a, p.b);
    if (!text) return false;
    cx.write_to_clipboard(text); d.copied = Math.abs(p.b - p.a) + 1; cx.notify();
    cx.spawn(async (cx) => { await cx.sleep(1200); d.copied = 0; cx.notify(); });
    return true;
  }

  openDiff(f, cx) {
    const c = this.c, d = { file: f };
    this.diff = d; this.handle.focus(); cx.notify();
    cx.spawn(async (cx) => this.fill(c, f, d, cx, () => this.diff === d));
  }

  diffView(d, t, dim, mono, back = (cx) => { this.diff = null; cx.notify(); }) { // back null: no Back button
    const f = d.file, sc = { A: t.ansi2, D: t.ansi1, R: t.ansi4, C: t.ansi4 }[f.status] ?? t.ansi3;
    const both = Boolean(d.preview?.before && d.preview?.after), swap = both && this.picMode === "swap";
    const head = h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(alpha(t.foreground, "1f")).text_size(13)
      // No Back when the host has its own (File History's header): back = null.
      .children(back ? [div().id("diff-back").h(22).px(8).flex_none().flex().items_center().rounded(5).cursor_pointer().text_size(12)
        .bg(t.raised).border_1().border_color(t.input ?? t.border).hover((h) => h.bg(t.hover ?? t.raised))
        .on_click((_e, cx) => back(cx)).child("← Back")] : [])
      .child(div().flex_1().min_w(0).whitespace_nowrap().overflow_hidden().text_ellipsis_start().child(f.old ? `${f.old} → ${f.path}` : f.path))
      .child(div().w(14).flex_none().text_color(sc).font_semibold().text_center().child(f.status))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(12).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(12).text_color(t.ansi1).child(`−${f.del}`)))
      .when(Boolean(d.copied), (e) => e.child(div().flex_none().text_size(12).text_color(dim).child(`Copied ${d.copied} line${d.copied === 1 ? "" : "s"}`)))
      // Wrap uses a checkmark to show its state. Reserve the check's width so the label does not jump.
      .when(Boolean(d.rows), (e) => e.child(h_flex().id("diff-wrap").h(22).pl(6).pr(9).gap(4).flex_none().items_center().rounded(5).cursor_pointer().text_size(12)
        .border_1().border_color(this.diffWrap ? t.accent ?? t.foreground : t.input ?? t.border)
        .bg(this.diffWrap ? alpha(t.accent ?? t.foreground, "26") : t.raised).hover((h) => h.bg(t.hover ?? t.raised))
        .on_click((_e, cx) => { this.diffWrap = !this.diffWrap; save("diff-wrap", this.diffWrap); cx.notify(); })
        .child(this.diffWrap ? svg("mods/git-grapher/icons/check.svg").size(12).flex_none().text_color(t.accent ?? t.foreground) : div().w(12).flex_none())
        .child("Wrap")))
      .when(Boolean(d.rows), (e) => e.child(segmented({ id: "diff-mode", t, w: 64, value: this.diffMode,
        options: [{ value: "unified", label: "Unified" }, { value: "split", label: "Split" }],
        onChange: (v, cx) => { this.diffMode = v; save("diff-mode", v); cx.notify(); } })))
      .when(both, (e) => e.child(segmented({ id: "pic-mode", t, w: 56, value: this.picMode,
        options: [{ value: "split", label: "Split" }, { value: "swap", label: "Swap" }],
        onChange: (v, cx) => { this.picMode = v; save("pic-mode", v); cx.notify(); } })))
      .when(swap, (e) => e.child(segmented({ id: "pic-side", t, w: 56, value: this.picSide,
        options: [{ value: "Before", label: "Before" }, { value: "After", label: "After" }],
        onChange: (v, cx) => { this.picSide = v; cx.notify(); } })))
      .when(!swap && d.preview?.before?.pages > 1 && d.preview?.after?.pages > 1, (e) => e.child(div().id("sync-scroll").h(22).px(8).flex_none().flex().items_center()
        .rounded(5).cursor_pointer().text_size(12).border_1().border_color(t.input ?? t.border)
        .bg(this.pv?.d === d && !this.pv.sync ? t.raised : alpha(t.accent ?? t.foreground, "33")).hover((h) => h.bg(t.hover ?? t.raised))
        .on_click((_e, cx) => { if (this.pv?.d === d) { this.pv.sync = !this.pv.sync; cx.notify(); } })
        .child(this.pv?.d === d && !this.pv.sync ? "Sync scroll: off" : "Sync scroll: on")));
    const note = (q) => div().text_size(12).text_color(dim).whitespace_normal().child(q ? q.note : "None");
    // A page of known size (PDF, heic, an image file(1) could size): fit to the column's width and scroll when it is taller. Several pages: one under another. The column is ours, not overflow_scroll, so
    // the two sides can scroll together ("Sync scroll", on by default): the wheel moves an offset per side, clamped.
    // Each page's height = the column's width × its ratio (an image keeps no ratio of its own: pages had gaps between).
    const pv = this.pv?.d === d ? this.pv : (this.pv = { d, y: {}, w: {}, h: {}, sync: this.pv?.sync ?? true });
    // A page is the column's width, but never larger than its own pixels (a small icon is not blown up), centred.
    const fw = (q, k) => Math.min(pv.w[k] ?? 0, q.w * (pv.unit ?? 1));
    const GAP = 8, tall = (p, k) => (p.list ?? [p]).reduce((n, q) => n + (q.w ? fw(q, k) * q.h / q.w : 40) + GAP, -GAP);
    const scrollBy = (k, dy) => {
      const all = { Before: d.preview?.before, After: d.preview?.after, Swap: this.picSide === "Before" ? d.preview?.before : d.preview?.after };
      const sides = k === "Swap" || !pv.sync ? [k] : ["Before", "After"];
      for (const s of sides) if (all[s]?.w) pv.y[s] = Math.max(0, Math.min(tall(all[s], s) - (pv.h[s] ?? 0), (pv.y[s] ?? 0) - dy));
    };
    // on_size_change reports zoomed pixels. Measure a 100-unit reference, keep dimensions in measured pixels,
    // and divide by that scale when setting sizes.
    const u = pv.unit ?? 1;
    const pages = (p, k) => div().id("pages-" + k).size_full().relative().overflow_hidden()
      .on_size_change((size, cx) => { if (pv.w[k] !== size.width || pv.h[k] !== size.height) { pv.w[k] = size.width; pv.h[k] = size.height; cx.notify(); } })
      .on_scroll_wheel((e, cx) => { scrollBy(k, e.delta.y); cx.stop_propagation(); cx.notify(); })
      .child(div().id("unit-" + k).absolute().w(100).h(1).invisible()
        .on_size_change((size, cx) => { if (size.width > 0 && pv.unit !== size.width / 100) { pv.unit = size.width / 100; cx.notify(); } }))
      .child(v_flex().absolute().left(0).w_full().items_center().top(-(pv.y[k] ?? 0) / u).gap(GAP / u)
        .children(pv.w[k] ? (p.list ?? [p]).map((q) => (q.file && q.w ? image(q.file).w(fw(q, k) / u).h(fw(q, k) * q.h / q.w / u).flex_none() : note(q))) : []));
    const pic = (label, p, k = label) => v_flex().flex_1().min_w(0).h_full().gap(6).p(10)
      .child(div().flex_none().text_size(12).text_color(dim).child(label + (p?.pages > 1 ? ` · ${p.pages} pages${p.pages > PAGES_MAX ? `, the first ${PAGES_MAX} shown` : ""}` : "")))
      .child(div().flex_1().min_h(0).rounded(6).border_1().border_color(alpha(t.foreground, "1f")).p(8)
        .child(p?.w ? pages(p, k) : p?.file ? image(p.file).size_full() : note(p)));
    const body = d.preview
      // An added file has no Before and a deleted one no After: only the side that exists, full width.
      // Swap: one side in the "Swap" column, so both sides share its width and scroll offset and a point stays put.
      ? h_flex().flex_1().min_h(0).children(swap ? [pic(this.picSide, d.preview[this.picSide === "Before" ? "before" : "after"], "Swap")]
        : [["Before", d.preview.before], ["After", d.preview.after]].filter(([, p]) => p).map(([k, p]) => pic(k, p)))
      : !d.rows
      ? (d.note ? div().p(12).text_size(12).text_color(dim).whitespace_normal().child(d.note) : skeletonDiff(t.foreground))
      : (() => {
        const last = d.rows.reduce((n, r) => Math.max(n, r.old ?? 0, r.new ?? 0), 0);
        const numW = String(last).length * CHAR_W + 10, width = Math.ceil(2 * numW + 14 + 12 + 16 + d.cols * CHAR_W);
        const id = "diff:" + f.path; // Keep scroll offsets per file so newly opened files start at the top-left.
        // Wrap uses variable-height list rows; otherwise scroll long lines horizontally, synchronizing both split-view halves.
        const wrap = this.diffWrap, split = this.diffMode === "split", rows = split ? (d.split ??= splitRows(d.rows)) : d.rows;
        const lid = id + (split ? ":split" : "") + (wrap ? ":wrap" : "");
        // a click picks a row, shift+click extends to it, ⌘C (copyPicked) copies the code. Rows cannot carry handlers in a
        // virtual list, so the list's on_item_click gives the row and the press before it gives shift.
        const pk = d.pick?.split === split ? d.pick : null, lo = pk ? Math.min(pk.a, pk.b) : -1, hi = pk ? Math.max(pk.a, pk.b) : -2;
        const draw = (r, i) => { const picked = i >= lo && i <= hi;
          return split ? splitRow(r, { t, numW, wrap, picked, sx: wrap ? null : d.sx ?? 0 }) : diffRow(r, { t, numW, wrap, picked }); };
        const pick = (key, cx) => {
          const i = Number(key), ext = this.press?.shift && pk;
          d.pick = { split, a: ext ? pk.a : i, b: i, rows }; this.diffRows = d; cx.notify();
        };
        const box = div().flex_1().min_h(0).relative().font_family(mono).text_size(12)
          .on_mouse_down("left", (e, _cx) => { this.press = { shift: Boolean(e.modifiers?.shift) }; });
        if (wrap) return box.child(list(lid, rows.length, (i) => String(i), (i) => draw(rows[i], i)).on_item_click(pick).size_full())
          .child(Scrollbar.vertical(lid).viewport_from_layout().absolute().inset_0());
        if (split) {
          // Split, not wrapped: halved at the middle, each half's code scrolled sideways together (d.sx), as Conflict Mode.
          // ponytail: the limit leaves ~160 px of the longest line, not measured against the half's real width.
          const maxSx = Math.max(0, d.cols * CHAR_W - 160);
          if ((d.sx ?? 0) > maxSx) d.sx = maxSx;
          return box.on_scroll_wheel((e, cx) => {
            const dx = e.delta.x !== 0 ? e.delta.x : e.modifiers?.shift ? e.delta.y : 0;
            if (dx === 0 || Math.abs(dx) < Math.abs(e.delta.y) * (e.modifiers?.shift ? 0 : 1)) return;
            const next = Math.min(maxSx, Math.max(0, (d.sx ?? 0) - dx));
            cx.stop_propagation();
            if (next !== d.sx) { d.sx = next; cx.notify(); }
          }).child(v_virtual_list(lid, rows.length, DIFF_ROW_H, (i) => String(i),
              (range) => rows.slice(range.start, range.end).map((r, k) => draw(r, range.start + k))).on_item_click(pick).size_full())
            .child(Scrollbar.vertical(lid).viewport_from_layout().absolute().inset_0());
        }
        return box.child(div().id(lid + ":x").size_full().overflow_x_scrollbar()
            .child(div().w_full().min_w(width).h_full().child(v_virtual_list(lid, rows.length, DIFF_ROW_H, (i) => String(i),
              (range) => rows.slice(range.start, range.end).map((r, k) => draw(r, range.start + k))).on_item_click(pick).size_full())))
          .child(Scrollbar.vertical(lid).viewport_from_layout().absolute().inset_0());
      })();
    return v_flex().size_full().min_h(0).child(head).child(body);
  }

  label(r, t) {
    const mark = (r.head ? "✓ " : "") + (r.kind === "local" ? "💻 " : "") + (r.tree ? "🌲 " : "") + (r.kind === "tag" ? "🏷 " : r.kind === "remote" || r.remote ? "☁ " : "");
    // Use the graph's translucent label style with the theme accent when the lane colour is unknown.
    return div().flex_shrink_1().min_w(0).max_w(240).h(20).px(6).rounded(4).flex().items_center().text_xs().whitespace_nowrap().overflow_hidden()
      .bg(alpha(t.accent, LABEL_GLASS)).border_1().border_color(t.accent).text_color(t.foreground)
      .when(r.name.length > 20, (e) => e.tooltip(r.name)) // past 20 characters the name is cut, the tooltip has it whole
      .child(div().truncate().child(mark + (r.name.length > 20 ? r.name.slice(0, 19) + "…" : r.name)));
  }

  // Send a question about the commit, comparison or branch to an existing agent via hc send, or a new Claude pane below.
  // Include the repository and commits; the agent reads their diff with git.
  // ponytail: new panes always run "claude"; add a setting or knownAgents() support for other agents.
  askText(c, q) {
    const repo = this.sel?.repo ?? "";
    const what = c.commits ? `the branch ${c.branch} since it branched (git diff ${c.base.slice(0, 12)}..${c.head.slice(0, 12)}; its commits: ${c.commits.map((k) => k.sha.slice(0, 12)).join(" ")})`
      : c.cmp ? `the changes from ${c.base.slice(0, 12)} to ${c.headLabel} (git diff ${c.base.slice(0, 12)} ${c.head})`
      : `commit ${c.sha.slice(0, 12)} "${c.subject}"`;
    return `In the git repo ${repo}, about ${what}:\n\n${q}`;
  }
  askBar(c, t, dim, head = {}) {
    if (c.wip) return div();
    const key = this.key, open = this.ask?.key === key, line = alpha(t.foreground, "1f");
    const btn = h_flex().id("ask").h(22).px(7).gap(5).items_center().rounded(5).cursor_pointer().text_size(12).text_color(open ? t.foreground : dim)
      .border_1().border_color(open ? t.accent ?? line : line).hover((h) => h.bg(t.hover ?? t.raised))
      .on_click((_e, cx) => { this.ask = open ? null : { key, target: this.ask?.target ?? "new" }; cx.notify(); if (!open) this.askBox.focus(); })
      .child(svg("mods/git-grapher/icons/message-circle-question.svg").size(14).text_color(open ? t.foreground : dim)).child("Ask");
    const bar = this.head(t, dim, head.title, [btn, head.actions]);
    if (!open) return bar;
    const picker = askPicker(t, this.ask, "ask"); // ask.js: a new pane, or an agent pane already open
    const send = div().id("ask-send").h(24).px(12).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(t.accent ?? t.foreground).text_color(t.background).on_click((_e, cx) => this.sendAsk(c, cx)).child("Send");
    return v_flex().child(bar).child(v_flex().mx(10).mt(6).p(8).gap(6).rounded(7).border_1().border_color(line)
      .child(Textarea.new(this.askBox).w_full().px(8).py(6).rounded(6).border_1().border_color(alpha(t.foreground, "33")).bg(t.background).text_size(13))
      // Send sits beside the pull-down; the last send's result beside "Send to".
      .child(h_flex().gap(8).items_center().text_size(11).text_color(dim).child(div().flex_none().child("Send to"))
        .child(div().flex_1().min_w(0).truncate().text_right().child(this.ask.sent ?? "")))
      .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).child(picker)).child(send)));
  }
  sendAsk(c, cx) {
    const q = this.askBox.value().trim(), a = this.ask;
    if (!q || !a) return;
    const msg = this.askText(c, q);
    cx.spawn(async (cx) => {
      const r = await sendAsk(a.target, this.sel?.repo, msg); // ponytail: another machine's repo still opens locally
      if (a.target === "new") { this.askBox.set_value(""); if (this.ask === a) this.ask = null; cx.notify(); return; }
      if (this.ask !== a) return;
      if (r.ok) this.askBox.set_value("");
      a.sent = r.text; cx.notify();
    });
  }

  // A hash chip: a click copies the full SHA, "Copied" for a moment.
  shaChip(sha, n, t, mono, cx0) {
    const done = this.copied?.chip === sha;
    return div().id("sha-" + sha).flex_none().px(5).rounded(4).cursor_pointer().bg(alpha(t.foreground, "14")).hover((h) => h.bg(alpha(t.foreground, "26")))
      .tooltip(sha) // the full SHA on hover
      .text_size(11).font_family(mono).text_color(t.foreground)
      .on_click((_e, cx) => {
        cx.write_to_clipboard(sha); const k = this.copied = { chip: sha }; cx.notify();
        cx.spawn(async (cx) => { await cx.sleep(1200); if (this.copied === k) { this.copied = null; cx.notify(); } });
      })
      .child(done ? "Copied" : sha.slice(0, n));
  }

  // Show a grey placeholder before avatar lookup completes to avoid flashing the tinted initial before the image.
  face(name, email, t) {
    const file = faces.get(email);
    return file ? image(file).size(18).rounded_full().flex_none()
      : file === undefined ? div().size(18).flex_none().rounded_full().bg(alpha(t.foreground, "26"))
      : div().size(18).flex_none().rounded_full().bg(tint(email)).flex().items_center().justify_center().text_xs().text_color("#ffffff").child(initial(name, email));
  }

  info(c, t, dim, mono) {
    if (c.cmp) return v_flex().gap(6).p(10).text_size(13)
      .child(div().text_size(14).font_semibold().child(c.subject))
      .child(h_flex().gap(6).items_center().text_size(12).text_color(dim)
        .child(c.base === EMPTY_TREE ? div().flex_none().child("empty") : this.shaChip(c.base, 7, t, mono))
        .child(div().flex_none().child("→ " + c.headLabel)).child(div().min_w(0).truncate().child(c.from)))
      .children((c.commits ?? []).map((k) => v_flex().gap(4).pt(8).mt(2).border_t(1).border_color(alpha(t.foreground, "14"))
        .child(h_flex().gap(6).items_center().text_size(12).text_color(dim)
          .child(this.face(k.name, k.email, t)).child(div().min_w(0).truncate().text_color(t.foreground).child(k.name))
          .child(div().flex_1()).child(div().flex_none().child(k.date))
          .child(this.shaChip(k.sha, 7, t, mono)))
        .child(selectable("msg-" + k.sha, k.subject, k.body.split("\n"), t.foreground))));
    if (c.wip) return v_flex().gap(6).p(10).text_size(13)
      .child(div().text_size(14).font_semibold().child(c.subject))
      .child(div().text_size(12).text_color(dim).child(c.branch ?? "detached HEAD"))
      .child(div().text_size(12).text_color(dim).font_family(mono).whitespace_normal().child(c.path));
    const face = (name, email) => this.face(name, email, t);
    const av = face(c.name, c.email);
    const btn = (id, text, solid) => div().id(id).h(22).px(9).rounded(5).flex().items_center().text_size(12).cursor_pointer()
      .when(solid, (e) => e.bg(t.accent).text_color(t.accent_foreground ?? "#ffffff"))
      .when(!solid, (e) => e.bg(t.raised).border_1().border_color(t.input ?? t.border))
      .child(text);
    const parents = c.parents.length > 1 ? `Merge · diff vs 1st parent ${c.parents[0].slice(0, 8)}` : c.parents.length === 0 ? "Root commit" : null;
    return v_flex().gap(6).p(10).text_size(13)
      .child(div().text_size(14).font_semibold().whitespace_normal().child(c.subject))
      .child(h_flex().gap(6).items_center().mt(2).text_size(12)
        // Hover shows the email; a click copies the name, and the name reads "Copied" for a moment.
        // ponytail: inline "Copied" instead of the graph's card, so a detached detail (no snackbar) shows it the same way.
        .child(av).child(div().flex_1().min_w(48).flex().child(div().id("author").min_w(0).truncate().cursor_pointer().hover((x) => x.underline())
          .when(Boolean(c.email), (e) => e.tooltip(c.email))
          .on_click((_e, cx) => {
            cx.write_to_clipboard(c.name); const k = this.copied = { sha: c.sha }; cx.notify();
            cx.spawn(async (cx) => { await cx.sleep(1200); if (this.copied === k) { this.copied = null; cx.notify(); } });
          })
          .child(this.copied?.sha === c.sha ? "Copied" : c.name)))
        .child(div().flex_none().text_color(dim).child(c.date))
        .child(this.shaChip(c.sha, 8, t, mono)))
      .when(c.refs.length > 0, (e) => e.child(h_flex().flex_wrap().gap(4).children(c.refs.map((r) => this.label(r, t)))))
      // Show Branch only when the host can open its creation dialog.
      .when(Boolean(this.onBranch), (e) => e.child(h_flex().gap(6).child(btn("branch", "+ Branch here", true).cursor_pointer()
        .on_click((_e, cx) => this.onBranch({ sha: c.sha, subject: c.subject }, cx)))))
      .when(Boolean(parents), (e) => e.child(div().text_xs().text_color(dim).child(parents)))
      .when(c.body.length > 0, (e) => e.child(selectable("body-" + c.sha, null, c.body, t.foreground)))

      .when(c.trailers.length > 0, (e) => e.child(v_flex().gap(4)
        .child(div().text_size(12).text_color(dim).child("Trailers"))
        .children(c.trailers.map((tr) => h_flex().gap(10).items_start().text_size(12)
          .child(div().min_w(80).max_w(160).flex_none().text_color(dim).child(tr.key))
          .child(((m) => m
            ? h_flex().flex_1().min_w(0).gap(6).items_center().child(face(m.name, m.email))
              .child(div().id("co-" + m.email).min_w(0).truncate().tooltip(m.email).child(m.name))
            : /^https?:\/\/\S+$/.test(tr.value) // a URL value opens on a click
              ? h_flex().flex_1().min_w(0).gap(4).items_center()
                .child(div().id("tr-" + tr.key + tr.value).min_w(0).truncate().cursor_pointer().text_color(t.accent ?? t.foreground).hover((x) => x.underline()).on_click((_e, cx) => cx.open_url(tr.value)).child(tr.value))
                // The icon turns into a green check for a moment once copied.
                .child(div().id("tr-copy-" + tr.key + tr.value).flex_none().cursor_pointer()
                  .on_click((_e, cx) => { cx.write_to_clipboard(tr.value); const k = this.copied = { url: tr.value }; cx.notify(); cx.spawn(async (cx) => { await cx.sleep(1200); if (this.copied === k) { this.copied = null; cx.notify(); } }); })
                  .child(this.copied?.url === tr.value ? svg("mods/git-grapher/icons/check.svg").size(12).text_color(t.ansi2 ?? t.accent ?? t.foreground) : svg("mods/git-grapher/icons/copy.svg").size(12).text_color(t.muted ?? t.foreground)))
              : div().flex_1().min_w(0).whitespace_normal().child(tr.value))(coAuthor(tr)))))));
  }

  fileRow(f, depth, name, t, dim, k = "", extra = null) {
    const sc = { A: t.ansi2, D: t.ansi1, R: t.ansi4, C: t.ansi4 }[f.status] ?? t.ansi3;
    const sq = { a: t.ansi2, d: t.ansi1, n: alpha(dim, "55") };
    const dir = name === null ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
    const base = name ?? f.path.slice(dir.length);
    // Place the file status letter in the icon slot and leave the chevron slot empty.
    return ROW("file-" + k + f.path, depth, t).cursor_pointer()
      .when(f.path === this.picked, (e) => e.bg(alpha(t.accent, "59"))) // the file whose diff the graph shows
      .on_mouse_down("right", () => { this.fileCtx = { f, k }; }) // the menu opens at render()'s wrapper
      // the whole path, and the counts in words
      .when(!this.fmenu, (e) => e.tooltip(`${f.old ? `${f.old} → ${f.path}` : f.path}${f.binary ? " · binary" : f.conflict ? "" : ` · ${f.add ?? 0} additions, ${f.del ?? 0} deletions`}`)) // none over an open menu
      .on_click((_e, cx) => { if (!this.onFile) return this.openDiff(f, cx); this.handle.focus(); this.onFile(f, cx); })
      .child(div().w(12).flex_none())
      .child(div().w(14).flex_none().text_color(sc).font_semibold().text_center().child(f.status))
      .child(h_flex().flex_1().min_w(0)
        .when(Boolean(dir), (e) => e.child(div().min_w(0).flex_shrink_1().truncate().text_color(dim).child(dir)))
        .child(div().flex_shrink_0().max_w_full().truncate().child(base + (f.old && name === null ? `  ← ${f.old}` : ""))))
      .when(f.binary, (e) => e.child(div().text_xs().font_semibold().text_color(dim).child("BIN")))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_color(t.ansi1).child(`-${f.del}`)))
      .child(h_flex().flex_none().gap(1).children(bar(f.add, f.del).map((k) => div().w(3).h(9).rounded(1).bg(sq[k]))))
      .children(extra ? [extra] : []);
  }

  // Files in on-screen order (Path list, or Tree rows with folded folders skipped); `dir` = +1 / -1.
  // Nothing picked yet: ↓ takes the first file, ↑ the last. Stops at the ends (no wrap, as Finder).
  step(dir) {
    const c = this.c;
    const list = this.mode === "path" ? c.files : treeRows(c.tree, this.closed).filter((r) => r.kind === "file").map((r) => r.file);
    if (!list.length) return null;
    const cur = this.picked ?? this.diff?.file?.path; // picked = the path string the host passes
    const i = list.findIndex((f) => f.path === cur);
    if (i < 0) return dir > 0 ? list[0] : list[list.length - 1];
    const j = i + dir;
    return j < 0 || j >= list.length ? null : list[j];
  }

  // A header row: the host's title on the left, then the given items (null skipped) on the right.
  head(t, dim, title, items) {
    return h_flex().px(10).pt(8).gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(12).text_color(dim).child(title ?? ""))
      .children(items.filter(Boolean));
  }
  files(c, t, dim, actions = null) {
    // generated files (lockfiles, minified, source maps) fold under "Generated (N)" at the end.
    const gen = c.files.filter((f) => generated(f.path)), own = gen.length ? c.files.filter((f) => !generated(f.path)) : c.files;
    if (c.ownFor !== c.files) { c.ownFor = c.files; c.ownTree = gen.length ? buildTree(own) : c.tree; }
    const rows = this.mode === "path"
      ? own.map((f) => this.fileRow(f, 0, null, t, dim))
      : treeRows(c.ownTree, this.closed).map((r) => r.kind === "file" ? this.fileRow(r.file, r.depth, r.name, t, dim)
        : ROW("dir-" + r.path, r.depth, t).cursor_pointer()
          .on_click((_e, cx) => { if (r.open) this.closed.add(r.path); else this.closed.delete(r.path); cx.notify(); })
          .child(ICON(r.open ? "chevron-down" : "chevron-right").size(12).flex_none().text_color(t.dim ?? dim))
          .child(ICON("folder").size(14).flex_none().text_color(t.muted ?? dim))
          .child(div().flex_1().min_w(0).truncate().child(r.name)));
    return v_flex().size_full().min_h(0).text_size(13)
      .child(h_flex().px(10).pt(8).pb(4).items_center().gap(4).text_size(12)
        .child(div().flex_1().text_color(dim).child(summary(c.files)))
        .children(actions ? [actions] : [])
        .child(segmented({ id: "mode", t, value: this.mode, options: [{ value: "path", label: "Path" }, { value: "tree", label: "Tree" }],
          onChange: (m, cx) => { this.mode = m; cx.notify(); } })))
      .child(v_flex().id("file-list").flex_1().min_h(0).p(6).overflow_y_scrollbar().children(rows)
        .children(gen.length ? [ROW("gen-fold", 0, t).cursor_pointer().on_click((_e, cx) => { this.genOpen = !this.genOpen; cx.notify(); })
          .child(ICON(this.genOpen ? "chevron-down" : "chevron-right").size(12).flex_none().text_color(dim))
          .child(div().flex_1().min_w(0).text_color(dim).child(`Generated (${gen.length})`)),
          ...(this.genOpen ? gen.map((f) => this.fileRow(f, 1, null, t, dim)) : [])] : []));
  }

  // Open a file's context menu at the pointer position, over the detail view.
  render(sel, o) {
    const body = this.renderBody(sel, o), t = o.t;
    return div().id("detail-wrap").relative().size_full()
      .on_mouse_down("right", (e, cx) => {
        const f = this.fileCtx; this.fileCtx = null; if (!f) return;
        const p = e.local_position ?? e.position; this.fmenu = { ...f, x: p.x, y: p.y }; cx.notify();
        if (!this.os) cx.spawn(async (cx) => { this.os = (await exec("uname", ["-s"]).catch(() => null))?.stdout?.trim() || "Windows"; cx.notify(); });
      })
      .child(body).children(this.fmenu ? [this.fileMenu(t)] : []);
  }
  fileMenu(t) {
    // A WIP's files are in its own worktree (a linked worktree's row opened the main worktree's file).
    const m = this.fmenu, c = this.c, cp = this.cp;
    const { absolutePath: abs, history } = fileMenuContext(c, this.sel, m.f.path);
    const close = (cx) => { this.fmenu = null; cx.notify(); };
    const mac = !this.os || this.os === "Darwin";
    // ponytail: a failed open says nothing (a deleted file, no default app); a note when that confuses.
    const openIt = (args) => () => { exec(mac ? "open" : "xdg-open", args).catch(() => null); };
    const copy = (text) => (cx) => { cx.write_to_clipboard(text); };
    const unstaged = m.k === "u" && cp;
    const sections = [
      { label: "Open", items: [["Open in the default editor", openIt([abs]), { icon: "file-text" }],
        [mac ? "Reveal in Finder" : "Open the folder", openIt(mac ? ["-R", abs] : [abs.slice(0, abs.lastIndexOf("/")) || "/"]), { icon: "folder-open" }]] },
      ...(unstaged ? [{ label: "Changes", items: [["Discard changes…", (cx) => { cp.ask = { files: [m.f] }; cx.notify(); }, { icon: "trash" }]] }] : []),
      ...(this.onHistory ? [{ label: "History", items: [["File History", (cx) => this.onHistory(m.f.path, cx, history), { icon: "git-commit" }]] }] : []),
      { label: "Copy", items: [["Copy path", copy(m.f.path), { icon: "copy" }], ["Copy full path", copy(abs), { icon: "hash" }]] },
    ];
    // File History when the host can show it (the graph; a detached detail has no room). ponytail: a machine of its own
    // (sel.machine) still opens locally.
    return contextMenu(t, { x: m.x, y: m.y, paneW: this.size?.width, paneH: this.size?.height, title: m.f.path.split("/").pop(), sections, onClose: close });
  }

  renderBody(sel, { size, wide: force, t, cx, file = null, onFile = null, onBranch = null, onHistory = null, store = null, title = null, actions = null }) {
    this.onHistory = onHistory; this.headed = false;
    this.sync(sel, cx);
    // The host's WIP scan saw a change (an edit in a terminal): the commit pane's lists follow.
    // The store read again (a write, a watch event, the poll): a WIP view reads its lists again too.
    if (store) this.store = store;
    const gen = this.store?.state.gen ?? 0;
    if (gen !== this.seenGen) { const was = this.seenGen; this.seenGen = gen; if (was != null && this.c?.wip) cx.spawn(async (cx) => this.reload(cx)); }
    this.picked = file; this.onFile = onFile; this.onBranch = onBranch;
    const fg = t.foreground, dim = t.muted ?? alpha(fg, "99");
    const mono = settings().font_family ?? "Menlo";
    const s = (this.size = size), wide = force ?? (s ? isWide(s.width, s.height) : true);
    const root = div().id("detail").size_full().flex().bg(t.background).text_color(fg).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if ((e.keystroke === "up" || e.keystroke === "down") && this.c) { // ↑/↓: move the picked file in list order
          const next = this.step(e.keystroke === "down" ? 1 : -1);
          if (next) { if (this.onFile) this.onFile(next, cx); else this.openDiff(next, cx); }
          // Always swallow: at the list ends the key must not fall through to the graph and change the commit.
          cx.stop_propagation(); cx.notify(); return;
        }
        if (e.keystroke === "cmd-c" && this.copyPicked(cx)) { cx.stop_propagation(); return; }
        if (e.keystroke !== "escape") return;
        if (this.diff) this.diff = null; // diff in this part
        else if (this.picked && this.onFile) this.onFile(null, cx); // Esc = Back for the host's diff
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag || !this.size) return;
        const { wide: w, p0, f0 } = this.drag, len = w ? this.size.width : this.size.height;
        const d = (w ? e.position.x : e.position.y) - p0;
        this.split[w ? "wide" : "tall"] = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, f0 + d / len));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (!this.drag) return; const k = this.drag.wide ? "wide" : "tall"; this.drag = null; save("split-" + k, this.split[k]); cx.notify(); });
    const msg = (text) => root.items_center().justify_center().child(div().p(20).text_color(dim).whitespace_normal().child(text));
    if (this.key === "null") return msg("No commit selected — pick one in the graph.");
    if (this.error) return msg(this.error);
    const c = this.c ?? this.stale, line = alpha(fg, "1f");
    if (this.diff) return root.flex_col().child(this.diffView(this.diff, t, dim, mono));
    if (this.c?.wip) {
      // A row picks the combined file (c.files: HEAD → worktree), so the diff shows staged and unstaged together.
      const pick = (f) => this.c.files.find((x) => x.path === f.path) ?? f;
      const row = (f, depth, name, k, extra) => this.fileRow(pick(f), depth, name, t, dim, k, extra);
      this.cp.ctx = { c: this.c, machine: this.c.machine, store: this.store, reload: (cx) => this.reload(cx) };
      return root.flex_col().child(this.cp.render({ t, dim, wide, row, cx }));
    }
    // Scroll both sections independently so long messages cannot push files out of view.
    // ponytail: use overflow_y_scroll without a visible scrollbar because the scrollbar variant ignores size caps;
    // restore the bar if the host fixes those bounds.
    // The host's title and actions (the drawer's Commit, Detach, ×) sit in these headers: actions beside Path / Tree
    // when the files are on the right, beside Ask when they are below. this.headed tells the host they were placed.
    this.headed = !!(title || actions);
    const topActs = wide ? null : actions, fileActs = wide ? actions : null;
    const info = v_flex().id("info").min_w(0).min_h(0).overflow_y_scroll()
      .children(c ? [this.askBar(c, t, dim, { title, actions: topActs }), this.info(c, t, dim, mono)] : [this.head(t, dim, title, [topActs]), skeletonInfo(fg)]);
    const files = div().min_w(0).min_h(0).child(c ? this.files(c, t, dim, fileActs)
      : v_flex().size_full().child(fileActs ? this.head(t, dim, null, [fileActs]) : div()).child(skeletonFiles(fg)));
    const len = s ? (wide ? s.width : s.height) : 0, a = Math.max(0, Math.round(len * this.split[wide ? "wide" : "tall"] - DIV / 2));
    const divider = div().id("split").flex_none().flex().items_center().justify_center()
      .when(wide, (e) => e.w(DIV).h_full().cursor_col_resize()).when(!wide, (e) => e.h(DIV).w_full().cursor_row_resize())
      .child(wide ? div().w(1).h_full().bg(this.drag ? t.accent ?? fg : line) : div().h(1).w_full().bg(this.drag ? t.accent ?? fg : line))
      .on_mouse_down("left", (e, cx) => { this.drag = { wide, p0: wide ? e.position.x : e.position.y, f0: this.split[wide ? "wide" : "tall"] }; cx.stop_propagation(); cx.notify(); });
    const out = wide
      ? root.flex_row().child(info.flex_none().w(a).h_full()).child(divider).child(files.flex_1().h_full())
      : root.flex_col().child(info.flex_none().h(a).w_full()).child(divider).child(files.flex_1().w_full());
    // The stale commit is only a picture: a click on it would act on the commit no longer selected.
    return this.c ? out : out.relative().child(div().absolute().inset_0()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation()));
  }
}
