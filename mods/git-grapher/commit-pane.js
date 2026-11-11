// The WIP commit pane: unstaged and staged files with per-file and bulk actions, List/Tree views, and a message editor.
// Bottom drawer: file lists side by side above the editor. Right sidebar: lists and editor stacked.
// DetailView owns the loaded WIP and reloads after writes through lib/core.js.
// ponytail: one HEAD-to-worktree diff per file; split index and worktree diffs if hunk staging is added.
import { div, h_flex, v_flex, svg, Input, Textarea } from "./ui/zoom.js";
import { InputState, TextareaState } from "gpui-base";
import { exec, setShared } from "herdr";
import { createGgit, herdrAdapter } from "./lib/core.js";
import { generate } from "./generate.js";
import { buildTree, treeRows } from "./lib/detail.js";
import { segmented } from "./ui/segmented.js";

const alpha = (c, a) => (c && c.length === 7 ? c + a : c);
// Animate file rows with native GPUI transitions: 180 ms ease-out, new rows fading in, removed rows fading out
// at their old slots, and surviving rows sliding into place. More than 64 changed rows settle immediately.
// Each slot is 28 px high. Updating top/opacity targets in two or three renders avoids a JS-driven 16 ms redraw loop.
const ROW_H = 28, MOTION_MS = 180, MAX_ANIMATED = 64;
const ICON = (n) => svg(`mods/git-grapher/icons/${n}.svg`);
const FILES_ICON = (n) => svg(`mods/files/${n}.svg`);

export class CommitPane {
  constructor() {
    this.summary = InputState.new({ placeholder: "Summary" });
    this.desc = TextareaState.new({ placeholder: "Description (optional)", rows: 3 });
    this.desc.set_auto_grow(3, 12); // grows with the text from 3 to 12 lines, then scrolls inside
    this.desc.on("change", (_e, cx) => cx.notify()); // the Template toggle follows the text
    this.summary.on("change", (_e, cx) => cx.notify());
    this.summary.on("submit", (_e, cx) => this.commit(cx));
    this.amend = false; this.loaded = null; // loaded = the last message Amend put in the fields
    this.mode = { u: "tree", s: "tree" }; this.closed = { u: new Set(), s: new Set() };
    this.busy = null; this.note = null; this.ask = null;
    this.fresh = { u: new Set(), s: new Set() }; this.ghosts = { u: [], s: [] }; // keys fading in (opacity 0 this render) / rows fading out
  }

  // On-screen rows of a section, in order: { key, file, depth, name } or { key, dir }. Rendering and splice() share it.
  items(k, files) {
    if (this.mode[k] === "path") return files.map((f) => ({ key: "f:" + f.path, file: f, depth: 0, name: null }));
    return treeRows(buildTree(files), this.closed[k]).map((r) => r.kind === "file"
      ? { key: "f:" + r.file.path, file: r.file, depth: r.depth, name: r.name } : { key: "d:" + r.path, dir: r });
  }

  // The lists changed (a reload after a write, or a fold): new keys start at opacity 0 and go to 1 a frame later; removed
  // rows stay drawn at their old slot going to 0, and leave after the transition. Rows that moved slot slide by themselves.
  splice(was, cx) {
    let any = false;
    for (const k of ["u", "s"]) {
      if (!was[k]) continue;
      const now = this.items(k, k === "u" ? this.ctx.c.unstaged : this.ctx.c.staged);
      const before = new Set(was[k].map((x) => x.key)), after = new Set(now.map((x) => x.key));
      const ins = now.filter((x) => !before.has(x.key)), del = was[k].flatMap((x, i) => (after.has(x.key) ? [] : [{ it: x, slot: i }]));
      if (!ins.length && !del.length) continue;
      if (ins.length + del.length > MAX_ANIMATED) { this.fresh[k] = new Set(); this.ghosts[k] = []; continue; }
      this.fresh[k] = new Set(ins.map((x) => x.key));
      this.ghosts[k] = [...this.ghosts[k].filter((g) => !after.has(g.it.key)), ...del.map((g) => ({ ...g, out: false }))];
      any = true;
    }
    if (!any) return;
    cx.spawn(async (cx) => {
      await cx.sleep(16); // the first render placed them; now the targets move and GPUI animates
      this.fresh = { u: new Set(), s: new Set() };
      for (const k of ["u", "s"]) for (const g of this.ghosts[k]) g.out = true;
      cx.notify();
      await cx.sleep(MOTION_MS + 40);
      for (const k of ["u", "s"]) this.ghosts[k] = this.ghosts[k].filter((g) => !g.out);
      cx.notify();
    });
  }
  snapshot() { const c = this.ctx?.c; return c ? { u: this.items("u", c.unstaged), s: this.items("s", c.staged) } : {}; }

  // ctx: { c, machine, reload(cx), changed(cx) } is set by DetailView before render.
  // Writes join the graph store's queue when available; a standalone detail pane calls ggit directly.
  git() { return this.ctx.store?.g ?? createGgit(herdrAdapter(exec, this.ctx.machine ?? undefined)); }

  // Serialize writes to avoid git index.lock conflicts. move(c) updates the lists optimistically at the click;
  // the actual lists replace that guess when the queue drains. Only Commit / Amend reload graph history;
  // other writes refresh WIP rows and header counts.
  op(name, fn, cx, ok = null, move = null) {
    if (move) { const was = this.snapshot(); move(this.ctx.c); this.splice(was, cx); }
    const history = name === "commit" || name === "amend";
    if (history) this.busy = name;
    this.pending = (this.pending ?? 0) + 1; this.note = null; cx.notify();
    // Capture the target and join the store queue at the click, so later selection changes cannot redirect a write
    // and later actions elsewhere in the UI cannot overtake it.
    const ctx = this.ctx, t = { root: ctx.c.path }; // the WIP row's worktree, which may be a linked one
    this.clicks = (this.clicks ?? 0) + 1; // reads begun before this write ends do not land (DetailView.reload)
    const t0 = Date.now();
    const g0 = ctx.store ? null : this.git(); // Capture the standalone pane's adapter at the click too.
    const write = (ctx.store ? ctx.store.write(name, (g) => fn(g, t)) : this.serial(() => fn(g0, t)))
      .catch((e) => ({ outcome: "refused", stderr: String(e?.message ?? e) }));
    const run = async (cx) => {
      const r = await write;
      this.written = (this.written ?? 0) + 1;
      const t1 = Date.now();
      this.pending--; if (history) this.busy = null;
      if (r.outcome === "completed") ok?.(r);
      else this.note = { error: true, text: (r.stderr || r.reason || r.outcome || "Failed").split("\n")[0] };
      // The last write to finish reloads the current pane, even if it ran on a different store, so no optimistic list remains stale.
      if (this.pending > 0) return;
      await this.ctx?.reload?.(cx);
      const t2 = Date.now(); cx.notify(); // The store has already refreshed after the write.
      // Publish the last write's timings to shared.json -> ggx.perf.commit for performance diagnosis.
      setShared("ggit.perf.commit", { op: name, write: t1 - t0, reload: t2 - t1, graph: Date.now() - t2, at: new Date().toISOString(),
        cmds: (r.commands ?? []).map((c) => c.args.join(" ").slice(0, 80)) });
    };
    // The click's cx is invalid after an await; run the queue in a task with its own context.
    cx.spawn(async (tcx) => {
      await run(tcx).catch((e) => setShared("ggit.perf.commit", { op: name, error: String(e?.message ?? e), at: new Date().toISOString() }));
    });
  }
  // A bare detail (no graph store): its own one-at-a-time chain, entered at the click.
  serial(fn) { const p = (this.chain ?? Promise.resolve()).then(fn, fn); this.chain = p.catch(() => {}); return p; }

  // The guesses for move: paths go from one list to the other in git's order (by path; untracked files after the rest).
  static byPath(a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; }
  moveStage(paths) {
    return (c) => {
      const p = paths && new Set(paths), go = c.unstaged.filter((f) => !p || p.has(f.path));
      c.unstaged = c.unstaged.filter((f) => p && !p.has(f.path));
      const keep = c.staged.filter((f) => !go.some((g) => g.path === f.path));
      c.staged = [...keep, ...go.map((f) => ({ ...f, status: f.untracked ? "A" : f.status, untracked: false }))].sort(CommitPane.byPath);
    };
  }
  moveUnstage(paths) {
    return (c) => {
      const p = paths && new Set(paths), go = c.staged.filter((f) => !p || p.has(f.path));
      c.staged = c.staged.filter((f) => p && !p.has(f.path));
      const keep = c.unstaged.filter((f) => !go.some((g) => g.path === f.path));
      const back = go.map((f) => (f.status === "A" ? { ...f, untracked: true } : f)); // a staged new file goes back to untracked
      const all = [...keep, ...back];
      c.unstaged = [...all.filter((f) => !f.untracked).sort(CommitPane.byPath), ...all.filter((f) => f.untracked).sort(CommitPane.byPath)];
    };
  }
  moveDiscard(files) { return (c) => { const p = files && new Set(files.map((f) => f.path)); c.unstaged = c.unstaged.filter((f) => p && !p.has(f.path)); }; }

  message() { const s = this.summary.value().trim(), d = this.desc.value().replace(/\s+$/, ""); return s ? (d ? `${s}\n\n${d}` : s) : ""; }
  // Protect a draft in either field, including a description with no summary.
  typed() { return Boolean(this.summary.value().trim() || this.desc.value().trim()); }
  fields() { return this.summary.value() + "\0" + this.desc.value(); }

  commit(cx) {
    const msg = this.message(), amend = this.amend, sent = this.fields(), at = this.ctx;
    if (!msg || (!amend && !this.ctx.c.staged.length)) return;
    this.op(amend ? "amend" : "commit", (g, t) => g.commit(t, msg, { amend }), cx, (r) => {
      // Clear the message only if it still matches the committed draft. Reset fields and Amend only in the originating pane.
      const same = this.ctx?.c?.path === at.c.path && this.ctx?.machine === at.machine;
      if (same && this.fields() === sent) { this.summary.set_value(""); this.desc.set_value(""); }
      if (same) { this.amend = false; this.loaded = null; }
      this.note = { text: `${amend ? "Amended" : "Committed"} ${r.head?.slice(0, 7) ?? ""}` };
    });
  }

  // Generate a message from staged changes. Replace fields only if the draft is unchanged since the click
  // and the pane still shows the originating worktree.
  generate(cx) {
    const ctx = this.ctx, staged = ctx.c.staged ?? [];
    if (this.generating) return;
    if (!staged.length) { this.note = { error: true, text: "Stage something first: the message is written from the staged changes" }; cx.notify(); return; }
    this.generating = true; this.note = null; cx.notify();
    const before = this.fields();
    cx.spawn(async (cx) => {
      const r = await generate(ctx.c.path, staged, ctx.machine ?? null).catch((e) => ({ message: "", note: String(e?.message ?? e) }));
      this.generating = false;
      // Match both worktree path and machine before applying the generated message.
      if (this.ctx?.c?.path === ctx.c.path && (this.ctx?.machine ?? null) === (ctx.machine ?? null) && this.fields() === before && r.message) {
        const [first, ...rest] = r.message.split("\n");
        this.summary.set_value(first); this.desc.set_value(rest.join("\n").replace(/^\n+/, ""));
      }
      if (r.note) this.note = { text: r.note };
      cx.notify();
    });
  }

  // Amend on: the last message fills empty fields. Off: fields still holding that message are cleared.
  toggleAmend(cx) { this.amend = !this.amend; cx.notify(); cx.spawn((tcx) => this.amendFill(tcx)); }
  async amendFill(cx) {
    const ctx = this.ctx, t = { root: ctx.c.path };
    if (this.amend && !this.typed()) {
      const n = (this.fillN = (this.fillN ?? 0) + 1);
      const m = await this.git().lastMessage(t);
      // Do not replace a draft typed during the read, update another worktree's pane, or apply a load older than the latest one.
      if (m == null || !this.amend || n !== this.fillN || this.typed() || this.ctx?.c?.path !== ctx.c.path || this.ctx?.machine !== ctx.machine) return;
      const [s, ...rest] = m.split("\n");
      this.summary.set_value(s); this.desc.set_value(rest.join("\n").replace(/^\n+/, "")); this.loaded = m; cx.notify();
    } else if (!this.amend && this.loaded != null && this.message() === this.loaded) {
      this.summary.set_value(""); this.desc.set_value(""); this.loaded = null; cx.notify();
    }
  }

  // Show Template only when commit.template is set; read it once per worktree. Toggling adds or removes it from
  // the description. --cleanup=strip removes "#" lines before committing.
  // ponytail: the toggle starts off each time; persist it if the choice should survive reopening the pane.
  readTemplate(cx) {
    const c = this.ctx?.c, key = `${this.ctx?.machine ?? ""}\0${c?.path}`;
    if (!c || this.tpl?.key === key) return;
    const tpl = (this.tpl = { key, text: null });
    cx.spawn(async (cx) => {
      const path = await this.git().templatePath({ root: c.path }).catch(() => null);
      const r = path ? await exec("cat", ["--", path], { cwd: c.path, on: this.ctx.machine ?? undefined }).catch(() => null) : null;
      if (this.tpl === tpl && r?.code === 0) { tpl.text = r.stdout.replace(/\s+$/, ""); cx.notify(); }
    });
  }
  templateOn() { return Boolean(this.tpl?.text) && this.desc.value().includes(this.tpl.text); }
  template(cx) {
    const tx = this.tpl?.text; if (!tx) return;
    const now = this.desc.value();
    this.desc.set_value(this.templateOn() ? now.replace(tx, "").replace(/\n{3,}/g, "\n\n").trim() : (now.trim() ? `${now.replace(/\s+$/, "")}\n\n${tx}` : tx));
    this.desc.focus(); cx.notify();
  }

  render({ t, dim, wide, picked, row, cx }) {
    if (cx) this.readTemplate(cx);
    const c = this.ctx.c, fg = t.foreground, line = alpha(fg, "1f"), busy = Boolean(this.busy);
    const pill = (id, text, color, fn, on = true) => div().id(id).h(22).px(8).flex_none().flex().items_center().rounded(6).text_size(12)
      .text_color(color).bg(alpha(color, "26")).when(!on, (e) => e.opacity(0.45))
      .when(on, (e) => e.cursor_pointer().hover((h) => h.bg(alpha(color, "40"))).on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }))
      .child(text);
    const green = t.ansi2 ?? "#3fb950", red = t.ansi1 ?? "#f85149", orange = t.ansi3 ?? "#d29922";
    const discardAsk = (files, cx) => { this.ask = { files }; cx.notify(); };

    const section = (k, files) => {
      const u = k === "u", title = `${u ? "Unstaged" : "Staged"} (${files.length})`;
      // Conflicted files show an outlined Conflict label and are resolved in Conflict Mode, without Stage / Discard actions.
      const actions = (f) => f.conflict
        ? div().flex_none().h(20).px(7).flex().items_center().rounded(5).border_1().border_color(red).text_size(11).text_color(red).child("Conflict")
        : u ? h_flex().gap(4).flex_none().child(pill(`dis-${f.path}`, "Discard", red, (cx) => discardAsk([f], cx)))
          .child(pill(`stg-${f.path}`, "Stage", green, (cx) => move([f], cx)))
        : pill(`ust-${f.path}`, "Unstage", orange, (cx) => move([f], cx));
      // Stage / Unstage a set of files (a row, or every file under a folder); a rename takes its old path along.
      const move = (fs, cx) => { const ps = fs.flatMap((f) => [f.path, ...(f.old ? [f.old] : [])]), shown = fs.map((f) => f.path);
        if (u) this.op("stage", (g, tt) => g.stage(tt, ps), cx, null, this.moveStage(shown));
        else this.op("unstage", (g, tt) => g.unstage(tt, ps), cx, null, this.moveUnstage(shown)); };
      // A folder row stages the files under it, leaving conflicts out (as Stage all does).
      const under = (d) => files.filter((f) => f.path.startsWith(d.path) && !f.conflict);
      // A ghost keeps its row's id: the same element, so its opacity animates from where it was.
      const draw = (it, ghost = false) => it.file ? row(it.file, it.depth, it.name, k, ghost ? null : actions(it.file))
        : h_flex().id(`${k}-dir-${it.dir.path}`).h(ROW_H).flex_none().pl(8 + it.dir.depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
          .hover((s) => s.bg(t.hover ?? alpha(fg, "10")))
          .on_click((_e, cx) => { const was = this.snapshot(); if (it.dir.open) this.closed[k].add(it.dir.path); else this.closed[k].delete(it.dir.path); this.splice(was, cx); cx.notify(); })
          .child(FILES_ICON(it.dir.open ? "chevron-down" : "chevron-right").size(12).flex_none().text_color(dim))
          .child(div().flex_1().min_w(0).truncate().text_color(dim).child(it.dir.name))
          .children(ghost ? [] : [(() => { const fs = under(it.dir);
            return pill(`${k}-dir-mv-${it.dir.path}`, u ? "Stage" : "Unstage", u ? green : orange, (cx) => move(fs, cx), fs.length > 0); })()]);
      const list = this.items(k, files), tr = { duration: MOTION_MS, easing: "ease-out" };
      // Every row absolute at its slot (4 = the list's padding); a spacer gives the scroll its height.
      const place = (el, slot, op) => el.absolute().left(4).right(4).top(4 + slot * ROW_H).opacity(op).transition("top", tr).transition("opacity", tr);
      const rows = list.map((it, i) => place(draw(it), i, this.fresh[k].has(it.key) ? 0 : 1));
      const ghosts = this.ghosts[k].map((g) => place(draw(g.it, true), g.slot, g.out ? 0 : 1));
      const n = Math.max(list.length, ...this.ghosts[k].map((g) => g.slot + 1));
      return v_flex().min_w(0).min_h(0).flex_1()
        .child(h_flex().px(10).pt(8).pb(6).gap(6).items_center().text_size(13)
          .child(div().flex_1().min_w(0).truncate().text_color(dim).child(title))
          // While files conflict, Stage all leaves them out (git add -A would take their markers as resolved).
          .children(u ? [pill(`${k}-all`, "Stage all", green, (cx) => { const ok = files.filter((f) => !f.conflict), some = ok.length < files.length ? ok.flatMap((f) => [f.path, ...(f.old ? [f.old] : [])]) : null;
              this.op("stage", (g, tt) => g.stage(tt, some), cx, null, this.moveStage(some)); }, files.some((f) => !f.conflict)),
            pill(`${k}-dis-all`, "Discard all", red, (cx) => discardAsk(null, cx), files.length > 0)]
            : [pill(`${k}-all`, "Unstage all", orange, (cx) => this.op("unstage", (g, tt) => g.unstage(tt), cx, null, this.moveUnstage(null)), files.length > 0)])
          .child(segmented({ id: `mode-${k}`, t, w: 44, value: this.mode[k], options: [{ value: "path", label: "List" }, { value: "tree", label: "Tree" }],
            onChange: (v, cx) => { this.mode[k] = v; this.fresh[k] = new Set(); this.ghosts[k] = []; cx.notify(); } })))
        .child(v_flex().id(`files-${k}`).relative().flex_1().min_h(0).mx(6).mb(6).rounded(8).border_1().border_color(line).overflow_y_scrollbar().text_size(13)
          .child(div().h(n * ROW_H + 8).flex_none())
          .children(rows).children(ghosts)
          .children(n ? [] : [div().absolute().top(4).left(4).p(8).text_size(12).text_color(dim).child(u ? "No unstaged changes" : "Nothing staged")]));
    };

    const can = !busy && Boolean(this.summary.value().trim()) && (this.amend || c.staged.length > 0);
    const field = (el) => el.w_full().px(8).rounded(6).border_1().border_color(alpha(fg, "33")).bg(t.background).text_size(13).text_color(fg);
    const iconBtn = (id, icon, tip, fn, on = false) => div().id(id).h(24).px(6).gap(5).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .text_color(on ? t.accent_foreground ?? "#ffffff" : dim).when(on, (e) => e.bg(t.accent ?? fg))
      .when(!on, (e) => e.hover((h) => h.bg(t.hover ?? alpha(fg, "10")))).tooltip(tip).on_click((_e, cx) => fn(cx))
      .child(ICON(icon).size(14).flex_none().text_color(on ? t.accent_foreground ?? "#ffffff" : dim));
    const box = v_flex().flex_none().gap(8).p(10).border_t(1).border_color(line)
      .child(field(Input.new(this.summary).h(30)))
      .child(field(Textarea.new(this.desc)).py(6))
      .child(h_flex().gap(6).items_center()
        .children(this.tpl?.text ? [iconBtn("tpl", "file-text", this.templateOn() ? "Take the commit template out" : "Add the commit template (commit.template)", (cx) => this.template(cx), this.templateOn()).child("Template")] : [])
        .child(iconBtn("gen", "sparkles", "Write the message from the staged changes (Settings → Generate command)", (cx) => this.generate(cx))
          .child(this.generating ? "Generating…" : "Generate"))
        .child(div().flex_1())
        .child(iconBtn("amend", "pencil-line", this.amend ? "Amend is on: the button rewrites the last commit" : "Amend the last commit", (cx) => this.toggleAmend(cx), this.amend)
          .when(this.amend, (e) => e.child("Amend")))
        .child(div().id("commit").h(26).px(14).flex().items_center().rounded(6).text_size(13)
          .bg(t.accent ?? fg).text_color(t.accent_foreground ?? "#ffffff").when(!can, (e) => e.opacity(0.4))
          .when(can, (e) => e.cursor_pointer().on_click((_e, cx) => this.commit(cx)))
          .child(this.busy === "commit" || this.busy === "amend" ? "Committing…" : this.amend ? "Amend" : "Commit")))
      .children(this.note ? [div().text_size(12).whitespace_normal().text_color(this.note.error ? red : dim).child(this.note.text)] : []);

    const un = section("u", c.unstaged), st = section("s", c.staged);
    const body = wide
      ? h_flex().size_full().min_h(0).child(un.h_full()).child(div().w(1).h_full().bg(line))
        .child(v_flex().flex_1().min_w(0).h_full().child(st).child(box))
      : v_flex().size_full().min_h(0).child(un).child(div().h(1).w_full().bg(line)).child(st).child(box);

    // Discard asks first: tracked files go back to the index, untracked ones are deleted (no undo).
    if (!this.ask) return body;
    const files = this.ask.files ?? c.unstaged, nu = files.filter((f) => f.untracked).length;
    const what = this.ask.files ? `"${files[0].path}"` : `${files.length} file(s)`;
    return div().size_full().relative().child(body)
      .child(div().absolute().inset_0().bg(alpha("#000000", "66")).flex().items_center().justify_center()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_scroll_wheel((_e, cx) => cx.stop_propagation())
        .child(v_flex().w(320).gap(10).p(14).rounded(10).bg(t.popover ?? t.raised ?? t.background).border_1().border_color(alpha(fg, "26")).shadow_lg()
          .child(div().text_size(14).font_semibold().child(`Discard ${what}?`))
          .child(div().text_size(12).text_color(dim).whitespace_normal()
            .child(nu ? `Unstaged changes are lost; ${nu} untracked file(s) are deleted. This cannot be undone.` : "Unstaged changes are lost. This cannot be undone."))
          .child(h_flex().gap(8).justify_end()
            .child(pill("ask-cancel", "Cancel", fg, (cx) => { this.ask = null; cx.notify(); }))
            .child(pill("ask-ok", "Discard", red, (cx) => { const a = this.ask; this.ask = null; this.op("discard", (g, tt) => g.discard(tt, a.files), cx, null, this.moveDiscard(a.files)); })))));
  }
}
