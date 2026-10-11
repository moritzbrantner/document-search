// Documents stored before #32 may carry level-indexed sparse heading paths
// (holes in IndexedDB, nulls after a JSON round-trip); keep only string entries, in order.
export function denseHeadingPath(path: readonly unknown[] | null | undefined): string[] {
  return Array.isArray(path)
    ? path.filter((heading): heading is string => typeof heading === "string")
    : [];
}
