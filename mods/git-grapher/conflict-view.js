import { conflictSaveRequest, conflictTakeRequest, conflictMergeRequest } from "./lib/view-decisions.js";
// Conflict Mode reads operation and file state from git on every store refresh. It keeps one unsaved Result draft
// per file, dropping drafts whose unmerged entry disappears or whose sides change.
// The title offers Graph, Skip and Abort; the file list is left of the editor, or above it in narrow panes.
// Current and Incoming stay side by side with aligned lines and per-line or per-side choices, above an editable Result.
// Save writes and stages the Result. Once all files are saved, Commit merge uses MERGE_MSG, or Continue advances
// a rebase, cherry-pick or revert. Nothing advances automatically.
import { div, h_flex, svg, v_flex, Textarea, image } from "./ui/zoom.js";
import { previewable, previewSide } from "./preview.js";
import { Editor, EditorState, TextareaState } from "gpui-base";
import { settings, theme as herdrTheme } from "herdr";
import * as C from "./lib/conflict.js";
import { askPicker, sendAsk } from "./ask.js";
import { appleCheck } from "./ui/check.js";

const alpha = (c, a) => (c && c.length === 7 ? c + a : c);
const MONO = () => settings().font_family ?? "Menlo";
const CTX = 3; // lines of unchanged text kept around a hunk in the source panes (the Result has the whole file)
const LANG = { ts: "js", tsx: "js", mjs: "js", cjs: "js", jsx: "js", toml: "yaml", jsonc: "json", yml: "yaml" };
const KIND_TEXT = {
  "deleted-current": (c) => `${c.current} deleted this file; ${c.incoming} changed it.`,
  "deleted-incoming": (c) => `${c.incoming} deleted this file; ${c.current} changed it.`,
  "deleted-both": (c) => `Both sides removed this file (renamed or deleted on each).`,
  "added-current": (c) => `Only ${c.current} has this file here (added, or renamed to this name); ${c.incoming} has none.`,
  "added-incoming": (c) => `Only ${c.incoming} has this file here (added, or renamed to this name); ${c.current} has none.`,
  binary: () => "A binary file: take one side whole.",
  symlink: () => "A symbolic link: take one side whole.",
  submodule: () => "A submodule: take one side's commit.",
};

export class ConflictView {
  constructor(gv) {
    this.gv = gv; this.c = null; this.drafts = new Map(); this.sel = null; this.hidden = false;
    this.ask = null; this.arm = null; this.note = null; this.blocked = null;
    this.msg = TextareaState.new({ placeholder: "Merge message", rows: 3 }); this.msgFor = null;
  }
  get st() { return this.gv.st; }
  get ad() { return this.gv.st.adapter; }
  get root() { return this.gv.st.state.root; }
  get open() { return Boolean(this.c) && !this.hidden; }

  // After each store read (graph.apply): read the conflict again when git may have one. One read at a time; an ask during
  // a read reads once more after it.
  sync(s, cx) {
    const maybe = (s.head?.unmerged ?? 0) > 0 || s.states.some((x) => ["merge", "rebase", "cherry-pick", "revert"].includes(x.kind));
    if (!maybe && !this.c) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    cx.spawn(async (cx) => {
      do {
        this.again = false;
        const c = maybe || this.c ? await C.readConflict(this.ad, this.root).catch(() => this.c) : null;
        await this.apply(c, cx);
      } while (this.again);
      this.reading = false;
    });
  }

  async apply(c, cx) {
    const was = this.c; this.c = c;
    if (!c) { this.drafts.clear(); this.hidden = false; this.sel = null; this.arm = null; this.blocked = null; cx.notify(); return; }
    if (!was) this.hidden = false; // a new conflict opens the mode
    const files = new Map(c.files.map((f) => [f.path, f]));
    for (const [p, d] of this.drafts) {
      const f = files.get(p);
      // gone from the unmerged list (saved here, by an AI or a terminal), or its sides changed: the draft is void
      if (!f || f.saved || f.e?.s2?.oid !== d.file.e?.s2?.oid || f.e?.s3?.oid !== d.file.e?.s3?.oid) { d.ed?.release?.(); this.drafts.delete(p); }
    }
    if (!this.sel || !files.has(this.sel)) this.sel = c.files.find((f) => !f.saved)?.path ?? c.files[0]?.path ?? null;
    if (c.op === "merge" && this.msgFor !== c.mergeHead) { this.msgFor = c.mergeHead; this.msg.set_value(C.mergeMessage(c.msg)); } // once per MERGE_HEAD
    await this.ensure(cx);
    // The open file changed on disk (an editor, an AI): untouched drafts follow it; a touched one is flagged (Save refuses).
    const d = this.drafts.get(this.sel);
    if (d && !d.loading) {
      const r = await this.ad.run(["hash-object", "--", d.file.path], { cwd: this.root }).catch(() => null);
      const id = r?.code === 0 ? r.stdout.trim() : null;
      if (id && id !== d.f.workId) { if (this.touched(d)) d.changed = true; else { this.drop(d.file.path); await this.ensure(cx); } }
    }
    cx.notify();
  }

  drop(path) { this.drafts.get(path)?.ed?.release?.(); this.drafts.delete(path); }
  // The selected file's draft, loaded from git when missing.
  async ensure(cx) {
    const f = this.c?.files.find((x) => x.path === this.sel);
    if (!f || f.saved || this.drafts.has(f.path)) return;
    const d = { file: f, loading: true, choices: [] };
    this.drafts.set(f.path, d); cx.notify();
    const lf = await C.loadFile(this.ad, this.root, f).catch((e) => ({ path: f.path, kind: f.kind, error: String(e?.message ?? e) }));
    if (this.drafts.get(f.path) !== d) return;
    d.f = lf; d.loading = false;
    // A picture on both sides: shown side by side, one taken whole. Each side copied out of the index
    // (stage 2 / 3) by preview.js, as the detail's previews.
    if (lf.kind === "binary" && previewable(f.path) && f.e?.s2 && f.e?.s3) {
      const one = (stage) => previewSide({ stage, path: f.path }, { cwd: this.root }).catch((e) => ({ note: String(e?.message ?? e) }));
      cx.notify();
      const [cur, inc] = await Promise.all([one(2), one(3)]);
      if (this.drafts.get(f.path) === d) d.pv = { current: cur, incoming: inc };
    }
    if (lf.segs) {
      const t = this.t ?? {}, ext = f.path.split(".").pop().toLowerCase();
      // The Editor gutter always uses herdr's theme. Hide line numbers when it differs in lightness from the ggit theme.
      const lum = (h) => { const n = parseInt((h ?? "#000000").slice(1, 7), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
      const clash = (lum(t.background) < 0.5) !== (lum(herdrTheme()?.background) < 0.5);
      d.ed = EditorState.new({ value: lf.merged, language: LANG[ext] ?? ext, font_family: settings().font_family, font_size: 12, folding: false, line_numbers: !clash,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.muted, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      d.ed.on("change", (_e, cx) => cx.notify());
    }
    cx.notify();
  }
  hunks(d) { return (d.f?.segs ?? []).filter((s) => s.t === "hunk"); }
  manual(d) { return d.ed && d.ed.value() !== C.assemble(d.f.segs, d.choices); }
  touched(d) { return Boolean(d.ed) && (d.choices.some(Boolean) || this.manual(d)); }

  // A line checkbox toggles one line; a side's header checkbox toggles the whole side.
  // The side selected first appears first in the Result. Existing Result edits are replaced only at surviving hunk markers.
  pickLines(d, i, side, ks, on, cx) {
    const old = d.choices[i], key = side === "current" ? "cur" : "inc";
    const c = { cur: [...(old?.cur ?? [])], inc: [...(old?.inc ?? [])], first: old?.first ?? side };
    for (const k of ks) c[key][k] = on;
    const any = c.cur.some(Boolean) || c.inc.some(Boolean);
    if (any && !(old?.cur?.some(Boolean) || old?.inc?.some(Boolean))) c.first = side;
    this.setChoice(d, i, any ? c : null, cx);
  }
  setChoice(d, i, c, cx) {
    const h = this.hunks(d)[i];
    if (this.manual(d)) {
      const next = C.applyChoice(d.ed.value(), h, c);
      if (next === null) { this.note = "That conflict was edited by hand in the Result, or another is identical to it: change it there, or Reset all"; cx.notify(); return; }
      d.choices[i] = c; d.ed.set_value(next);
    } else { d.choices[i] = c; d.ed.set_value(C.assemble(d.f.segs, d.choices)); }
    this.note = null; cx.notify();
  }
  resetAll(d, cx) { d.choices = []; d.ed.set_value(d.f.merged); this.arm = null; cx.notify(); }

  // ---- writes: all through the store's one queue; the result is a snackbar card (header.js).
  write(name, fn, cx) {
    const hd = this.gv.hd; hd.busy = name; hd.setSnack(cx, { busy: name });
    cx.spawn(async (cx) => { const r = await this.st.write(name, fn); if (hd.busy === name) hd.busy = null; hd.setSnack(cx, { busy: null, r }); this.sync(this.st.state, cx); });
  }
  save(d, cx) {
    const request = conflictSaveRequest(this.c, d, d.ed.value());
    this.write("conflict-save", () => C.saveFile(this.ad, this.root, request), cx);
  }
  // The file as it was loaded goes along: a change made since refuses the take.
  take(f, side, cx) { const request = conflictTakeRequest(this.c, f, side, this.drafts.get(f.path)); this.write("conflict-take", () => C.takeSide(this.ad, this.root, request), cx); }
  async finish(cx) {
    const c = this.c;
    const b = await C.blockers(this.ad, this.root, c).catch(() => ["Could not check"]);
    this.blocked = b.length ? b : null; cx.notify();
    if (b.length) return;
    if (c.op === "merge") {
      const m = this.msg.value();
      // Capture the staged tree at the click; commitMerge commits only that tree for this merge.
      const w = await this.ad.run(["write-tree"], { cwd: this.root }).catch(() => null);
      const request = conflictMergeRequest(c, m, w);
      if (request.blocked) { this.blocked = [request.blocked]; cx.notify(); return; }
      this.write("commit", () => C.commitMerge(this.ad, this.root, request.conflict, request.message, request.tree), cx);
    } else this.write("conflict-continue", () => C.continueOp(this.ad, this.root, c), cx);
  }
  // Skip / Abort require a second confirmation tied to the revision on which they were armed.
  armed(k) { return this.arm?.k === k && this.arm.rev === this.c?.rev; }
  twice(k, cx, run) { if (!this.armed(k)) { this.arm = { k, rev: this.c.rev }; cx.notify(); return; } this.arm = null; run(); }

  // ---- render. body: the area under the toolbar.
  render(t, cx, size) {
    this.t = t;
    const c = this.c, fg = t.foreground, dim = t.muted ?? alpha(fg, "99"), line = alpha(fg, "1f"), warn = t.ansi3 ?? "#d4a017", red = t.ansi1 ?? "#d33";
    const W = size?.width ?? 800, narrow = W < 640;
    const btn = (id, label, fn, { icon = null, ink = null, primary = false, disabled = false, frame = true } = {}) =>
      h_flex().id(id).h(24).px(9).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .when(frame && !primary, (e) => e.border_1().border_color(line))
        .when(primary, (e) => e.bg(t.accent ?? fg).text_color(t.accent_foreground ?? t.background).font_semibold())
        .when(!primary, (e) => e.text_color(ink ?? fg))
        .when(disabled, (e) => e.opacity(0.4))
        .when(!disabled, (e) => e.cursor_pointer().hover((h) => h.bg(primary ? t.accent ?? fg : t.hover ?? t.raised)).on_click((_e, cx) => fn(cx)))
        .children(icon ? [svg(`mods/git-grapher/icons/${icon}.svg`).size(13).text_color(primary ? t.accent_foreground ?? t.background : ink ?? dim)] : []).child(label);
    const seq = ["rebase", "cherry-pick", "revert"].includes(c.op);
    const title = h_flex().flex_none().h(36).px(10).gap(6).items_center().border_b_1().border_color(line).bg(alpha(warn, "14"))
      .child(svg("mods/git-grapher/icons/git-merge.svg").size(15).flex_none().text_color(warn))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(c.title))
      .child(btn("cf-graph", narrow ? "" : "Graph", (cx) => { this.hidden = true; cx.notify(); }, { icon: "git-branch" }))
      .children(seq ? [btn("cf-skip", this.armed("skip") ? "Confirm skip" : "Skip", (cx) => this.twice("skip", cx, () => this.write("conflict-skip", () => C.skipOp(this.ad, this.root, c), cx)), { ink: this.armed("skip") ? warn : null })] : [])
      .children(c.op !== "stash" ? [btn("cf-abort", this.armed("abort") ? "Confirm abort" : "Abort", (cx) => this.twice("abort", cx, () => this.write("conflict-abort", () => C.abortOp(this.ad, this.root, c), cx)), { ink: red })] : []);

    // Group files into In progress and Saved.
    const fileRow = (f) => h_flex().id("cf-f-" + f.path).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer().text_size(12)
      .when(f.path === this.sel, (e) => e.bg(alpha(t.accent ?? fg, "26"))).hover((h) => h.bg(t.hover ?? t.raised))
      .on_click((_e, cx) => { this.sel = f.path; this.ask = null; this.note = null; cx.spawn((cx) => this.ensure(cx)); cx.notify(); })
      .child(badge(f))
      .child(div().flex_1().min_w(0).truncate().child(f.path.split("/").pop()))
      .children(note(f) ? [div().flex_none().max_w(120).truncate().text_size(11).text_color(dim).child(note(f))] : []);
    // Use a 14 px rounded square per file: "C" for a conflict, a check once saved.
    // Describe the required resolution choice in words on the right.
    const badge = (f) => div().size(14).flex_none().rounded(3).flex().items_center().justify_center().bg(f.saved ? t.ansi2 ?? "#2a2" : warn)
      .text_size(9).font_bold().text_color("#ffffff").children(f.saved ? [svg("mods/git-grapher/icons/check-bold.svg").size(10).text_color("#ffffff")] : [div().child("C")]);
    const KIND = { "deleted-current": "deleted on one side", "deleted-incoming": "deleted on one side", "deleted-both": "deleted on both",
      "added-current": "on one side only", "added-incoming": "on one side only", submodule: "submodule", symlink: "link", binary: "binary" };
    const note = (f) => [f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") : "", f.saved ? "" : KIND[this.drafts.get(f.path)?.f?.kind ?? f.kind] ?? ""].filter(Boolean).join(" · ");
    const group = (label, list) => list.length ? [div().px(8).pt(8).pb(2).text_size(11).text_color(dim).child(`${label} (${list.length})`), ...list.map(fileRow)] : [];
    const inProg = c.files.filter((f) => !f.saved), saved = c.files.filter((f) => f.saved);
    const done = !inProg.length;
    const footer = v_flex().flex_none().p(8).gap(6).border_t_1().border_color(line)
      .children(this.blocked ? this.blocked.map((b) => div().text_size(11).text_color(red).whitespace_normal().child(b)) : [])
      .children(done && c.op === "merge" ? [Textarea.new(this.msg).w_full().px(6).py(4).rounded(6).border_1().border_color(alpha(fg, "33")).bg(t.background).text_size(12)] : [])
      .child(c.op === "stash" ? div().text_size(11).text_color(dim).whitespace_normal().child("The stash is kept. Saved files stay staged.")
        : btn("cf-continue", c.op === "merge" ? "Commit merge" : "Continue", (cx) => cx.spawn((cx) => this.finish(cx)), { primary: true, disabled: !done }));
    const list = v_flex().id("cf-files").flex_none().when(!narrow, (e) => e.w(220).h_full().border_r_1()).when(narrow, (e) => e.w_full().max_h(150).border_b_1())
      .border_color(line)
      .child(v_flex().id("cf-files-scroll").flex_1().min_h(0).overflow_y_scroll().px(4).pb(4).children([...group("In progress", inProg), ...group("Saved", saved)]))
      .child(footer);
    const f = c.files.find((x) => x.path === this.sel);
    const main = v_flex().flex_1().min_w(0).min_h(0).child(f ? this.fileView(f, t, cx, { W: narrow ? W : W - 220, dim, line, warn, red, btn }) : div().p(12).text_color(dim).child("No file selected"));
    return v_flex().flex_1().min_w(0).min_h(0).child(title)
      .child(div().flex().when(narrow, (e) => e.flex_col()).flex_1().min_w(0).min_h(0).child(list).child(main));
  }

  fileView(f, t, cx, o) {
    const { dim, line, warn, red, btn } = o, c = this.c, fg = t.foreground;
    const head = (right) => h_flex().flex_none().h(34).px(10).gap(8).items_center().border_b_1().border_color(line)
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child(f.path)).children(right);
    if (f.saved) {
      const next = c.files.find((x) => !x.saved);
      return v_flex().size_full().child(head(next ? [btn("cf-next", "Next file", (cx) => { this.sel = next.path; cx.spawn((cx) => this.ensure(cx)); cx.notify(); })] : []))
        .child(div().p(12).text_size(12).text_color(dim).whitespace_normal().child("Saved: its result is staged. To change it, edit the file and stage it again."));
    }
    const d = this.drafts.get(f.path);
    if (!d || d.loading) return v_flex().size_full().child(head([])).child(div().p(12).text_color(dim).child("Loading…"));
    if (d.f.error) return v_flex().size_full().child(head([])).child(div().p(12).text_color(red).child(d.f.error));
    if (!d.f.segs && d.f.kind === "binary" && previewable(f.path)) return this.pictures(f, d, t, o, head);
    if (!d.f.segs) { // one side whole
      const kind = d.f.kind, one = kind.startsWith("deleted") || kind.startsWith("added");
      const keep = kind === "deleted-current" || kind === "added-incoming" ? "incoming" : kind === "deleted-both" ? "base" : "current";
      const whose = keep === "base" ? "the original" : `${keep === "current" ? c.current : c.incoming}'s version`;
      const acts = one ? [btn("cf-keep", `Keep ${whose}`, (cx) => this.take(f, keep, cx), { primary: true }),
        btn("cf-del", "Delete the file", (cx) => this.take(f, "delete", cx), { ink: red })]
        : [btn("cf-cur", `Use Current (${c.current})`, (cx) => this.take(f, "current", cx)), btn("cf-inc", `Use Incoming (${c.incoming})`, (cx) => this.take(f, "incoming", cx))];
      return v_flex().size_full().child(head([])).child(v_flex().p(12).gap(10).child(div().text_size(12).whitespace_normal().child(KIND_TEXT[kind]?.(c) ?? kind)).child(h_flex().gap(8).flex_wrap().children(acts)));
    }
    const hunks = this.hunks(d), text = d.ed.value(), left = hunks.filter((h) => text.includes(h.raw)).length, markers = C.markerLines(text);
    // Why Save is off, in words: conflicts still open (or markers typed back in).
    const counts = div().flex_none().text_size(11).text_color(markers ? warn : dim)
      .child(left ? `${left} of ${hunks.length} conflict${hunks.length === 1 ? "" : "s"} to resolve before Save` : markers ? "Conflict markers left in the Result" : "Ready to save");
    const save = btn("cf-save", "Save", (cx) => this.save(d, cx), { primary: true, disabled: markers > 0 || d.changed });
    const askBtn = btn("cf-ask", "Ask AI", (cx) => { this.ask = this.ask?.path === f.path ? null : { path: f.path, target: this.ask?.target ?? "new" }; cx.notify(); }, { icon: "sparkles" });
    const notes = [
      ...(d.changed ? [h_flex().px(10).py(6).gap(8).items_center().bg(alpha(warn, "1f")).text_size(12)
        .child(div().flex_1().min_w(0).whitespace_normal().child("The file changed on disk since it was loaded. Save would overwrite that, so it is off."))
        .child(btn("cf-reload", "Reload", (cx) => { this.drop(f.path); cx.spawn((cx) => this.ensure(cx)); cx.notify(); }))] : []),
      ...(this.note ? [div().px(10).py(4).text_size(11).text_color(warn).whitespace_normal().child(this.note)] : []),
      ...(this.ask?.path === f.path ? [this.askPanel(t, c, d, o)] : []),
    ];
    // Horizontal gestures or Shift+wheel scroll both source panes together, bounded by the longest line and column width.
    // ponytail: estimate text width by a fixed character advance; measure glyphs if alignment needs greater accuracy.
    const colW = Math.max(80, (o.W - 24) / 2 - 40);
    const longest = Math.max(0, ...(d.f.merged ?? "").split("\n").map((l) => l.length));
    const maxSx = Math.max(0, longest * 7.3 - colW);
    if ((this.sx ?? 0) > maxSx) this.sx = maxSx;
    const scroll = div().id("cf-src-" + f.path).flex().flex_col().flex_grow(1).min_h(0).overflow_y_scroll().text_size(12)
      .on_scroll_wheel((e, cx) => {
        const dx = e.delta.x !== 0 ? e.delta.x : e.modifiers?.shift ? e.delta.y : 0;
        if (dx === 0 || Math.abs(dx) < Math.abs(e.delta.y) * (e.modifiers?.shift ? 0 : 1)) return;
        const next = Math.min(maxSx, Math.max(0, (this.sx ?? 0) - dx));
        cx.stop_propagation();
        if (next !== this.sx) { this.sx = next; cx.notify(); }
      })
      .child(this.sideBySide(d, t, o));
    const sources = v_flex().flex_grow(2).flex_basis(0).min_h(0).child(this.sideHeads(t, o)).child(scroll);
    const rc = t.ansi2 ?? "#4a4";
    const resultHead = h_flex().flex_none().h(26).px(10).gap(6).items_center().border_b_1().border_color(alpha(rc, "80")).bg(alpha(rc, "14")).text_size(11).text_color(dim)
      .child(div().size(8).rounded(4).bg(rc)).child(div().flex_1().text_color(t.foreground).child(this.manual(d) ? "Result · edited by hand" : "Result · what Save writes; you can edit it"))
      .child(btn("cf-reset", this.armed("reset") ? "Confirm reset all" : "Reset all", (cx) => this.twice("reset", cx, () => this.resetAll(d, cx)), { frame: false, ink: this.armed("reset") ? warn : dim }));
    return v_flex().size_full().min_h(0)
      .child(head([counts, askBtn, save]))
      .children(notes)
      .child(sources)
      // The Result framed in its own colour, as the two sides are.
      .child(v_flex().flex_grow(1).flex_basis(0).min_h(0).mx(8).mt(6).mb(8).rounded(8).overflow_hidden().border_1().border_color(alpha(rc, "80"))
        .child(resultHead).child(Editor.new(d.ed).flex_grow(1).min_h(0))); // sources: Result = 2: 1
  }

  // Two pictures side by side, framed in their sides' colours; a click picks one whole, Save takes it.
  pictures(f, d, t, o, head) {
    const k = this.colours(t), pick = d.pick ?? null;
    const side = (key, label, col) => {
      const p = d.pv?.[key];
      return v_flex().id(`cf-img-${key}`).flex_1().min_w(0).min_h(0).rounded(8).overflow_hidden().border_2().cursor_pointer()
        .border_color(pick === key ? col : alpha(col, "59")).bg(alpha(col, "0d"))
        .when(Boolean(pick) && pick !== key, (e) => e.opacity(0.5))
        .on_click((_e, cx) => { d.pick = key; cx.notify(); })
        .child(h_flex().flex_none().h(28).px(8).gap(7).items_center().text_size(11).bg(alpha(col, "26"))
          .child(appleCheck(t, pick === key)).child(div().min_w(0).truncate().font_semibold().text_color(col).child(label)))
        .child(div().flex_1().min_h(0).p(10).flex().items_center().justify_center()
          .child(p?.file ? image(p.file).size_full() : div().text_size(12).text_color(o.dim).child(p?.note ?? "Loading…")));
    };
    const save = o.btn("cf-save", "Save", (cx) => this.take(f, pick, cx), { primary: true, disabled: !pick });
    return v_flex().size_full().min_h(0)
      .child(head([div().text_size(11).text_color(pick ? o.dim : o.warn).child(pick ? `Keeps ${pick === "current" ? "Current" : "Incoming"}'s picture` : "Pick one picture to keep"), save]))
      .child(h_flex().flex_1().min_h(0).p(8).gap(8).items_stretch()
        .child(side("current", `CURRENT · ${this.c.current}`, k.current))
        .child(side("incoming", `INCOMING · ${this.c.incoming}`, k.incoming)));
  }
  askPanel(t, c, d, o) {
    const ctx = C.askContext(c, d.f, this.root), a = this.ask;
    return v_flex().mx(10).my(6).p(8).gap(6).rounded(7).border_1().border_color(o.line).text_size(12)
      .child(div().text_color(o.dim).whitespace_normal().child("The conflict as text for an AI: which side is which, and each hunk's three versions. Copy it anywhere, or send it to an agent; it edits the file and stages it, and this view follows."))
      .child(h_flex().gap(6).items_center()
        .child(o.btn("cf-ask-copy", "Copy", (cx) => { cx.write_to_clipboard(ctx); a.sent = "Copied"; cx.notify(); }, { icon: "copy" }))
        .child(div().flex_1().min_w(0).child(askPicker(t, a, "cf-ask")))
        .child(o.btn("cf-ask-send", "Send", (cx) => cx.spawn(async (cx) => { const r = await sendAsk(a.target, this.root, ctx); a.sent = r.text; cx.notify(); }), { primary: true })))
      .children(a.sent ? [div().text_size(11).text_color(o.dim).child(a.sent)] : []);
  }

  // Source rows. A segment of unchanged text keeps CTX lines next to each hunk; the rest folds to "⋯ n lines".
  pieces(d) {
    const segs = d.f.segs, out = [];
    let hi = 0;
    segs.forEach((s, i) => {
      if (s.t === "hunk") { out.push({ hunk: s, i: hi++ }); return; }
      const ls = s.text.replace(/\n$/, "").split("\n"), before = i > 0, after = i < segs.length - 1;
      const head = before ? ls.slice(0, CTX) : [], tail = after ? ls.slice(Math.max(head.length, ls.length - CTX)) : [];
      const hidden = ls.length - head.length - tail.length;
      out.push({ same: head }); if (hidden > 0) out.push({ fold: hidden }); out.push({ same: tail });
    });
    return out.filter((p) => !p.same || p.same.length);
  }
  lines(text, ink, bg) { return text.replace(/\n$/, "").split("\n").map((l) => div().h(18).px(10).flex().items_center().overflow_hidden().when(Boolean(bg), (e) => e.bg(bg)).text_color(ink).child(this.shifted(div().child(l || " ")))); }
  // Code text moved left by the shared horizontal scroll (both sides together, so aligned rows stay aligned).
  shifted(el) { return h_flex().flex_1().min_w(0).overflow_hidden().child(el.flex_none().relative().left(-(this.sx ?? 0)).font_family(MONO()).whitespace_nowrap()); }
  // Keep Current and Incoming side by side, each framed in its colour. alignLines pairs corresponding lines,
  // leaves gaps for lines present on only one side, and marks changed text.
  // Clicking a line or its checkbox takes that line; the hunk header checkbox takes a whole side.
  colours(t) { return { current: t.ansi4 ?? "#4a8", incoming: t.ansi5 ?? "#a6c" }; }
  cell(col, inner, { top = false, bottom = false } = {}) {
    return div().flex_1().min_w(0).bg(alpha(col, "0d")).border_l_1().border_r_1().border_color(alpha(col, "80"))
      .when(top, (e) => e.border_t_1().rounded_t(8)).when(bottom, (e) => e.border_b_1().rounded_b(8)).children(inner);
  }
  sideBySide(d, t, o) {
    const k = this.colours(t), n = this.hunks(d).length;
    const pair = (l, r, opt = {}) => h_flex().px(8).gap(8).items_stretch().child(this.cell(k.current, l, opt)).child(this.cell(k.incoming, r, opt));
    const rows = this.pieces(d).flatMap((p) => {
      if (p.fold) { const f = () => [div().h(18).px(10).text_color(o.dim).child(`⋯ ${p.fold} unchanged lines`)]; return [pair(f(), f())]; }
      if (p.same) return [pair(this.lines(p.same.join("\n"), o.dim), this.lines(p.same.join("\n"), o.dim))];
      return this.hunkRows(d, p.hunk, p.i, n, t, o, pair);
    });
    return v_flex().flex_grow(1).flex_shrink_0().children(rows).child(pair([div().h(6)], [div().h(6)], { bottom: true }).flex_grow(1));
  }
  captionText(d, i) {
    const c = d.choices[i], cur = c?.cur?.some(Boolean), inc = c?.inc?.some(Boolean);
    return !c ? "" : cur && inc ? `both, ${c.first === "incoming" ? "Incoming" : "Current"} first` : cur ? "Current" : "Incoming";
  }
  hunkRows(d, h, i, n, t, o, pair) {
    const c = d.choices[i], k = this.colours(t), fg = t.foreground;
    const cl = C.linesOf(h.ours).map((l) => l.replace(/\r?\n$/, "")), il = C.linesOf(h.theirs).map((l) => l.replace(/\r?\n$/, ""));
    const pc = cl.map((_, x) => Boolean(c?.cur?.[x])), pi = il.map((_, x) => Boolean(c?.inc?.[x]));
    const both = pc.some(Boolean) && pi.some(Boolean);
    const tri = (p) => (p.length && p.every(Boolean) ? true : p.some(Boolean) ? "mixed" : false);
    const warn = !c, band = (col) => alpha(warn ? o.warn : col, "33");
    const head = (side, p, ls, col) => h_flex().id(`cf-h-${side}-${i}`).h(24).px(6).gap(6).items_center().text_size(11).bg(band(col))
      .border_t_1().border_color(alpha(warn ? o.warn : col, "80"))
      .when(ls.length > 0, (e) => e.cursor_pointer().on_click((_e, cx) => this.pickLines(d, i, side, ls.map((_, x) => x), tri(p) !== true, cx)))
      .child(ls.length ? appleCheck(t, tri(p)) : div().w(12))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(warn ? o.warn : fg)
        .child(side === "current" && c ? `Conflict ${i + 1} of ${n} · ${this.captionText(d, i)}` : `Conflict ${i + 1} of ${n}`))
      .children(both && p.some(Boolean) ? [div().flex_none().text_color(o.dim).child(c.first === side ? "1st" : "2nd")] : [])
      .children(side === "current" && both ? [o.btn(`cf-swap-${i}`, "Swap", (cx) => this.setChoice(d, i, { ...c, first: c.first === "incoming" ? "current" : "incoming" }, cx), { frame: false, ink: o.dim })] : []);
    const text = (s, other, col) => {
      const [pre, mid, post] = C.splitChange(s, other);
      return this.shifted(h_flex()
        .children([pre && div().child(pre), mid && div().bg(alpha(col, "4d")).rounded(2).child(mid), post && div().child(post)].filter(Boolean))
        .children(s ? [] : [div().child(" ")]));
    };
    // One side's line on an aligned row: x its index (null: this side has no line here), other the counterpart's text.
    const line = (side, x, other, same) => {
      const col = k[side], p = side === "current" ? pc : pi, s = x == null ? null : (side === "current" ? cl : il)[x];
      if (x == null) return [div().h(20).bg(alpha(fg, "08"))];
      return [h_flex().id(`cf-l-${side}-${i}-${x}`).h(20).px(6).gap(6).items_center().cursor_pointer()
        .bg(alpha(col, same ? "0d" : "1a")).hover((e) => e.bg(alpha(col, "2e")))
        .when(Boolean(c) && !p[x], (e) => e.opacity(0.45))
        .on_click((_e, cx) => this.pickLines(d, i, side, [x], !p[x], cx))
        .child(appleCheck(t, p[x]))
        .child(same ? this.shifted(div().text_color(o.dim).child(s || " ")) : text(s, other, col))];
    };
    const out = [pair([head("current", pc, cl, k.current)], [head("incoming", pi, il, k.incoming)])];
    for (const r of C.alignLines(cl, il)) {
      const same = r.t === "same";
      out.push(pair(line("current", r.c, r.i == null ? null : il[r.i], same), line("incoming", r.i, r.c == null ? null : cl[r.c], same)));
    }
    out.push(pair([div().h(2).bg(alpha(warn ? o.warn : k.current, "80"))], [div().h(2).bg(alpha(warn ? o.warn : k.incoming, "80"))]));
    return out;
  }
  // The columns' headers, outside the scroll so they stay.
  sideHeads(t, o) {
    const k = this.colours(t), head = (col, text) => this.cell(col, [h_flex().h(26).px(10).gap(6).items_center().text_size(11)
      .child(div().size(8).rounded(4).bg(col)).child(div().min_w(0).truncate().font_semibold().text_color(col).child(text))], { top: true });
    return h_flex().flex_none().px(8).pt(6).gap(8).child(head(k.current, `CURRENT · ${this.c.current}`)).child(head(k.incoming, `INCOMING · ${this.c.incoming}`));
  }

  // The strip over the graph while an operation is stopped but the mode is not shown (Graph pressed, or all saved).
  strip(t) {
    const c = this.c; if (!c || !this.hidden) return null;
    const warn = t.ansi3 ?? "#d4a017";
    return h_flex().flex_none().h(28).px(10).gap(8).items_center().bg(alpha(warn, "1f")).text_size(12)
      .child(svg("mods/git-grapher/icons/git-merge.svg").size(13).flex_none().text_color(warn))
      .child(div().flex_1().min_w(0).truncate().child(c.unmerged ? `${c.title} · ${c.unmerged} file(s) to resolve` : `${c.title} · resolved`))
      .child(h_flex().id("cf-back").h(22).px(8).flex_none().items_center().rounded(5).cursor_pointer().border_1().border_color(alpha(t.foreground, "26"))
        .hover((h) => h.bg(t.hover ?? t.raised)).on_click((_e, cx) => { this.hidden = false; cx.notify(); }).child("Back to conflicts"));
  }
}
