// Preview binary files via image(), which accepts appHome-relative paths and caches by path.
// Mods lack fs access and exec stdout cannot carry binary data. Copy each version with git or cp into
// data/ggit-preview/<content id>.<ext>, writing .part before renaming.
// Convert PDF and HEIC with bin/ggit-helper (hayro / heic-rs), or show a note when unavailable.
// ponytail: the preview cache is never pruned; prune by age if it grows.
import { gitRun } from "./run.js";
import { appHome, exec } from "herdr";

export const DIR = "data/ggit-preview";
const SHOWN = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|svg)$/i; // GPUI's image() shows these as they are
const CONVERT = /\.(pdf|heic|heif)$/i;                     // these go through the helper
export const previewable = (path) => SHOWN.test(path) || CONVERT.test(path);
const ext = (path) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
const abs = (rel) => `${appHome()}/${rel}`;
const converted = new Map(); // raw copy → helper result (the helper decodes again even when its PNG exists)
export const helper = () => `${appHome()}/mods/git-grapher/bin/ggit-helper`;

let made = null;
const mkdir = () => (made ??= exec("mkdir", ["-p", abs(DIR)]).catch(() => null));
const exists = async (rel) => (await exec("test", ["-e", abs(rel)]).catch(() => null))?.code === 0;

// One side of a preview. src: { rev: "<commit-ish>", path } for a version in git, { stage: 1 | 2 | 3, path } for a side of
// a conflict in the index, or { work: path } for the working tree.
// → { file: "<appHome-relative path>", w?, h?, pages? } | { note }
export async function previewSide(src, { cwd, on = null }) {
  if (on) return { note: "Preview is not available for a space on another machine" };
  await mkdir();
  const path = src.path ?? src.work, git = (args) => gitRun("git", ["--no-optional-locks", ...args], { cwd });
  const spec = src.stage ? `:${src.stage}:${src.path}` : `${src.rev}:${src.path}`;
  const id = src.work ? await git(["hash-object", "--", src.work]) : await git(["rev-parse", "--verify", "-q", spec]);
  if (id.code !== 0) return { note: "Not in this version" };
  // Limit images to 8 MiB and PDFs to 10 MiB before copying or decoding. Mods share about 47 MB of JS memory;
  // images above roughly 16 MiB can render blank without an error.
  const size = src.work ? await gitRun("sh", ["-c", 'wc -c < "$1"', "sh", `${cwd}/${src.work}`]) : await git(["cat-file", "-s", spec]);
  const bytes = size.code === 0 ? Number(size.stdout.trim()) : NaN, limit = /\.pdf$/i.test(path) ? 10 * 2 ** 20 : 8 * 2 ** 20;
  if (bytes > limit) return { note: `This file exceeds the inline preview limit (${(bytes / 2 ** 20).toFixed(1)} MiB; at most ${limit / 2 ** 20} MiB).` };
  const raw = `${DIR}/${id.stdout.trim()}.${ext(path)}`;
  if (!(await exists(raw))) {
    const r = src.work
      ? await gitRun("sh", ["-c", 'cp -- "$1" "$2.part.$$" && mv -- "$2.part.$$" "$2"', "sh", `${cwd}/${src.work}`, abs(raw)])
      : await gitRun("sh", ["-c", 'git --no-optional-locks cat-file --filters "$1" > "$2.part.$$" && mv -- "$2.part.$$" "$2"', "sh", spec, abs(raw)], { cwd });
    if (r.code !== 0) return { note: (r.stderr || "Could not copy the file").split("\n")[0] };
  }
  if (SHOWN.test(path)) return { file: raw };
  // Convert PDF / HEIC to PNG with the helper: PDF page 1 at 1920 px wide, HEIC at most 2048 px.
  // Content-derived filenames accompany { path, width, height, pages } output.
  return { ...(await convert(raw, 1)), raw };
}

// Page n (1-based) of a PDF already copied by previewSide (its `raw`): one helper call per page, 13–15 ms at 2048 px.
export const previewPage = (raw, n) => convert(raw, n);

async function convert(raw, page) {
  const k = raw + "#" + page;
  if (converted.has(k)) return converted.get(k);
  // Render PDFs at a fixed width of 1920 px; a longest-side cap can make wide page views soft.
  // ponytail: fixed resolution; render at display size times backing scale if more detail is needed.
  const size = /\.pdf$/i.test(raw) ? ["--width", "1920"] : ["--max", "2048"];
  const h = await gitRun(helper(), ["--path", abs(raw), "--out", abs(DIR), ...size, "--page", String(page)]).catch(() => null);
  let res;
  try { const j = JSON.parse(h?.stdout ?? ""); res = j.error ? { note: j.error } : { file: j.path.replace(appHome() + "/", ""), w: j.width, h: j.height, pages: j.pages }; }
  catch { res = { note: h ? "Could not convert" : "Install ggit-helper to preview PDF and heic files" }; }
  converted.set(k, res);
  return res;
}
