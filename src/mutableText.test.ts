import { describe, expect, it } from 'vitest';

import { MutableText } from './mutableText';

describe('MutableText', () => {
  it('matches sequential string splices, slices, and character reads', () => {
    const text = new MutableText('alpha beta gamma');
    text.splice(6, 10, 'B');
    text.splice(0, 5, 'A');
    text.splice(text.length, text.length, '!');
    expect(text.toString()).toBe('A B gamma!');
    expect(text.slice(2, 9)).toBe('B gamma');
    expect(text.charAt(0)).toBe('A');
    expect(text.charAt(text.length - 1)).toBe('!');
  });

  it('handles a splice crossing several existing chunks', () => {
    const text = new MutableText('0123456789');
    text.splice(2, 4, 'AB');
    text.splice(6, 8, 'CD');
    text.splice(1, 9, 'x');
    expect(text.toString()).toBe('0x9');
  });

  it('reads characters in any order across splices', () => {
    const text = new MutableText('abcdefghij');
    text.splice(2, 3, 'XY');
    text.splice(8, 9, 'Z');
    const expected = 'abXYdefgZij';
    for (const i of [10, 0, 5, 4, 9, 1, 7, 7, 3, -1, 11]) {
      expect(text.charAt(i)).toBe(expected[i] ?? '');
    }
  });

  it('joins once and stays correct after further splices', () => {
    const text = new MutableText('one two three');
    text.splice(4, 7, '2');
    const joined = text.toString();
    expect(text.toString()).toBe(joined);
    expect(joined).toBe('one 2 three');
    text.splice(0, 3, '1');
    expect(text.toString()).toBe('1 2 three');
    expect(text.charAt(4)).toBe('t');
  });
});
