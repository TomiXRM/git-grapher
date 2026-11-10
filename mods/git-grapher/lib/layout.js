// Stable lane layout -> graph.v1. Pure ES module for Node and QuickJS.
// Input: [{ id, parents: [...], subject, wip?, stash?, color? }] in topological order, children first.
// WIP and stash nodes use dashed edges to their base commits. IDs are opaque strings; parents retain first-parent order.
// Missing parents at the truncated bottom leave open edges. Invalid topology has unspecified layout; inputs are not mutated.

export const NUM_COLORS = 8;

export function layout(commits) {
  // active[i] = { target, color, mergeBorn } | null
  const active = [];
  let colorCounter = 0;
  let maxLanes = 0;
  const rows = [];
  const alloc = () => colorCounter++ % NUM_COLORS;
  const freeSlot = () => {
    const i = active.indexOf(null);
    if (i >= 0) return i;
    active.push(null);
    return active.length - 1;
  };

  for (const c of commits) {
    // 1. lanes waiting for this commit
    const waiting = [];
    for (let i = 0; i < active.length; i++) if (active[i] && active[i].target === c.id) waiting.push(i);

    // 2. node lane: merge-born waiter first, else leftmost waiter, else free slot
    let lane, color;
    if (waiting.length === 0) {
      lane = freeSlot();
      color = c.color ?? alloc(); // c.color: a fixed colour index for a new lane (stash rows), not drawn from the rotation
    } else {
      // A solid waiter first: a dashed (wip / stash) lane never hands its colour to a commit, so a commit only they reach gets its own.
      lane = waiting.find((j) => active[j].mergeBorn) ?? waiting.find((j) => !active[j].dashed) ?? waiting[0];
      color = active[lane].dashed ? (c.color ?? alloc()) : active[lane].color;
    }

    // 3. top half
    const edges = [];
    for (const j of waiting) {
      edges.push({ from: j, to: lane, kind: "into", color: active[j].color, ...(active[j].dashed ? { dashed: true } : {}) });
      if (j !== lane) active[j] = null;
    }
    for (let k = 0; k < active.length; k++) {
      if (active[k] && !waiting.includes(k)) edges.push({ from: k, to: k, kind: "pass", color: active[k].color, ...(active[k].dashed ? { dashed: true } : {}) });
    }

    // 4. bottom half
    const parents = c.parents || [];
    if (parents.length === 0) {
      active[lane] = null;
    } else {
      active[lane] = { target: parents[0], color, mergeBorn: false, ...(c.wip || c.stash ? { dashed: true } : {}) };
      edges.push({ from: lane, to: lane, kind: "out", color, ...(c.wip || c.stash ? { dashed: true } : {}) });
      for (const p of parents.slice(1)) {
        let j = active.findIndex((l) => l && l.target === p);
        if (j < 0) {
          j = freeSlot();
          active[j] = { target: p, color: alloc(), mergeBorn: true };
        }
        edges.push({ from: lane, to: j, kind: "out", color: active[j].color });
      }
    }

    // 5. Track column extent, including root nodes after their lane is freed.
    // Do not compact holes: Rust's stable layout never emits a pass shift.
    let hi = lane + 1;
    for (let i = active.length - 1; i >= hi; i--) if (active[i]) { hi = i + 1; break; }
    if (hi > maxLanes) maxLanes = hi;

    const row = { commit: c.id, lane, color, node: c.wip ? "wip" : c.stash ? "stash" : parents.length > 1 ? "merge" : "commit", edges };
    if (c.subject !== undefined) row.subject = c.subject;
    rows.push(row);
  }

  return { schema: "graph.v1", lane_count: maxLanes, rows };
}
