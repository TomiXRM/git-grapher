// Apple-style checkbox: 12 px box, 3 px corners, 1 px border over field colour; checked/mixed uses accent fill
// and an 8 px white check/dash. Draw it here because gpui-base's Checkbox provides no styling.
// state: true | false | "mixed". Visual only; the containing row handles clicks.
import { div, svg } from "./zoom.js";

const lum = (hex) => { const n = parseInt((hex ?? "#000000").slice(1, 7), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
export function appleCheck(t, state, size = 12) {
  const dark = lum(t.background) < 0.5, on = state === true || state === "mixed";
  const fill = t.accent ?? t.foreground, ink = t.accent_foreground ?? "#ffffff";
  return div().flex_none().size(size).rounded(3).border_1().flex().items_center().justify_center()
    .border_color(on ? fill : dark ? "#67676a" : "#8e8e8e")
    .bg(on ? fill : dark ? "#ffffff14" : "#ffffff")
    .children(on ? [svg(`mods/git-grapher/icons/${state === "mixed" ? "minus-bold" : "check-bold"}.svg`).size(size - 4).text_color(ink)] : []);
}
