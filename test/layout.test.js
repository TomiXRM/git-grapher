import * as F from "./fx.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layout, NUM_COLORS } from '../mods/git-grapher/lib/layout.js';
import { parseLog, LOG_ARGS } from '../mods/git-grapher/lib/parse-log.js';

const c = (id, parents = []) => ({ id, parents, subject: `commit ${id}` });
const merge = () => [c('M', ['B', 'D']), c('B', ['A']), c('D', ['A']), c('A')];
const has = (row, kind, from, to, color) => row.edges.some(e =>
  e.kind === kind && e.from === from && e.to === to && (color === undefined || e.color === color));
const boundary = (row, top) => [...new Set(row.edges
  .filter(e => e.kind === 'pass' || e.kind === (top ? 'into' : 'out'))
  .map(e => `${top ? e.from : e.to}:${e.color}`))].sort();

// T007's five invariants, strengthened with boundary colours and exact extent.
// Compare sets: a merge out and a pass may share the same bottom lane/colour.
function check(commits, graph = layout(commits)) {
  assert.equal(graph.schema, 'graph.v1');
  assert.deepEqual(graph.rows.map(r => r.commit), commits.map(c => c.id));
  let extent = 0;
  graph.rows.forEach((row, i) => {
    assert.equal(row.node, commits[i].parents.length > 1 ? 'merge' : 'commit');
    assert.equal(row.subject, commits[i].subject);
    assert.ok(Number.isInteger(row.color) && row.color >= 0 && row.color < NUM_COLORS);
    const seen = new Set();
    for (const e of row.edges) {
      assert.ok(['pass', 'into', 'out'].includes(e.kind));
      if (e.kind === 'into') assert.equal(e.to, row.lane);
      if (e.kind === 'out') assert.equal(e.from, row.lane);
      if (e.kind === 'pass') {
        assert.equal(e.from, e.to); // public Rust layout never shifts columns
        assert.notEqual(e.from, row.lane);
      }
      assert.ok(Number.isInteger(e.color) && e.color >= 0 && e.color < NUM_COLORS);
      const key = `${e.kind}:${e.from}:${e.to}`;
      assert.ok(!seen.has(key), `duplicate edge at ${row.commit}`);
      seen.add(key);
    }
    for (const lane of [row.lane, ...row.edges.flatMap(e => [e.from, e.to])]) {
      assert.ok(Number.isInteger(lane) && lane >= 0 && lane < graph.lane_count);
      extent = Math.max(extent, lane + 1);
    }
    if (i) assert.deepEqual(boundary(graph.rows[i - 1], false), boundary(row, true), `boundary at ${row.commit}`);
  });
  assert.equal(graph.lane_count, extent);
  if (graph.rows.length) assert.deepEqual(boundary(graph.rows[0], true), []);
  return graph;
}

// Stable lane layout cases.
test('layout: empty input', () => assert.deepEqual(check([]), { schema: 'graph.v1', lane_count: 0, rows: [] }));
test('layout: linear three commits', () => {
  const g = check([c('C', ['B']), c('B', ['A']), c('A')]);
  assert.equal(g.lane_count, 1);
  assert.deepEqual(g.rows.map(r => r.edges), [
    [{ from: 0, to: 0, kind: 'out', color: 0 }],
    [{ from: 0, to: 0, kind: 'into', color: 0 }, { from: 0, to: 0, kind: 'out', color: 0 }],
    [{ from: 0, to: 0, kind: 'into', color: 0 }],
  ]);
});
test('layout: branch and merge', () => {
  const g = check(merge());
  assert.equal(g.lane_count, 2);
  assert.deepEqual(g.rows.map(r => r.lane), [0, 0, 1, 0]);
  assert.ok(has(g.rows[2], 'out', 1, 1));
  assert.ok(has(g.rows[3], 'into', 1, 0));
});
test('layout: multiple roots', () => {
  const g = check([c('B'), c('A')]);
  assert.equal(g.lane_count, 1);
  assert.ok(g.rows.every(r => r.lane === 0 && r.edges.length === 0));
});
test('layout: first parent converges at parent row', () => {
  const g = check([c('X', ['A']), c('Y', ['A']), c('A')]);
  assert.equal(g.lane_count, 2);
  assert.ok(has(g.rows[1], 'out', 1, 1));
  assert.ok(!has(g.rows[1], 'out', 1, 0));
  assert.ok(has(g.rows[2], 'into', 1, 0));
});
test('layout: stable colour carried along branch', () => {
  const g = check([c('C', ['B']), c('B', ['A']), c('A')]);
  assert.ok(g.rows.every(r => r.color === 0 && r.edges.every(e => e.color === 0)));
});
test('layout: distinct branch colours', () => assert.deepEqual(check(merge()).rows.map(r => r.color), [0, 0, 1, 0]));

// Graph topology cases, including real git histories below.
const cases = [
  ['linear_10', Array.from({ length: 10 }, (_, i) => c(String(9 - i), i < 9 ? [String(8 - i)] : [])), [0,0,0,0,0,0,0,0,0,0]],
  ['branch_and_merge', merge(), [0,0,1,0]],
  ['octopus_merge_3parents', [c('O', ['A','B','C']), c('A'), c('B'), c('C')], [0,0,1,2]],
  ['criss_cross_merge', [c('M2', ['M1','B']), c('M1', ['A','B']), c('A'), c('B')]],
  ['parallel_long_branch_pass_edges', [5,4,3,2,1].flatMap(i => [c(`M${i}`, [i > 1 ? `M${i-1}` : 'R']), c(`F${i}`, [i > 1 ? `F${i-1}` : 'R'])]).concat(c('R'))],
  ['multiple_roots_lane_reuse', [c('T',['P']), c('P'), c('R1'), c('R2')], [0,0,0,0]],
  ['lane_reuse_after_merge', merge().concat(c('X',['Y']), c('Y')), [0,0,1,0,0,0]],
  ['single_commit', [c('A')], [0]],
  ['stress_three_level_nested', [c('M3',['B3','F3']), c('B3',['M2a']), c('F3',['M2b']), c('M2a',['B2a','F2a']), c('B2a',['R2a']), c('F2a',['R2a']), c('M2b',['B2b','F2b']), c('B2b',['R2b']), c('F2b',['R2b']), c('R2a'), c('R2b')]],
  ['criss_cross_full', [c('Z',['X','Y']), c('X',['A','B']), c('Y',['B','A']), c('A'), c('B')]],
  ['two_roots_lane_concurrent_then_reuse', [c('M',['X','Y']), c('X'), c('Y'), c('N',['P']), c('P')], [0,0,1,0,0]],
  ['stable_stacked_branches_staircase', [c('P1',['P2','T1']), c('P2',['P3','T4']), c('P3',['P4','T5']), c('T1',['T2']), c('T2',['T3']), c('T3',['T4']), c('T4',['T5']), c('T5',['P4']), c('P4')], [0,0,0,1,1,1,2,3,0]],
];
// Topology fixtures verify stable rows and boundary continuity.
for (const [name, commits, lanes] of cases) test(`layout: ${name}`, () => {
  const g = check(commits);
  if (lanes) assert.deepEqual(g.rows.map(r => r.lane), lanes);
  if (name === 'octopus_merge_3parents') assert.equal(g.rows[0].edges.filter(e => e.kind === 'out').length, 3);
  if (name === 'parallel_long_branch_pass_edges') assert.ok(g.rows.slice(2, 8).every(r => r.edges.some(e => e.kind === 'pass')));
  if (name === 'stable_stacked_branches_staircase') {
    for (const [i, from, to] of [[6,2,2], [6,1,2], [7,3,3], [7,2,3], [8,0,0], [8,3,0]]) assert.ok(has(g.rows[i], 'into', from, to));
  }
});

// Topology fixtures verify stable rows and boundary continuity.
test('layout: end-to-end Git log -> parser -> layout', async () => {
  const dir = F.repo({});
  const git = (args, input) => { const r = F.processRun('git', args, { cwd: dir, input }); assert.equal(r.code, 0, r.stderr); return r.stdout; };
  const tree = git(['mktree'], '').trim();
  const commit = (subject, parents = []) => git(['commit-tree', tree, ...parents.flatMap(p => ['-p', p])], subject + '\n').trim();
  const a = commit('initial A');
  const b = commit('B', [a]);
  const cc = commit('C 日本語\x1f extra', [b]);
  const d = commit('D', [cc]);
  const e = commit('merge E', [b, d]);
  git(['update-ref', 'HEAD', e]);
  const out = await F.ad.run([...LOG_ARGS, 'HEAD'], { cwd: dir }); assert.equal(out.code, 0, out.stderr);
  const commits = parseLog(out.stdout);
  assert.deepEqual(commits.map(c => c.id), [e,d,cc,b,a]);
  assert.deepEqual(commits[0].parents, [b,d]);
  assert.equal(commits[2].subject, 'C 日本語\x1f extra');
  assert.equal(check(commits).rows[0].edges.filter(e => e.kind === 'out').length, 2);
});

test('layout: frozen inputs, repeatability and optional subject', () => {
  const input = Object.freeze(merge().map(c => Object.freeze({ ...c, parents: Object.freeze(c.parents) })));
  const first = layout(input);
  assert.deepEqual(layout(input), first);
  first.rows[0].edges[0].color = 99;
  assert.notEqual(layout(input).rows[0].edges[0].color, 99);
  assert.ok(!Object.hasOwn(layout([{ id: 'root', parents: [] }]).rows[0], 'subject'));
});
test('layout: colour wrap and lane reuse keep fresh colours', () => {
  const g = check(Array.from({ length: 19 }, (_, i) => c(String(i))));
  assert.deepEqual(g.rows.map(r => r.color), Array.from({ length: 19 }, (_, i) => i % 8));
});
test('layout: merge to existing lane uses its colour without allocating', () => {
  const g = check([c('X',['P']), c('M',['Q','P']), c('Q'), c('P')]);
  assert.equal(g.lane_count, 2);
  assert.ok(has(g.rows[1], 'out', 1, 0, 0));
  assert.ok(has(g.rows[1], 'pass', 0, 0, 0));
});
test('layout: truncated window retains unresolved parent edges', () => {
  const g = check([c('M',['B','D']), c('B',['outside'])]);
  assert.deepEqual(boundary(g.rows.at(-1), false), ['0:0','1:1']);
});
test('layout fixture: hand-authored shift is outside the stable output subset', () => {
  const basic = JSON.parse(readFileSync(new URL('./fixtures/rows-basic.json', import.meta.url), 'utf8'));
  const e5 = basic.rows.find(r => r.commit === 'e5');
  assert.ok(has(e5, 'pass', 2, 1));
  assert.ok(has(e5, 'out', 1, 0));
  // Stable columns cannot shift. A leftward out remains possible at a merge.
  const g = check([c('X',['P']), c('M',['Q','P']), c('Q'), c('P')]);
  assert.ok(has(g.rows[1], 'out', 1, 0));
  assert.ok(g.rows.every(r => r.edges.every(e => e.kind !== 'pass' || e.from === e.to)));
});
test('generated DAGs: 100 seeded topologies, coloured boundary continuity', () => {
  let seed = 0x5032;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2**32; };
  for (let trial = 0; trial < 100; trial++) {
    const commits = Array.from({ length: 60 }, (_, i) => {
      const available = 59 - i;
      const parents = new Set();
      const count = Math.min(available, Math.floor(random() * 5));
      while (parents.size < count) parents.add(String(i + 1 + Math.floor(random() * available)));
      return c(String(i), [...parents]);
    });
    const graph = check(commits);
    assert.deepEqual(boundary(graph.rows.at(-1), false), []);
  }
});

test('wip rows: hollow node, dashed only down to their HEAD', () => {
  const g = layout([
    { id: 'wip:/a', parents: ['h'], wip: true },
    { id: 'wip:/b', parents: ['x'], wip: true },
    { id: 'h', parents: ['x'] },
    { id: 'x', parents: [] },
  ]);
  const [wa, wb, h, x] = g.rows;
  assert.equal(wa.node, 'wip'); assert.equal(h.node, 'commit');
  assert.ok(wa.edges.every((e) => e.dashed), 'out of the wip row');
  assert.ok(wb.edges.filter((e) => e.from === wa.lane).every((e) => e.dashed), 'pass through the next wip row');
  assert.ok(h.edges.some((e) => e.kind === 'into' && e.dashed), 'into HEAD');
  assert.ok(h.edges.filter((e) => e.kind === 'out').every((e) => !e.dashed), 'below HEAD: solid');
  assert.ok(x.edges.some((e) => e.kind === 'into' && e.dashed && e.from === wb.lane), 'second wip reaches its own HEAD dashed');
});

test('stash rows: node "stash", dashed down to their base', () => {
  const g = layout([{ id: 'stash:s', parents: ['h', 'i'], stash: true }, { id: 'h', parents: [] }]);
  assert.equal(g.rows[0].node, 'stash');
  assert.ok(g.rows[0].edges.filter((e) => e.from === e.to).every((e) => e.dashed));
});

test('a commit reached only by a stash lane does not take the stash colour', () => {
  const g = layout([{ id: 's', parents: ['h'], stash: true, color: 8 }, { id: 'h', parents: ['x'] }, { id: 'x', parents: [] }]);
  assert.equal(g.rows[0].color, 8);
  assert.notEqual(g.rows[1].color, 8);
  assert.notEqual(g.rows[2].color, 8);
});
