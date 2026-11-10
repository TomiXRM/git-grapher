// Decisions shared by the detail and conflict views. Host rendering and input stay in the views.
export const detailSelectionKey = selection => JSON.stringify(selection ?? null);
export const closesFileMenu = (previousKey, selection) => previousKey !== detailSelectionKey(selection);

export function fileMenuContext(commit, selection, path) {
  const cwd = (commit?.wip ? commit.path : selection?.repo) ?? "";
  return { cwd, absolutePath: `${cwd}/${path}`,
    history: commit?.wip ? { rev: "HEAD", cwd: commit.path } : { rev: commit?.cmp ? commit.head : commit?.sha } };
}

export function conflictSaveRequest(conflict, draft, text) {
  return { rev: conflict.rev, path: draft.f.path, text, workId: draft.f.workId,
    mode: draft.file.e?.s2?.mode ?? draft.file.e?.s3?.mode ?? "100644" };
}
export function conflictTakeRequest(conflict, file, side, draft) {
  return { rev: conflict.rev, f: file, side, workId: draft?.f?.workId ?? null };
}
export function conflictMergeRequest(conflict, message, treeResult) {
  const text = message.trim();
  if (!text) return { blocked: "Write a merge message" };
  if (treeResult?.code !== 0) return { blocked: "Could not read what is staged" };
  return { conflict, message: text, tree: treeResult.stdout.trim() };
}
