import { describe, expect, it, vi } from 'vitest';
import {
  applyPatchImplementations,
  getAllPatchDefinitions,
  PatchGroup,
} from './index';

const only = (fn: (s: string) => string | null) => {
  const defs = getAllPatchDefinitions();
  const id = defs[0].id;
  const impls = Object.fromEntries(
    defs.map(d => [d.id, { fn: (s: string) => s, condition: false }])
  );
  impls[id] = { fn, condition: true } as never;
  return applyPatchImplementations('abc', impls as never).results.find(
    r => r.id === id
  )!;
};

describe('applyPatchImplementations', () => {
  it('marks a patch that logs an error but returns a file as partial', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = only(s => {
      console.error('patch: demo: failed to patch the header');
      return s + 'x';
    });
    spy.mockRestore();
    expect(r.applied).toBe(true);
    expect(r.failed).toBe(false);
    expect(r.partial).toBe(true);
    expect(r.details).toBe('partially applied (failed to patch the header)');
  });

  it('leaves a clean patch unflagged and restores console.error', () => {
    const original = console.error;
    const r = only(s => s + 'x');
    expect(r.partial).toBeUndefined();
    expect(r.details).toBeUndefined();
    expect(console.error).toBe(original);
  });

  it('keeps a null return as failed, not partial', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = only(() => {
      console.error('patch: demo: failed to find x');
      return null;
    });
    spy.mockRestore();
    expect(r.failed).toBe(true);
    expect(r.partial).toBeUndefined();
  });

  it('applies saved guidance hygiene through filters while fff is disabled', () => {
    const definitions = getAllPatchDefinitions();
    const implementations = Object.fromEntries(
      definitions.map(definition => [
        definition.id,
        { fn: (source: string) => source, condition: false },
      ])
    );
    implementations['fff-instruction-hygiene'] = {
      fn: source => source + ' repaired',
      condition: true,
    };
    const result = applyPatchImplementations(
      'native',
      implementations as never,
      ['fff-bash-reads']
    );
    expect(result.content).toBe('native repaired');
    expect(
      result.results.find(row => row.id === 'fff-instruction-hygiene')
    ).toMatchObject({ applied: true, failed: false });
    expect(
      result.results.find(row => row.id === 'swap-ripgrep-for-fff')
    ).toMatchObject({ applied: false, skipped: true });
  });

  it('classifies hygiene as correctness and enabled navigation as model facing', () => {
    const definitions = getAllPatchDefinitions();
    expect(
      definitions.find(
        definition => definition.id === 'fff-instruction-hygiene'
      )
    ).toMatchObject({
      name: 'Remove stale fff tool guidance',
      group: PatchGroup.ALWAYS_APPLIED,
    });
    expect(
      definitions.find(definition => definition.id === 'swap-ripgrep-for-fff')
    ).toMatchObject({ modelFacing: true, group: PatchGroup.FEATURES });
  });
});
