// A 44 px sidebar rail opens floating lists over the graph, at most 320 x 420 px: Local, Remote, Worktrees, Tags, Stashes.
// Names fold at their first slash, under remote groups where applicable. Filtering sits above the list.
// Select a row to centre its commit and close the list; stash selections keep it open. Use graph double-clicks
// or menus to switch branches. Esc, the active icon or an outside press closes the list.
// ponytail: no ahead/behind or pull-request badges; add repository metadata if those are needed.
//   rail(gv, t), panel(gv, t); state lives on GraphView as side, sideFold, sideFilter, sideCtx.
import { div, h_flex, v_flex, svg, Input } from "./ui/zoom.js";

const alpha = (c, a) => (c && c.length === 7 ? c + a : c);
const US = "\x1f";
export const RAIL_W = 50; // 4 + the 36 icon + the 10 gap the open tab bridges
export const SECTIONS = [
  { k: "local", icon: "git-branch", name: "Local" }, { k: "remote", icon: "cloud", name: "Remote" },
  { k: "worktree", icon: "tree-pine", name: "Worktrees" }, { k: "tag", icon: "tag", name: "Tags" }, { k: "stash", icon: "inbox", name: "Stashes" },
];
const ICON = (n) => svg(`mods/git-grapher/icons/${n}.svg`);

// The rows of one section, filtered: { kind: "head" | "row", … }. Pure; graph state in, plain data out.
export function sideRows(k, { refs, headBranch, worktrees, stashes, atOf }, filter, folded) {
  const q = filter.trim().toLowerCase(), hit = (s) => !q || s.toLowerCase().includes(q);
  const lines = (refs ?? "").trim().split("\n").filter(Boolean).map((l) => { const [obj, peeled, name] = l.split(US); return { sha: peeled || obj, name }; });
  const fold = (items, prefixOf) => { // one level of folding by prefix; a filter opens every group
    const out = [], groups = new Map();
    for (const it of items) { const p = prefixOf(it); if (!p) { out.push({ ...it, depth: 0 }); continue; } if (!groups.has(p)) groups.set(p, []); groups.get(p).push(it); }
    const rows = [];
    for (const [p, its] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const open = q || !folded.has(k + ":" + p);
      rows.push({ kind: "head", id: k + ":" + p, label: p, count: its.length, open });
      if (open) rows.push(...its.map((it) => ({ ...it, depth: 1 })));
    }
    return [...rows, ...out];
  };
  if (k === "local" || k === "remote") {
    const pre = k === "local" ? "refs/heads/" : "refs/remotes/";
    const items = lines.filter((r) => r.name.startsWith(pre) && !r.name.endsWith("/HEAD")).map((r) => ({ kind: "row", ref: k, name: r.name.slice(pre.length), sha: r.sha }))
      .filter((r) => hit(r.name)).sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({ ...r, label: r.name, head: k === "local" && r.name === headBranch, at: atOf(r.sha) }));
    if (k === "local") return fold(items.map((r) => { const i = r.name.indexOf("/"); return i > 0 ? { ...r, label: r.name.slice(i + 1) } : r; }), (r) => (r.name.indexOf("/") > 0 ? r.name.slice(0, r.name.indexOf("/")) : null));
    // Remote: grouped by the remote; inside it the name past "origin/" (a second fold level is left out: ponytail).
    return fold(items.map((r) => ({ ...r, label: r.name.slice(r.name.indexOf("/") + 1) })), (r) => r.name.slice(0, r.name.indexOf("/")));
  }
  if (k === "tag") return lines.filter((r) => r.name.startsWith("refs/tags/")).map((r) => ({ kind: "row", ref: "tag", name: r.name.slice(10), label: r.name.slice(10), sha: r.sha, at: atOf(r.sha) }))
    .filter((r) => hit(r.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (k === "worktree") return worktrees.filter((w) => !w.main).map((w) => ({ kind: "row", ref: "worktree", w, label: w.branch ?? `detached ${w.head.slice(0, 7)}`, path: w.path, head: w.current }))
    .filter((r) => hit(r.label) || hit(r.path));
  return stashes.map((x, i) => ({ kind: "row", ref: "stash", sha: x.oid, x, label: `stash@{${i}}: ${x.msg}` })).filter((r) => hit(r.label));
}

// The open icon forms a tab bridging the gap to the list. Start the list slightly above it, or level for the first icon.
// Use the list colour for the tab, with inward corners formed by rail-colour quarter circles.
const BTN = 36, GAP = 10, TOP = 4, R = 8, FR = 10, LIFT = 22; // GAP: between icons and before the list; LIFT: list above tab
const y = (i) => TOP + i * (BTN + GAP);
const panelTop = (a) => (a <= 0 ? TOP : Math.max(TOP, y(a) - LIFT));
// Use opaque fill to avoid a colour seam where the tab overlays the rail but the list overlays graph rows.
// herdr's GPUI has no backdrop blur.
export const panelColor = (t) => t.raised ?? alpha(t.foreground, "14");
export function rail(gv, t) {
  const dim = t.muted ?? alpha(t.foreground, "99"), fill = panelColor(t), a = SECTIONS.findIndex((s) => s.k === gv.side);
  const op = (e) => e.opacity(gv.sideFade ? 0 : 1).transition("opacity", FADE); // the tab fades with its list
  const fillet = (top, corner) => [op(div().absolute().left(RAIL_W - FR).top(top).size(FR).bg(fill)),
    corner(div().absolute().left(RAIL_W - FR).top(top).size(FR).bg(t.background))];
  return div().id("side-rail").relative().w(RAIL_W).flex_none().h_full().bg(t.background)
    .children(a >= 0 ? [op(div().absolute().left(4).top(y(a)).w(RAIL_W - 4).h(BTN).rounded_l(R).bg(fill))] : [])
    .children(a > 0 ? fillet(y(a) - FR, (e) => e.rounded_br(FR)) : [])
    .children(a >= 0 ? fillet(y(a) + BTN, (e) => e.rounded_tr(FR)) : [])
    .children(SECTIONS.map((s, i) => div().id("side-" + s.k).absolute().left(4).top(y(i)).h(BTN).flex().items_center().cursor_pointer()
      .when(i === a, (e) => e.w(RAIL_W - 4).pl((BTN - 18) / 2)) // The tab behind the icon supplies its fill; animate opacity only.
      // Closed icons have no fill except a hover tint.
      .when(i !== a, (e) => e.w(BTN).rounded(R).justify_center().hover((h) => h.bg(alpha(t.foreground, "14"))))
      .tooltip(s.name)
      // Hover opens the list; leaving closes it. Clicking pins it and focuses the filter; clicking the pinned icon closes it.
      .on_hover((on, cx) => {
        gv.overIcon = on ? s.k : gv.overIcon === s.k ? null : gv.overIcon;
        if (on && gv.sideFade) { gv.sideFade = false; cx.notify(); }
        if (on && !gv.sidePinned && gv.side !== s.k) { gv.side = s.k; cx.notify(); }
        if (!on) leave(gv, cx);
      })
      .on_click((_e, cx) => {
        if (gv.sidePinned && gv.side === s.k) { gv.side = null; gv.sidePinned = false; }
        else { gv.side = s.k; gv.sidePinned = true; gv.sideFilter.focus(); }
        cx.notify();
      })
      .child(ICON(s.icon).size(18).text_color(i === a ? t.foreground : dim))));
}

// After leaving both rail and list, fade an unpinned list over 90 ms. Crossing the 10 px gap or returning
// during the fade keeps it open.
const FADE = { duration: 90, easing: "ease-out" };
function leave(gv, cx) {
  cx.spawn(async (cx) => {
    await cx.sleep(0); // hover events of the move land first (leaving the icon, entering the list)
    if (!gv.side || gv.sidePinned || gv.overIcon || gv.overPanel || gv.ctx?.fromSide) return; // its menu is open: kept
    const k = gv.side; gv.sideFade = true; cx.notify();
    await cx.sleep(FADE.duration);
    if (!gv.sideFade) return; // hovered again
    gv.sideFade = false; if (gv.side === k && !gv.sidePinned && !gv.overIcon && !gv.overPanel) gv.side = null; cx.notify();
  });
}

const ago = (at) => { if (!at) return ""; const s = Date.now() / 1000 - at; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };

export function panel(gv, t) {
  if (!gv.side || !gv.graph) return null;
  const k = gv.side, s = gv.st?.state ?? {}, dim = t.muted ?? alpha(t.foreground, "99"), line = alpha(t.foreground, "1f");
  gv.atOf ??= new Map();
  if (gv.atFor !== gv.commits) { gv.atFor = gv.commits; gv.atOf = new Map((gv.commits ?? []).map((c) => [c.id, c.at])); }
  const rows = sideRows(k, { refs: gv.history?.refs, headBranch: s.headBranch, worktrees: s.worktrees ?? [], stashes: s.stashes ?? [], atOf: (x) => gv.atOf.get(x) },
    gv.sideFilter.value(), gv.sideFold);
  const size = gv.size ?? { width: 600, height: 600 };
  const w = Math.min(320, size.width - 60), a = SECTIONS.findIndex((x) => x.k === k), first = a === 0;
  // Fit list height to content, capped at 420 px, with enough height to reach the tab's lower curve.
  const top = panelTop(a), maxH = Math.max(120, Math.min(420, size.height - top - 40)), minH = Math.min(maxH, y(a) + BTN + FR + 12 - top);
  const row = (r, i) => r.kind === "head"
    ? h_flex().id(`sh-${i}`).h(26).px(8).gap(6).items_center().cursor_pointer().text_size(12).text_color(dim).hover((x) => x.bg(t.hover ?? t.raised)).rounded(5)
      .on_click((_e, cx) => { if (gv.sideFold.has(r.id)) gv.sideFold.delete(r.id); else gv.sideFold.add(r.id); cx.notify(); })
      .child(ICON(r.open ? "chevron-down" : "chevron-right").size(12)).child(div().min_w(0).truncate().child(`${r.label}/`)).child(div().flex_none().child(`(${r.count})`))
    : h_flex().id(`sr-${i}`).h(24).pl(r.depth ? 26 : 10).pr(8).gap(6).items_center().cursor_pointer().text_size(12).rounded(5).hover((x) => x.bg(t.hover ?? t.raised))
      .on_click((_e, cx) => gv.sidePick(r, cx))
      // The root handles context-menu presses for worktree, branch and tag rows.
      .on_mouse_down("right", () => { gv.sideCtx = r.ref === "worktree" ? r.w : r.ref === "stash" ? { stash: r.x } : { ref: { kind: r.ref, name: r.name, sha: r.sha } }; })
      .child(div().flex_1().min_w(0).truncate().when(Boolean(r.head), (e) => e.text_color(t.ansi2 ?? t.foreground)).child((r.head ? "✓ " : "") + r.label))
      .when(Boolean(r.path), (e) => e.child(div().flex_none().max_w(120).truncate().text_size(11).text_color(dim).child(r.path.split("/").pop())))
      .when(Boolean(r.at), (e) => e.child(div().flex_none().text_size(11).text_color(dim).child(ago(r.at))));
  const name = SECTIONS.find((x) => x.k === k).name;
  // Place the list flush against the rail without a shadow or top hairline, keeping the tab seam continuous.
  return v_flex().id("side-panel").absolute().top(top).left(0).w(w).min_h(minH).max_h(maxH).rounded(12).when(first, (e) => e.rounded_tl(0))
    .on_hover((on, cx) => { gv.overPanel = on; if (on && gv.sideFade) { gv.sideFade = false; cx.notify(); } if (!on) leave(gv, cx); })
    .opacity(gv.sideFade ? 0 : 1).transition("opacity", FADE)
    .bg(panelColor(t)).text_color(t.foreground)
    // Stop presses and wheel events at the overlay so graph rows underneath cannot react. Menu cards do the same.
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_down("right", (_e, cx) => { if (!gv.sideCtx) cx.stop_propagation(); }) // a worktree row's right press goes on to the root's menu
    .on_scroll_wheel((_e, cx) => cx.stop_propagation())
    // A press outside closes it — not one on an icon: that one's click decides (pin, switch or close).
    .on_mouse_down_out((_e, cx) => { if (gv.overIcon) return; gv.side = null; gv.sidePinned = false; cx.notify(); })
    .child(h_flex().px(10).pt(8).pb(4).gap(6).items_center().text_size(13).font_semibold().child(name)
      .child(div().text_size(12).text_color(dim).child(`(${rows.filter((r) => r.kind === "row").length})`)))
    .child(h_flex().mx(8).mb(6).px(6).h(26).gap(6).items_center().rounded(6).border_1().border_color(line).bg(t.background)
      .child(ICON("search").size(12).text_color(dim)).child(div().flex_1().min_w(0).child(Input.new(gv.sideFilter).w_full().text_size(12))))
    .child(v_flex().id("side-rows").flex_shrink_1().min_h(0).overflow_y_scroll().px(4).pb(6)
      .children(rows.length ? rows.map(row) : [div().p(10).text_size(12).text_color(dim).child(gv.sideFilter.value() ? "No match" : `No ${name.toLowerCase()}`)]));
}
