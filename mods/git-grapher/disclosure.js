// Disclosure accordion and selectable code block for commands, output, reason codes and OIDs.
//   disclosure(t, id, { label, open, onToggle, body }) -> element
//   codeBlock(t, id, lines: string[]) -> element
import { TextView, div, h_flex, svg, v_flex } from "./ui/zoom.js";
import { settings } from "herdr";

const alpha = (c, a) => (c && c.length === 7 ? c + a : c);
const CHEVRON = (open) => `mods/git-grapher/icons/chevron-${open ? "down" : "right"}.svg`;

export function disclosure(t, id, { label = "Details", open, onToggle, body }) {
  const dim = t.muted ?? alpha(t.foreground, "99");
  return v_flex().gap(6)
    .child(h_flex().id(id).gap(4).items_center().cursor_pointer().text_size(12).text_color(dim).hover((x) => x.text_color(t.foreground))
      .on_click((_e, cx) => onToggle(cx))
      .child(svg(CHEVRON(open)).size(12).text_color(dim)).child(label))
    .children(open ? [body] : []);
}

// The terminal's font (herdr settings), a soft fill, its own scroll so a long output never pushes the buttons away.
// One selectable TextView (lines are strings), so a drag selects across lines and Cmd+C copies; one colour, markdown has none.
// Markdown with every punctuation escaped and hard breaks: TextView.html drops "<…>" even escaped (&lt;, &#60;), and a ``` fence
// draws its own square box inside ours. Leading spaces and runs of 2+ become no-break spaces (U+00A0) to keep their width; that is also what copies.
export function codeBlock(t, id, lines, { maxH = 200 } = {}) {
  const fg = t.foreground;
  const md = lines.map((l) => l.replace(/[\\`*_{}\[\]()#+\-.!<>&|~]/g, "\\$&").replace(/^ +| {2,}/g, (m) => "\u00a0".repeat(m.length))).join("\\\n");
  return v_flex().id(id).max_h(maxH).overflow_y_scroll().px(10).py(8).rounded(8).bg(alpha(fg, "0f")).border_1().border_color(alpha(fg, "14"))
    .font_family(settings().font_family ?? "Menlo").text_size(11.5).text_color(fg)
    .child(TextView.markdown(`${id}-text`, md).selectable(true));
}
