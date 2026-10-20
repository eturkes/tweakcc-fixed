import { describe, expect, it, vi } from 'vitest';
import {
  diversifyNativeSearchLines,
  writeNativeSearchResults,
} from './native-search-interleaving.mjs';

const row = (path, number, text = 'hit', match = true) =>
  `${path}\0${number}${match ? ':' : '-'}${text}`;
const content = lines => lines.filter(line => line !== '--');

describe('native search result diversity', () => {
  it('exposes distinct files before repeating one file without changing matches', () => {
    const original = [
      ...Array.from({ length: 1500 }, (_, index) => row('noisy.ts', index + 1)),
      row('other.ts', 3),
      row('third.ts', 17),
    ];
    const ordered = diversifyNativeSearchLines(original, false);
    expect(ordered.slice(0, 4)).toEqual([
      original[0],
      original[1500],
      original[1501],
      original[1],
    ]);
    expect([...ordered].sort()).toEqual([...original].sort());
  });

  it('keeps short context excerpts together and marks every new excerpt', () => {
    const first = [
      row('one.ts', 1, 'before', false),
      row('one.ts', 2),
      row('one.ts', 3, 'after', false),
    ];
    const second = [row('two.ts', 5, 'before', false), row('two.ts', 6)];
    const later = [row('one.ts', 30)];
    const original = [...first, '--', ...later, '--', ...second];
    expect(diversifyNativeSearchLines(original, true)).toEqual([
      ...first,
      '--',
      ...second,
      '--',
      ...later,
    ]);
  });

  it('preserves long connected context blocks instead of hiding their matches', () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      row('noisy.ts', index + 1, 'é'.repeat(150), index % 2 === 0)
    );
    const original = [...first, '--', row('other.ts', 1)];
    const ordered = diversifyNativeSearchLines(original, true);
    expect(ordered).toEqual(original);
    expect(content(ordered)).toEqual(content(original));
  });

  it('preserves the original output for ambiguous, binary or duplicate line records', () => {
    for (const original of [
      [row('one.ts', 1), 'binary file matches'],
      [row('one.ts', 1), row('two.ts', 2, 'binary\0data')],
      [row('one.ts', 1), row('one.ts', 1), row('two.ts', 1)],
      [row('one.ts', 1), `two.ts\0${Number.MAX_SAFE_INTEGER + 1}:hit`],
      [row('one.ts', 1), row('one.ts', 2)],
    ])
      expect(diversifyNativeSearchLines(original, true)).toBe(original);
  });

  it('preserves unusual filenames and literal content without parsing visible colons', () => {
    const original = [
      row('a:1-foo.ts', 1, 'a:b-c'),
      row('a:1-foo.ts', 2),
      row('é space.ts', 1),
    ];
    expect(diversifyNativeSearchLines(original, false)).toEqual([
      original[0],
      original[2],
      original[1],
    ]);
  });
});

const fixture = `async function search(target,{pattern:q,glob:g,type:t,output_mode:mode="files_with_matches","-B":before,"-A":after,"-C":around,context:ctx,"-n":numbers=!0,"-i":ignoreCase=!1,"-o":only=!1,head_limit:limit,offset:offset=0,multiline:multi=!1},scope){let lines=await execute({beforeSpawn:()=>scope.recheck()});lines=lines.filter(line=>!line.startsWith("denied.ts\\0"));if(mode==="content"){let{items:items,appliedLimit:applied}=paginate(lines,limit,offset),result=items;return{data:{content:result,numLines:result.length,totalLines:lines.length,appliedLimit:applied}}}return{data:{content:lines}}}`;

describe('native search binary patch', () => {
  it('runs after filtering and before paging, retaining every permitted line across pages', async () => {
    const original = [
      row('one.ts', 1),
      row('one.ts', 2),
      row('denied.ts', 1),
      row('two.ts', 1),
    ];
    const recheck = vi.fn();
    const execute = async ({ beforeSpawn }) => {
      beforeSpawn();
      return original;
    };
    const paginate = (lines, limit = 250, offset = 0) => ({
      items:
        limit === 0 ? lines.slice(offset) : lines.slice(offset, offset + limit),
      appliedLimit: limit,
    });
    const patched = writeNativeSearchResults(fixture);
    expect(patched).not.toBeNull();
    const search = new Function(
      'execute',
      'paginate',
      `${patched};return search;`
    )(execute, paginate);
    const target = { isDirectory: true };
    const options = { pattern: 'hit', output_mode: 'content', head_limit: 2 };
    const first = await search(target, options, { recheck });
    const second = await search(target, { ...options, offset: 2 }, { recheck });
    expect(first.data.content).toEqual([original[0], original[3]]);
    expect(first.data.totalLines).toBe(3);
    expect([...first.data.content, ...second.data.content]).toEqual([
      original[0],
      original[3],
      original[1],
    ]);
    expect(recheck).toHaveBeenCalledTimes(2);
    expect(writeNativeSearchResults(patched)).toBe(patched);
    const permitted = original.filter(line => !line.startsWith('denied.ts\0'));
    for (const override of [{ multiline: true }, { '-o': true }]) {
      const result = await search(
        target,
        { ...options, ...override },
        { recheck }
      );
      expect(result.data.content).toEqual(permitted.slice(0, 2));
    }
    expect(
      (await search(target, { ...options, head_limit: 0 }, { recheck })).data
        .content
    ).toEqual([original[0], original[3], original[1]]);
    expect(
      (
        await search(
          target,
          { ...options, offset: 2, head_limit: 0 },
          { recheck }
        )
      ).data.content
    ).toEqual(second.data.content);
    expect(
      (await search(target, { ...options, output_mode: 'count' }, { recheck }))
        .data.content
    ).toEqual(permitted);
    expect(
      (await search({ isDirectory: false }, options, { recheck })).data.content
    ).toEqual(permitted.slice(0, 2));
  });

  it('handles minifier dollar identifiers and refuses missing or ambiguous boundaries', () => {
    const renamed = fixture
      .replaceAll('target', '$target')
      .replaceAll('mode', '$mode')
      .replaceAll('output_$mode', 'output_mode')
      .replaceAll('limit', '$limit')
      .replaceAll('head_$limit', 'head_limit');
    expect(writeNativeSearchResults(renamed)).not.toBeNull();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        writeNativeSearchResults(fixture.replace('beforeSpawn:', 'wrong:'))
      ).toBeNull();
      expect(writeNativeSearchResults(fixture + fixture)).toBeNull();
      expect(writeNativeSearchResults('unrelated')).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it('refuses a matching paginator in a neighboring or nested function', () => {
    const header = fixture.slice(0, fixture.indexOf('{let lines'));
    const nearby =
      'function unrelated(lines,mode,limit,offset){if(mode==="content"){let{items:items,appliedLimit:applied}=paginate(lines,limit,offset);return{data:{totalLines:lines.length}}}}';
    const guard = 'const job={beforeSpawn:()=>scope.recheck()};';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        writeNativeSearchResults(header + '{' + guard + 'return []}' + nearby)
      ).toBeNull();
      expect(
        writeNativeSearchResults(header + '{' + guard + nearby + 'return []}')
      ).toBeNull();
    } finally {
      error.mockRestore();
    }
  });
});
