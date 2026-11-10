// The graph writes "ggit.tab.<tab>" = { repo, sha, machine, file, at } for selection and drawer file clicks.
// Detached details write only "ggit.file.<tab>" with the loaded commit and file, so lagging shared() reads
// cannot overwrite selection. Display the newer file key that matches the selected commit and machine.
// Order writes with counter n, one greater than both keys, so clock changes cannot retain stale diffs.
const fits = (k, { repo, sha, machine }) => k && typeof k === "object" && k.repo === repo && k.sha === sha && (k.machine ?? null) === (machine ?? null);
export function fileFor(tabKey, fileKey, sel) {
  const pick = [tabKey, fileKey].filter((k) => fits(k, sel)).sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || (b.at ?? 0) - (a.at ?? 0))[0];
  return typeof pick?.file?.path === "string" ? pick.file.path : null;
}
export const nextN = (tabKey, fileKey) => Math.max(tabKey?.n ?? 0, fileKey?.n ?? 0) + 1;
