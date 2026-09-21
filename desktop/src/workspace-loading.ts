export function areWorkspacesLoaded(
  expected: Set<string> | null,
  initialized: Set<string>,
): boolean {
  if (!expected) return false;
  for (const id of expected) {
    if (!initialized.has(id)) return false;
  }
  return true;
}
