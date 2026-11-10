// Modal alert card: 460 px wide, large corners, operation icon, title, body, full-width fields and equal-width buttons.
// Render last inside a relative box covering the pane.
//   modal(t, { icon, color, title, subtitle?, body: [elements], actions: [modalButton(...)], paneW?, bg? }) -> element
import { div, h_flex, svg, v_flex } from "./ui/zoom.js";

const alpha = (c, a) => (c && c.length === 7 ? c + a : c);

export function modal(t, { icon, color, title, subtitle = null, body = [], actions = [], paneW = 0, bg = null }) {
  const fg = t.foreground, dim = t.muted ?? alpha(fg, "99"), tint = color ?? t.accent ?? fg;
  // ponytail: no app icon to show, so a tinted rounded square carries the operation's glyph (alert icons are 64 pt; 52 here).
  const badge = div().size(52).rounded(13).bg(alpha(tint, "2e")).border_1().border_color(alpha(tint, "59"))
    .flex().items_center().justify_center().child(svg(icon).size(26).text_color(tint));
  // Constrain tall cards to the pane; scroll their content while keeping action buttons reachable at the bottom.
  const card = v_flex().id("modal-card").w(Math.min(460, Math.max(240, (paneW || 600) - 32))).flex_shrink_1().min_h(0).pt(20).pb(16).rounded(22)
    .bg(bg ?? t.popover ?? t.raised ?? t.background).border_1().border_color(alpha(fg, "2e")).shadow_lg().text_size(13).text_color(fg)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(v_flex().id("modal-body").flex_shrink_1().min_h(0).overflow_y_scroll().px(18).gap(10)
      .child(badge)
      .child(div().pt(4).font_bold().child(title))
      .children(subtitle ? [typeof subtitle === "string" ? div().text_size(12).text_color(dim).child(subtitle) : subtitle] : [])
      .children(body))
    .child(h_flex().flex_none().px(18).pt(16).gap(8).children(actions));
  // The scrim swallows clicks so nothing under it reacts; it does not close the popup (Cancel does).
  // Wheel too: the scrim covers the pane, so nothing under the popup scrolls; scroll areas inside it get the wheel first.
  return div().id("modal-scrim").absolute().inset_0().bg("#00000040").flex().flex_col().items_center().justify_center().py(16)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_scroll_wheel((_e, cx) => cx.stop_propagation()).child(card);
}

// Equal-width pill, as in the alert: Cancel is a neutral fill, the action is the accent.
export function modalButton(t, id, label, onClick, { primary = false, disabled = false } = {}) {
  const fg = t.foreground;
  return div().id(id).flex_1().h(28).flex().items_center().justify_center().rounded_full().text_size(13).font_semibold()
    .when(primary, (e) => e.bg(t.accent ?? fg).text_color(t.accent_foreground ?? t.background))
    .when(!primary, (e) => e.bg(alpha(fg, "1f")))
    .when(disabled, (e) => e.opacity(0.4))
    .when(!disabled, (e) => e.cursor_pointer().hover((x) => x.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
    .child(label);
}

// Full-width field frame as in the alert: a soft fill, rounded 8; the focused one gets an accent ring.
export function modalField(t, el, focused) {
  const fg = t.foreground;
  return el.h(28).px(8).items_center().rounded(8).bg(alpha(fg, "0f")).text_size(13).text_color(fg)
    .border_2().border_color(focused ? alpha(t.accent ?? fg, "b3") : alpha(fg, "1f"));
}

// A controlled checkbox drawn by hand (gpui-base's Checkbox has no styling).
export function modalCheck(t, id, checked, label, onToggle) {
  const fg = t.foreground, on = t.accent ?? fg;
  return div().id(id).flex().gap(7).items_center().cursor_pointer().on_click((_e, cx) => onToggle(cx))
    .child(div().size(14).rounded(4).border_1().border_color(checked ? on : alpha(fg, "59")).when(checked, (e) => e.bg(on))
      .flex().items_center().justify_center().text_size(10).font_bold().text_color(t.accent_foreground ?? t.background).child(checked ? "✓" : ""))
    .child(label);
}
