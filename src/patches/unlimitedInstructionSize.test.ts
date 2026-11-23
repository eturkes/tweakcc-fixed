import { describe, expect, it, vi } from 'vitest';

import { writeUnlimitedInstructionSize } from './unlimitedInstructionSize';

// Trimmed from CC 2.1.328 (instruction-file size limits).
const EXCERPT =
  'var DZr=0.05,U5t=4194304,LZr=40000;' +
  'function Mut(e=dt()){let o=Jp(e,qm()),r=Number.isFinite(o)&&o>0?o:gyt;return Math.max(LZr,Math.round(r*DZr*Fy(e)))}' +
  'var NZr=120000;function FZr(e){return Math.max(NZr,Mut(e))}';

describe('writeUnlimitedInstructionSize', () => {
  it('makes the per-file limit (and so the total limit) Infinity', () => {
    const result = writeUnlimitedInstructionSize(EXCERPT);

    expect(result).toBe(
      EXCERPT.replace(
        'function Mut(e=dt()){',
        'function Mut(e=dt()){return 1/0;'
      )
    );
    const run = new Function(
      'dt',
      'Jp',
      'qm',
      'Fy',
      'gyt',
      `${result};return [Mut(),FZr()];`
    );
    expect(
      run(
        () => 'm',
        () => 1e6,
        () => 0,
        () => 3,
        2e5
      )
    ).toEqual([Infinity, Infinity]);
  });

  it('returns null when the anchor is absent', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      writeUnlimitedInstructionSize('function Mut(e){return 4e4}')
    ).toBeNull();
    spy.mockRestore();
  });
});
