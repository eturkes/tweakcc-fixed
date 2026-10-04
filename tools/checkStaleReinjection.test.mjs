import { describe, expect, it } from 'vitest';
import { isAdjacencyRun } from './lib/adjacency.mjs';

const cur =
  'it tells you what is available to this user and how to use it prefer a state capability over browser storage omitting the field on a redeploy keeps what the page already has';

describe('isAdjacencyRun', () => {
  it('detects a cut whose two halves are both live', () => {
    expect(
      isAdjacencyRun(
        'available to this user and how to use it omitting the field on a redeploy keeps what',
        cur
      )
    ).toBe(true);
  });

  it('still flags a genuine re-injection whose left half is not live', () => {
    expect(
      isAdjacencyRun(
        'always ask before deleting anything from the shared drive omitting the field on a redeploy keeps what',
        cur
      )
    ).toBe(false);
  });

  it('does not treat halves shorter than 3 tokens as adjacency', () => {
    expect(isAdjacencyRun('how to use it zzz qqq', cur)).toBe(false);
    expect(isAdjacencyRun('zzz qqq available to this user', cur)).toBe(false);
    expect(isAdjacencyRun('how to xxx yyy zzz', cur)).toBe(false);
  });
});
