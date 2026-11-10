// Solid vertical edges have exactly the rectangular footprint of a butt-capped
// stroke. Keep dashed edges and bent/curved subpaths in the native path builder.
export function solidVertical(edge, lane, height, gap = 0) {
  if (edge.dashed) return null;
  const mid = height / 2;
  if (edge.kind === "pass" && edge.from === edge.to) return { lane: edge.from, top: 0, bottom: height };
  if (edge.kind === "into" && edge.from === lane) return { lane, top: 0, bottom: mid - gap };
  if (edge.kind === "out" && edge.to === lane) return { lane, top: mid + gap, bottom: height };
  return null;
}
