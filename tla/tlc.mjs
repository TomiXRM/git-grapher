// Thin wrapper over tla-ts: load a .tla next to this file, build a TLC config, return status + a short trace.
import { readFileSync } from "node:fs";
import { check, formatValue } from "tla-ts";

const here = new URL(".", import.meta.url);
const lit = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v).toUpperCase());

export async function tlc(spec, { constants = {}, invariants = [], properties = [], liveness = false } = {}) {
  const source = readFileSync(new URL(spec + ".tla", here), "utf8");
  const config = [
    liveness ? "SPECIFICATION Spec" : "INIT Init\nNEXT Next",
    ...Object.entries(constants).map(([k, v]) => `CONSTANT ${k} = ${lit(v)}`),
    ...invariants.map((i) => `INVARIANT ${i}`),
    ...properties.map((p) => `PROPERTY ${p}`),
    "CHECK_DEADLOCK FALSE",
  ].join("\n");
  const r = await check({ source, config });
  const v = r.violation;
  const trace = v?.trace.map((s, i) => `${i}${v.loopStart === i ? " (loop)" : ""} ${s.label?.split(" line ")[0] ?? s.action ?? "Init"}: ` +
    Object.entries(s.state).map(([k, x]) => `${k}=${formatValue(x)}`).join(" "));
  return { status: r.status, name: v?.name, trace, states: r.distinctStates, failure: r.failure?.message };
}

// Trace validation: is a sequence of states, recorded from a real run, a behaviour of the model?
// obs: a TLA tuple expression over the model's variables (e.g. "<<ref, phase>>"); states: one JS array per state, in
// obs order. The model gets a step counter; each step must be one Next step landing on the next recorded state.
// The check "succeeds" when TLC reaches the end of the trace (the TraceDone invariant is violated).
const tlaVal = (v) => (typeof v === "string" ? JSON.stringify(v) : typeof v === "boolean" ? String(v).toUpperCase()
  : Array.isArray(v) ? `<<${v.map(tlaVal).join(", ")}>>` : String(v));
export async function traceCheck(spec, { constants = {}, obs, states }) {
  if (!states?.length) throw Error("traceCheck: no states");
  let source = readFileSync(new URL(spec + ".tla", here), "utf8");
  source = source.replace(/^EXTENDS (.*)$/m, (_m, l) => `EXTENDS ${l}${/\bSequences\b/.test(l) ? "" : ", Sequences"}`);
  const extra = `
VARIABLE traceK
TraceStates == <<${states.map(tlaVal).join(", ")}>>
TraceInit == Init /\\ ${obs} = TraceStates[1] /\\ traceK = 1
TraceNext == traceK < Len(TraceStates) /\\ Next /\\ (${obs})' = TraceStates[traceK + 1] /\\ traceK' = traceK + 1
TraceDone == traceK < Len(TraceStates)
====`;
  source = source.replace(/\n====\s*$/, extra);
  const config = ["INIT TraceInit", "NEXT TraceNext", ...Object.entries(constants).map(([k, v]) => `CONSTANT ${k} = ${lit(v)}`),
    "INVARIANT TraceDone", "CHECK_DEADLOCK FALSE"].join("\n");
  const r = await check({ source, config });
  // accepted: TLC reached the last recorded state; rejected: it searched every matching path and none got there.
  // Anything else (a model or config error) is neither, and throws.
  if (r.status === "invariant-violation" && r.violation?.name === "TraceDone") return { accepted: true, states: r.distinctStates };
  if (r.status === "success") return { accepted: false, states: r.distinctStates };
  throw Error(`traceCheck ${spec}: ${r.status} ${r.failure?.message ?? r.violation?.name ?? ""}`);
}
