// Context menu with title, section headings, separators and dimmed disabled items.
// Use 9 px corners and 26 px items; a transparent pane overlay closes it on outside presses.
//   contextMenu(t, { x, y, paneW, paneH, title, sections: [{ label, items: [[text, onClick | null, { icon?, accent? }?]] }], onClose })
// icon names a file under mods/git-grapher/icons/; accent adds a tinted row and accent icon.
import { div, h_flex, v_flex, svg } from "./ui/zoom.js";

const alpha = (c, a) => (c && c.length === 7 ? c + a : c);
const W = 320, ITEM_H = 26, HEAD_H = 22; // 320 px accommodates icons and the detached-checkout label.

// onLeave: called when the pointer, having been on the card, leaves it (a menu opened from the sidebar closes with it).
// hold: an object that outlives renders (the caller's menu state), where "the pointer has been on it" is kept.
export function contextMenu(t, { x, y, paneW, paneH, title, sections, onClose, onLeave = null, hold = {} }) {
  const fg = t.foreground, dim = t.muted ?? alpha(fg, "99"), line = alpha(fg, "1f");
  const h = 34 + sections.reduce((n, s) => n + HEAD_H + s.items.length * ITEM_H + 9, 0);
  // Opens at the pointer; moved back inside the pane when it would run off an edge.
  const left = Math.max(4, Math.min(x, (paneW || x + W) - W - 4)), top = Math.max(4, Math.min(y, (paneH || y + h) - h - 4));
  const item = (text, fn, k, o = {}) => h_flex().id("cm-" + k).h(ITEM_H).px(10).gap(8).items_center().rounded(6).text_size(13)
    // accent: a tinted row and an accent icon; the text keeps the menu's colour (Flower Road's pink text was unreadable).
    .when(Boolean(o.accent && fn), (e) => e.bg(alpha(t.accent ?? fg, "2e")))
    .when(!fn, (e) => e.text_color(alpha(fg, "59")))
    .when(Boolean(fn), (e) => e.cursor_pointer().hover((x) => x.bg(t.accent ?? t.hover).text_color(t.accent_foreground ?? fg))
      .on_click((_e, cx) => { onClose(cx); fn(cx); }))
    .child(o.icon ? svg(`mods/git-grapher/icons/${o.icon}.svg`).size(14).flex_none().when(Boolean(o.accent && fn), (e) => e.text_color(t.accent ?? fg)) : div().w(14).flex_none())
    .child(div().truncate().child(text));
  const card = v_flex().id("ctx-menu").absolute().left(left).top(top).w(W).p(5).rounded(9).bg(t.popover ?? t.raised ?? t.background)
    .border_1().border_color(alpha(fg, "26")).shadow_lg().text_color(fg)
    // Stop release events too, so choosing a menu item cannot select the graph row underneath.
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_mouse_up("left", (_e, cx) => cx.stop_propagation())
    .when(Boolean(onLeave), (e) => e.on_hover((on, cx) => { if (on) hold.entered = true; else if (hold.entered) onLeave(cx); }))
    .child(div().px(10).pt(3).pb(6).text_size(13).font_semibold().truncate().child(title))
    .children(sections.map((s, i) => v_flex().pt(4).mt(4).border_t(1).border_color(line)
      .child(div().h(HEAD_H).px(10).flex().items_center().text_size(12).text_color(dim).child(s.label))
      .children(s.items.map(([text, fn, o], j) => item(text, fn, `${i}-${j}`, o)))));
  return div().id("ctx-layer").absolute().inset_0().on_scroll_wheel((_e, cx) => cx.stop_propagation()) // the graph under it stays put
    .on_mouse_down("left", (_e, cx) => onClose(cx)).on_mouse_down("right", (_e, cx) => onClose(cx))
    .child(card);
}
