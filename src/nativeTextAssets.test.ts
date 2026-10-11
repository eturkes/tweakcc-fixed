import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

import {
  BUN_LOADER_FILE,
  BUN_LOADER_TEXT,
  decodeTextAsset,
  encodeTextAsset,
  templateLiteralToText,
  textToTemplateLiteral,
  zstdAvailable,
} from './nativeTextAssets';

const zstd = zlib as unknown as {
  zstdCompressSync(b: Buffer): Buffer;
};

// What a JS engine makes of the literal: the ground truth both directions
// must agree with.
const evaluate = (literal: string): string =>
  new Function(`return ${literal};`)() as string;

const TRICKY = [
  '',
  'plain ascii',
  'a `code` span and a ```fence```',
  'shell ${HOME} and $HOME and $ {x} and ${',
  'back\\slash \\n literal \\` and \\${x}',
  'crlf\r\nline\rcr only\n',
  'tab\there, nul\0, bell\x07, del\x7f',
  'latin1 · é ×, em — dash, emoji 😀, cjk 漢字',
  'lone surrogates \ud800 x \udc00',
  'separators   and  ',
  'ends with a backslash \\',
  'ends with a dollar $',
];

describe('textToTemplateLiteral / templateLiteralToText', () => {
  it.each(TRICKY)('round-trips %j', text => {
    const literal = textToTemplateLiteral(text);
    expect(evaluate(literal)).toBe(text);
    expect(templateLiteralToText(literal)).toBe(text);
  });

  it('emits pure ASCII with raw newlines and tabs', () => {
    const literal = textToTemplateLiteral(TRICKY.join('\n'));
    // eslint-disable-next-line no-control-regex
    expect(literal).toMatch(/^[\x00-\x7f]*$/);
    expect(textToTemplateLiteral('a\nb\tc')).toBe('`a\nb\tc`');
  });

  it('cooks the escape forms an override splice may write', () => {
    const literal = '`raw é \\xe9 \\u00e9 \\u{1F600} a\\\nb \\q`';
    expect(templateLiteralToText(literal)).toBe(evaluate(literal));
    expect(templateLiteralToText(literal)).toBe('raw é é é 😀 ab q');
  });

  it('normalizes a raw CR the way a template literal does', () => {
    expect(templateLiteralToText('`a\r\nb\rc`')).toBe('a\nb\nc');
  });

  it.each([
    ['not a literal', '"text"'],
    ['an unescaped backtick', '`a`b`'],
    ['a substitution', '`a ${x} b`'],
    ['an octal escape', '`\\1`'],
    ['a bad hex escape', '`\\xZZ`'],
    ['a dangling backslash', '`a\\`'],
  ])('rejects %s', (_label, literal) => {
    expect(() => templateLiteralToText(literal)).toThrow();
  });
});

describe('decodeTextAsset / encodeTextAsset', () => {
  it('decodes a one-byte text module and keeps ASCII edits one-byte', () => {
    const asset = decodeTextAsset(
      '/$bunfs/root/a.md',
      BUN_LOADER_TEXT,
      1,
      Buffer.from('# Title\n', 'latin1')
    );
    expect(asset).toEqual({ kind: 'latin1', text: '# Title\n' });
    expect(encodeTextAsset('latin1', '# New\n')).toEqual({
      contents: Buffer.from('# New\n', 'latin1'),
      encoding: 1,
    });
  });

  it('promotes a one-byte module to UTF-16LE when an edit adds non-ASCII', () => {
    const out = encodeTextAsset('latin1', 'a · b');
    expect(out.encoding).toBe(2);
    expect(out.contents.toString('utf16le')).toBe('a · b');
  });

  it('decodes and re-encodes a UTF-16LE module byte-identically', () => {
    const bytes = Buffer.from('dash — and 😀 \ud800', 'utf16le');
    const asset = decodeTextAsset(
      '/$bunfs/root/b.md',
      BUN_LOADER_TEXT,
      2,
      bytes
    );
    expect(asset?.kind).toBe('utf16le');
    expect(encodeTextAsset('utf16le', asset!.text)).toEqual({
      contents: bytes,
      encoding: 2,
    });
  });

  it('rejects an odd-length UTF-16 module and unknown encodings', () => {
    expect(
      decodeTextAsset('/x.md', BUN_LOADER_TEXT, 2, Buffer.from([0x41]))
    ).toBeNull();
    expect(
      decodeTextAsset('/x.md', BUN_LOADER_TEXT, 0, Buffer.from('a'))
    ).toBeNull();
  });

  it('leaves non-text modules alone', () => {
    expect(
      decodeTextAsset('/x.node', 10, 0, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
    ).toBeNull();
    expect(
      decodeTextAsset('/x.woff2.asset', BUN_LOADER_FILE, 0, Buffer.from('a'))
    ).toBeNull();
    expect(
      decodeTextAsset('/x.md', BUN_LOADER_TEXT, 1, Buffer.alloc(0))
    ).toBeNull();
  });

  it.runIf(zstdAvailable())(
    'decompresses a .zst file module and recompresses edits',
    () => {
      const text = '---\nname: s\n---\nbody — é\n';
      const frame = zstd.zstdCompressSync(Buffer.from(text, 'utf8'));
      const asset = decodeTextAsset(
        '/$bunfs/root/SKILL-x.md.zst',
        BUN_LOADER_FILE,
        0,
        frame
      );
      expect(asset).toEqual({ kind: 'zstd', text });
      const out = encodeTextAsset('zstd', `${text}more\n`);
      expect(out.encoding).toBe(0);
      expect(
        decodeTextAsset('/a.md.zst', BUN_LOADER_FILE, 0, out.contents)?.text
      ).toBe(`${text}more\n`);
    }
  );

  it.runIf(zstdAvailable())(
    'skips a .zst module that is not UTF-8 text',
    () => {
      const frame = zstd.zstdCompressSync(Buffer.from([0xff, 0xfe, 0x00]));
      expect(
        decodeTextAsset('/a.bin.zst', BUN_LOADER_FILE, 0, frame)
      ).toBeNull();
      expect(decodeTextAsset('/a.md', BUN_LOADER_FILE, 0, frame)).toBeNull();
    }
  );
});
