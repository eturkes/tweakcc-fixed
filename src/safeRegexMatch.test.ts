import { describe, expect, it } from 'vitest';

import {
  findAllMatchesWithStackFallback,
  findAllMatchesInWorker,
} from './safeRegexMatch';

// A pattern with thousands of escape-tolerant disjunctions, shaped exactly like
// what buildSearchRegexFromPieces emits for a very large prompt. On Windows the
// default stack overflows compiling this (the bug we fixed); on macOS/Linux it
// compiles inline. Either way the *result* must be correct — that's what these
// tests assert.
const buildHeavyPattern = (token: string, repeats: number): string =>
  Array.from({ length: repeats }, () => `(?:${token}|\\\\${token})`).join('');

describe('safeRegexMatch', () => {
  it('finds all matches inline with capture groups (fast path)', async () => {
    const content = 'aXb aYb aZb';
    const matches = await findAllMatchesWithStackFallback(
      'a(.)b',
      'sig',
      content
    );
    expect(matches.map(m => m[1])).toEqual(['X', 'Y', 'Z']);
    expect(matches.map(m => m.index)).toEqual([0, 4, 8]);
  });

  it('adds the global flag when missing so all matches are returned', async () => {
    const matches = await findAllMatchesWithStackFallback('x', 'si', 'xxx');
    expect(matches).toHaveLength(3);
  });

  it('rethrows non-stack-overflow errors (e.g. invalid regex syntax)', async () => {
    await expect(
      findAllMatchesWithStackFallback('(', 'si', 'anything')
    ).rejects.toThrow();
  });

  it('worker path returns byte-identical matches to a native exec', async () => {
    // Mirror the structure of a generated search regex: literal text wrapped in
    // escape-tolerant backtick/quote disjunctions.
    const source = '(?:`|\\\\`)Model(?:"|\\\\")Guide(?:`|\\\\`)';
    const content = 'see `Model"Guide` here';
    const re = new RegExp(source, 'sig');
    const expected: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      expected.push(m[0]);
      if (m[0].length === 0) re.lastIndex++;
    }

    const viaWorker = await findAllMatchesInWorker(source, 'sig', content);
    expect(viaWorker.map(x => x[0])).toEqual(expected);
    expect(viaWorker[0]?.index).toBe(content.indexOf('`Model"Guide`'));
  });

  it('handles a huge disjunction-heavy pattern and returns the correct match', async () => {
    // ~3000 disjunctions — large enough to overflow a small default stack and
    // route through the worker fallback, while remaining a valid pattern.
    const heavy = buildHeavyPattern('a', 3000);
    const content = 'a'.repeat(3000);
    const matches = await findAllMatchesWithStackFallback(
      heavy,
      'sig',
      content
    );
    expect(matches).toHaveLength(1);
    expect(matches[0][0]).toBe(content);
  });
});
