// One file's diff for ggx-detail, pure (no herdr import: `node --test mods/ggx-detail/lib/`).

// Replace diffs above 5,000 lines or 1 MB with a one-line note.
// ponytail: MAX_BYTES counts UTF-16 units, not bytes; CJK-heavy text gets about 3x more room.
// Count encoded bytes if an exact byte ceiling becomes necessary.
export const MAX_LINES = 5000, MAX_BYTES = 1_000_000, MAX_COLS = 2000, TAB = "    ";

// The same pair as the detail pane (lib/detail.js diffArgs): merge -> 1st parent, root -> empty tree.
// A rename passes both paths so -M can still pair them inside the pathspec.
export const patchArgs = (sha, parents, file) => ["diff-tree", "-r", "-p", "-M", "--no-commit-id", "--no-color", "--no-ext-diff", "--no-textconv",
  ...(parents.length ? [parents[0], sha] : ["--root", sha]), "--", ...(file.old ? [file.old, file.path] : [file.path])];

// Terminal-style width: East Asian wide / emoji count 2. ponytail: range list, not the full EAW table.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u;
export function cols(s) { let n = 0; for (const ch of s) n += WIDE.test(ch) ? 2 : 1; return n; }

const clip = (s) => { s = s.replace(/\t/g, TAB); return s.length > MAX_COLS ? s.slice(0, MAX_COLS) + " … (line truncated)" : s; };

// Unified diff text -> { rows, cols } or { note } (one line to show instead).
// rows: { kind: "@", text: "@@ -a,b +c,d @@", fn } | { kind: "+"|"-"|" ", old?, new?, text } | { kind: "\\", text }
export function parseDiff(text) {
  if (text.length > MAX_BYTES) return { note: `Diff too large to show (${(text.length / 1e6).toFixed(1)} MB, limit 1 MB)` };
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length > MAX_LINES) return { note: `Diff too large to show (${String(lines.length).replace(/\B(?=(\d{3})+$)/g, ",")} lines, limit 5,000)` };
  const rows = [];
  let a = 0, b = 0, inHunk = false, width = 0;
  for (const l of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l);
    if (m) {
      a = +m[1]; b = +m[2]; inHunk = true;
      const fn = clip(m[3]), head = l.slice(0, l.indexOf(" @@") + 3);
      rows.push({ kind: "@", text: head, fn });
      width = Math.max(width, cols(head) + (fn ? 1 + cols(fn) : 0));
      continue;
    }
    if (!inHunk) {
      if (l.startsWith("Binary files ") || l === "GIT binary patch") return { note: "Binary file — no text diff" };
      continue;
    }
    const k = l[0] ?? " ", t = clip(l.slice(1));
    if (k === "+") rows.push({ kind: "+", new: b++, text: t });
    else if (k === "-") rows.push({ kind: "-", old: a++, text: t });
    else if (k === " ") rows.push({ kind: " ", old: a++, new: b++, text: t });
    else if (k === "\\") { rows.push({ kind: "\\", text: l.slice(2) }); continue; }
    else { inHunk = false; continue; } // "diff --git" of a next file: never expected (one path), header skipped
    width = Math.max(width, cols(t));
  }
  if (!rows.length) return { note: "No text changes (mode change or pure rename)" };
  return { rows, cols: width };
}

// Split rows: hunk headers and missing-newline notes span both sides; context appears on both.
// Pair the i-th removal and addition, padding the shorter side with null.
// Return [{ kind: "@" | "\\", row } | { kind: "pair", l: row | null, r: row | null }].
export function splitRows(rows) {
  const out = []; let del = [], add = [];
  const flush = () => { for (let i = 0; i < Math.max(del.length, add.length); i++) out.push({ kind: "pair", l: del[i] ?? null, r: add[i] ?? null }); del = []; add = []; };
  for (const r of rows) {
    if (r.kind === "-") { if (add.length) flush(); del.push(r); continue; }
    if (r.kind === "+") { add.push(r); continue; }
    flush();
    out.push(r.kind === " " ? { kind: "pair", l: r, r } : { kind: r.kind, row: r });
  }
  flush();
  return out;
}

// the code of picked rows, without +/-. rows: unified rows or splitRows
// items; a..b inclusive. Hunk headers and "\ No newline" are left out; a split pair gives its left then its right line
// (a context pair once).
export function rowsText(rows, a, b) {
  const out = [];
  for (const x of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) {
    if (x.kind === "pair") { if (x.l) out.push(x.l.text); if (x.r && x.r !== x.l) out.push(x.r.text); }
    else if (x.kind === "+" || x.kind === "-" || x.kind === " ") out.push(x.text);
  }
  return out.join("\n");
}
