import { test } from "node:test";
import assert from "node:assert/strict";
import { loadView } from "./vm-load.js";

// generate.js imports herdr; its pure parts are loaded without the imports.
const { fromNames, promptFor, tidy } = loadView("generate.js", "({ fromNames, promptFor, tidy })");
const f = (path, status = "M") => ({ path, status });

test("fromNames: one, two, many; a shared kind gives the verb", () => {
  assert.equal(fromNames([f("src/a.js")]), "Update a.js");
  assert.equal(fromNames([f("a.js", "A"), f("b.js", "A")]), "Add a.js and b.js");
  assert.equal(fromNames([f("a.js", "A"), f("b.js"), f("c.js"), f("d.js")]), "Update a.js, b.js and 2 more");
  assert.equal(fromNames([]), "");
});
test("promptFor cuts a long diff; tidy strips fences and quotes", () => {
  assert.match(promptFor("1 file", "x".repeat(70_000)), /\[diff cut at 60 KB\]$/);
  assert.equal(tidy("```\nFix a\n\nbody\n```\n"), "Fix a\n\nbody");
  assert.equal(tidy('"Fix a"'), "Fix a");
});
