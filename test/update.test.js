// Settings → Updates: update.sh against a fake release served from a file:// folder (GG_BASE). Nothing changes unless every
// downloaded file matches SHA256SUMS; the old folder is kept as a backup; a cargo-built helper survives a release without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../mods/git-grapher/update.sh", import.meta.url).pathname;
const TARGET = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu", "linux-arm64": "aarch64-unknown-linux-gnu" }[`${process.platform}-${process.arch}`];
const sha = (b) => createHash("sha256").update(b).digest("hex");

function setup({ helper = true, corrupt = null, devLink = false, oldHelper = "old-helper" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gg-update-")), home = join(root, "home"), rel = join(root, "rel", "download", "v9.9.9");
  const mod = join(home, "mods", "git-grapher");
  mkdirSync(join(mod, "bin"), { recursive: true }); mkdirSync(rel, { recursive: true });
  writeFileSync(join(mod, "main.js"), "old\n");
  if (oldHelper) writeFileSync(join(mod, "bin", "ggit-helper"), oldHelper);
  if (devLink) writeFileSync(join(mod, ".dev-link"), "");
  const src = join(root, "src", "git-grapher"); mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "main.js"), "new\n");
  execFileSync("tar", ["-czf", join(rel, "git-grapher-v9.9.9.tar.gz"), "-C", join(root, "src"), "git-grapher"]);
  if (helper) writeFileSync(join(rel, `ggit-helper-${TARGET}`), "new-helper");
  const sums = readdirSync(rel).map((f) => `${sha(readFileSync(join(rel, f)))}  ${f}`).join("\n") + "\n";
  writeFileSync(join(rel, "SHA256SUMS"), sums);
  if (corrupt) writeFileSync(join(rel, corrupt), "tampered");
  const run = (...args) => spawnSync("sh", [SCRIPT, ...args], { env: { ...process.env, HERDR_APP_HOME: home, GG_BASE: `file://${join(root, "rel")}` }, encoding: "utf8" });
  const read = (p) => existsSync(join(mod, p)) ? readFileSync(join(mod, p), "utf8") : null;
  return { root, home, mod, run, read, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("update install: new folder in place with this machine's helper; the old folder is the printed backup", { skip: !TARGET }, () => {
  const s = setup();
  const r = s.run("install", "v9.9.9");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.read("main.js"), "new\n");
  assert.equal(s.read("bin/ggit-helper"), "new-helper");
  assert.equal(readFileSync(join(r.stdout.trim(), "main.js"), "utf8"), "old\n");
  assert.deepEqual(readdirSync(join(s.home, "backups")).filter((f) => f.startsWith(".update")), []); // temp folder removed
  s.done();
});

test("update install: a file that does not match SHA256SUMS → exit 4, installed folder untouched, no backup", { skip: !TARGET }, () => {
  for (const bad of ["git-grapher-v9.9.9.tar.gz", `ggit-helper-${TARGET}`]) {
    const s = setup({ corrupt: bad });
    const r = s.run("install", "v9.9.9");
    assert.equal(r.status, 4, bad);
    assert.equal(s.read("main.js"), "old\n");
    assert.equal(s.read("bin/ggit-helper"), "old-helper");
    assert.deepEqual(readdirSync(join(s.home, "backups")), []);
    s.done();
  }
});

test("update install: a release without a helper for this machine keeps the helper already there (built with cargo)", () => {
  const s = setup({ helper: false });
  const r = s.run("install", "v9.9.9");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.read("main.js"), "new\n");
  assert.equal(s.read("bin/ggit-helper"), "old-helper");
  s.done();
});

test("update: a development copy (scripts/dev-link.sh) → exit 3, untouched", () => {
  const s = setup({ devLink: true });
  assert.equal(s.run("install", "v9.9.9").status, 3);
  assert.equal(s.read("main.js"), "old\n");
  s.done();
});

test("update helper: only bin/ggit-helper changes; none in the release → exit 8", { skip: !TARGET }, () => {
  const s = setup({ oldHelper: null });
  assert.equal(s.run("helper", "v9.9.9").status, 0);
  assert.equal(s.read("bin/ggit-helper"), "new-helper");
  assert.equal(s.read("main.js"), "old\n");
  s.done();
  const n = setup({ helper: false, oldHelper: null });
  assert.equal(n.run("helper", "v9.9.9").status, 8);
  assert.equal(n.read("bin/ggit-helper"), null);
  n.done();
});

test("update: newer compares release tags by number", async () => {
  const { loadView } = await import("./vm-load.js");
  const newer = await loadView("update.js", "newer", { appHome: () => "/h", exec: async () => ({ code: 1 }), shared: () => null, setShared: () => {} });
  assert.deepEqual([["v0.10.0", "0.9.1"], ["v0.1.0", "0.1.0"], ["v0.1.1", "0.2.0"], ["v1.0.0", "0.99.99"]].map(([a, b]) => newer(a, b)), [true, false, false, true]);
});
