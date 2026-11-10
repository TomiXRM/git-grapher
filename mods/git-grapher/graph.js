// Git history in three resizable columns: BRANCH/TAG | GRAPH | MESSAGE. Each GRAPH cell has a lane-coloured band.
// GRAPH scrolls horizontally independently and clips paths to its column.
// Row clicks or arrow keys publish the selection to "ggit.tab.<tabId>" and open the detail drawer.
// Click again, Esc or Close to hide it. Detach opens a detail pane; Dock or closing that pane restores the drawer.
// A file selection opens its diff over the graph. Esc returns from diff to graph, then closes the drawer.
// Keep the graph laid out but invisible beneath the diff to preserve its scroll position.
// Optional props: repo, wB, wG, sx (initial horizontal scroll), top, sweep (performance run), light (light-theme preview),
// select (initial row), walk (initial arrow-key steps), pollMs, motionMs, drawer ("bottom" | "right"), file (initial diff).
import { gitRun } from "./run.js";
import { div, h_flex, svg, v_flex, v_virtual_list, setZoom, image } from "./ui/zoom.js";

import { VirtualListScrollHandle, InputState } from "gpui-base";
import { rail as sideRail, panel as sidePanel } from "./sidebar.js";

import { exec, theme, themes, props, shared, setShared, nextCommand, focused, panes, spaces, run, settings as herdrSettings } from "herdr";
import { layout } from "./lib/layout.js";
import { herdrAdapter } from "./lib/core.js";
import { storeFor } from "./lib/store.js";
import { drive } from "./drive.js";
import { laneCell, LANE_W, ROW_H, X, AV, cellW } from "./lane-cell.js";
import { LanePathCache } from "./lib/lane-cache.js";
import { RedrawGate } from "./lib/redraw.js";
import { zoom } from "./ui/zoom.js";
import { avatarFile, initial, tint } from "./avatar.js";
import { Header } from "./header.js";
import { DetailView, skeletonDiff } from "./detail-view.js";
import { applyTheme, settings as ggxSettings } from "./themes.js";
import { contextMenu } from "./menu.js";
import { ConflictView } from "./conflict-view.js";
import { forkPoint, READ, HISTORY_ARGS, HISTORY_NUMSTAT, parseHistory, parseNumstat } from "./lib/detail.js";
import { fileFor, nextN } from "./lib/tabkey.js";

// Resolve the initial folder with chooseRepo(), then ask git for its repository root on the space's machine.
const US = "\x1f";
const MIN_W = 60, GRAPH_PAD = 8;
// Lane bands fill GRAPH with ~2 pt side insets, ~79% row height and 3 pt corners.
const BAND = { inset: 2, h: 23, r: 3 };
// Band tint alpha: dark 33 (20%), light 4d (30%) so bands remain visible on white.
// Cap alpha at 4d to keep a same-colour crossing lane line at least 3:1 against the band.
const BAND_A = { dark: "33", light: "4d" };
// Branch label fill alpha: a touch stronger than the band so the pill reads as glass over it, not as more band.
const LABEL_GLASS = "40";
// Tint the selected row in its lane colour and add a solid lane-colour bar at the left edge.
const STASH_C = 8; // palette index of the stash colour (after the 8 lane colours)
const WIP_A = { dark: "40", light: "33" }; // WIP row tint: the whole row in its lane colour
const SEL_A = { dark: "59", light: "66" }, SEL_BAR = 4; // The light selection tint must exceed its 4d band so it stands out from neighbouring rows.
const lum = (c) => { const n = parseInt(c.slice(1, 7), 16); return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255; };
const now = () => globalThis.performance?.now?.() ?? Date.now();
// Drawer shares are draggable and retained per side, using the spring from ui/segmented.js.
// Defaults: bottom graph/detail 6:4; right graph/detail 7:3. Apply the same shares after detaching via layout.resize
// because pane.split has no size argument.
const DRAWER = { bottom: 0.4, right: 0.3 }, DRAWER_MIN = 0.2, DRAWER_MAX = 0.8, EDGE = 6, BAR_H = 26, SPRING = { response: 260 };
const hex2 = (a) => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");

// Draw each GRAPH edge shadow once using SH_W one-pixel strips with alpha max*(1-t)^SH_K.
// The steep falloff gives a soft tail without per-row work.
const SH_W = 28, SH_K = 1.8, SH_FADE = { duration: 200, easing: "ease-out" };
function shadowEdge(side, on, t, colW) {
  // Light themes sink toward their own ink; dark themes toward black (ink would glow there).
  const light = lum(t.background) >= 0.5, col = light ? t.foreground : "#000000", max = light ? 0.13 : 0.35; // Cap dark shadow opacity at 0.35 to avoid a black rim.
  const strips = [];
  for (let i = 0; i < SH_W; i++) {
    const a = max * Math.pow(1 - (i + 0.5) / SH_W, SH_K);
    strips.push(div().absolute().top(0).bottom(0).w(1).left(side === "left" ? i : SH_W - 1 - i).bg(col + hex2(a)));
  }
  // Keep the shadow in the tree so native opacity transitions see their target changes.
  // ponytail: position with left insets because .right() places these absolute boxes at the left edge;
  // use right insets if host positioning is fixed.
  return div().id("shadow-" + side).absolute().top(0).bottom(0).left(side === "left" ? 0 : colW - SH_W).w(SH_W)
    .opacity(on ? 1 : 0).transition("opacity", SH_FADE).children(strips);
}

const MOTION_MS = 180; // 180 ms row transition; props.motionMs supports slow-motion screenshots.

function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.round(d / 86400 / 30)}mo`;
  return `${Math.round(d / 86400 / 365)}y`;
}
const alpha = (c, a) => (c && c.length === 7 ? c + a : c);
// A ref label's text, as characters (marks are one each): drawn by label(), measured by labelAt().
const labelText = (r) => [...((r.head ? "✓ " : "") + (r.tree ? "🌲 " : "") + (r.kind === "tag" ? "🏷 " : r.kind === "remote" || r.remote ? "☁ " : "") + (r.short ?? r.name))];

// Use full refs so a tag and branch with the same short name cannot be confused.
const fullRef = (r) => (r.kind === "remote" ? "refs/remotes/" : r.kind === "tag" ? "refs/tags/" : "refs/heads/") + r.name;
function load(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

// The row a selection stands on: "<sha>", "cmp:<sha>" (compare with HEAD) or "br:<tip>:<branch>" (a branch since it branched).
const rowOf = (sel) => sel?.replace(/^cmp:/, "").replace(/^br:([0-9a-f]+):.*$/, "$1") ?? null;

export class GraphView {
  init(_p, cx) {
    const p = (this.p = props() ?? {});
    this.origin = focused(); // snapshot now: the pane the user opened us from (cmd-shift-g), before focus moves
    this.w = { b: p.wB ?? load("wB", 240), g: p.wG ?? load("wG", 240), a: p.wA ?? load("wA", 84) }; // a = AUTHOR (narrow: the message matters more)
    this.sx = p.sx ?? 0;
    this.drag = null;
    this.graph = null; this.meta = []; this.refs = new Map(); this.files = new Map();
    this.lanePaths = new LanePathCache(); this.layoutGeneration = 0;
    this.backgroundRedraw = new RedrawGate();
    this.sel = null; this.repo = null; this.focus = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new(); this.histScroll = VirtualListScrollHandle.new();
    // Sidebar state: open list, folded groups and filter (sidebar.js).
    this.side = p.side ?? null; this.sidePinned = Boolean(p.side); this.sideFold = new Set(); this.sideFilter = InputState.new({ placeholder: "Filter" });
    this.sideFilter.on("change", (_e, cx) => cx.notify());
    this.hd = new Header(p); this.dv = new DetailView(cx, { slow: p.detailSlow, autoStage: p.autoStage, diffMode: p.diffMode, diffWrap: p.diffWrap }); // detailSlow: screenshots this.size = null; this.tab = null; this.restored = false; this.last = null;
    this.drawer = { bottom: load("drawer-bottom", DRAWER.bottom), right: load("drawer-right", DRAWER.right) };
    this.cv = new ConflictView(this); // shown in place of the graph while git has a conflict (conflict-view.js)
    this.stats = "loading…"; this.builds = []; this.off = p.top ?? 0; // top: first row shown (screenshots; the list cannot be scrolled from code)
    // mod.json focusable: pane.go hands us the keyboard with "focus" (AGENTS.md).
    cx.spawn(async () => { for (;;) if ((await nextCommand()) === "focus") this.focus.focus(); });
    cx.spawn(async (cx) => {
      try {
        const w = await this.locate(cx);
        if (!w) { this.stats = "Not a git repository here — open the graph from a pane inside a repo."; cx.notify(); return; }
        // The repository store owns this copy's reads and writes; the graph renders its state.
        const top = await gitRun("git", ["rev-parse", "--show-toplevel"], { cwd: w.dir, on: w.on ?? undefined }).catch(() => null);
        this.repo = top?.code === 0 ? top.stdout.trim() : w.dir; this.machine = w.on ?? null;
        this.st = storeFor(herdrAdapter(exec, this.machine), this.repo, this.machine, this.p.logLimit ? { limit: this.p.logLimit } : {});
        this.dv.store = this.st;
        cx.spawn(async (cx) => { for (;;) { const s = await this.st.next(); this.apply(s, cx); } });
        // The drive starts before the first read, so a bump during that read is not taken as already seen.
        drive(this.st, { machine: this.machine, pollMs: this.p.pollMs }, cx); // watch + poll + copies' bump → refresh
        await this.st.refresh();
        this.hd.attach(this.st, cx);
        // props.walk: n presses of ↓ a quarter second apart, after the first frame (screenshots of follow(); no synthetic input).
        if (p.walk) { await cx.sleep(800); for (let k = 0; k < p.walk; k++) { this.move(1, cx); await cx.sleep(250); } }
      }
      catch (e) { this.stats = "error: " + e; cx.notify(); }
    });
  }

  // Prefer the initiating pane's live folder if it is in this tab, then this tab's saved repository, then a terminal
  // in this tab, then another tab's focused pane, then the space folder. A separate graph tab may have no terminal.
  // Persist by tab ID: after a restart focus may be elsewhere, and a global saved repository would leak across tabs.
  async locate(cx) {
    if (this.p.repo) return { dir: this.p.repo, on: this.p.machine ?? null };
    const origin = this.origin;
    for (let i = 0; i < 80 && !this.tab; i++) await cx.sleep(25); // this.tab is learned in render
    const term = panes().find((q) => q.tab === this.tab && q.terminal && q.focused && q.cwd)
      ?? panes().find((q) => q.tab === this.tab && q.terminal && q.cwd);
    const space = spaces().find((sp) => sp.tabs?.some((tb) => tb.id === this.tab));
    const on = space?.machine ?? null;
    const here = origin?.terminal && origin.cwd && (!this.tab || origin.tab === this.tab) ? origin.cwd : null;
    const kept = this.tab ? load("repo." + this.tab, null) : null;
    const tries = [here && { dir: here, on }, kept, term?.cwd && { dir: term.cwd, on }, origin?.terminal && origin.cwd && { dir: origin.cwd, on }, space?.folder && { dir: space.folder, on }].filter(Boolean);
    for (const w of tries) {
      const r = await gitRun("git", ["rev-parse", "--show-toplevel"], { cwd: w.dir, on: w.on ?? undefined }).catch(() => null);
      if (r?.code !== 0) continue;
      const found = { dir: r.stdout.trim(), on: w.on ?? null };
      if (this.tab) save("repo." + this.tab, found);
      return found;
    }
    return null;
  }

  // A new store state → what this view draws. History is rebuilt only when the store read it again (refs moved).
  apply(s, cx) {
    this.hd.sync(s);
    this.cv.sync(s, cx);
    if (s.error && !s.history) { this.stats = s.error; cx.notify(); return; }
    const histNew = s.history !== this.history, wip = s.worktrees.filter((w) => w.n).map((w) => ({ ...w, id: "wip:" + w.path }));
    const key = (l, x) => l.map((w) => w.id + ":" + w.head).join("|") + "/" + x.map((y) => y.oid).join("|");
    const relayout = histNew || s.headId !== this.headId || key(wip, s.stashes) !== key(this.wip ?? [], this.stashes ?? []);
    this.wip = wip; this.stashes = s.stashes;
    if (histNew) {
      this.history = s.history; this.commits = s.history.commits; this.orphans = s.history.orphans;
      this.baseMeta = this.commits.map((c) => ({ an: c.an, ae: c.ae, at: c.at }));
    }
    this.headId = s.headId;
    if (relayout) {
      const before = this.graph ? this.graph.rows.map((r) => r.commit) : null, t0 = now(), keep = this.anchor();
      this.buildGraph(); if (!this.reanchor(keep)) this.splice(before, cx);
      this.refs = new Map(); this.buildRefs(s.history.refs, s.worktrees, s.headId, s.headBranch);
      // A lost tip with no lost child is where that line ends: it gets the label. (A tip below another lost commit is inside it.)
      const inner = new Set(this.commits.filter((c) => this.orphans.has(c.id)).flatMap((c) => c.parents));
      for (const x of s.history.tips) if (!inner.has(x)) { const l = this.refs.get(x) ?? []; l.unshift({ kind: "orphan", name: "Not on a branch" }); this.refs.set(x, l); }
      this.stats = `${this.commits.length} commits${s.history.omitted ? " (older ones not read yet)" : ""}, ${this.graph.lane_count} lanes` +
        (ggxSettings().verbose ? ` · layout ${(now() - t0).toFixed(1)} ms · read #${s.gen}` : ""); // timings only with Verbose
    } else this.meta.splice(0, wip.length, ...wip.map((w) => ({ wip: w })));
    this.backgroundRedraw.request(cx);
    if (histNew) cx.spawn((cx) => this.faces(cx));
  }

  // Preserve the middle visible row across refreshes. The list keeps a pixel offset, so inserting rows above would
  // otherwise shift the content. scroll_to_item with "center" always positions the row; other modes only reveal it.
  // At the top, allow new commits to enter view.
  // ponytail: the exact scroll offset is unavailable in JS, so anchoring can differ by half a row; use a native offset API if it twitches.
  anchor() {
    const v = this.view, rows = this.graph?.rows;
    if (!v || !rows || v.start === 0) return null;
    const mid = Math.floor((v.start + v.end) / 2);
    return rows[mid + this.off] ? { key: rows[mid + this.off].commit, at: mid } : null;
  }
  reanchor(keep) {
    if (!keep) return false;
    const i = this.graph.rows.findIndex((r) => r.commit === keep.key) - this.off;
    if (i < 0 || i === keep.at) return false;
    this.scroll.scroll_to_item(i, "center"); this.motion = null; // no slide: the rows on screen do not move
    return true;
  }

  // ponytail: sequential avatar fetch (few authors per repo); pool it if a repo has hundreds of new ones.
  async faces(cx) {
    const people = new Map(this.baseMeta.map((m) => [m.ae, m.an]));
    for (const e of people.keys()) if (!this.files.has(e)) { this.files.set(e, await avatarFile(e)); this.backgroundRedraw.request(cx); }
    if (this.p.sweep && !this.swept) { this.swept = true; await this.sweep(cx); }
  }

  buildGraph() {
    this.layoutGeneration++; this.lanePaths.clear();
    const wip = this.wip ?? [], st = this.stashes ?? [], have = new Set(this.commits.map((c) => c.id));
    // A row whose base is past the log's limit has nothing to hang from: it floats (no parent edge).
    const rows = [...wip.map((w) => ({ id: w.id, parents: have.has(w.head) ? [w.head] : [], wip: true, subject: "" })),
      ...st.map((x) => ({ id: x.oid, parents: have.has(x.base) ? [x.base] : [], stash: true, color: STASH_C, subject: x.msg }))];
    this.graph = layout([...rows, ...this.commits]);
    this.meta = [...wip.map((w) => ({ wip: w })), ...st.map((x) => ({ stash: x })), ...this.baseMeta];
    this.graph.rows.forEach((r) => { if (r.commit === this.headId) r.node = r.node === "merge" ? "head-merge" : "head"; });
  }

  // Animate inserted rows over 180 ms with OutCubic: fade them in at their final slots while other rows slide.
  // Removed rows leave a closing gap. Skip motion on first load, repository changes or more than 64 changed rows.
  // ponytail: removed rows have no fading ghost; add one if removals look abrupt.
  splice(before, cx) {
    if (!before) return;
    const after = this.graph.rows.map((r) => r.commit), was = new Set(before), is = new Set(after);
    const ins = after.flatMap((k, i) => (was.has(k) ? [] : [{ at: i, add: true }]));
    let kept = 0; const del = [];
    for (const k of before) if (is.has(k)) kept++; else del.push({ at: kept, add: false }); // where it was, in the new list
    const changes = [...ins, ...del];
    if (!changes.length || changes.length > 64) return;
    this.motion = { t0: Date.now(), changes, newRows: new Set(ins.map((c) => c.at)) };
    cx.spawn(async (cx) => { while (this.motion && Date.now() - this.motion.t0 < (this.p.motionMs ?? MOTION_MS)) { await cx.sleep(16); cx.notify(); } this.motion = null; cx.notify(); });
  }
  // Current row motion: { dy (pixels added to its slot), op }. With eased progress p, each inserted row above
  // adds p - 1 to the offset; each removed row above adds 1 - p.
  rowMotion(i) {
    const m = this.motion, p = 1 - Math.pow(1 - Math.min(1, (Date.now() - m.t0) / (this.p.motionMs ?? MOTION_MS)), 3);
    let n = 0;
    for (const c of m.changes) if (c.add ? c.at < i : c.at <= i) n += c.add ? p - 1 : 1 - p;
    return { dy: n * ROW_H, op: m.newRows.has(i) ? p : 1 };
  }

  // One label per branch name: local + its origin/ twin on the same commit merge into one (cloud mark).
  buildRefs(text, worktrees, headId, headBranch) {
    const trees = new Set(worktrees.filter((w) => w.branch).map((w) => "refs/heads/" + w.branch));
    const by = new Map();
    for (const line of text.trim().split("\n")) {
      if (!line) continue; // no refs yet (a new repo): "".split gave one empty line
      const [obj, peeled, name] = line.split(US);
      if (name.endsWith("/HEAD")) continue;
      const id = peeled || obj;
      const list = by.get(id) ?? []; by.set(id, list);
      if (name.startsWith("refs/heads/")) list.push({ kind: "local", name: name.slice(11), tree: trees.has(name) });
      else if (name.startsWith("refs/tags/")) list.push({ kind: "tag", name: name.slice(10) });
      else list.push({ kind: "remote", name: name.slice(13), short: name.slice(13).replace(/^[^/]+\//, "") });
    }
    // Detached: a HEAD label marks where you are. On a branch, that branch's ✓ already does.
    if (!headBranch && headId) { const list = by.get(headId) ?? []; by.set(headId, list); list.push({ kind: "head", name: "HEAD" }); }
    for (const [id, list] of by) {
      const locals = new Set(list.filter((r) => r.kind === "local").map((r) => r.name));
      const out = [];
      for (const r of list) {
        if (r.kind === "remote") { const short = r.name.replace(/^[^/]+\//, ""); if (locals.has(short)) continue; }
        if (r.kind === "local") r.remote = list.some((o) => o.kind === "remote" && o.name.replace(/^[^/]+\//, "") === r.name);
        r.head = r.kind === "local" && r.name === headBranch;
        out.push(r);
      }
      // HEAD branch first, then local, remote, tag.
      const rank = (r) => (r.head ? 0 : { head: 0, local: 1, remote: 2, tag: 3, orphan: 4 }[r.kind]);
      this.refs.set(id, out.sort((a, b) => rank(a) - rank(b)));
    }
  }

  // Performance sweep: horizontal graph scroll plus vertical movement of the list data window.
  // uniform_list ignores track_scroll. Measure JS range construction per frame.
  async sweep(cx) {
    const maxX = Math.max(0, cellW(this.graph.lane_count) + GRAPH_PAD - this.w.g);
    const run = async (label, step) => {
      this.builds = []; const t0 = now(); let n = 0;
      for (let k = 0; k < 120; k++) { step(k); cx.notify(); n++; await cx.sleep(16); }
      const b = this.builds, wall = now() - t0;
      const avg = b.reduce((a, x) => a + x, 0) / b.length;
      return `${label}: ${b.length} builds/${n} steps in ${wall.toFixed(0)} ms, build avg ${avg.toFixed(2)} max ${Math.max(...b).toFixed(2)} ms`;
    };
    const h = await run("H", (k) => { this.sx = Math.round((maxX * (k % 60)) / 59); });
    this.sx = 0;
    const v = await run("V", (k) => { this.off = Math.min(k * 37, this.graph.rows.length - 1); });
    this.off = 0;
    this.stats += ` · ${h} · ${v}`;
    console.log("[ggit] " + this.stats);
    cx.notify();
  }

  // sha null = deselect (the drawer slides back). Written to this tab's key only.
  select(sha, cx) {
    if (sha === this.sel) return;
    this.selectNow(sha);
    cx.notify();
  }
  selectNow(sha) { this.sel = sha; this.write(null); } // a new commit (or none) closes the diff
  // file = { path, old? } | null. Only the graph writes sha; file is also written by the detail (docs/protocol.md).
  write(file) {
    if (!this.tab) return;
    const n = nextN(shared("ggit.tab." + this.tab), shared("ggit.file." + this.tab));
    setShared("ggit.tab." + this.tab, { repo: this.repo, sha: this.sel, machine: this.machine ?? null, file, at: Date.now(), n });
  }
  // The diff shown in the graph's area: the key's file, if the key is about our current commit.
  openFile() {
    if (!this.tab || !this.sel) return null;
    return fileFor(shared("ggit.tab." + this.tab), shared("ggit.file." + this.tab), { repo: this.repo, sha: this.sel, machine: this.machine ?? null }); // lib/tabkey.js
  }

  // Once per copy, when both the tab and the history are known: the tab key's selection comes back (start, hot reload).
  restore() {
    if (this.restored || !this.tab || !this.graph) return;
    this.restored = true;
    // select (screenshots): written to the key like a click, so a detached the detail in the same tab follows it.
    // Harmless to the user's own graph: the key is per tab.
    // ctx: { row, x, y } a row's menu drawn open; compare: a row index shown as Compare with HEAD (screenshots)
    if (this.p.ctx) { const r = this.graph.rows[this.p.ctx.row]; if (r) this.ctx = { sha: r.commit, subject: r.subject ?? "", merge: r.node.includes("merge"), x: this.p.ctx.x, y: this.p.ctx.y }; }
    if (this.p.compare != null) { const r = this.graph.rows[this.p.compare]; if (r) this.selectNow("cmp:" + r.commit); return; }
    if (this.p.select != null) {
      this.selectNow(this.graph.rows[this.p.select]?.commit ?? null); this.pendingFollow = this.sel; // once the list has a size
      if (this.p.file && this.sel) this.write({ path: this.p.file });
      return;
    }
    const k = shared("ggit.tab." + this.tab);
    if (k?.repo === this.repo && this.graph.rows.some((r) => r.commit === k.sha)) this.sel = k.sha;
  }

  // Both roles use mod "git-grapher", and panes() exposes no props, so Detach records its pane in "ggit.detail.<tab>".
  // Ignore stale pane IDs. A mod is not told its own pane ID; props() contains only passed values.
  // After a slow split, adopt only a pane newly appearing in this tab, not another existing graph.
  // After restart, a detail pane claims the key when interacted with (detail-main claim).
  // ponytail: two graphs in one tab share the first detail pane; separate ownership keys would support independent drawers.
  detailPane() {
    if (!this.tab) return null;
    const id = shared("ggit.detail." + this.tab), all = panes();
    const keyed = id ? all.find((x) => x.pane === id) : null;
    if (keyed) return keyed;
    const born = this.split && all.find((x) => x.mod === "git-grapher" && x.tab === this.tab && !this.split.before.has(x.pane));
    if (born) { setShared("ggit.detail." + this.tab, born.pane); this.split = null; } // adopt it
    return born ?? null;
  }
  me() { const d = this.detailPane(); return panes().find((x) => x.mod === "git-grapher" && x.tab === this.tab && x.pane !== d?.pane); }

  // The drawer: always in the tree (so the native spring sees its size change), 0 when closed.
  // Its content keeps a fixed size and rides the moving edge, so it slides instead of reflowing.
  drawerView(side, open, t, cx, file) {
    const s = this.size, bottom = side === "bottom", f = this.drawer[side];
    const full = s ? Math.round((bottom ? s.height : s.width) * f) : 0;
    const len = open ? full : 0, line = alpha(t.foreground, "1f"), dim = t.muted ?? alpha(t.foreground, "99");
    const sel = this.sel ? { repo: this.repo, sha: this.sel, machine: this.machine ?? null } : null;
    if (sel) this.last = sel; // closing: keep drawing the last commit while it slides out
    const btn = (id, text, fn) => div().id(id).h(20).px(7).rounded(5).flex().items_center().cursor_pointer()
      .hover((h) => h.bg(t.hover ?? t.raised)).on_click(fn).child(text);
    const edge = div().id("drawer-edge").flex_none().flex().items_center().justify_center()
      .when(bottom, (e) => e.h(EDGE).w_full().cursor_row_resize()).when(!bottom, (e) => e.w(EDGE).h_full().cursor_col_resize())
      .child(bottom ? div().h(1).w_full().bg(this.drag?.drawer ? t.accent ?? line : line) : div().w(1).h_full().bg(this.drag?.drawer ? t.accent ?? line : line))
      .on_mouse_down("left", (e, cx) => { this.drag = { drawer: side, p0: bottom ? e.position.y : e.position.x, f0: f }; cx.stop_propagation(); cx.notify(); });
    const w = s ? (bottom ? s.width : full) : 0, h = s ? (bottom ? full : s.height) : 0;
    const bar = h_flex().h(BAR_H).flex_none().px(8).gap(4).items_center().text_size(12).text_color(dim)
      .child(div().flex_1().child("Commit"))
      .child(btn("detach", "⇱ Detach", (_e, cx) => this.detach(side, cx)))
      .child(btn("drawer-close", "×", (_e, cx) => this.select(null, cx)));
    // The axis that doesn't slide fills the drawer (w_full / h_full): the root's measured size can lag the pane
    // (seen: ~100px gap on the right of a bottom drawer). Only the sliding axis is a number. The detail gets the
    // content box's own measured size, falling back to the estimate before the first layout.
    const m = this.dsize?.[side];
    const inner = { width: Math.max(0, (bottom ? m?.width ?? w : w) - (bottom ? 0 : EDGE)), height: Math.max(0, (bottom ? h : m?.height ?? h) - BAR_H - (bottom ? EDGE : 0)) };
    const content = div().id("drawer-content-" + side).absolute().top(0).left(0).when(bottom, (e) => e.w_full().h(h)).when(!bottom, (e) => e.h_full().w(w)).flex()
      .on_size_change((sz, cx) => { this.dsize = { ...this.dsize, [side]: sz }; cx.notify(); }).when(bottom, (e) => e.flex_col()).when(!bottom, (e) => e.flex_row())
      .child(edge)
      .child(v_flex().flex_1().min_w(0).min_h(0).child(bar)
        .child(div().flex_1().min_h(0).child(this.dv.render(sel ?? this.last, { size: inner, wide: bottom, t, cx,
          // Accept a file only when the drawer's loaded commit matches the graph selection; stale row clicks must not
          // publish a file under another commit or an empty selection.
          file, onFile: (f) => { if (this.sel && this.dv.sel?.sha === this.sel) this.write(f ? { path: f.path, ...(f.old ? { old: f.old } : {}) } : null); },
          onBranch: (at, cx) => this.hd.openBranch(cx, at),
          onHistory: (path, cx, at) => this.openHistory(path, cx, at),
          store: this.st }))));
    // ponytail: no spring while the edge is dragged, so the drawer follows the pointer 1:1.
    return div().id("drawer-" + side).relative().flex_none().overflow_hidden()
      .when(bottom, (e) => e.w_full().h(len)).when(!bottom, (e) => e.h_full().w(len))
      .when(!this.drag?.drawer, (e) => e.spring(bottom ? "height" : "width", SPRING))
      .child(content);
  }

  // Reveal the selected row using v_virtual_list; uniform_list ignores track_scroll.
  // "top" moves only enough to reveal a row and leaves fully visible rows alone. Do not infer visibility from
  // the rendered range: it includes about two overscan rows beyond the viewport.
  follow(sha) {
    const i = sha ? this.graph?.rows.findIndex((r) => r.commit === rowOf(sha)) : -1;
    if (i >= this.off) this.scroll.scroll_to_item(i - this.off, "top");
  }
  // ↑/↓ moves the selection, and the list follows it.
  onKey(e, cx) {
    if (this.side && e.keystroke === "escape") { this.side = null; this.sidePinned = false; this.sideFade = false; cx.stop_propagation(); cx.notify(); return; } // the sidebar list first
    if (this.hist && e.keystroke === "escape") { this.hist = null; cx.stop_propagation(); cx.notify(); return; } // File History closes
    // ↑/↓ in File History moves the picked commit, and its list follows it.
    if (this.hist?.list?.length && (e.keystroke === "up" || e.keystroke === "down")) {
      const L = this.hist.list, i = L.indexOf(this.hist.pick), j = Math.max(0, Math.min(L.length - 1, i < 0 ? 0 : i + (e.keystroke === "up" ? -1 : 1)));
      this.pickHistory(L[j], cx); this.histScroll.scroll_to_item(j); cx.stop_propagation(); return;
    }
    // Esc order: diff → graph, then graph → drawer closed. (A focused detail takes the first Esc itself, same result.)
    if (this.openFile()) { // ↑/↓ off while the diff shows; ⌘C copies its picked rows
      if (e.keystroke === "escape") { this.write(null); cx.stop_propagation(); }
      else if (e.keystroke === "cmd-c" && this.dv.copyPicked(cx)) cx.stop_propagation();
      return;
    }
    // Enter on a commit requests detached checkout through the same confirmation as the menu.
    // While that dialog is open, Enter does nothing and Esc closes it; only its button confirms the operation.
    const dlg = this.hd.dialog?.kind === "checkout";
    if (dlg && (e.keystroke === "enter" || e.keystroke === "escape")) {
      if (e.keystroke === "escape") { this.hd.dialog = null; cx.notify(); }
      cx.stop_propagation(); return;
    }
    if (e.keystroke === "enter" && this.sel && !this.hd.dialog) {
      const i = this.graph?.rows.findIndex((r) => r.commit === this.sel) ?? -1, m = this.meta[i];
      // a commit with a local branch switches to that branch (no dialog); else the detached checkout, asked first.
      const local = (this.refs.get(this.sel) ?? []).find((r) => r.kind === "local" && !r.head);
      if (i >= 0 && !m.wip && !m.stash && local) this.switchTo(local, cx);
      else if (i >= 0 && !m.wip && !m.stash && this.sel !== this.headId) this.hd.confirm(cx, "checkout", { sha: this.sel, subject: this.graph.rows[i].subject ?? "" });
      cx.stop_propagation(); return;
    }
    if (e.keystroke === "escape" && this.sel) { this.select(null, cx); cx.stop_propagation(); return; }
    // Cmd+C copies the commit hash; Cmd+Shift+C copies a local branch name (checked-out branch first), or the hash.
    // ponytail: copying the branch name on Cmd+C is not configurable; add a setting if needed.
    if ((e.keystroke === "cmd-c" || e.keystroke === "cmd-shift-c") && this.sel && !this.hd.dialog) {
      const sha = rowOf(this.sel), i = this.graph?.rows.findIndex((r) => r.commit === sha) ?? -1;
      if (i < 0 || this.meta[i].wip || this.meta[i].stash) return;
      const locals = (this.refs.get(sha) ?? []).filter((r) => r.kind === "local").sort((a, b) => Boolean(b.head) - Boolean(a.head));
      const branch = e.keystroke === "cmd-shift-c" ? locals[0]?.name : null;
      cx.write_to_clipboard(branch ?? sha); this.hd.note(cx, branch ? `Copied ${branch}` : "Copied the SHA");
      cx.stop_propagation(); return;
    }
    const d = e.keystroke === "up" ? -1 : e.keystroke === "down" ? 1 : 0;
    if (!d || !this.graph) return;
    this.move(d, cx);
    cx.stop_propagation();
  }
  move(d, cx) {
    const rows = this.graph.rows, i = rows.findIndex((r) => r.commit === this.sel);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))].commit;
    this.select(next, cx); this.follow(next);
  }

  avatar(m) {
    // Not looked up yet: a plain grey disc, so the initial's tint does not flash before the picture.
    if (!this.files.has(m.ae)) return { file: null, initial: "", tint: "#8080804d" };
    const f = this.files.get(m.ae);
    return { file: typeof f === "string" ? f : null, initial: initial(m.an, m.ae), tint: tint(m.ae) };
  }

  // Detach splits the pane, then sizes the detail pane. run() returns null, so find the new pane via panes(),
  // which may take a frame, and set both weights with layout.resize.
  // Allow only one pending split so repeated clicks cannot create competing detail panes.
  detach(side, cx) {
    const me = this.me(); if (!me || this.detaching || this.detailPane()) return;
    this.detaching = true;
    // Always below ggit, whichever side the drawer was on.
    const before = new Set(panes().map((p) => p.pane)), share = DRAWER.bottom;
    this.split = { before }; // remembered past the search, for a split slower than it (detailPane)
    run("pane.split", { pane: me.pane, direction: "down", mod: "git-grapher", props: { role: "detail" } });
    cx.spawn(async (cx) => {
      try {
        for (let i = 0; i < 2400; i++) { // Wait up to 60 s; detailPane() can adopt a slower split later.
          const p = panes().find((q) => q.mod === "git-grapher" && q.tab === me.tab && !before.has(q.pane));
          if (p) {
            setShared("ggit.detail." + me.tab, p.pane); this.split = null;
            run("layout.resize", { id: me.pane, weight: 1 - share }); run("layout.resize", { id: p.pane, weight: share }); return;
          }
          await cx.sleep(25);
        }
      } finally { this.detaching = false; }
    });
  }

  maxScroll() { return Math.max(0, cellW(this.graph.lane_count) + GRAPH_PAD - this.w.g); }

  // Hit-test labels in row coordinates at 100% zoom. Virtual-list rows cannot carry handlers, so reconstruct
  // the BRANCH/TAG layout: left padding 10, gap 4, label width 16 + text (capped at wB - 24), shrinking proportionally.
  // ponytail: estimate text at 5.6 px per character and 13 per mark; edge hits can name a neighbour.
  // Measure labels with on_size_change outside the list if that becomes visible.
  // any includes all branch and tag labels, not only switchable ones.
  labelAt(sha, x, any = false) {
    const refs = this.refs.get(sha), wB = this.w.b;
    if (!refs || x < 10 || x > wB) return null;
    const can = any ? (r) => r.kind === "local" || r.kind === "remote" || r.kind === "tag" : (r) => (r.kind === "local" || r.kind === "remote") && !r.head, ok = refs.filter(can);
    if (refs.length === 1) return ok[0] ?? null; // one label: anywhere on the strip, no estimate needed
    const basis = refs.map((r) => Math.min(wB - 24, 16 + labelText(r).reduce((n, ch) => n + (ch.codePointAt(0) > 0x2000 ? 13 : 5.6), 0)));
    const room = wB - 10 - 4 * refs.length - 4, sum = basis.reduce((a, b) => a + b, 0), k = sum > room ? Math.max(0, room) / sum : 1;
    let at = 10;
    for (let i = 0; i < refs.length; i++) {
      const w = basis[i] * k;
      if (x >= at && x < at + w) return can(refs[i]) ? refs[i] : null;
      at += w + 4;
    }
    return null;
  }

  // File History overlays the graph: Back, path, count and Show in graph above newest-first commit rows,
  // with the selected commit's file diff below under its historical name. Selection also updates the detail drawer.
  // Read from git each time and always follow renames.
  // at = { rev, cwd } fixes the menu's commit (or WIP worktree HEAD) once so both reads agree.
  openHistory(path, cx, at = {}) {
    const h = (this.hist = { path, at, list: null, err: null, pick: null }); this.write(null); this.focus.focus(); cx.notify(); // ↑/↓ reach the list
    cx.spawn(async (cx) => {
      const run = (args) => gitRun("git", [...READ, ...args], { cwd: at.cwd ?? this.repo, on: this.machine ?? undefined }).catch((e) => ({ code: 1, stderr: String(e) }));
      const id = await run(["rev-parse", "-q", "--verify", `${at.rev ?? "HEAD"}^{commit}`]);
      const rev = id.code === 0 ? id.stdout.trim() : null;
      const [r, n] = rev ? await Promise.all([run(HISTORY_ARGS(path, { rev })), run(HISTORY_NUMSTAT(path, { rev }))]) : [{ code: 0, stdout: "" }, { code: 0, stdout: "" }];
      if (this.hist !== h) return;
      if (r.code !== 0) { h.err = (r.stderr || "Could not read the history").split("\n")[0]; cx.notify(); return; }
      const counts = n.code === 0 ? parseNumstat(n.stdout) : new Map();
      h.list = parseHistory(r.stdout).map((e) => ({ ...e, ...(counts.get(e.sha) ?? {}) }));
      if (h.list[0]) this.pickHistory(h.list[0], cx);
      cx.notify();
    });
  }
  pickHistory(e, cx) { this.hist.pick = e; this.select(e.sha, cx); cx.notify(); }
  histView(t, cx) {
    const h = this.hist, fg = t.foreground, dim = t.muted ?? alpha(fg, "99"), line = alpha(fg, "1f");
    const btn = (id, label, fn, on = false) => div().id(id).h(22).px(8).flex_none().flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .bg(on ? alpha(t.accent ?? fg, "33") : t.raised ?? t.background).border_1().border_color(t.input ?? line).hover((x) => x.bg(t.hover ?? t.raised))
      .on_click((_e, cx) => fn(cx)).child(label);
    const n = h.list?.length;
    const head = h_flex().flex_none().h(34).px(8).gap(6).items_center().border_b_1().border_color(line).text_size(12)
      .child(btn("hist-back", "← Back", (cx) => { this.hist = null; this.focus.focus(); cx.notify(); }))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(`File History: ${h.path}`))
      .children(n != null ? [div().flex_none().text_color(dim).child(`${n} commit${n === 1 ? "" : "s"}`)] : [])
      .children(h.pick ? [btn("hist-graph", "Show in Graph", (cx) => { this.hist = null; this.focus.focus(); cx.notify(); })] : []);
    const sc = (st) => ({ A: t.ansi2, D: t.ansi1, R: t.ansi4, C: t.ansi4 }[st] ?? t.ansi3);
    // A virtual list (handlers cannot live in its rows: a click comes as on_item_click with the row's sha), so ↑/↓ can
    // scroll it to the picked row (histScroll).
    const row = (e) => h_flex().h(24).px(8).gap(8).flex_none().items_center().cursor_pointer().text_size(12)
      .when(h.pick === e, (x) => x.bg(alpha(t.accent ?? fg, "40")))
      .child(div().w(12).flex_none().font_semibold().text_color(sc(e.status)).child(e.status))
      .child(div().flex_1().min_w(0).truncate().child(e.subject + (e.old ? `  (renamed from ${e.old})` : "")))
      .child(div().w(90).flex_none().truncate().text_color(dim).child(e.name))
      .child(div().w(36).flex_none().text_right().text_color(dim).child(ago(e.at)))
      .child(h_flex().w(70).flex_none().gap(4).justify_end()
        .children(e.add == null ? [div().text_color(dim).child("bin")] : [div().text_color(t.ansi2 ?? fg).child(`+${e.add}`), div().text_color(t.ansi1 ?? fg).child(`−${e.del}`)]))
      .child(div().w(62).flex_none().font_family(herdrSettings().font_family ?? "Menlo").text_color(dim).child(e.sha.slice(0, 7)));
    const L = h.list ?? [];
    const list = v_flex().id("hist-list").flex_none().h(Math.min(8, Math.max(1, L.length || 1)) * 24 + 8).py(4).border_b_1().border_color(line)
      .children(h.err ? [div().px(10).text_size(12).text_color(t.ansi1 ?? fg).child(h.err)] : !h.list ? [div().px(10).text_size(12).text_color(dim).child("Reading the history…")]
        : !L.length ? [div().px(10).text_size(12).text_color(dim).child("No commits changed this file")]
        : [v_virtual_list("hist-rows", L.length, 24, (i) => L[i].sha, ({ start, end }) => L.slice(start, end).map(row)).flex_1().track_scroll(this.histScroll)
          .on_item_click((sha, cx) => { const e = L.find((x) => x.sha === sha); if (e) { this.focus.focus(); this.pickHistory(e, cx); } })]);
    const ready = h.pick && this.dv.sel?.sha === h.pick.sha && this.dv.c?.sha === h.pick.sha;
    const diff = div().flex_1().min_h(0).child(ready ? this.dv.fileDiff(h.pick.path, { t, cx, onBack: null })
      : h.pick ? skeletonDiff(fg) : div());
    return v_flex().size_full().bg(t.background).child(head).child(list).child(diff);
  }

  // Dropping a label onto a local branch label opens its merge plan. The checked-out branch receives a normal merge;
  // another target branch moves without being checked out (header.openMerge).
  // Virtual lists expose neither row press handlers nor scroll offsets. Estimate the row from view.start and pointer
  // height, using frac learned from clicks or half a row by default. Prefer the candidate with a label at x.
  // Dim the source, ring the target and show "X -> Y" during dragging so the target is visible before release.
  // ui/zoom.js already divides pointer coordinates by zoom; use unscaled ROW_H.
  // ponytail: row positions are estimated; a native row key on press/release or a readable scroll offset would make them exact.
  rowAt(y) {
    const H = ROW_H, start = (this.view?.start ?? 0) + this.off, f = this.frac?.start === this.view?.start ? this.frac.v : H / 2;
    return start + Math.floor((y + f) / H);
  }
  calibrate(sha) {
    const p = this.press, i = this.graph?.rows.findIndex((r) => r.commit === sha) ?? -1;
    if (!p || i < 0 || !this.view) return;
    const H = ROW_H, k = i - (this.view.start + this.off), lo = Math.max(0, k * H - p.y), hi = Math.min(H, (k + 1) * H - p.y);
    if (hi > lo) this.frac = { start: this.view.start, v: (lo + hi) / 2 };
  }
  labelNear(y, x, ok) {
    const rows = this.graph?.rows ?? [], H = ROW_H, base = this.rowAt(y);
    const f = this.frac?.start === this.view?.start ? this.frac.v : H / 2, within = (((y + f) % H) + H) % H;
    // the guessed row; if it has no label there, the neighbour on the side the pointer leans to
    for (const i of [base, within < H / 2 ? base - 1 : base + 1]) {
      const r = rows[i], lb = r && this.labelAt(r.commit, x, true);
      if (lb && ok(lb)) return { ...lb, sha: r.commit };
    }
    return null;
  }
  dndMove(e) {
    const p = this.press, dx = e.position.x - p.px, dy = e.position.y - p.py;
    if (!this.dnd) {
      if (p.no || Math.hypot(dx, dy) < 6) return false;
      const src = this.labelNear(p.y, p.x, (lb) => lb.kind === "local" || lb.kind === "remote" || lb.kind === "tag");
      if (!src) { p.no = true; return false; }
      this.dnd = { src };
    }
    const l = e.local_position ?? e.position, y = p.y + dy, x = p.x + dx;
    this.dnd.gx = l.x; this.dnd.gy = l.y;
    const dst = this.labelNear(y, x, (lb) => lb.kind === "local");
    this.dnd.dst = dst && !(dst.name === this.dnd.src.name && dst.kind === this.dnd.src.kind) ? dst : null;
    return true;
  }
  dndDrop(cx) {
    const { src, dst } = this.dnd; this.dnd = null; this.press = null;
    if (dst) this.hd.openMerge(cx, fullRef(src), dst.name === this.st?.state.headBranch ? null : dst.name);
    cx.notify();
  }
  dndGhost(t) {
    const d = this.dnd; if (!d || d.gx == null) return [];
    const ok = Boolean(d.dst), into = d.dst ? `Merge ${d.src.name} into ${d.dst.name}` : `${d.src.name} → drop on a branch`;
    return [div().absolute().left(d.gx + 14).top(d.gy + 10).h(24).px(9).rounded(6).flex().items_center().text_size(12).whitespace_nowrap()
      .bg(ok ? t.accent ?? t.foreground : t.raised ?? t.background).text_color(ok ? t.accent_foreground ?? t.background : t.foreground)
      .border_1().border_color(alpha(t.foreground, "33")).shadow_md().child(into)];
  }

  // Local labels switch branches, offering Stash and switch if local changes block it.
  // Remote labels create a tracking branch or switch and fast-forward its existing local branch.
  switchTo(r, cx) {
    if (r.kind === "remote") this.hd.op("sync", () => this.hd.g.syncRemote(this.hd.t, r.name), cx);
    else this.hd.op("switch", () => this.hd.g.switchBranch(this.hd.t, r.name), cx);
  }

  label(r, c, t, sha = null) {
    // Labels use a translucent lane-colour fill, solid lane-colour rim and theme text.
    // During dragging, dim the source and ring the prospective merge target in the accent colour.
    const d = this.dnd, src = d && d.src.sha === sha && d.src.name === r.name, dst = d?.dst && d.dst.sha === sha && d.dst.name === r.name;
    return div().flex_shrink_1().when(Boolean(src), (e) => e.opacity(0.45)).when(Boolean(dst), (e) => e.border_2().border_color(t.accent ?? t.foreground).bg(alpha(t.accent ?? t.foreground, "40"))).min_w(0).max_w(this.w.b - 24).h(22).px(7).rounded(5).flex().items_center().text_sm().whitespace_nowrap().overflow_hidden()
      .bg(alpha(c, LABEL_GLASS)).border_1().border_color(c)
      .text_color(t.foreground)
      .child(div().truncate().child(labelText(r).join("")));
  }


  render(cx) {
    setZoom(this.p.zoom ?? ggxSettings().zoom); // Zoom is shared with detached details; props.zoom overrides it for screenshots.
    // Only a visible copy renders, so focused().tab identifies its tab during render.
    this.tab = focused()?.tab ?? this.tab;
    this.restore();
    // light previews the first light theme without changing the global theme.
    const t = applyTheme(this.p.light ? { ...theme(), ...(themes().find((x) => x.light)?.colors ?? {}) } : theme(), this.p.theme); // Settings → Theme (props.theme: screenshots)
    const dark = lum(t.background) < 0.5, bandA = dark ? BAND_A.dark : BAND_A.light, selA = dark ? SEL_A.dark : SEL_A.light;
    const fg = t.foreground, dim = alpha(fg, "99");
    // ggit themes supply eight lane colours; the herdr theme uses its ANSI colours.
    // STASH_C adds the warning/yellow colour for each stash's full line.
    const palette = [...(t.lanes ?? [t.ansi1, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi4, t.ansi9 ?? t.ansi1, t.ansi10 ?? t.ansi2]), t.ansi3 ?? fg];
    // Wide pane → detail on the right, tall pane → detail below. Detach splits the same way.
    const s = this.size, side = this.p.drawer ?? (s && s.width >= 1.3 * s.height ? "right" : "bottom");
    const root = div().id("graph-root").relative().size_full().flex().flex_col().bg(t.background).text_color(fg)
      // Esc closes the sidebar list wherever the keyboard is inside ggit: keys bubble here, and onKey
      // takes it first. One on_key_down per element (the host keeps the last; ).
      .track_focus(this.focus).on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_move((e, cx) => {
        if (!this.drag && this.press && this.dndMove(e)) { cx.notify(); return; }
        if (!this.drag) return;
        if (this.drag.drawer) {
          const { drawer: d, p0, f0 } = this.drag, len = d === "bottom" ? this.size.height : this.size.width;
          this.drawer[d] = Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, f0 - ((d === "bottom" ? e.position.y : e.position.x) - p0) / len));
          cx.notify(); return;
        }
        const { col, x0, w0 } = this.drag;
        // AUTHOR sits right of its divider, so dragging right shrinks it; MESSAGE (flex) takes the rest.
        this.w[col] = Math.max(col === "a" ? 40 : MIN_W, Math.round(w0 + (col === "a" ? -1 : 1) * (e.position.x - x0)));
        this.sx = Math.min(this.sx, this.graph ? this.maxScroll() : 0);
        cx.notify();
      })
      .on_mouse_down("right", (e, cx) => {
        if (this.sideCtx) { // a sidebar row: a worktree's menu or a branch's / tag's
          const p = e.local_position ?? e.position, c = this.sideCtx; this.sideCtx = null;
          this.ctx = c.ref ? { ref: c.ref, x: p.x, y: p.y, fromSide: true } : c.stash ? { stash: c.stash, x: p.x, y: p.y, fromSide: true } : { wt: c, x: p.x, y: p.y, fromSide: true };
          cx.notify(); return;
        }
        const key = this.ctxKey; this.ctxKey = null;
        // Branch and tag labels open their ref menu rather than the commit menu.
        const lb = key && this.rpress && this.labelAt(key, this.rpress.x, true); this.rpress = null;
        if (lb) { const p = e.local_position ?? e.position; this.ctx = { ref: { kind: lb.kind, name: lb.name, sha: key }, x: p.x, y: p.y }; cx.notify(); return; }
        const i = key ? this.graph?.rows.findIndex((r) => r.commit === key) : -1;
        const p = e.local_position ?? e.position;
        // another worktree's WIP row has its own menu (open, reveal, copy path, lock, remove, prune, repair).
        if (i >= 0 && this.meta[i].wip && !this.meta[i].wip.current) {
          this.ctx = { wt: this.meta[i].wip, x: p.x, y: p.y }; cx.notify();
          if (!this.os) cx.spawn(async (cx) => { await this.detectOs(); cx.notify(); }); // the item's name follows the OS
          return;
        }
        if (i >= 0 && this.meta[i].stash) { this.ctx = { stash: this.meta[i].stash, x: p.x, y: p.y }; cx.notify(); return; } // Open the stash menu for the clicked row.
        if (i < 0 || this.meta[i].wip || this.meta[i].stash) return; // commit rows only
        const ctx = this.ctx = { sha: key, subject: this.graph.rows[i].subject ?? "", merge: this.graph.rows[i].node.includes("merge"), x: p.x, y: p.y };
        cx.notify();
        // Read the full message before the click; clipboard writes must run inside the click handler, before any await.
        gitRun("git", [...READ, "log", "-1", "--format=%B", key], { cwd: this.repo, on: this.machine ?? undefined })
          .then((r) => { if (r?.code === 0) ctx.body = r.stdout.replace(/\n+$/, ""); }).catch(() => {});
        // Review: the local branches this commit is one of the own commits of, read now (the menu redraws when it arrives).
        cx.spawn(async (cx) => { const b = await this.reviewBranches(key); if (this.ctx === ctx) { ctx.review = b; cx.notify(); } });
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.dnd) { this.dndDrop(cx); return; }
        this.press = null;
        if (!this.drag) return;
        if (this.drag.drawer) save("drawer-" + this.drag.drawer, this.drawer[this.drag.drawer]);
        else { save("wB", this.w.b); save("wG", this.w.g); save("wA", this.w.a); }
        this.drag = null; cx.notify();
      });
    if (!this.graph) return root.p(12).child(this.stats);
    // Conflict Mode fills the area below the toolbar.
    if (this.cv.open) return root.child(this.hd.render(t, cx))
      .child(div().relative().flex().flex_col().flex_1().min_w(0).min_h(0).child(this.cv.render(t, cx, s)).children(this.hd.snackView(t)))
      .children(this.hd.modalView(t, this.size?.width));
    const detached = Boolean(this.detailPane());
    const open = Boolean(this.sel) && !detached && Boolean(s);
    // Drawer first: it syncs this.dv to the selection, which the diff below reads.
    const file = this.openFile(), drawer = this.drawerView(side, open, t, cx, file);

    const { b: wB, g: wG, a: wA } = this.w;
    const lanes = this.graph.lane_count, rows = this.graph.rows;
    const rowZoom = zoom();
    this.lanePaths.configure(this.layoutGeneration, rowZoom);
    const divider = (col) => div().flex_none().w(7).h_full().cursor_col_resize().flex().justify_center()
      .child(div().w(1).h_full().bg(this.drag?.col === col ? t.accent ?? fg : alpha(fg, "26")))
      .on_mouse_down("left", (e, cx) => { this.drag = { col, x0: e.position.x, w0: this.w[col] }; cx.stop_propagation(); cx.notify(); });
    const head = h_flex().flex_none().h(26).items_center().text_xs().text_color(dim)
      .child(div().w(wB).flex_none().pl(10).truncate().child("BRANCH / TAG")).child(divider("b"))
      .child(div().w(wG).flex_none().pl(4).truncate().child(this.sx > 0 ? `GRAPH  ◀ ${Math.round(this.sx / LANE_W)}` : "GRAPH")).child(divider("g"))
      .child(div().flex_1().min_w(0).pl(4).truncate().child("MESSAGE")).child(divider("a"))
      .child(div().w(wA).flex_none().truncate().child("AUTHOR")).child(div().w(44 + 10).flex_none());

    const sx = this.sx;
    const onWheel = (e, cx) => {
      const dx = e.delta.x !== 0 ? e.delta.x : e.modifiers?.shift ? e.delta.y : 0;
      if (dx === 0 || Math.abs(dx) < Math.abs(e.delta.y) * (e.modifiers?.shift ? 0 : 1)) return; // vertical gesture: leave it to the list
      const next = Math.min(this.maxScroll(), Math.max(0, this.sx - dx));
      cx.stop_propagation();
      if (next !== this.sx) { this.sx = next; cx.notify(); }
    };
    // Align WIP / stash dashes across BRANCH and GRAPH: end on a 3 px gap at the column edge, fit one 4 + 3 period
    // in the 7 px divider gap, and start the lane path's [4, ROW_H/4 - 4] dash at the GRAPH edge.
    // ponytail: the path gap is 3.25 rather than 3 px; align the periods if the difference becomes visible.
    const dashTo = (c) => h_flex().flex_1().min_w(4).h(2).gap(3).pr(3).justify_end().overflow_hidden().children(Array.from({ length: 60 }, () => div().flex_none().w(4).h(2).bg(c)));
    const dashGap = (c) => div().w(7).flex_none().h_full().flex().items_center().child(div().w(4).h(2).bg(c));
    const wipRow = (r, w, c, i) => {
      const on = r.commit === this.sel;
      const mark = w.current ? "✏ " : "🌲 ", name = w.branch ?? `detached ${w.head.slice(0, 7)}`;
const dashes = dashTo(c);
      return h_flex().w_full().h(ROW_H).flex_none().items_center().overflow_hidden().relative().bg(alpha(c, on ? selA : WIP_A[dark ? "dark" : "light"]))
        .child(div().absolute().left(0).top(0).bottom(0).w(on ? SEL_BAR : 2).bg(c))
        .child(h_flex().w(wB).flex_none().h_full().items_center().overflow_hidden().pl(10).gap(4)
          // WIP labels use the ref style: lane-colour fill, solid rim and theme text.
          .child(this.label({ name: mark + name, kind: "wip" }, c, t))
          .child(dashes))
        .child(dashGap(c))
        .child(div().w(wG).flex_none().h_full().overflow_hidden().relative()
          .child(div().relative().left(-sx).w(cellW(lanes)).h_full().child(laneCell(r, { lanes, palette, connectFrom: sx, cache: this.lanePaths, index: i }))))
        .child(div().w(7).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_sm().text_color(dim).child(`// WIP — ${w.n} change${w.n === 1 ? "" : "s"}`))
        .child(div().w(7).flex_none())
        .child(h_flex().flex_none().mr(10).gap(6).text_sm().font_semibold()
          .children(w.add == null ? [] : [div().text_color(t.ansi2 ?? fg).child(`+${w.add}`), div().text_color(t.ansi1 ?? fg).child(`-${w.del}`)]));
    };
    // A stash row: the stash colour (palette slot STASH_C, see buildGraph), inbox icon + stash@{n}, dashed to its base, the message, its age.
    const stashRow = (r, x, c, i) => {
      const on = r.commit === this.sel;
const dashes = dashTo(c);
      return h_flex().w_full().h(ROW_H).flex_none().items_center().overflow_hidden().relative().when(on, (e) => e.bg(alpha(c, selA)))
        .children(on ? [div().absolute().left(0).top(0).bottom(0).w(SEL_BAR).bg(c)] : [])
        .child(h_flex().w(wB).flex_none().h_full().items_center().overflow_hidden().pl(10).gap(4)
          .child(h_flex().flex_shrink_1().min_w(0).h(22).px(7).gap(5).rounded(5).items_center().text_sm().whitespace_nowrap().overflow_hidden()
            .bg(alpha(c, LABEL_GLASS)).border_1().border_color(c).text_color(t.foreground)
            .child(svg("mods/git-grapher/icons/inbox.svg").size(13).flex_none().text_color(t.foreground)).child(div().truncate().child(x.ref)))
          .child(dashes))
        .child(dashGap(c))
        .child(div().w(wG).flex_none().h_full().overflow_hidden().relative()
          .child(div().relative().left(-sx).w(cellW(lanes)).h_full().child(laneCell(r, { lanes, palette, connectFrom: sx, cache: this.lanePaths, index: i }))))
        .child(div().w(7).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_sm().text_color(dim).child(x.msg))
        .child(div().w(7).flex_none())
        .child(div().w(wA).flex_none())
        .child(div().w(44).flex_none().mr(10).text_right().text_sm().text_color(dim).child(ago(x.at)));
    };
    const row = (r, i) => {
      const m = this.meta[i], c = palette[r.color % palette.length];
      if (m.wip) return wipRow(r, m.wip, c, i);
      if (m.stash) return stashRow(r, m.stash, c, i);
      const refs = this.refs.get(r.commit);
      // Avatar nodes are enabled by default in Settings. When disabled, show the face before the subject and use
      // dot nodes: larger with a ring for HEAD, a ring for merges.
      const faceNode = (this.p.avatars ?? ggxSettings().avatars) !== false, face = this.avatar(m); // props.avatars: screenshots
      const cellRow = { ...r, avatar: faceNode ? face : null };
      const on = r.commit === rowOf(this.sel);
      return h_flex().w_full().h(ROW_H).flex_none().items_center().overflow_hidden().relative()
        .when(on, (el) => el.bg(alpha(c, selA)))
        .when(this.orphans?.has(r.commit), (el) => el.opacity(0.5)) // on no branch: kept visible, but dimmed
        .children(on ? [div().absolute().left(0).top(0).bottom(0).w(SEL_BAR).bg(c)] : [])
        .child(h_flex().w(wB).flex_none().h_full().items_center().overflow_hidden().pl(10).gap(4)
          .children(refs ? refs.map((x) => this.label(x, c, t, r.commit)) : [])
          // connector from the last label to the column edge (continues inside GRAPH)
          .children(refs ? [div().flex_1().min_w(4).ml(-4).h(2).bg(c)] : [])) // ml -4: cancels the gap, so the line meets the label
        .child(div().w(7).flex_none().h_full().children(refs ? [div().mt(ROW_H / 2 - 1).h(2).bg(c)] : []))
        .child(div().w(wG).flex_none().h_full().overflow_hidden()
          .relative()
          // Band first = painted under the lane cell (lines, then node). Not inside the scrolled div: it never moves.
          .child(div().absolute().left(BAND.inset).right(BAND.inset).top((ROW_H - BAND.h) / 2).h(BAND.h).rounded(BAND.r).bg(alpha(c, bandA)))
          .child(div().relative().left(-sx).w(cellW(lanes)).h_full()
            .child(laneCell(cellRow, { lanes, palette, connectFrom: refs ? sx : undefined, cache: this.lanePaths, index: i })))
          // Edge treatment: a node scrolled out of the column leaves a half dot on that edge.
          .children(X(r.lane) + AV / 2 <= sx ? [div().absolute().left(-5).top(ROW_H / 2 - 5).size(10).rounded_full().bg(c)]
            : X(r.lane) - AV / 2 >= sx + wG ? [div().absolute().right(-5).top(ROW_H / 2 - 5).size(10).rounded_full().bg(c)] : []))
        .child(div().w(7).flex_none())
        .when(!faceNode, (el) => el.child(face.file ? image(face.file).size(16).rounded_full().flex_none().mr(6)
          : div().size(16).flex_none().mr(6).rounded_full().bg(face.tint).flex().items_center().justify_center().text_size(9).text_color("#ffffff").child(face.initial)))
        .child(div().flex_1().min_w(0).truncate().text_sm().child(r.subject ?? ""))
        .child(div().w(7).flex_none()) // under the MESSAGE | AUTHOR divider
        .child(div().w(wA).flex_none().truncate().text_sm().text_color(dim).child(m.an))
        .child(div().w(44).flex_none().mr(10).text_right().text_sm().text_color(dim).child(ago(m.at)));
    };
    const off = this.off;
    // Virtual-list row handlers throw TypeError, so catch GRAPH wheel events in a transparent overlay.
    // It paints above the list: consume horizontal gestures and pass vertical ones through to the list.
    const graph = v_flex().size_full()
      .child(head)
      .child(div().relative().flex_1().min_h(0).flex().flex_col()
        // The press, for on_item_click (key only): a double-click and where along the row it was.
        .on_mouse_down("left", (e, _cx) => { const l = e.local_position ?? e.position; this.press = { n: e.click_count, x: l.x, y: l.y, px: e.position.x, py: e.position.y }; })
        .on_mouse_down("right", (e, _cx) => { this.rpress = { x: (e.local_position ?? e.position).x }; }) // for a label's menu
        .child(v_virtual_list("rows", rows.length - off, ROW_H, (i) => rows[i + off].commit, ({ start, end }) => {
        const t0 = now(), out = []; this.view = { start, end };
        setZoom(rowZoom); // deferred rows may run after another copy at a different zoom
        this.lanePaths.retain(start + off, end + off, off);
        if (this.pendingFollow) { const f = this.pendingFollow; this.pendingFollow = null; this.follow(f); }
        try {
          for (let i = start + off; i < end + off; i++) {
            const el = row(rows[i], i), mv = this.motion && this.rowMotion(i);
            out.push(mv ? el.top(mv.dy).opacity(mv.op) : el);
          }
        }
        catch (e) { console.log("[ggit] row error " + e + " " + e.stack); return [div().h(ROW_H).child(String(e))]; }
        this.builds.push(now() - t0);
        if (this.builds.length > 2000) this.builds.splice(0, 1000);
        return out;
      }).flex_1().track_scroll(this.scroll)
        .on_item_click((sha, cx) => {
          if (this.dnd) return; // a label drag released over its own row: no selection
          this.calibrate(sha);
          this.focus.focus();
          // A double-click on a branch label switches to it; the row stays selected.
          const p = this.press, lb = p?.n >= 2 && this.labelAt(sha, p.x);
          this.press = null;
          if (lb) { this.select(sha, cx); this.switchTo(lb, cx); return; }
          this.select(sha === this.sel ? null : sha, cx);
        })
        .on_item_secondary_click((key, _e, _cx) => { this.ctxKey = key; }))
        .child(div().absolute().top(0).bottom(0).left(wB + 7).w(wG).on_scroll_wheel(onWheel)
          .child(shadowEdge("left", sx > 0, t, wG))
          .child(shadowEdge("right", sx < this.maxScroll(), t, wG))))
      // History stops at the configured limit; Load more commits reads another 1,000 while retaining the viewport anchor.
      .child(h_flex().flex_none().px(10).py(4).gap(8).items_center().text_xs().text_color(dim)
        .child(div().min_w(0).truncate().child(this.stats))
        .when(Boolean(this.history?.omitted), (e) => e.child(div().id("load-more").flex_none().px(8).h(20).flex().items_center().rounded(5)
          .cursor_pointer().border_1().border_color(t.input ?? t.border).text_color(t.foreground).hover((h) => h.bg(t.hover ?? t.raised))
          .on_click((_e, cx) => { this.loadingMore = true; cx.notify(); cx.spawn(async (cx) => { await this.st.more(); this.loadingMore = false; cx.notify(); }); })
          .child(this.loadingMore ? "Loading…" : "Load more commits"))));
    // Keep the graph laid out but invisible under the diff to preserve native scroll state; sx, widths and selection
    // remain on the view. Keep the drawer below the full-width toolbar so opening it never moves toolbar buttons.
    return root.child(this.hd.render(t, cx))
      .children([this.cv.strip(t)].filter(Boolean))
      .child(div().flex().when(side === "bottom", (e) => e.flex_col()).flex_1().min_w(0).min_h(0)
        // Put the rail and graph in their own row; in a bottom-drawer column, a direct rail child would take the full height.
        .child(h_flex().flex_1().min_w(0).min_h(0).items_stretch()
        .child(sideRail(this, t))
        .child(div().relative().flex_1().min_w(0).min_h(0)
          .child(file || this.hist ? graph.invisible() : graph)
          .when(Boolean(this.hist), (e) => e.child(div().absolute().inset_0().child(this.histView(t, cx))))
          .when(Boolean(file), (e) => e.child(div().absolute().inset_0().bg(t.background)
            .on_mouse_down("left", () => this.focus.focus()) // the graph's keys (Esc, ⌘C for picked rows) serve the diff
            .child(this.dv.fileDiff(file, { t, cx, onBack: (cx) => { this.write(null); this.focus.focus(); cx.notify(); } }))))
          .children(this.hd.snackView(t))
          .children(file ? [] : [sidePanel(this, t)].filter(Boolean))))
        .child(drawer))
      .children(this.hd.modalView(t, this.size?.width))
      .children(this.ctx ? [this.ctxMenu(t)] : [])
      .children(this.dndGhost(t));
  }

  // Branch and tag menus use { kind: "local" | "remote" | "tag", name, sha }. Writes go through the header dialogs
  // and shared queue. A sidebar-opened menu keeps its list visible; choosing, leaving or clicking outside closes both.
  menuClose() {
    const side = Boolean(this.ctx?.fromSide);
    return {
      hold: this.ctx ?? {},
      onClose: (cx) => { this.ctx = null; if (side) { this.side = null; this.sidePinned = false; } cx.notify(); },
      onLeave: side ? (cx) => { this.ctx = null; this.side = null; this.sidePinned = false; cx.notify(); } : null,
    };
  }

  // Stash menu: Peek, Pop, Apply (keep it), Drop. Use OIDs so changing stash indices cannot redirect an action.
  stashMenu(t) {
    const x = this.ctx.stash, hd = this.hd;
    return contextMenu(t, { x: this.ctx.x, y: this.ctx.y, paneW: this.size?.width, paneH: this.size?.height, title: `${x.ref ?? "stash"}: ${x.msg}`,
      ...this.menuClose(),
      sections: [
        { label: "Stash", items: [["Peek", (cx) => this.select(x.oid, cx), { icon: "info" }],
          ["Pop", (cx) => hd.op("pop", () => hd.g.stashPop(hd.t, x.oid, []), cx), { icon: "inbox" }],
          ["Apply (keep the stash)", (cx) => hd.op("apply", () => hd.g.stashApply(hd.t, x.oid, []), cx), { icon: "copy" }],
          ["Drop…", (cx) => hd.openDrop(cx, x), { icon: "trash" }]] },
        { label: "Copy", items: [["Copy SHA", (cx) => { cx.write_to_clipboard(x.oid); hd.note(cx, "Copied the SHA"); }, { icon: "hash" }]] },
      ] });
  }

  refMenu(t) {
    const { ref: r, x, y } = this.ctx, hd = this.hd, at = { sha: r.sha, subject: "" }, cur = this.st?.state.headBranch ?? null, head = r.kind === "local" && r.name === cur;
    const copy = (text, what) => (cx) => { cx.write_to_clipboard(text); hd.note(cx, `Copied ${what}`); };
    const go = r.kind === "local"
      ? (head ? [["Pull", hd.pullRefused() ? null : (cx) => hd.pull(cx), { icon: "arrow-down" }], ["Push", (cx) => { const h = hd.h; hd.op("push", () => hd.g.push(hd.t, h), cx); }, { icon: "arrow-up" }],
        ["Fetch", (cx) => hd.fetch(cx, false), { icon: "refresh-cw" }]] : [["Check out", (cx) => this.switchTo(r, cx), { icon: "git-commit" }]])
      : r.kind === "remote" ? [["Check out as a local branch", (cx) => this.switchTo(r, cx), { icon: "git-commit" }],
        ["Fetch this branch", (cx) => hd.op("fetch-branch", () => hd.g.fetchBranch(hd.t, r.name), cx), { icon: "refresh-cw" }]]
      : [["Push tag…", (cx) => hd.openTagPush(cx, r.name, r.sha), { icon: "arrow-up" }]];
    return contextMenu(t, { x, y, paneW: this.size?.width, paneH: this.size?.height, title: (r.kind === "tag" ? "🏷 " : r.kind === "remote" ? "☁ " : "") + r.name,
      ...this.menuClose(),
      sections: [
        { label: r.kind === "tag" ? "Tag" : "Branch", items: go },
        { label: "Compare", items: [
          ...(r.kind === "local" ? [[`Review ${r.name} since it branched`, (cx) => this.select(`br:${r.sha}:${r.name}`, cx), { icon: "git-pull-request", accent: true }]] : []),
          ["Compare with HEAD", (cx) => this.select("cmp:" + r.sha, cx), { icon: "git-compare" }]] },
        // merge it into the checked-out branch, or (a local branch) the checked-out branch into it without checking it out.
        ...(cur && !head ? [{ label: "Merge", items: [[`Merge ${r.name} into ${cur}…`, (cx) => hd.openMerge(cx, fullRef(r), null), { icon: "git-merge" }],
          ...(r.kind === "local" ? [[`Merge ${cur} into ${r.name}…`, (cx) => hd.openMerge(cx, `refs/heads/${cur}`, r.name), { icon: "git-merge" }]] : [])] }] : []),
        { label: "Create from it", items: [["Create branch here…", (cx) => hd.openBranch(cx, at), { icon: "git-branch" }],
          ["Create worktree here…", (cx) => hd.openWorktree(cx, at), { icon: "folder-open" }], ["Create tag here…", (cx) => hd.openTag(cx, at), { icon: "tag" }]] },
        ...(r.kind === "local" ? [{ label: "Manage", items: [["Rename…", (cx) => hd.openRename(cx, r.name), { icon: "pencil-line" }],
          ["Set upstream…", (cx) => hd.openUpstream(cx, r.name), { icon: "cloud" }],
          ["Delete…", head ? null : (cx) => hd.openDelete(cx, r.name), { icon: "trash" }]] }] : []),
        ...(r.kind === "remote" ? [{ label: "Manage", items: [["Delete on the remote…", (cx) => hd.openRemoteDelete(cx, r.name, r.sha), { icon: "trash" }]] }] : []),
        { label: "Copy", items: [["Copy name", copy(r.name, "the name"), { icon: "copy" }], ["Copy SHA", copy(r.sha, "the SHA"), { icon: "hash" }]] },
      ] });
  }

  // "Darwin" | "Linux" | … from uname; "Windows" when uname is missing. Read once.
  async detectOs() {
    if (!this.os) this.os = await exec("uname", ["-s"]).then((r) => (r.code === 0 ? r.stdout.trim() : "Windows")).catch(() => "Windows");
    return this.os;
  }

  // Worktree WIP menu. Reveal uses `open -R` on macOS and xdg-open on other supported systems.
  wtMenu(t) {
    const w = this.ctx.wt, hd = this.hd, name = w.branch ?? `detached ${w.head.slice(0, 7)}`;
    // Reveal by OS: on Linux `open` is often openvt, so it is never tried there. uname fails on Windows.
    // The OS is read at the click (detectOs), never guessed: a guess of macOS would run `open -R` on Linux.
    const reveal = (cx) => cx.spawn(async () => {
      const os = await this.detectOs();
      await (os === "Darwin" ? exec("open", ["-R", w.path]) : os === "Windows" ? exec("explorer", [`/select,${w.path}`]) : exec("xdg-open", [w.path])).catch(() => {});
    });
    const revealLabel = this.os === "Darwin" ? "Reveal in Finder" : this.os === "Windows" ? "Show in Explorer" : this.os ? "Open in file manager" : "Reveal in file manager";
    return contextMenu(t, { x: this.ctx.x, y: this.ctx.y, paneW: this.size?.width, paneH: this.size?.height, title: `🌲 ${name}`,
      ...this.menuClose(),
      sections: [
        { label: "Open", items: [["Open in a new tab", () => run("tab.new", { folder: w.path }), { icon: "plus" }],
          [revealLabel, reveal, { icon: "folder-open" }],
          ["Copy path", (cx) => { cx.write_to_clipboard(w.path); hd.note(cx, "Copied the path"); }, { icon: "copy" }]] },
        // Long branch names cut the item: the name goes in the confirm card instead.
        { label: "Worktree", items: [[w.locked ? "Unlock" : "Lock", (cx) => hd.op("wt-lock", () => hd.g.worktreeLock(hd.t, w.path, !w.locked), cx), { icon: w.locked ? "lock-open" : "lock" }],
          ["Remove worktree…", (cx) => hd.confirmRemove(cx, w, false), { icon: "trash" }],
          ...(w.branch ? [["Remove worktree and its branch…", (cx) => hd.confirmRemove(cx, w, true), { icon: "trash" }]] : [])] },
        { label: "All worktrees", items: [["Prune stale worktrees", (cx) => hd.op("wt-prune", () => hd.g.worktreePrune(hd.t), cx), { icon: "refresh-cw" }],
          ["Repair worktrees", (cx) => hd.op("wt-repair", () => hd.g.worktreeRepair(hd.t), cx), { icon: "settings" }]] },
      ] });
  }

  // Selecting a sidebar row centres and selects its commit, then closes the list (stashes keep it open).
  // Worktrees select their WIP row, falling back to HEAD. Switching uses graph label double-clicks or menus;
  // sidebar double-clicks could land on the graph after the first click closes the list.
  sidePick(r, cx) {
    const sha = r.ref === "worktree" ? (r.w.n ? "wip:" + r.w.path : r.w.head) : r.sha;
    const i = this.graph?.rows.findIndex((x) => x.commit === sha) ?? -1;
    if (i < 0) { this.hd.note(cx, "Not in the commits read so far (Load more commits)"); return; }
    this.select(sha, cx);
    if (i >= this.off) this.scroll.scroll_to_item(i - this.off, "center");
    if (r.ref !== "stash") { this.side = null; this.sidePinned = false; }
    cx.notify();
  }

  // Offer Review up to here for each local branch containing this commit among its own commits.
  // forkPoint excludes that branch from the comparison set.
  // ponytail: inspect at most eight branches; page or cache the search if more candidates are needed.
  async reviewBranches(sha) {
    const git = async (args, ok = [0]) => {
      const r = await gitRun("git", [...READ, ...args], { cwd: this.repo, on: this.machine ?? undefined });
      if (!ok.includes(r.code)) throw new Error(r.stderr); return r.stdout;
    };
    const names = (await git(["for-each-ref", "--format=%(refname:short)", "--contains", sha, "refs/heads"]).catch(() => "")).trim().split("\n").filter(Boolean).slice(0, 8);
    const out = [];
    for (const b of names) if (await forkPoint(git, sha, b).catch(() => null)) out.push(b);
    return out;
  }

  // Commit row menu. Every write goes through the header's dialogs.
  ctxMenu(t) {
    if (this.ctx.wt) return this.wtMenu(t);
    if (this.ctx.ref) return this.refMenu(t);
    if (this.ctx.stash) return this.stashMenu(t);
    const c = this.ctx, at = { sha: c.sha, subject: c.subject }, hd = this.hd;
    const tips = new Set((this.refs.get(c.sha) ?? []).filter((x) => x.kind === "local").map((x) => x.name));
    const copy = (text, what) => (cx) => { cx.write_to_clipboard(text); hd.note(cx, `Copied ${what}`); };
    const copyMessage = (cx) => { cx.write_to_clipboard(c.body ?? c.subject); hd.note(cx, "Copied the commit message"); };
    return contextMenu(t, { x: c.x, y: c.y, paneW: this.size?.width, paneH: this.size?.height, title: `${c.sha.slice(0, 7)} ${c.subject}`,
      onClose: (cx) => { this.ctx = null; cx.notify(); },
      sections: [
        // Compare first; every item has an icon, Review in the accent colour.
        { label: "Compare", items: [
          // Review a branch from its fork point, as a pull request would.
          ...(c.review ?? []).map((b) => [tips.has(b) ? `Review ${b} since it branched` : `Review ${b} up to this commit`, (cx) => this.select(`br:${c.sha}:${b}`, cx), { icon: "git-pull-request", accent: true }]),
          ["Compare with HEAD", (cx) => this.select("cmp:" + c.sha, cx), { icon: "git-compare" }]] },
        { label: "Inspect", items: [["Copy SHA", copy(c.sha, "the SHA"), { icon: "copy" }],
          ["Copy short SHA", copy(c.sha.slice(0, 7), "the short SHA"), { icon: "hash" }], ["Copy commit message", copyMessage, { icon: "message-square-text" }]] },
        { label: "Create from this commit", items: [["Create branch here…", (cx) => hd.openBranch(cx, at), { icon: "git-branch" }], ["Create worktree here…", (cx) => hd.openWorktree(cx, at), { icon: "folder-open" }],
          ["Create tag here…", (cx) => hd.openTag(cx, at), { icon: "tag" }]] },
        { label: "Apply changes", items: [["Revert this commit…", c.merge ? null : (cx) => hd.confirm(cx, "revert", at), { icon: "undo" }]] },
        { label: "Checkout / Move", items: [["Check out this commit… (detached HEAD)", (cx) => hd.confirm(cx, "checkout", at), { icon: "git-commit" }]] },
      ] });
  }
}
