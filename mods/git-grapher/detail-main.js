// Detached commit detail pane for the selection in `ggit.tab.<tabId>`, rendered by the same DetailView as the drawer.
// Each pane has its own repository store and refresh drive. Dock closes this pane and restores the graph's drawer.
// With a graph in the tab, file clicks publish the selected file for the graph to show; otherwise the diff opens here.
// Props override the shared key for previews: { repo, sha, mode: "path", file: "path/opened", light }; sha: null shows an empty state.
import { div, h_flex, v_flex, setZoom } from "./ui/zoom.js";

import { theme, themes, props, shared, setShared, focused, panes, run } from "herdr";
import { fileFor, nextN } from "./lib/tabkey.js";
import { DetailView } from "./detail-view.js";
import { exec } from "herdr";
import { herdrAdapter } from "./lib/core.js";
import { storeFor } from "./lib/store.js";
import { drive } from "./drive.js";
import { applyTheme, settings as ggitSettings } from "./themes.js";

const BAR_H = 26;

export class DetailPane {
  init(_p, cx) {
    const p = props() ?? {};
    this.d = new DetailView(cx, { mode: p.mode, file: p.file });
    this.size = null; this.tab = null;
  }

  target() {
    const p = props() ?? {};
    if ("sha" in p) return p.sha && p.repo ? { repo: p.repo, sha: p.sha, machine: p.machine ?? null } : null;
    if (!this.tab) return null;
    const s = shared("ggit.tab." + this.tab);
    return s && typeof s === "object" && s.repo && s.sha ? s : null;
  }

  // Dock closes this pane. Use the keyed pane if it still exists; after a restart, use the focused pane containing Dock.
  // ponytail: with several detail panes in one tab, the focused one (else the first) closes; explicit pane IDs would remove the ambiguity.
  dock() {
    const id = shared("ggit.detail." + this.tab);
    run("pane.close", id && panes().some((x) => x.pane === id) ? { pane: id } : {});
  }

  render(cx) {
    setZoom(props()?.zoom ?? ggitSettings().zoom); // Zoom is shared with the graph; props.zoom overrides it for screenshots.
    // Only a visible copy renders, so focused().tab identifies its tab during render.
    this.tab = focused()?.tab ?? this.tab;
    const t = applyTheme(props()?.light ? { ...theme(), ...(themes().find((x) => x.light)?.colors ?? {}) } : theme()); // ggx-graph Settings → Theme
    const dim = t.muted ?? t.foreground;
    const mine = shared("ggit.detail." + this.tab);
    const graph = panes().some((x) => x.mod === "git-grapher" && x.tab === this.tab && x.pane !== mine); // something to dock into
    const s = this.size, inner = s && { width: s.width, height: Math.max(0, s.height - BAR_H) };
    const sel = this.target();
    const at = sel && `${sel.machine ?? ""}\0${sel.repo}`; // repo and machine: one path on two machines is two repos
    if (sel && at !== this.repo) { // a store for the shown repo, driven while this pane lives
      this.repo = at; const st = this.store = storeFor(herdrAdapter(exec, sel.machine ?? null), sel.repo, sel.machine ?? null, { history: false });
      // Start only one drive per store to avoid duplicate polling when returning to a repository.
      // ponytail: departed repositories keep their drives for this pane's lifetime; stop them if frequent switching adds overhead.
      this.driven ??= new Set();
      cx.spawn(async (cx) => {
        if (!this.driven.has(st)) { this.driven.add(st); drive(st, { machine: sel.machine ?? null }, cx); } // Start the drive before reading so intervening bumps are not missed.
        await st.refresh();
        while (this.store === st) { await st.next(); if (this.store === st) cx.notify(); }
      });
    }
    const k = !("sha" in (props() ?? {})) && sel; // the key (not props) is what the graph reads
    const file = k && graph ? fileFor(shared("ggit.tab." + this.tab), shared("ggit.file." + this.tab), { repo: k.repo, sha: k.sha, machine: k.machine ?? null }) : null;
    // Publish the loaded commit's file only while that commit is selected. A separate file key prevents a lagging
    // shared() read from writing an old selection back. Files belonging to an unselected commit are not displayed.
    // ponytail: shared() can lag; keep selection and file identity separate to contain stale writes.
    const onFile = k && graph ? (f) => {
      if (!this.d.sel) return;
      const tk = "ggit.tab." + this.tab, fk = "ggit.file." + this.tab;
      setShared(fk, { repo: this.d.sel.repo, sha: this.d.sel.sha, machine: this.d.sel.machine ?? null, file: f ? { path: f.path, ...(f.old ? { old: f.old } : {}) } : null, at: Date.now(), n: nextN(shared(tk), shared(fk)) });
    } : null;
    // On interaction this pane has focus; claim an empty detail key after a restart or slow split.
    const claim = (cx) => cx.spawn(async (cx) => {
      await cx.sleep(0); const f = focused(), key = "ggit.detail." + this.tab, id = shared(key), all = panes();
      // Only a ggit pane in this tab (focus may have moved by now); a key naming a live pane is left alone.
      const mine = f?.pane && all.find((x) => x.pane === f.pane && x.mod === "git-grapher" && x.tab === this.tab);
      if (mine && !(id && all.some((x) => x.pane === id))) setShared(key, mine.pane);
    });
    return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground)
      .on_mouse_down("left", (_e, cx) => claim(cx))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .child(h_flex().h(BAR_H).flex_none().px(8).items_center().text_size(12).text_color(dim)
        .child(div().flex_1().child("Commit"))
        .when(graph, (e) => e.child(div().id("dock").h(20).px(7).rounded(5).flex().items_center().cursor_pointer()
          .hover((h) => h.bg(t.hover ?? t.raised)).on_click(() => this.dock()).child("⇲ Dock"))))
      .child(div().flex_1().min_h(0).child(this.d.render(sel && { repo: sel.repo, sha: sel.sha, machine: sel.machine ?? null }, { size: inner, t, cx, file, onFile, store: this.store })));
  }
}
