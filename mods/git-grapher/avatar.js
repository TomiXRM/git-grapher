// Author email -> avatar file under ~/.config/herdr-app/data/ggit-avatars/.
// Only network traffic: one GET per email to the avatar image host (no API calls).
// GitHub noreply -> avatars.githubusercontent.com; anything else -> Gravatar by sha256(email), d=404.
import * as fs from "fs/promises";
import { createHash } from "crypto";
import { appHome, exec } from "herdr";

export const DIR = "data/ggit-avatars"; // relative to appHome(): what image() takes
const abs = (f) => `${appHome()}/${DIR}/${f}`;
const sha = (s) => createHash("sha256").update(s).digest("hex");

export function avatarUrl(email) {
  const e = email.trim().toLowerCase();
  let m = e.match(/^(\d+)\+[^@]+@users\.noreply\.github\.com$/);
  if (m) return `https://avatars.githubusercontent.com/u/${m[1]}?s=64`;
  m = e.match(/^([^@+]+)@users\.noreply\.github\.com$/); // older noreply form: login only
  if (m) return `https://avatars.githubusercontent.com/${m[1]}?s=64`;
  return `https://www.gravatar.com/avatar/${sha(e)}?s=64&d=404`;
}

// Resolves to the image() path, or null to draw initials.
// image() caches failed loads for the app's lifetime, so return a path only after the file is complete.
// Create the cache folder on first use so curl can write on a fresh install.
// ponytail: the cache never expires; delete the directory to refresh changed avatars.
let made = null;
export async function avatarFile(email) {
  made ??= exec("mkdir", ["-p", `${appHome()}/${DIR}`]).catch(() => null);
  await made;
  const key = sha(email.trim().toLowerCase());
  if (await fs.exists(abs(key))) return `${DIR}/${key}`;
  if (await fs.exists(abs(key + ".none"))) return null;
  // fetch() only exposes text() (bytes come back UTF-8-mangled), so curl does the binary GET.
  // Written to .part first so the final name never exists half-written.
  // No -f: on Gravatar's HTTP/2 404 `curl -f` exits 56, not 22, so read the status instead.
  const r = await exec("curl", ["-sL", "-m", "10", "-o", abs(key + ".part"), "-w", "%{http_code}", avatarUrl(email)]).catch(() => ({ code: -1, stdout: "" }));
  const status = r.code === 0 ? Number(r.stdout) : 0;
  if (status === 200) {
    await exec("mv", [abs(key + ".part"), abs(key)]);
    return `${DIR}/${key}`;
  }
  await fs.unlink(abs(key + ".part")).catch(() => {});
  if (status >= 400 && status < 500) await fs.writeFile(abs(key + ".none"), ""); // remember the miss; network errors retry next start
  return null;
}

// Initials circle colour/letter for people without an avatar (deterministic per email).
export function initial(name, email) {
  const s = (name || email).trim();
  return (s.match(/\p{L}|\d/u)?.[0] ?? "?").toUpperCase();
}
const TINTS = ["#8b5cf6", "#ec4899", "#f97316", "#14b8a6", "#3b82f6", "#84cc16", "#eab308", "#ef4444"];
export const tint = (email) => TINTS[parseInt(sha(email.trim().toLowerCase()).slice(0, 4), 16) % TINTS.length];
