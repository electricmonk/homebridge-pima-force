import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { paginateDataResponse } from './pagination.js';

describe('paginateDataResponse', () => {
  it('concatenates parameters across pages until more=false', async () => {
    const pages = [
      { parameters: ['a', 'b'], more: true },
      { parameters: ['c', 'd'], more: true },
      { parameters: ['e'],      more: false },
    ];
    const seen: number[] = [];
    const result = await paginateDataResponse(1, async (cursor) => {
      seen.push(cursor);
      return pages.shift()!;
    });
    assert.deepEqual(result, ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(seen, [1, 3, 5], `expected cursor to advance by page size; saw ${seen}`);
  });

  it('returns empty array when first page is empty and more=false', async () => {
    const result = await paginateDataResponse(1, async () => ({ parameters: [], more: false }));
    assert.deepEqual(result, []);
  });

  it('rejects fast when the panel returns more=yes but no parameters (would otherwise loop forever)', async () => {
    // The bug we're guarding against: more=yes with parameters=[] makes the
    // cursor never advance and the function re-issues the same fetch forever.
    // We can't race against a real timer because the busy await-loop starves
    // the event loop entirely (setTimeout never fires). Instead we trip a
    // call-count tripwire — without the fix, paginateDataResponse keeps
    // calling fetch and eventually rejects with the tripwire's error rather
    // than the guard's error.
    let calls = 0;
    const TRIPWIRE = 5;
    const buggy = async (): Promise<{ parameters: string[]; more: boolean }> => {
      calls++;
      if (calls > TRIPWIRE) {
        throw new Error(`tripwire: paginateDataResponse called fetch ${calls} times — infinite loop`);
      }
      return { parameters: [], more: true };
    };

    await assert.rejects(
      paginateDataResponse(1, buggy),
      /pagination stuck/,
      `expected guard error; without the guard fetch is called repeatedly until the tripwire fires`,
    );
    assert.equal(calls, 1, `guard should fire on the first more=yes empty response; got ${calls} fetches`);
  });
});
