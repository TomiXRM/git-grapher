// One row of a unified diff (a row from lib/diff.js parseDiff). Knows nothing about git or this pane;
// the caller owns the state and passes the theme and the line-number column width.
//
//   diffRow(row, { t: theme(), numW })     DIFF_ROW_H = the row height a virtual list needs
//
// No mouse handlers here: rows live in a v_virtual_list, and a handler on a row blanks it.
import { div, h_flex } from "./zoom.js";

export const DIFF_ROW_H = 18;
const a = (c, x) => (c && c.length === 7 ? c + x : c);

// Wrapped text grows the row, so the caller uses list() with variable heights instead of v_virtual_list.
export function diffRow(r, { t, numW, wrap = false, picked = false }) {
  const dim = t.dim ?? t.muted ?? a(t.foreground, "80");
  const nowrap = (text) => div().flex_none().whitespace_nowrap().child(text);
  // Hunk headers show a faint band, ellipsis and enclosing function when available; row numbers already give positions.
  if (r.kind === "@") return h_flex().w_full().h(DIFF_ROW_H).flex_none().items_center().gap(8).px(8).bg(a(t.foreground, "08"))
    .text_color(a(dim, "99")).child(nowrap("⋯")).when(Boolean(r.fn), (e) => e.child(nowrap(r.fn)));
  const add = r.kind === "+", del = r.kind === "-";
  const num = (n) => div().w(numW).flex_none().pr(6).text_right().text_color(a(dim, "aa")).child(n === undefined ? "" : String(n));
  return h_flex().w_full().flex_none().when(!wrap, (e) => e.h(DIFF_ROW_H).items_center()).when(wrap, (e) => e.min_h(DIFF_ROW_H).items_start())
    .when(add, (e) => e.bg(a(t.ansi2, "1f"))).when(del, (e) => e.bg(a(t.ansi1, "1f")))
    .when(picked, (e) => e.bg(a(t.accent ?? t.foreground, "40"))) // picked for copy
    .child(num(r.old)).child(num(r.new))
    .child(div().w(14).flex_none().text_center().text_color(add ? t.ansi2 : del ? t.ansi1 : dim).child(add || del ? r.kind : ""))
    .child(textCell(r, t, add, wrap).pr(12).when(r.kind === "\\", (e) => e.text_color(dim)));
}

// The text of a row: one run per colour (pieces), or the plain text. Wrapped: the runs are cut at spaces and every 16
// characters so flex_wrap can break a long line anywhere.
function textCell(r, t, add, wrap) {
  const plain = (e) => e, text = r.text || " ";
  const runs = r.s || r.w ? pieces(r, t, add, wrap) : wrap ? chunks(text).flatMap((c) => marked(c, t, plain))
    : HIDDEN.test(text) ? marked(text, t, plain) : null;
  if (!runs) return div().flex_none().whitespace_nowrap().child(text);
  return wrap ? h_flex().flex_1().min_w(0).flex_wrap().children(runs) : h_flex().flex_none().children(runs);
}
const chunks = (x) => x.match(/\s+|[^\s]{1,16}/g) ?? [x];

// Mark invisible code-changing characters (bidi controls, zero-width characters, BOM) as red <U+XXXX> text.
// Show CRLF carriage returns as a faint return mark. style(el) applies syntax colour and word highlighting.
const HIDDEN = /([\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff\r])/;
function marked(text, t, style) {
  if (!HIDDEN.test(text)) return [style(div().flex_none().whitespace_nowrap().child(text))];
  return text.split(HIDDEN).filter((x) => x !== "").map((x) => !HIDDEN.test(x) ? style(div().flex_none().whitespace_nowrap().child(x))
    : x === "\r" ? div().flex_none().text_color(a(t.dim ?? t.muted ?? t.foreground, "99")).child("␍")
    : div().flex_none().px(2).rounded(3).bg(a(t.ansi1, "59")).text_color(t.foreground).child(`⟨U+${x.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`));
}

// One row of the split view (lib/diff.js splitRows): before | after, each half its own number, sign and text; a missing side
// is a blank. Headers span both. halfW: a half's least width (the longest line), so the pair scrolls sideways together.
// sx (not wrapped): the two halves keep half the width each and their code moves sideways by sx inside them, numbers
// fixed — as Conflict Mode's columns.
export function splitRow(x, { t, numW, wrap = false, halfW = 0, picked = false, sx = null }) {
  if (x.kind !== "pair") return diffRow(x.row, { t, numW: 0, wrap, picked });
  const dim = t.dim ?? t.muted ?? a(t.foreground, "80");
  const half = (r, left) => {
    // Wrapped: two equal halves. Scrolling: each half exactly as wide as the longest line (a min width let them slide).
    const box = (e) => (halfW ? e.w(halfW).flex_none() : e.flex_1().min_w(0).flex_basis(0));
    if (!r) return box(div()).self_stretch().bg(a(t.foreground, "08"));
    const add = !left && r.kind === "+", del = left && r.kind === "-", n = left ? r.old : r.new;
    return box(h_flex()).self_stretch().when(!wrap, (e) => e.items_center()).when(wrap, (e) => e.items_start()).overflow_hidden()
      .when(add, (e) => e.bg(a(t.ansi2, "1f"))).when(del, (e) => e.bg(a(t.ansi1, "1f")))
      .child(div().w(numW).flex_none().pr(6).text_right().text_color(a(dim, "aa")).child(n === undefined ? "" : String(n)))
      .child(div().w(14).flex_none().text_center().text_color(add ? t.ansi2 : del ? t.ansi1 : dim).child(add ? "+" : del ? "-" : ""))
      .child(sx == null ? textCell(r, t, add, wrap) : div().flex_1().min_w(0).overflow_hidden().child(textCell(r, t, add, wrap).relative().left(-sx)));
  };
  return h_flex().flex_none().when(!halfW, (e) => e.w_full()).when(Boolean(halfW), (e) => e.w(2 * halfW + 1))
    .when(!wrap, (e) => e.h(DIFF_ROW_H)).when(wrap, (e) => e.min_h(DIFF_ROW_H))
    .when(picked, (e) => e.bg(a(t.accent ?? t.foreground, "40")))
    .child(half(x.l, true)).child(div().w(1).self_stretch().flex_none().bg(a(t.foreground, "1f"))).child(half(x.r, false));
}

// Render syntax spans r.s ([start, len, class]) and changed-word ranges r.w ([start, len]) from the helper as text runs.
// Use the theme's syntax palette, falling back to herdr's ANSI colours.
// ponytail: a minified line can create hundreds of runs; only build visible rows and consider coalescing if rendering slows.
function pieces(r, t, add, wrap = false) {
  const text = r.text, cut = new Set([0, text.length]);
  for (const [a, n] of r.s ?? []) { cut.add(a); cut.add(a + n); }
  for (const [a, n] of r.w ?? []) { cut.add(a); cut.add(a + n); }
  const at = [...cut].filter((x) => x <= text.length).sort((x, y) => x - y);
  const syn = t.syntax ?? [t.ansi5 ?? t.ansi4, t.ansi2, t.muted ?? t.foreground, t.ansi4, t.ansi3, t.ansi6 ?? t.ansi3, t.ansi6 ?? t.ansi3, t.foreground, t.foreground, t.foreground];
  const mark = a(add ? t.ansi2 : t.ansi1, "59"), out = [];
  for (let i = 0; i + 1 < at.length; i++) {
    const p = at[i], q = at[i + 1];
    const sp = (r.s ?? []).find(([x, n]) => p >= x && q <= x + n), word = (r.w ?? []).some(([x, n]) => p >= x && q <= x + n);
    const style = (e) => e.when(Boolean(sp), (e) => e.text_color(syn[sp[2]] ?? t.foreground)).when(word, (e) => e.bg(mark).rounded(2));
    for (const c of wrap ? chunks(text.slice(p, q)) : [text.slice(p, q)]) out.push(...marked(c, t, style));
  }
  return out;
}
