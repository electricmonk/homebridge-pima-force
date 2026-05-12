/**
 * Poll `fn` until it returns truthy (or any value other than `undefined`)
 * or its synchronous `assert` calls stop throwing. Re-throws the last
 * error / asserts failure once `timeoutMs` elapses.
 *
 * Patterns:
 *
 *   await eventually(() => assert.equal(partition.currentState, AWAY_ARM));
 *
 *   const acc = await eventually(async () => {
 *     const a = await homebridge.findAccessory('E2E Door');
 *     assert.equal(a.values.ContactSensorState, 1);
 *     return a;
 *   });
 *
 * Intentionally tiny: one shape, one timeout default, one interval default.
 */
export async function eventually<T>(
  fn: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      return result;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const suffix = opts.message ? ` (${opts.message})` : '';
  if (lastError instanceof Error) {
    lastError.message = `eventually: timed out after ${timeoutMs}ms${suffix} — ${lastError.message}`;
    throw lastError;
  }
  throw new Error(`eventually: timed out after ${timeoutMs}ms${suffix}`);
}
