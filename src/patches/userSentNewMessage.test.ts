// Integration test (no sibling patch file): exercises the `user-sent-new-message`
// system-reminder override — a REMINDER_REGISTRY entry in systemReminderOverrides,
// not a standalone patch — so src/patches/userSentNewMessage.ts does not exist.
import { describe, it, expect } from 'vitest';
import { REMINDER_REGISTRY } from './systemReminderOverrides';

const injection = REMINDER_REGISTRY.find(
  r => r.id === 'user-sent-new-message'
)!;

// A substituted, EDITED override body (substitutePlaceholders turns `{{message}}`
// into the `${H}` interpolation the apply() then rebinds to the matched delta
// param). It must differ from every stock body the entry ever shipped: an
// unedited stub leaves pristine untouched and would never reach these anchors.
const defaultBody =
  'The user sent a new message while you were working:\n${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Edited.";

// 2.1.169 shape: `case"auto-continuation":` prepended, `default:` split into its
// own [MESSAGE FROM NON-USER SOURCE] case after the user-message return.
const cli2169 =
  'case"auto-continuation":case"human":case void 0:return`The user sent a new message while you were working:\n${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;" +
  'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n${H}`}';

// <=2.1.168 shape: no auto-continuation prefix, `default:` falls through to the
// user-message return.
const cli2168 =
  'case"human":case void 0:default:return`The user sent a new message while you were working:\n${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;";

// 2.1.177 shape: the intro line is hoisted into a standalone `$Tq` var, so the
// return reads `${$Tq}${H}` instead of inlining the English text.
const cli2177 =
  'case"auto-continuation":case"human":case void 0:return`${$Tq}${H}\n\n' +
  "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.`;" +
  'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n${H}`}';

describe('user-sent-new-message reminder injection', () => {
  it('preserves the 2.1.169 case-label prefix (and leaves the split default case intact)', () => {
    const out = injection.apply(cli2169, defaultBody, false)!;
    expect(out).not.toBeNull();
    // Prefix captured + reused verbatim — NOT hardcoded to the old shape.
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`'
    );
    expect(out).not.toContain('case void 0:default:return`The user sent');
    // The separate non-user-source default case must survive untouched.
    expect(out).toContain(
      'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]'
    );
  });

  it('still matches the <=2.1.168 case-label prefix (fallback shape)', () => {
    const out = injection.apply(cli2168, defaultBody, false)!;
    expect(out).not.toBeNull();
    expect(out).toContain('case"human":case void 0:default:return`');
    expect(out).not.toContain('auto-continuation');
  });

  it('suppression collapses to just the message param, prefix preserved', () => {
    const out = injection.apply(cli2169, defaultBody, true)!;
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`${H}`'
    );
    expect(out).not.toContain('The user sent a new message');
  });

  it('matches the 2.1.177 hoisted-intro (${$Tq}) shape', () => {
    const out = injection.apply(cli2177, defaultBody, false)!;
    expect(out).not.toBeNull();
    // The hoisted `${$Tq}${H}` intro is replaced by the override body, prefix kept.
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`The user sent a new message while you were working:'
    );
    expect(out).not.toContain('${$Tq}');
    expect(out).toContain(
      'default:{let q=_;return`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]'
    );
  });

  it('suppresses the 2.1.177 hoisted-intro shape to the bare message', () => {
    const out = injection.apply(cli2177, defaultBody, true)!;
    expect(out).toContain(
      'case"auto-continuation":case"human":case void 0:return`${H}`'
    );
    expect(out).not.toContain('${$Tq}');
    expect(out).not.toContain('The user sent a new message');
  });
});

// 2.1.311 shape: the trailing framing is a hoisted var declared right before the
// wrapper, and an unwrapper beside it recovers the typed message from a wrapped
// one (the transcript merge calls it on human-origin meta rows).
const FRAMING_2311 =
  '\n\nThis is how Claude Code surfaces messages the user sends mid-turn \\u2014 within ' +
  'the running turn, often alongside the next tool result, rather than as a ' +
  'separate conversation turn. Address the message above as you continue this turn.';
const cli2311 =
  'var DPe=`The user sent a new message while you were working:\n`;' +
  'var u5n=`Messages arrived:\n`,xZ=`[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n`,' +
  'TOe=`' +
  FRAMING_2311 +
  '`;function w2n(e){return`${DPe}${e}${TOe}`}' +
  'function ozs(e){return e.length>=DPe.length+TOe.length&&e.startsWith(DPe)&&e.endsWith(TOe)?e.slice(DPe.length,e.length-TOe.length):void 0}' +
  'function tL(e){return e.startsWith(xZ)?e:`${xZ}${e}`}' +
  'globalThis.__t={w2n,ozs,tL};';

const load2311 = (src: string) => {
  new Function(src)();
  const t = (globalThis as Record<string, unknown>).__t as {
    w2n: (e: string) => string;
    ozs: (e: string) => string | undefined;
    tL: (e: string) => string;
  };
  delete (globalThis as Record<string, unknown>).__t;
  return t;
};

describe('user-sent-new-message 2.1.311 hoisted wrapper + unwrapper', () => {
  it('pristine fixture round-trips (sanity)', () => {
    const { w2n, ozs } = load2311(cli2311);
    expect(ozs(w2n('hi'))).toBe('hi');
  });

  it('wraps with a custom body and unwraps the message back', () => {
    const body = 'Mid-turn:\n${H}\n\nAddress it.';
    const out = injection.apply(cli2311, body, false)!;
    expect(out).not.toBeNull();
    // The framing var declaration and the neighbouring helper survive.
    expect(out).toContain('TOe=`' + FRAMING_2311 + '`;function w2n(e){');
    expect(out).toContain('function tL(e){return e.startsWith(xZ)');
    const { w2n, ozs } = load2311(out);
    expect(w2n('hello')).toBe('Mid-turn:\nhello\n\nAddress it.');
    expect(ozs(w2n('hello'))).toBe('hello');
    expect(ozs(w2n(''))).toBe('');
    expect(ozs('hello')).toBeUndefined();
    expect(ozs('Mid-turn:\nhello\n\nAddress it?')).toBeUndefined();
  });

  it('unwraps with {{message}} at the start, the end, and repeated', () => {
    for (const body of ['${H}\n\ntrailer', 'leader: ${H}', 'A ${H} B ${H} C']) {
      const out = injection.apply(cli2311, body, false)!;
      const { w2n, ozs } = load2311(out);
      for (const msg of ['x', 'two words', 'B ${H} C', '']) {
        expect(ozs(w2n(msg))).toBe(msg);
      }
      expect(ozs('unrelated text')).toBeUndefined();
    }
  });

  it('suppression wraps to the bare message and unwraps as identity', () => {
    const out = injection.apply(cli2311, 'ignored ${H}', true)!;
    expect(out).toContain('function w2n(e){return`${e}`}');
    expect(out).not.toContain('${DPe}${e}${TOe}');
    const { w2n, ozs } = load2311(out);
    expect(w2n('hey')).toBe('hey');
    expect(ozs('hey')).toBe('hey');
  });

  it('a body without {{message}} unwraps to undefined', () => {
    const out = injection.apply(cli2311, 'static text', false)!;
    const { w2n, ozs } = load2311(out);
    expect(w2n('hey')).toBe('static text');
    expect(ozs('static text')).toBeUndefined();
  });

  it('is idempotent on an already-patched 2.1.311 bundle', () => {
    const once = injection.apply(cli2311, 'M ${H} N', false)!;
    expect(injection.apply(once, 'M ${H} N', false)).toBe(once);
    const suppressed = injection.apply(cli2311, '', true)!;
    expect(injection.apply(suppressed, '', true)).toBe(suppressed);
    const noSlot = injection.apply(cli2311, 'static', false)!;
    expect(injection.apply(noSlot, 'static', false)).toBe(noSlot);
  });
});
