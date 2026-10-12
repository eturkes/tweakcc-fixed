import { describe, expect, it } from 'vitest';
import { buildFffUsageRuntime, observeFffFileUsage } from './fffRuntime';

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
