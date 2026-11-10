// Print one check and its counterexample: node tla/trace.mjs <Spec> <Invariant | L:Property> K=V ...
import { tlc } from "./tlc.mjs";
const [spec, prop, ...kv] = process.argv.slice(2);
const val = (v) => (v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v);
const constants = Object.fromEntries(kv.map((x) => { const [k, v] = x.split("="); return [k, val(v)]; }));
const live = prop.startsWith("L:");
const r = await tlc(spec, { constants, ...(live ? { properties: [prop.slice(2)], liveness: true } : { invariants: [prop] }) });
console.log(r.status, `${r.states} distinct states`, r.failure ?? "");
if (r.trace) console.log(r.trace.join("\n"));
