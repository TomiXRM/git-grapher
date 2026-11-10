// Render one graph.v1 row with native GPUI paths: straight passes first, then entry/exit curves, then the node.
// HEAD gets a soft lane-colour glow; merges keep the avatar unchanged.
// An optional connector joins the visible column edge to nodes with refs.
import { PathBuilder, div, image, paint_path } from "./ui/zoom.js";
import { solidVertical } from "./lib/lane-segments.js";

export const LANE_W = 22, ROW_H = 29;
const NODE_R = 4, EDGE_W = 2, // Keep lane strokes legible at small sizes.
  CORNER_R = 9, DASH = [4, ROW_H / 4 - 4]; // period divides ROW_H: dashes stay in phase across rows
const MID = ROW_H / 2;
export const AV = 20, RING = 1.5; // Avatar diameter and ring width.
// Left padding keeps lane 0's avatar and HEAD glow (radius 14 > LANE_W/2) inside the column.
export const PAD_L = 6;
export const X = (lane) => PAD_L + lane * LANE_W + LANE_W / 2;
export const cellW = (lanes) => PAD_L + lanes * LANE_W;

// Add an edge as a subpath, with quadratic corners controlled at each corner point.
function edge(p, e, lane, y0 = 0) {
  const a = X(e.from), b = X(e.to), n = X(lane);
  if (e.kind === "pass") {
    if (a === b) return p.move_to(a, 0).line_to(a, ROW_H);
    const d = Math.sign(b - a), r = Math.min(CORNER_R, Math.abs(b - a) / 2, MID);
    return p.move_to(a, 0).line_to(a, MID - r).curve_to(a + d * r, MID, a, MID)
      .line_to(b - d * r, MID).curve_to(b, MID + r, b, MID).line_to(b, ROW_H);
  }
  if (e.kind === "into") {
    if (a === n) return p.move_to(a, 0).line_to(a, MID - y0);
    const d = Math.sign(n - a), r = Math.min(CORNER_R, Math.abs(n - a), MID);
    return p.move_to(a, 0).line_to(a, MID - r).curve_to(a + d * r, MID, a, MID).line_to(n, MID);
  }
  if (b === n) return p.move_to(n, MID + y0).line_to(n, ROW_H);
  const d = Math.sign(b - n), r = Math.min(CORNER_R, Math.abs(b - n), MID);
  return p.move_to(n, MID).line_to(b - d * r, MID).curve_to(b, MID + r, b, MID).line_to(b, ROW_H);
}

const circle = (p, x, r) => p.move_to(x + r, MID)
  .arc_to(r, r, 0, false, true, x - r, MID).arc_to(r, r, 0, false, true, x + r, MID);

// HEAD glow uses stacked discs with alpha chosen for max*(1-t)^k from the node edge outward.
// The 4 px extension stays inside the row (10 + 4 < ROW_H/2) so neighbours do not clip it.
const GLOW = { rad: 4, max: 0.55, k: 1, step: 0.5 };
function glow(cx, r0, c) {
  const n = Math.round(GLOW.rad / GLOW.step), out = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const R = r0 + GLOW.rad * (1 - i / n), C = GLOW.max * Math.pow((i + 0.5) / n, GLOW.k);
    const a = 1 - (1 - C) / (1 - prev); prev = C;
    if (a > 0.001) out.push(div().absolute().left(cx - R).top(MID - R).size(2 * R).rounded_full().bg(c).opacity(a));
  }
  return out;
}

/**
 * @param row  graph.v1 Row, plus optional `avatar` ({file, initial, tint})
 * @param opts { lanes, palette: Color[], fg: Color, connectFrom?: number (x where the ref connector starts) }
 */
function nodeShape(row) {
  const x = X(row.lane), stash = row.node === "stash", wip = row.node === "wip" || stash; // stash: the WIP ring with a square inside
  const head = row.node === "head" || row.node === "head-merge";
  const merge = row.node === "merge" || row.node === "head-merge";
  const av = row.avatar && !wip;
  const r = av ? AV / 2 : head ? NODE_R * 1.5 : NODE_R;
  const ring = wip ? NODE_R * 1.5 + 1.5 : av ? 0 : head ? r + 1.5 : merge ? r + 2.5 : 0;
  return { x, stash, wip, head, av, r, ring };
}

function buildGeometry(row, connected) {
  const { x, wip, r, ring } = nodeShape(row);

  // Preserve colour/layer order. Only groups with curves, dashes or rings need a path.
  const groups = new Map();
  const group = (layer, c, dashed) => {
    const k = `${layer}:${c}${dashed ? "-" : ""}`;
    if (!groups.has(k)) groups.set(k, { layer, c, p: null, rects: [], dashed });
    return groups.get(k);
  };
  const path = (g) => g.p ??= PathBuilder.stroke(EDGE_W);
  for (const e of row.edges) {
    const straight = e.kind === "pass" && e.from === e.to;
    const g = group(straight ? 0 : 1, e.color, e.dashed), rect = solidVertical(e, row.lane, ROW_H, wip ? ring : 0);
    if (rect) g.rects.push(rect);
    else edge(path(g), e, row.lane, wip ? ring : 0);
  }
  if (ring) circle(path(group(1, row.color, false)), x, ring);

  const reach = x - (ring || r);
  // Keep the connector in its original colour/dash group's insertion slot.
  // A reused colour can put that slot below another straight passing lane.
  if (connected && reach > 0) group(0, row.color, wip).connected = true;
  const paths = [...groups.values()].sort((a, b) => a.layer - b.layer).map(({ c, p, rects, dashed, connected }) => {
    if (p && dashed) p.dash_array(DASH);
    return { c, rects, connected, path: p?.build() ?? null };
  });
  let connector = null;
  if (connected && wip && reach > 0) {
    const p = PathBuilder.stroke(EDGE_W).move_to(0, MID).line_to(reach, MID);
    p.dash_array(DASH);
    connector = p.build();
  }
  return { paths, connector, reach };
}

export function laneCell(row, { lanes, palette, connectFrom, cache, index }) {
  const color = (i) => palette[i % palette.length], connected = connectFrom !== undefined;
  const { x, stash, head, av, r, wip } = nodeShape(row);
  const geometry = cache ? cache.get(index, row, connected, () => buildGeometry(row, connected)) : buildGeometry(row, connected);

  let cell = div().relative().flex_none().w(cellW(lanes)).h(ROW_H);
  if (av && head) cell = cell.children(glow(x, AV / 2, color(row.color))); // band < glow < lines < node
  // sx only offsets/clips this element. Geometry starts at zero so the dashed
  // connector's phase still starts at the visible column edge, as before.
  const connector = () => geometry.connector
      ? div().absolute().left(connectFrom).top(0).w(geometry.reach - connectFrom).h(ROW_H).overflow_hidden()
        .child(paint_path(geometry.connector, color(row.color)).absolute().left(0).top(0).w(geometry.reach).h(ROW_H))
      : div().absolute().left(connectFrom).top(MID - EDGE_W / 2).w(geometry.reach - connectFrom).h(EDGE_W).bg(color(row.color));
  cell = cell.children(geometry.paths.flatMap(({ c, path, rects, connected }) => [
    ...rects.map((r) => div().absolute().left(X(r.lane) - EDGE_W / 2).top(r.top).w(EDGE_W).h(r.bottom - r.top).bg(color(c))),
    ...(path ? [paint_path(path, color(c)).absolute().inset_0()] : []),
    ...(connected && connectFrom < geometry.reach ? [connector()] : []),
  ]));
  if (av) cell = cell.child(avatarNode(row.avatar, color(row.color)).absolute().left(x - AV / 2).top(MID - AV / 2));
  else if (!wip) cell = cell.child(div().absolute().left(x - r).top(MID - r).size(2 * r).rounded_full().bg(color(row.color)));
  if (stash) cell = cell.child(div().absolute().left(x - 2.5).top(MID - 2.5).size(5).rounded(1).bg(color(row.color)));
  return cell;
}

// Avatar node: a lane-coloured disc with the picture (or initials) inset by RING.
export function avatarNode({ file, initial, tint }, ring) {
  const d = AV - 2 * RING;
  const inner = file
    ? image(file).size(d).rounded_full()
    : div().size(d).rounded_full().bg(tint).flex().items_center().justify_center()
      .text_color("#ffffff").text_size(10).font_weight(700).child(initial);
  return div().size(AV).rounded_full().bg(ring).p(RING).child(inner);
}
