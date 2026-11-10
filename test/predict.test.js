import * as F from "./fx.js";
import { readFileSync } from "node:fs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewPull } from '../mods/git-grapher/lib/preview-pull.js';
const { fixture, objectCount, actualResult, gitVersion, markerExists } = F;

const scenarios = [
  'clean', 'same-line', 'modify-delete', 'rename-modify', 'rename-untracked',
  'incoming-file-local-directory', 'incoming-directory-local-file', 'already-applied-patch',
  'autostash-conflict', 'custom-driver', 'dirty-unrelated', 'dirty-overlap', 'newline-conflict',
];

const rows = [];
const expectedActual = {
  clean: ['clean', 'clean'], 'same-line': ['conflict', 'conflict'],
  'modify-delete': ['conflict', 'conflict'], 'rename-modify': ['clean', 'clean'],
  'rename-untracked': ['refused', 'refused'],
  'incoming-file-local-directory': ['refused', 'refused'],
  'incoming-directory-local-file': ['refused', 'refused'],
  'already-applied-patch': ['conflict', 'clean'], 'autostash-conflict': ['conflict', 'conflict'],
  'custom-driver': ['clean', 'clean'], 'dirty-unrelated': ['clean', 'refused'],
  'dirty-overlap': ['refused', 'refused'], 'newline-conflict': ['conflict', 'conflict'],
};
const expectedMergePrediction = {
  clean: 'clean', 'same-line': 'conflict', 'modify-delete': 'conflict', 'rename-modify': 'clean',
  'already-applied-patch': 'conflict', 'newline-conflict': 'conflict', 'dirty-unrelated': 'clean',
};

// preview and native pull run on independent copies across the scenario/policy matrix.
for (const name of scenarios) for (const mode of ['merge', 'rebase']) {
  test(`${name} / ${mode}: independent preview and native pull`, async () => {
    const f = fixture(name, mode);
    try {
      const before = F.snap(f.preview, { preview: true }), oracleBefore = F.snap(f.oracle, { preview: true });
      assert.deepEqual(before, oracleBefore, 'The two copies must start identically');
      const objectsBefore = objectCount(f.preview);
      const previewCalls = [];
      const mergeTreeEffects = [];
      const prediction = await previewPull(async (args, { cwd }) => {
        previewCalls.push(args);
        const beforeCount = args.includes('merge-tree') ? objectCount(cwd) : null;
        const result = await f.run(args, { cwd });
        if (beforeCount !== null) mergeTreeEffects.push({ quiet: args.includes('--quiet'), code: result.code,
          objectsAdded: objectCount(cwd) - beforeCount });
        return result;
      }, { cwd: f.preview });
      assert.equal(prediction.ok, true, JSON.stringify(prediction));
      const predictedAfter = F.snap(f.preview, { preview: true });
      // The custom merge driver writes a marker; preview can run it, so those files can differ.
      if (name === 'custom-driver' && mode === 'merge') {
        const { ['preview-driver-marker']: marker, ...files } = predictedAfter.files;
        assert.ok(marker); assert.equal(readFileSync(join(f.preview, 'preview-driver-marker'), 'utf8'), 'driver-ran');
        // The driver's one explicit side effect is allowed; all refs, index bytes and other files are still protected.
        assert.equal(predictedAfter.status, before.status + '? preview-driver-marker\0');
        assert.deepEqual({ ...predictedAfter, files, status: before.status }, before);
      } else assert.deepEqual(predictedAfter, before, 'Preview must preserve refs, index bytes and working files');
      assert.deepEqual(F.snap(f.oracle, { preview: true }), oracleBefore, 'Preview must not contaminate the oracle');
      const out = f.git(f.oracle, ['pull'], false); // no --rebase/--autostash policy override
      const afterState = F.snap(f.oracle, { preview: true });
      const actual = actualResult(out, oracleBefore, afterState);
      assert.equal(actual, expectedActual[name][mode === 'merge' ? 0 : 1], JSON.stringify(out));
      assert.equal(prediction.data.predicted, mode === 'rebase' ? 'unknown' : expectedMergePrediction[name] || 'unknown');
      assert.ok(previewCalls.every(args => args[0] === '--no-optional-locks'));
      assert.ok(previewCalls.every(args => !args.includes('fetch') && !args.includes('pull') && !args.includes('replay')));
      const quiet = previewCalls.findIndex(args => args.includes('--quiet'));
      const detail = previewCalls.findIndex(args => args.includes('merge-tree') && !args.includes('--quiet'));
      if (detail >= 0) assert.ok(quiet >= 0 && quiet < detail, 'Detailed merge-tree only follows quiet conflict');
      for (const effect of mergeTreeEffects.filter(x => x.quiet)) assert.equal(effect.objectsAdded, 0,
        'Quiet built-in merge prediction creates no objects in the tested cases');
      if (prediction.data.history.result === 'clean' && quiet >= 0) {
        assert.equal(detail, -1);
        assert.equal(objectCount(f.preview), objectsBefore, 'Quiet clean preview creates no objects in this fixture');
      }
      if (name === 'newline-conflict' && mode === 'merge') assert.deepEqual(prediction.data.history.paths, ['line\nspace 日本語\tfile']);
      if (name === 'rename-untracked' && mode === 'merge') assert.deepEqual(prediction.data.localOverwrite.paths, ['renamed']);
      if (name === 'incoming-file-local-directory' && mode === 'merge') assert.deepEqual(prediction.data.localOverwrite.paths, ['path/local']);
      if (name === 'incoming-directory-local-file' && mode === 'merge') assert.ok(prediction.data.localOverwrite.paths.includes('path'));
      if (name === 'autostash-conflict') {
        assert.equal(out.code, 0, 'Native pull can exit zero with unresolved autostash');
        assert.ok(afterState.stash);
        assert.notEqual(afterState.head, oracleBefore.head);
        assert.equal(prediction.data.stashRestore.result, 'unknown');
      }
      let rawDriver = null;
      if (name === 'custom-driver') {
        assert.deepEqual(prediction.data.externalCode, ['merge-driver']);
        assert.equal(markerExists(f.preview), mode === 'merge', 'merge-tree runs the driver; rebase mode never reaches merge-tree');
        // The fixture driver writes a file, so the final re-check sees a changed status and abstains (a detected side effect).
        if (mode === 'merge') assert.equal(prediction.data.history.reason, 'observed-basis-changed');
        assert.equal(markerExists(f.oracle), true);
        const raw = join(f.root, 'raw-quiet-probe');
        cpSync(f.seed, raw, { recursive: true });
        const probe = f.git(raw, ['--no-optional-locks', 'merge-tree', '--write-tree', '--quiet', 'HEAD', '@{upstream}'], false);
        rawDriver = { code: probe.code, markerCreated: markerExists(raw) };
        assert.equal(rawDriver.markerCreated, true, 'Even --quiet runs a custom driver');
      }
      let naiveUntracked = null;
      if (['rename-untracked', 'incoming-file-local-directory'].includes(name)) {
        const added = f.git(f.seed, ['diff', '--name-only', '--diff-filter=A', '-z', 'HEAD', '@{upstream}']).stdout.split('\0').filter(Boolean);
        const untracked = f.git(f.seed, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
        naiveUntracked = { added, untracked, intersection: untracked.filter(path => added.includes(path)) };
        assert.deepEqual(naiveUntracked.intersection, [], 'The old exact-path/A-only heuristic misses this refusal');
      }
      rows.push({ name, mode, prediction: prediction.data, actual, pull: out,
        headChanged: before.head !== afterState.head, unmerged: afterState.unmerged, stash: afterState.stash,
        statCacheChanged: before.index !== afterState.index && before.indexEntries === afterState.indexEntries,
        objectsAddedByPreview: objectCount(f.preview) - objectsBefore, mergeTreeEffects, rawDriver, naiveUntracked, commands: f.log });
    } finally { f.dispose(); }
  });
}

test('ff-only rejects a divergent history without trying a merge predictor', async () => {
  const f = fixture('clean', 'merge');
  try {
    for (const cwd of [f.preview, f.oracle]) f.git(cwd, ['config', 'pull.ff', 'only']);
    const p = await previewPull(f.run, f.preview);
    assert.equal(p.ok, true);
    assert.equal(p.data.predicted, 'refused');
    const before = F.snap(f.oracle, { preview: true }), out = f.git(f.oracle, ['pull'], false);
    assert.equal(actualResult(out, before, F.snap(f.oracle, { preview: true })), 'refused');
  } finally { f.dispose(); }
});

// Revalidate the observed basis before returning the prediction.
test('an upstream move during preview invalidates the observed basis', async () => {
  const f = fixture('clean', 'merge');
  try {
    const race = F.race({ cwd: f.preview, at: "after", when: (k, args) => k === "run" && args.includes("--quiet"), do: () => F.git(f.preview, "update-ref", "refs/heads/upstream", "HEAD") });
    const p = await previewPull(race.ad.run, f.preview); F.fired(race);
    F.same(f.preview, race.record.snapshot);
    assert.equal(F.git(f.preview, "rev-parse", "upstream"), F.git(f.preview, "rev-parse", "HEAD"));
    assert.equal(p.ok, true);
    assert.equal(p.data.predicted, 'unknown');
    assert.equal(p.data.history.reason, 'observed-basis-changed');
  } finally { f.dispose(); }
});

test('unsupported quiet mode is unknown, never a clean prediction', async () => {
  const f = fixture('clean', 'merge');
  try {
    const p = await previewPull((args, { cwd }) => args.includes('--quiet')
      ? { code: 129, stdout: '', stderr: 'unsupported option' } : f.run(args, { cwd }), f.preview);
    assert.equal(p.ok, true);
    assert.equal(p.data.history.result, 'unknown');
  } finally { f.dispose(); }
});

test('truncated porcelain is an observation error, not a clean working tree', async () => {
  const p = await previewPull(async () => ({ code: 0, stdout: '# branch.oid abc', stderr: '' }), { cwd: '/unused-fixture' });
  assert.equal(p.ok, false);
});

test('runner rejection is distinct from a Git conflict', async () => {
  const p = await previewPull(async () => { throw new Error('fixture transport lost'); }, { cwd: '/unused-fixture' });
  assert.equal(p.ok, false);
  assert.equal(p.error.kind, 'exec-rejected');
});

test('branch rebase config takes precedence over pull.rebase', async () => {
  const f = fixture('same-line', 'merge');
  try {
    f.git(f.preview, ['config', 'branch.main.rebase', 'true']);
    const p = await previewPull(f.run, f.preview);
    assert.equal(p.ok, true);
    assert.equal(p.data.mode, 'rebase');
    assert.equal(p.data.history.result, 'unknown');
  } finally { f.dispose(); }
});

after(() => {
  if (process.env.GGIT_G2_REPORT) writeFileSync(process.env.GGIT_G2_REPORT,
    JSON.stringify({ gitVersion: gitVersion(), nodeVersion: process.version, rows }, null, 2) + '\n');
});
