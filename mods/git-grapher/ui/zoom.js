// Per-view zoom multiplies element sizes by Z and divides pointer/size events by Z, keeping view code in 100% pixels.
// gpui-kit set_rem_size affects the whole window, so it cannot implement this setting.
// Mods share a JS realm: leave native prototypes untouched and layer one wrapper prototype per native prototype
// onto each element with Object.setPrototypeOf.
// ponytail: setPrototypeOf runs per element; profile it if frames slow down before moving scaling into the host.
import * as kit from "gpui-kit";
import * as base from "gpui-base";

let Z = 1;
export const zoom = () => Z;
export const setZoom = (z) => { Z = Math.min(2, Math.max(0.7, Number(z) || 1)); };
export const ZOOM_MIN = 0.7, ZOOM_MAX = 2;

const sc = (v) => typeof v === "number" ? v * Z
  : typeof v === "string" && /^-?[\d.]+px$/.test(v) ? `${parseFloat(v) * Z}px` : v;
const pt = (p) => p && { ...p, x: p.x / Z, y: p.y / Z };
const ev = (e) => e && { ...e, position: pt(e.position), local_position: pt(e.local_position), delta: pt(e.delta) };

const SIZE = ["w", "h", "size", "min_w", "max_w", "min_h", "max_h", "p", "px", "py", "pt", "pb", "pl", "pr", "m", "mx", "my",
  "mt", "mb", "ml", "mr", "gap", "gap_x", "gap_y", "text_size", "rounded", "rounded_tl", "rounded_tr", "rounded_bl", "rounded_br", "rounded_l", "rounded_r", "top", "left", "right", "bottom", "line_height"];
const REM = { text_xs: 12, text_sm: 14 }; // gpui's 0.75 / 0.875 rem at herdr's 16 px rem
const layered = new Map();
function layer(p) {
  let z = layered.get(p);
  if (z) return z;
  z = Object.create(p);
  for (const m of SIZE) if (typeof p[m] === "function") { const f = p[m]; z[m] = function (...a) { return f.apply(this, Z === 1 ? a : a.map(sc)); }; }
  for (const [m, px] of Object.entries(REM)) if (typeof p[m] === "function") { const f = p[m]; z[m] = function () { return Z === 1 ? f.call(this) : p.text_size.call(this, px * Z); }; }
  for (const m of ["on_mouse_down", "on_mouse_up"]) if (typeof p[m] === "function") { const f = p[m]; z[m] = function (b, h) { return f.call(this, b, (e, cx) => h(ev(e), cx)); }; }
  for (const m of ["on_mouse_move", "on_scroll_wheel"]) if (typeof p[m] === "function") { const f = p[m]; z[m] = function (h) { return f.call(this, (e, cx) => h(ev(e), cx)); }; }
  if (typeof p.on_size_change === "function") { const f = p.on_size_change; z.on_size_change = function (h) { return f.call(this, (s, cx) => h(s && { ...s, width: s.width / Z, height: s.height / Z }, cx)); }; }
  layered.set(p, z);
  return z;
}
const zz = (el) => { if (el && typeof el === "object") Object.setPrototypeOf(el, layer(Object.getPrototypeOf(el))); return el; };
const make = (f) => (...a) => zz(f(...a));

export const div = make(kit.div), svg = make(kit.svg), image = make(kit.image), uniform_list = make(kit.uniform_list), list = make(kit.list);
export const h_flex = make(base.h_flex), v_flex = make(base.v_flex);
export const v_virtual_list = (id, n, itemH, ...rest) => zz(base.v_virtual_list(id, n, itemH * Z, ...rest));
export const Input = { new: (s) => zz(base.Input.new(s)) };
export const Textarea = { new: (s) => zz(base.Textarea.new(s)) };
export const TextView = { ...base.TextView, markdown: (...a) => zz(base.TextView.markdown(...a)) };
export const paint_path = (path, c) => zz(window.paint_path(path, c));

// Paths: every coordinate, the dash lengths and the stroke width scale (arc rotation is 0 here). A plain wrapper object:
// the builder's methods may hand back a fresh builder, so a prototype on the first one would not last the chain.
// Shared methods do not retain their wrapper (or its native builder) through a closure cycle.
const pathPrototype = {
  close() { this.b = this.b.close() ?? this.b; return this; },
  dash_array(v) { this.b = this.b.dash_array(v.map(sc)) ?? this.b; return this; },
  build() { return this.b.build(); },
};
for (const m of ["move_to", "line_to", "curve_to", "cubic_bezier_to", "arc_to"])
  pathPrototype[m] = function (...a) { this.b = this.b[m](...a.map(sc)) ?? this.b; return this; };
function zpath(b) { const w = Object.create(pathPrototype); w.b = b; return w; }
export const PathBuilder = { ...kit.PathBuilder, stroke: (w) => zpath(kit.PathBuilder.stroke(w * Z)), fill: () => zpath(kit.PathBuilder.fill()) };
