// a picture over its inline limit is not copied; the side says so. preview.js runs in a VM with herdr stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadView } from "./vm-load.js";

const side = (sizes, calls) => loadView("preview.js", "previewSide", {
  appHome: () => "/home", exec: async (cmd) => ({ code: cmd === "test" ? 1 : 0, stdout: "" }), // nothing cached yet
  gitRun: async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args.includes("rev-parse") || args.includes("hash-object")) return { code: 0, stdout: "abc\n" };
    if (args.includes("-s")) return { code: 0, stdout: String(sizes.blob) + "\n" };
    if (cmd === "sh" && args[1].startsWith("wc")) return { code: 0, stdout: String(sizes.work) + "\n" };
    return { code: 0, stdout: "" };
  },
});

// Enforce picture size limits before copying so oversized images produce a note instead of a blank preview.
test("preview: image over 8 MiB or PDF over 10 MiB → a note and no copy; under the limit → copied", async () => {
  for (const [path, size, over] of [["a.png", 8 * 2 ** 20 + 1, true], ["a.png", 8 * 2 ** 20, false], ["a.pdf", 9 * 2 ** 20, false], ["a.pdf", 10 * 2 ** 20 + 1, true]]) {
    const calls = [], r = await side({ blob: size }, calls)({ rev: "HEAD", path }, { cwd: "/r" });
    assert.equal(Boolean(r.note?.startsWith("This file exceeds the inline preview limit")), over, `${path} ${size}`);
    assert.equal(calls.some((c) => c.includes("cat-file --filters")), !over, `${path} copied only under the limit`);
  }
  const calls = [], r = await side({ work: 9 * 2 ** 20 }, calls)({ work: "big.jpg" }, { cwd: "/r" });
  assert.match(r.note, /9\.0 MiB; at most 8 MiB/); assert.ok(!calls.some((c) => c.startsWith("sh -c cp")));
});
