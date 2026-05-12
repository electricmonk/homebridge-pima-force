/**
 * Walk a paginated DATA response. Each call to `fetch(cursor)` returns the
 * next page; the loop stops when `more` is false. Successive pages are
 * concatenated and returned as a flat array.
 *
 * Fail-fast guard: if the panel ever returns `more: true` with an empty
 * `parameters` array — or if the computed next cursor doesn't strictly
 * advance — the function rejects rather than re-issuing the same DATA-REQ
 * forever. Without this guard a malformed panel response wedges the
 * transport's wire queue and starves the Node event loop (the busy await-
 * loop never yields to a macrotask).
 */
export async function paginateDataResponse(
  startOrder: number,
  fetch: (cursor: number) => Promise<{ parameters: string[]; more: boolean }>,
): Promise<string[]> {
  const all: string[] = [];
  let cursor = startOrder;
  while (true) {
    const res = await fetch(cursor);
    if (res.more && res.parameters.length === 0) {
      throw new Error(
        `pagination stuck: panel returned more=yes with no parameters at startOrder=${startOrder}, cursor=${cursor}`,
      );
    }
    all.push(...res.parameters);
    if (!res.more) return all;
    const nextCursor = startOrder + all.length;
    if (nextCursor <= cursor) {
      // Defensive: should be unreachable given the more+empty guard above,
      // but if it ever isn't, refuse to re-send the same DATA-REQ.
      throw new Error(
        `pagination stuck: cursor did not advance (cursor=${cursor}, next=${nextCursor})`,
      );
    }
    cursor = nextCursor;
  }
}
