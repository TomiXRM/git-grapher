// Generate a commit message from staged changes with Settings -> Generate command (default: `claude -p`),
// without opening a pane. Fall back to a message based on file names if the command is unavailable or fails.
// Dock-launched herdr lacks the shell PATH, so resolve bare command names once through the login shell.
// exec has no stdin: put the diff in the prompt, capped at 60 KB. herdr 0.1.13 limits exec to 30 s, then fallback applies.
// ponytail: one exec within that limit; use a background run with file polling if long diffs often time out.
import { exec } from "herdr";
import { gitRun } from "./run.js";
import { settings } from "./themes.js";

export const DEFAULT_COMMAND = "claude -p";
const DIFF_MAX = 60_000;

const verb = { A: "Add", D: "Remove", R: "Rename", M: "Update", T: "Update", C: "Copy" };
const base = (p) => p.split("/").pop();
// "Update a.js", "Add a.js and b.js", "Update a.js, b.js and 3 more" — by the first file's kind when all share it.
export function fromNames(files) {
  if (!files.length) return "";
  const v = files.every((f) => f.status === files[0].status) ? verb[files[0].status] ?? "Update" : "Update";
  const names = files.map((f) => base(f.path));
  const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  return `${v} ${list}`;
}

export function promptFor(stat, diff) {
  const cut = diff.length > DIFF_MAX ? diff.slice(0, DIFF_MAX) + "\n[diff cut at 60 KB]" : diff;
  return "Write a git commit message for these staged changes. First line: an imperative summary under 72 characters. " +
    "Then, only if it helps, a blank line and a short body that says why. Output only the message, no quotes or code fences.\n\n" +
    `${stat.trim()}\n\n${cut}`;
}

// A model's answer, tidied: no surrounding fences or quotes, no trailing blank lines.
export function tidy(text) {
  let s = text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (/^".*"$/s.test(s)) s = s.slice(1, -1).trim();
  return s;
}

const found = new Map(); // command name → its path, looked up once through the login shell
async function resolve(bin) {
  if (bin.includes("/")) return bin;
  if (found.has(bin)) return found.get(bin);
  const sh = (await exec("sh", ["-c", 'printf %s "${SHELL:-/bin/zsh}"']).catch(() => null))?.stdout || "/bin/zsh";
  const r = await exec(sh, ["-lic", 'command -v -- "$1"', "ggit", bin]).catch(() => null);
  const path = r?.code === 0 ? r.stdout.trim().split("\n").pop() : null;
  const out = path && path.startsWith("/") ? path : null;
  found.set(bin, out);
  return out;
}

// → { message, ai: true } or { message, ai: false, note } (the names, and why the command was not used).
export async function generate(root, staged, on = null) {
  const names = () => fromNames(staged);
  if (on) return { message: names(), ai: false, note: "On another machine: made from the file names" };
  const words = (settings().genCommand || DEFAULT_COMMAND).trim().split(/\s+/);
  const bin = await resolve(words[0]);
  if (!bin) return { message: names(), ai: false, note: `${words[0]} not found: made from the file names` };
  const [diff, stat] = await Promise.all([
    gitRun("git", ["diff", "--cached", "--no-color", "--no-ext-diff"], { cwd: root }),
    gitRun("git", ["diff", "--cached", "--stat"], { cwd: root }),
  ]);
  const r = await exec(bin, [...words.slice(1), promptFor(stat.stdout ?? "", diff.stdout ?? "")], { cwd: root }).catch((e) => ({ code: -1, stderr: String(e) }));
  const msg = r.code === 0 ? tidy(r.stdout ?? "") : "";
  if (msg) return { message: msg, ai: true };
  return { message: names(), ai: false, note: `${words[0]} failed (${(r.stderr || "no answer").split("\n")[0].slice(0, 80)}): made from the file names` };
}
