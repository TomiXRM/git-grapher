// Segmented control, macOS style: one recessed track, equal segments, a raised thumb under the chosen one
// that springs sideways when the value changes. Knows nothing about git or this pane.
//
//   segmented({ id, options: [{ value, label }], value, onChange: (value, cx) => void, t: theme(), w? })
//
// The thumb is a separate absolute element (kept in the tree, keyed by `id`) so the native spring can
// animate its `left` between renders; labels sit on top and stay crisp.
import { div, h_flex } from "./zoom.js";

const H = 22, PAD = 2;
const lum = (c) => { const n = parseInt(c.slice(1, 7), 16); return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255; };
const a = (c, x) => (c && c.length === 7 ? c + x : c);

export function segmented({ id, options, value, onChange, t, w = 56 }) {
  const dark = lum(t.background) < 0.5, fg = t.foreground;
  // Track sits a step below the surface; the thumb a step above it (light: the page colour + shadow, as AppKit).
  const track = a(fg, dark ? "14" : "0f"), thumb = dark ? a(fg, "33") : t.background;
  const i = Math.max(0, options.findIndex((o) => o.value === value));
  return div().id(id).relative().flex_none().h(H).w(options.length * w + PAD * 2).p(PAD).rounded(7).bg(track)
    .child(div().id(id + "-thumb").absolute().top(PAD).left(PAD + i * w).w(w).h(H - PAD * 2).rounded(5).bg(thumb)
      .when(!dark, (e) => e.shadow_sm()).spring("left", { response: 260 }))
    .child(h_flex().relative().size_full().children(options.map((o) =>
      div().id(`${id}-${o.value}`).w(w).h_full().flex().items_center().justify_center().text_size(12).cursor_pointer()
        .text_color(o.value === value ? fg : a(fg, "99")).when(o.value === value, (e) => e.font_medium())
        .on_click((_e, cx) => { if (o.value !== value) onChange(o.value, cx); })
        .child(o.label))));
}
