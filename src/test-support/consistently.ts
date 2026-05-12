/**
 * Sibling of `eventually()` for the inverse semantic: poll `fn` for a
 * fixed duration, asserting the predicate keeps holding. If `fn` ever
 * throws (or its `assert` calls fail), the failure is re-thrown
 * immediately. If the duration elapses without a single failure, returns
 * the last successful value.
 *
 * Use for "this MUST NOT happen for a while" checks where `eventually()`
 * is the wrong shape — `eventually()` polls until success and so would
 * pass on the first tick of a transient correct state.
 *
 * Patterns:
 *
 *   // Driver must not ACK a NAK for at least 50ms.
 *   await consistently(() => assert.equal(alarm.received.length, 0), { durationMs: 50 });
 *
 *   // The alarm port must stay unbound while discoverDevices runs.
 *   await consistently(async () => {
 *     const bound = await tryConnect(harness.alarmPort);
 *     assert.equal(bound, false);
 *   }, { durationMs: 5000, intervalMs: 50 });
 */
export async function consistently<T>(
  fn: () => T | Promise<T>,
  opts: { durationMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const durationMs = opts.durationMs ?? 100;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + durationMs;
  let lastResult: T;
  while (Date.now() < deadline) {
    try {
      lastResult = await fn();
    } catch (err) {
      const suffix = opts.message ? ` (${opts.message})` : '';
      if (err instanceof Error) {
        err.message = `consistently: predicate failed within ${durationMs}ms${suffix} — ${err.message}`;
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return lastResult!;
}
