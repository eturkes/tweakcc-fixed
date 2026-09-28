import { describe, it, expect, vi } from 'vitest';
import { writeHideTitleSpinner } from './hideTitleSpinner';

// Terminal-title component, verbatim from CC 2.1.282 (minified names kept).
const FIXTURE =
  'var y5=["\\u25D0","\\u25D1"],S5="\\u2733",ZJe=960;function b5(h){let Le=w(1),{titles:M,isAnimating:E,noPrefix:V}=h,ee=xe(M,b7t),Se=xe(M,k7t),ve=El(),Ce=kCt()!==null&&x("tengu_static_title_under_mux",!0),[Pe,Me]=g(0),je;if(Le[0]===b)je=()=>Me(v7t),Le[0]=je;else je=Le[0];Bs(je,Se||V||Ce||!E||!ve?null:ZJe);let $e=E&&!Ce?y5[Pe]??S5:S5;return Bce(Se?null:V?ee:`${$e} ${ee}`),null}';

interface State {
  busy: boolean;
  disabled?: boolean;
  noPrefix?: boolean;
  mux?: boolean;
  frame?: number;
}

// Renders b5 once with stubbed hooks → the string handed to useTerminalTitle.
const render = (src: string, s: State): string | null => {
  let title: string | null = null;
  const sentinel = {};
  const b5 = new Function(
    'w,b,xe,b7t,k7t,El,kCt,x,g,v7t,Bs,Bce',
    `${src};return b5;`
  )(
    () => [sentinel],
    sentinel,
    (m: object, f: (m: object) => unknown) => f(m),
    (m: { terminalTitle: string }) => m.terminalTitle,
    (m: { disabled: boolean }) => m.disabled,
    () => true,
    () => (s.mux ? 'tmux' : null),
    () => true,
    () => [s.frame ?? 0, () => {}],
    (n: number) => n + 1,
    () => {},
    (t: string | null) => (title = t)
  );
  b5({
    titles: { terminalTitle: 'agents', disabled: !!s.disabled },
    isAnimating: s.busy,
    noPrefix: !!s.noPrefix,
  });
  return title;
};

describe('writeHideTitleSpinner', () => {
  const patched = writeHideTitleSpinner(FIXTURE)!;

  it('busy → bare title where stock shows a spinner frame', () => {
    expect(render(FIXTURE, { busy: true })).toBe('◐ agents');
    expect(render(FIXTURE, { busy: true, frame: 1 })).toBe('◑ agents');
    expect(render(patched, { busy: true })).toBe('agents');
    expect(render(patched, { busy: true, frame: 1 })).toBe('agents');
    expect(render(patched, { busy: true, mux: true })).toBe('agents');
  });

  it('idle/waiting, noPrefix + disabled match stock', () => {
    const same: State[] = [
      { busy: false },
      { busy: false, mux: true },
      { busy: true, noPrefix: true },
      { busy: false, noPrefix: true },
      { busy: true, disabled: true },
      { busy: false, disabled: true },
    ];
    for (const s of same) expect(render(patched, s)).toBe(render(FIXTURE, s));
    expect(render(patched, { busy: false })).toBe('✳ agents');
    expect(render(patched, { busy: true, disabled: true })).toBeNull();
  });

  it('returns null (logging) when the title statement is absent', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeHideTitleSpinner('x=1;function y(){}')).toBeNull();
    expect(writeHideTitleSpinner(patched)).toBeNull();
    errSpy.mockRestore();
  });
});
