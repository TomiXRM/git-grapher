// Supplemental Node method tests only: no constructors, rendering, host imports or real input.
import fs from "node:fs";
import vm from "node:vm";
export function loadView(file, expression, globals = {}) {
  const url = new URL(`../mods/git-grapher/${file}`, import.meta.url);
  const code = fs.readFileSync(url, "utf8").replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, "");
  if (/^\s*(import|export)\b/m.test(code)) throw Error(`Unsupported module syntax in ${file}`);
  const value = vm.runInNewContext(code + "\n" + expression, { setShared() {}, console, ...globals }, { filename: url.pathname });
  if (value === undefined) throw Error(`Missing ${expression} in ${file}`);
  return value;
}
