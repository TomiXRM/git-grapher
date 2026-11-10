// Advisory prediction from cached upstream refs; never fetches or pulls.
// run(args, { cwd }) executes git and preserves NULs in stdout. No Node or herdr dependency.
// The observations are not guaranteed to form an atomic snapshot.

const assessment = (result, reason, paths = [], extra = {}) => ({ result, reason, paths, ...extra });
const clean = reason => assessment('clean', reason);
const unknown = (reason, paths = []) => assessment('unknown', reason, paths);
const unique = values => [...new Set(values)].sort();
const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

function splitPrefix(record, count) {
  const fields = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const next = record.indexOf(' ', at);
    if (next < 0) throw new Error('Incomplete porcelain record');
    fields.push(record.slice(at, next));
    at = next + 1;
  }
  return { fields, path: record.slice(at) };
}

function parseStatus(text) {
  if (text && !text.endsWith('\0')) throw new Error('Truncated status output');
  const result = { head: null, branch: null, upstream: null, tracked: [], untracked: [], unmerged: [] };
  const records = text.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const space = record.indexOf(' ', 2);
      const key = record.slice(2, space), value = record.slice(space + 1);
      if (key === 'branch.oid') result.head = value === '(initial)' ? null : value;
      if (key === 'branch.head') result.branch = value === '(detached)' ? null : value;
      if (key === 'branch.upstream') result.upstream = value;
    } else if (record.startsWith('? ')) result.untracked.push(record.slice(2));
    else if (record.startsWith('1 ')) result.tracked.push(splitPrefix(record, 8).path);
    else if (record.startsWith('2 ')) {
      result.tracked.push(splitPrefix(record, 9).path);
      if (!records[++i]) throw new Error('Missing rename source');
      result.tracked.push(records[i]);
    } else if (record.startsWith('u ')) result.unmerged.push(splitPrefix(record, 10).path);
    else throw new Error('Unexpected porcelain record');
  }
  if (!result.head && !result.branch) throw new Error('Missing branch headers');
  return result;
}

function parseConfig(text) {
  if (text && !text.endsWith('\0')) throw new Error('Truncated config output');
  const values = new Map();
  for (const record of text.split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\n');
    const key = separator < 0 ? record : record.slice(0, separator);
    const value = separator < 0 ? '' : record.slice(separator + 1);
    values.set(key, [...(values.get(key) || []), value]);
  }
  return { values, get: key => values.get(key)?.at(-1) };
}

function boolean(value) {
  if (value === undefined) return false;
  if (['', 'true', 'yes', 'on', '1'].includes(value.toLowerCase())) return true;
  if (['false', 'no', 'off', '0'].includes(value.toLowerCase())) return false;
  return null;
}

function settings(config, branch) {
  const rebase = config.get(`branch.${branch}.rebase`) ?? config.get('pull.rebase');
  let mode = rebase === undefined ? 'unspecified' : boolean(rebase) === false ? 'merge'
    : boolean(rebase) === true || ['merges', 'interactive', 'preserve'].includes(rebase) ? 'rebase' : 'unknown';
  const ff = config.get('pull.ff');
  if (ff === 'only') mode = 'ff-only';
  const autostash = boolean(config.get(mode === 'rebase' ? 'rebase.autostash' : 'merge.autostash'));
  const customDriver = [...config.values.keys()].some(key => /^merge\..+\.driver$/.test(key));
  const unmodelled = ['pull.twohead', 'pull.octopus', 'pull.autostash', 'merge.ff', `branch.${branch}.mergeoptions`]
    .filter(key => config.get(key) !== undefined);
  if (ff !== undefined && ff !== 'only' && boolean(ff) === null) unmodelled.push('pull.ff');
  if (ff !== undefined && boolean(ff) === false) unmodelled.push('pull.ff=false');
  if ((config.values.get(`branch.${branch}.merge`) || []).length > 1) unmodelled.push('multiple-upstreams');
  // Rerere can change what is left unresolved by the real pull.
  if (boolean(config.get('rerere.enabled')) !== false) unmodelled.push('rerere.enabled');
  return { mode, autostash, customDriver, unmodelled };
}

function conflictPaths(text) {
  const records = text.split('\0');
  if (!/^[0-9a-f]+$/.test(records[0]) || !text.endsWith('\0')) throw new Error('Invalid merge-tree output');
  const end = records.indexOf('', 1);
  if (end < 0) throw new Error('Missing merge-tree section delimiter');
  // Information messages follow the empty record; they are not path records.
  return unique(records.slice(1, end));
}

function verdict(data) {
  const axes = [data.history, data.localOverwrite, data.stashRestore];
  // An unknown checkout refusal could precede a known history conflict.
  if (axes.some(a => a.result === 'unknown')) return 'unknown';
  if (axes.some(a => a.result === 'refused')) return 'refused';
  return axes.some(a => a.result === 'conflict') ? 'conflict' : 'clean';
}

/** @returns {Promise<{ok:true,data:object}|{ok:false,error:object}>} */
export async function previewPull(run, repo) {
  const cwd = typeof repo === 'string' ? repo : repo.cwd;
  let phase = 'inspect';
  const calls = [];
  const git = async args => {
    // same read flags as herdr's changes mod (fsmonitor off, no index refresh).
    const argv = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false', ...args];
    let out;
    try { out = await run(argv, { cwd }); }
    catch (error) { throw { kind: 'exec-rejected', message: error.message || String(error) }; }
    if (!out || !Number.isInteger(out.code) || typeof out.stdout !== 'string' || typeof out.stderr !== 'string') {
      throw { kind: 'unexpected-output', message: 'Runner did not return a completed Git command' };
    }
    calls.push({ args: argv, code: out.code });
    return out;
  };
  const required = async args => {
    const out = await git(args);
    if (out.code !== 0) throw { kind: 'git-failed', message: 'Git observation failed', raw: out, args };
    return out.stdout;
  };
  try {
    const rawStatus = await required(['status', '--porcelain=v2', '--branch', '--show-stash', '--untracked-files=all', '-z']);
    const status = parseStatus(rawStatus);
    const configText = await required(['config', '--null', '--list']);
    const config = parseConfig(configText);
    const policy = settings(config, status.branch);
    const data = {
      basis: { headOid: status.head, branch: status.branch, upstreamRef: null, upstreamOid: null, knowledge: 'cached' },
      mode: policy.mode,
      history: unknown('not-evaluated'), localOverwrite: unknown('not-evaluated'), stashRestore: unknown('not-evaluated'),
      scope: 'Content prediction only; fetch, hooks, credentials and external races can change the result.',
      calls,
    };
    const finish = () => ({ ok: true, data: { ...data, predicted: verdict(data) } });
    const abstain = reason => {
      data.history = unknown(reason); data.localOverwrite = unknown(reason); data.stashRestore = unknown(reason);
      return finish();
    };
    if (!status.head || !status.branch) return abstain(!status.head ? 'unborn' : 'detached-head');
    if (status.unmerged.length) return abstain('already-unmerged');
    if (!status.upstream) return abstain('upstream-unavailable');
    const upstream = await git(['rev-parse', '--verify', '@{upstream}']);
    if (upstream.code !== 0) return abstain('upstream-unavailable');
    const upstreamOid = upstream.stdout.trim();
    if (!/^[0-9a-f]+$/.test(upstreamOid)) throw new Error('Invalid upstream OID');
    data.basis.upstreamOid = upstreamOid;
    data.basis.upstreamRef = (await required(['rev-parse', '--symbolic-full-name', '@{upstream}'])).trim();
    // Run the preview even with a custom merge driver and disclose the possible side effect:
    // merge-tree --quiet can execute the driver.
    if (policy.customDriver) data.externalCode = ['merge-driver'];
    if (policy.unmodelled.length || policy.mode === 'unknown' || policy.autostash === null) return abstain('unmodelled-pull-settings');
    const ancestor = async (a, b) => {
      const out = await git(['merge-base', '--is-ancestor', a, b]);
      if (out.code !== 0 && out.code !== 1) throw { kind: 'git-failed', message: 'Cannot compare histories', raw: out };
      return out.code === 0;
    };
    const noChange = await ancestor(upstreamOid, status.head);
    const ff = noChange ? false : await ancestor(status.head, upstreamOid);
    data.topology = noChange ? 'up-to-date' : ff ? 'fast-forward' : 'diverged';
    phase = 'preview';
    if (policy.mode === 'rebase') data.history = unknown('rebase-semantics-not-modelled');
    else if (noChange) data.history = clean('upstream-is-ancestor');
    else if (policy.mode === 'ff-only' && !ff) data.history = assessment('refused', 'ff-only-diverged');
    else if (policy.mode === 'unspecified' && !ff) data.history = unknown('divergent-pull-mode-unspecified');
    else {
      // Pin the observed OIDs; preview does not fetch and never uses git replay.
      const quiet = await git(['merge-tree', '--write-tree', '--quiet', status.head, upstreamOid]);
      if (quiet.code === 0) data.history = assessment('clean', 'merge-tree-clean', [], { method: 'merge-tree-quiet' });
      else if (quiet.code === 1) {
        const detail = await git(['merge-tree', '--write-tree', '--name-only', '-z', status.head, upstreamOid]);
        if (detail.code !== 1) data.history = unknown('merge-tree-detail-disagreed');
        else data.history = assessment('conflict', 'merge-tree-conflict', conflictPaths(detail.stdout), { method: 'merge-tree' });
      } else data.history = unknown('merge-tree-unavailable-or-failed');
    }

    const tracked = unique(status.tracked), untracked = unique(status.untracked);
    data.stashRestore = policy.autostash && tracked.length
      ? unknown('autostash-restore-not-modelled', tracked) : clean('no-tracked-autostash');
    if (!tracked.length && !untracked.length) data.localOverwrite = clean('working-tree-clean');
    else if (noChange && policy.mode !== 'rebase') data.localOverwrite = clean('no-incoming-changes');
    else if (!ff || policy.mode === 'rebase') data.localOverwrite = unknown('checkout-semantics-not-modelled', unique([...tracked, ...untracked]));
    else {
      // Disable rename folding: a rename destination must appear in the delta.
      const delta = await required(['diff', '--no-renames', '--name-only', '-z', status.head, upstreamOid, '--']);
      if (delta && !delta.endsWith('\0')) throw new Error('Truncated incoming path list');
      const incoming = delta.split('\0').filter(Boolean);
      const atRisk = unique([...(!policy.autostash ? tracked : []), ...untracked].filter(path => incoming.some(other => overlap(path, other))));
      // Path overlap is evidence of risk, not proof of refusal (content/filters matter).
      data.localOverwrite = atRisk.length ? unknown('overlapping-local-paths', atRisk) : clean('no-overlapping-incoming-paths');
    }
    phase = 'verify';
    const statusAfter = await required(['status', '--porcelain=v2', '--branch', '--show-stash', '--untracked-files=all', '-z']);
    const configAfter = await required(['config', '--null', '--list']);
    const upstreamAfter = await git(['rev-parse', '--verify', '@{upstream}']);
    if (statusAfter !== rawStatus || configAfter !== configText || upstreamAfter.code !== 0 || upstreamAfter.stdout.trim() !== upstreamOid) {
      return abstain('observed-basis-changed');
    }
    return finish();
  } catch (error) {
    return { ok: false, error: {
      kind: error.kind || (error instanceof Error ? 'unexpected-output-or-exec' : 'exec-rejected'),
      phase, message: error.message || String(error), raw: error.raw || null,
    } };
  }
}
