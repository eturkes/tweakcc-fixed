import { describe, expect, it } from 'vitest';
import {
  buildFffUsageRuntime,
  observeFffFileUsage,
  buildFffAutocompleteRuntime,
  useFffAutocomplete,
} from './fffRuntime';

const OPERATION =
  'function iv(e){let n={operation:d(e.operation),tool:d(e.tool),filePathHash:Bto(e.filePath)};i("tengu_file_operation",n)}';

describe('fff file usage observer', () => {
  it('preserves successful operation telemetry and accepts dollar identifiers', () => {
    const source = OPERATION.replaceAll('iv', '$observer')
      .replaceAll('e.', '$input.')
      .replace('(e)', '($input)');
    const patched = observeFffFileUsage(source, '/tmp/rg-fff')!;
    expect(patched).toContain(
      '__tweakccFffRecord($input.operation,$input.filePath)'
    );
    expect(patched).toContain('i("tengu_file_operation",n)');
    expect(() => new Function(patched)).not.toThrow();
    expect(observeFffFileUsage(patched, '/tmp/rg-fff')).toBe(patched);
  });

  it('does not guess when the successful-operation shape is missing', () => {
    expect(
      observeFffFileUsage('function read(){return null}', '/tmp/rg-fff')
    ).toBeNull();
  });

  it('ignores unrelated operations before spawning anything', () => {
    const scope = {
      globalThis: {} as {
        __tweakccFffRecord?: (operation: string, path: string) => void;
      },
    };
    new Function('globalThis', buildFffUsageRuntime('/tmp/`"${x}/rg-fff'))(
      scope.globalThis
    );
    expect(() =>
      scope.globalThis.__tweakccFffRecord!('delete', '/tmp/file')
    ).not.toThrow();
  });
});

describe('fff autocomplete', () => {
  it('preserves native branches, constructor, base directory, and result contract', () => {
    const source =
      'async function suggestions(e,f,o){if(custom())return command();let h=e.fileIndex?e.fileIndex.search(f,limit).map((I)=>C(I.path,I.score)):[],x=e.indexBaseDir??o,F=Date.now();return{items:h,baseDir:x}}';
    const patched = useFffAutocomplete(source, '/tmp/rg-fff')!;
    expect(patched).toContain('if(custom())return command()');
    expect(patched).toContain('C(item.path,item.score)');
    expect(patched).toContain('return{items:h,baseDir:x}');
    expect(() => new Function(patched)).not.toThrow();
    expect(useFffAutocomplete(patched, '/tmp/rg-fff')).toBe(patched);
  });

  it('merges directories and external config entries with fuzzy files using ascending scores', () => {
    const global = {} as {
      __tweakccFffMerge: (
        native: unknown[],
        extra: unknown[],
        limit: number,
        query: string
      ) => Array<{ displayText: string }>;
    };
    new Function('globalThis', buildFffAutocompleteRuntime('/tmp/rg-fff'))(
      global
    );
    const native = [
      { displayText: 'src/', metadata: { score: 0.3 } },
      { displayText: '../config.md', metadata: { score: 0.2 } },
      { displayText: 'src/user.ts', metadata: { score: 0.5 } },
    ];
    const extra = [
      { displayText: 'src/user.ts', metadata: { score: 0.1 } },
      { displayText: 'src/new.ts', metadata: { score: 0.4 } },
    ];
    expect(
      global
        .__tweakccFffMerge(native, extra, 4, 'user')
        .map(item => item.displayText)
    ).toEqual(['src/user.ts', '../config.md', 'src/', 'src/new.ts']);
    expect(global.__tweakccFffMerge(native, extra, 1, 'user')).toHaveLength(1);
  });
});
