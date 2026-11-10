// Syntax-coloured diff rows from `ggit-helper diff` (syntect with changed-word ranges).
// colouredDiff(cwd, args) returns { rows, cols } like lib/diff.js parseDiff, with s: [[start, len, class]]
// and w: [[start, len]] as UTF-16 offsets into text; { note }; or null for plain git diff fallback.
// args follow `git diff`: revisions, then -- paths. Both file versions provide highlighting context above each hunk.
import { gitRun } from "./run.js";
import { exec } from "herdr";
import { helper } from "./preview.js";
import { cols, MAX_LINES } from "./lib/diff.js";

export async function colouredDiff(cwd, args) {
  // Explicit a/ b/ prefixes keep diff.noprefix and diff.mnemonicPrefix from breaking path parsing.
  const r = await gitRun(helper(), ["diff", "--repo", cwd, "--", "--src-prefix=a/", "--dst-prefix=b/", "-M", "--no-textconv", ...args]).catch(() => null);
  if (!r || r.code !== 0) return null;
  let j; try { j = JSON.parse(r.stdout); } catch { return null; }
  const f = j.files?.[0];
  if (!f) return { note: "No text changes (mode change or pure rename)" };
  if (f.note) return { note: f.note === "binary" ? "Binary file — no text diff" : f.note };
  if (f.rows.length > MAX_LINES) return { note: `Diff too large to show (${f.rows.length.toLocaleString("en")} lines, limit 5,000)` };
  let width = 0;
  const rows = f.rows.map((x) => {
    const row = { kind: x.k, text: x.t ?? "", ...(x.o != null ? { old: x.o } : {}), ...(x.n != null ? { new: x.n } : {}),
      ...(x.f ? { fn: x.f } : {}), ...(x.s ? { s: x.s } : {}), ...(x.w ? { w: x.w } : {}) };
    width = Math.max(width, cols(row.text) + (row.fn ? 1 + cols(row.fn) : 0));
    return row;
  });
  return { rows, cols: width };
}
