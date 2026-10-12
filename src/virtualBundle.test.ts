import { describe, expect, it } from 'vitest';

import {
  BundleRegions,
  matchesInRegion,
  moduleCountDeclaration,
  moduleSentinel,
} from './virtualBundle';

const bundle = (js: string[], assets: string[]): string =>
  '#!/usr/bin/env node\n' +
  moduleCountDeclaration(js.length) +
  js
    .map((src, i) => moduleSentinel(i, `/$bunfs/root/m${i}.js`) + src)
    .join('') +
  assets
    .map(
      (text, i) =>
        moduleSentinel(js.length + i, `/$bunfs/root/a${i}.md`) + `\`${text}\``
    )
    .join('');

const at = (content: string, needle: string, from = 0): RegExpExecArray => {
  const index = content.indexOf(needle, from);
  const match = [needle] as unknown as RegExpExecArray;
  match.index = index;
  return match;
};

describe('BundleRegions', () => {
  it('is null for a cli.js that is not a virtual bundle with assets', () => {
    expect(BundleRegions.of('let a = "x";')).toBeNull();
    expect(BundleRegions.of(bundle(['let a = 1;'], []))).toBeNull();
  });

  it('keeps JS prompts in the JS and asset prompts inside one asset', () => {
    const content = bundle(
      ['let a = "Run /model to switch";'],
      ['# Doc\nRun /model to switch\n', 'second']
    );
    const regions = BundleRegions.of(content)!;
    const js = at(content, 'Run /model to switch');
    const doc = at(content, 'Run /model to switch', js.index + 1);
    expect(matchesInRegion([js, doc], regions, false)).toEqual([js]);
    expect(matchesInRegion([js, doc], regions, true)).toEqual([doc]);

    // A whole asset's text is inside its literal; one spanning two assets is
    // not a site of either.
    const whole = at(content, '# Doc\nRun /model to switch\n');
    expect(matchesInRegion([whole], regions, true)).toEqual([whole]);
    const spanning = at(content, 'switch\n`');
    spanning[0] = content.slice(spanning.index, content.indexOf('second'));
    expect(matchesInRegion([spanning], regions, true)).toEqual([]);
  });

  it('follows the boundaries through splices on either side', () => {
    const content = bundle(['let a = "short";'], ['doc text']);
    const regions = BundleRegions.of(content)!;
    const start = content.indexOf('short');
    // Grow the JS by 100 chars: the asset moves right with it.
    regions.recordSplice(start, start + 5, 105);
    const spliced =
      content.slice(0, start) + 'x'.repeat(105) + content.slice(start + 5);
    expect(regions.allows(...span(spliced, 'doc text'), true)).toBe(true);
    expect(regions.allows(...span(spliced, 'doc text'), false)).toBe(false);
    expect(regions.allows(...span(spliced, 'x'.repeat(105)), false)).toBe(true);
  });
});

const span = (content: string, needle: string): [number, number] => {
  const index = content.indexOf(needle);
  return [index, index + needle.length];
};
