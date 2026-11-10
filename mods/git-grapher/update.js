// Settings → Updates: what update.sh says, for the view. The latest tag is cached in shared "ggit.update" for a day, so
// every open copy does not ask GitHub (one HEAD request to github.com/<repo>/releases/latest).
import { appHome, exec, shared, setShared } from "herdr";
import { VERSION } from "./version.js";

const sh = (...args) => exec("env", [`HERDR_APP_HOME=${appHome()}`, "sh", `${appHome()}/mods/git-grapher/update.sh`, ...args])
  .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
const has = (p) => exec("test", ["-e", `${appHome()}/mods/git-grapher/${p}`]).then((r) => r.code === 0, () => false);

export const newer = (a, b) => { // "v0.10.0" > "0.9.1"
  const p = (v) => String(v).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

// → { version, latest, available, helper, dev }; force: ask GitHub even when the cached answer is fresh.
export async function updateState(force = false) {
  const c = shared("ggit.update");
  let latest = c?.latest ?? null;
  if (force || !c || Date.now() - c.at > 86_400_000) {
    const r = await sh("latest"), tag = r.stdout.trim();
    if (r.code === 0 && /^v\d+\.\d+\.\d+$/.test(tag)) { latest = tag; setShared("ggit.update", { latest, at: Date.now() }); }
  }
  return { version: VERSION, latest, checked: true, available: !!latest && newer(latest, VERSION), helper: await has("bin/ggit-helper"), dev: await has(".dev-link") };
}

// mode "install" (mod and helper) | "helper". After an install herdr reloads this mod from the new files, so a caller
// usually never sees the result; it matters when something failed and nothing changed.
export async function runUpdate(mode, tag) {
  const r = await sh(mode, tag);
  if (r.code === 0) return { ok: true, text: mode === "helper" ? "Helper installed" : `Updated to ${tag}; the old version is in ${r.stdout.trim()}` };
  return { ok: false, text: (r.stderr.trim().split("\n").pop() || `Update failed (exit ${r.code})`) + (r.code === 4 || r.code === 5 ? ". Nothing was changed." : "") };
}
