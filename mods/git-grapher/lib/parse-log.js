// NUL separates records; the first two US characters separate fields.
// Further US characters belong to the subject and survive.
export const LOG_FORMAT = "%H%x1f%P%x1f%s";
export const LOG_ARGS = Object.freeze([
  "log", "--topo-order", "--no-color", "--no-decorate",
  "--no-show-signature", "--encoding=UTF-8", "-z", `--format=${LOG_FORMAT}`,
]);

export function parseLog(text) {
  if (text === "") return [];
  const records = text.split("\0");
  if (records[records.length - 1] === "") records.pop();
  return records.map((record, index) => {
    const first = record.indexOf("\x1f");
    const second = record.indexOf("\x1f", first + 1);
    if (first <= 0 || second < 0) {
      throw new SyntaxError(`Invalid git log record ${index + 1}: expected id, parents, subject`);
    }
    const parents = record.slice(first + 1, second);
    return {
      id: record.slice(0, first),
      parents: parents ? parents.split(" ") : [],
      subject: record.slice(second + 1),
    };
  });
}

// Commits on no branch.
// The HEAD reflog's "checkout: moving from <sha> to …" lines name a detached HEAD that was left: those shas are the
// candidates. The caller keeps the ones `rev-list <tips> --not --branches --remotes --tags HEAD` still finds.
// ponytail: only left detached HEADs; commits dropped by reset --hard / amend / rebase on a branch are not shown.
export const ORPHAN_REFLOG = ["reflog", "show", "--no-color", "--format=%gs", "-n", "1000", "HEAD"];
export function orphanTips(text) {
  const out = new Set();
  for (const l of text.split("\n")) {
    const m = /^checkout: moving from ([0-9a-f]{40}|[0-9a-f]{64}) to /.exec(l);
    if (m) out.add(m[1]);
  }
  return [...out];
}
