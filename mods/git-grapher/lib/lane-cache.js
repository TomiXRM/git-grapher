// Per-view cache of immutable geometry, never native elements or builders.
// The index bounds retention; commit/shape and the context identify the geometry.
export const laneShapeKey = (row, connected) => JSON.stringify([
  row.commit, row.lane, row.color, row.node, Boolean(row.avatar), Boolean(connected),
]);

export class LanePathCache {
  constructor({ margin = 32, limit = 256 } = {}) {
    this.margin = margin; this.limit = Math.max(1, limit); this.entries = new Map(); this.context = null;
  }
  configure(generation, zoom) {
    const key = JSON.stringify([generation, zoom]);
    if (key !== this.context) { this.clear(); this.context = key; }
  }
  clear() { this.entries.clear(); }
  get size() { return this.entries.size; }
  // The virtual list also measures its first row. Keep it without letting that
  // one-row callback discard the visible viewport on every render.
  retain(start, end, measured = 0) {
    if (end - start <= 1) return;
    for (const i of this.entries.keys())
      if (i !== measured && (i < start - this.margin || i >= end + this.margin)) this.entries.delete(i);
  }
  get(index, row, connected, build) {
    const key = laneShapeKey(row, connected), entry = this.entries.get(index);
    this.entries.delete(index); // LRU, including changed identities at the same index.
    const value = entry?.key === key ? entry.value : build();
    this.entries.set(index, { key, value });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    return value;
  }
}
