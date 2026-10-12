import { describe, it, expect } from 'vitest';
import { cookedForms } from './searchNeedles.mjs';

describe('cookedForms', () => {
  it('decodes an already-escaped backtick without a stray backslash', () => {
    const forms = cookedForms('run \\`ls\\` then \\u2014 done');
    expect(forms).toContain('run `ls` then — done');
    expect(forms.some(f => f.includes('\\`'))).toBe(false);
  });

  it('still escapes a bare backtick before decoding', () => {
    expect(cookedForms('a `b` \\u2014')).toContain('a `b` —');
  });
});
