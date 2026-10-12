import zlib from 'node:zlib';

/**
 * Text assets in a code-split Bun bundle (CC 2.1.246+).
 *
 * Model-facing docs (bundled skills, their references, some reminders) do not
 * live in JS. They ship as their own modules and JS loads them by path:
 * `import.meta.require("/$bunfs/root/SKILL-x.md")` for a text-loader module,
 * or a readFileSync + `Bun.zstdDecompressSync` helper for a `.zst` file module.
 * Three storage forms occur:
 *
 *   - loader `text`, encoding 1: one byte per char (Bun's `latin1`). Bun only
 *     picks it for pure-ASCII files.
 *   - loader `text`, encoding 2: UTF-16LE. Bun picks it for any file with a
 *     non-ASCII char, even one inside Latin-1 (`·`).
 *   - loader `file`, name `*.zst`, encoding 0: a zstd frame of UTF-8 text.
 *
 * The virtual bundle carries each asset as one template literal so the
 * extractor and the prompt applier treat it like any other prompt string.
 */

export const BUN_LOADER_FILE = 5;
export const BUN_LOADER_TEXT = 13;
export const BUN_ENCODING_BINARY = 0;
export const BUN_ENCODING_LATIN1 = 1;
export const BUN_ENCODING_UTF16LE = 2;

export type TextAssetKind = 'latin1' | 'utf16le' | 'zstd';

export interface TextAsset {
  kind: TextAssetKind;
  text: string;
}

interface ZstdApi {
  zstdCompressSync(buf: Buffer): Buffer;
  zstdDecompressSync(buf: Buffer): Buffer;
}

// Node gained zstd in 22.15 / 23.8 and @types/node 20 does not declare it.
// Without it the compressed assets stay opaque (never extracted, never
// expected back at repack), so both directions agree on any Node.
const zstd = zlib as unknown as Partial<ZstdApi>;

export function zstdAvailable(): boolean {
  return (
    typeof zstd.zstdCompressSync === 'function' &&
    typeof zstd.zstdDecompressSync === 'function'
  );
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isZstdFrame(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
}

/**
 * Decode a module as a text asset, or return null when it is not one (JS,
 * native addons, fonts, binary payloads, or `.zst` without Node zstd).
 */
export function decodeTextAsset(
  moduleName: string,
  loader: number,
  encoding: number,
  contents: Buffer
): TextAsset | null {
  if (contents.length === 0) return null;
  if (loader === BUN_LOADER_TEXT) {
    if (encoding === BUN_ENCODING_LATIN1) {
      return { kind: 'latin1', text: contents.toString('latin1') };
    }
    if (encoding === BUN_ENCODING_UTF16LE && contents.length % 2 === 0) {
      return { kind: 'utf16le', text: contents.toString('utf16le') };
    }
    return null;
  }
  if (
    loader === BUN_LOADER_FILE &&
    moduleName.endsWith('.zst') &&
    isZstdFrame(contents) &&
    zstdAvailable()
  ) {
    let raw: Buffer;
    try {
      raw = zstd.zstdDecompressSync!(contents);
    } catch {
      return null;
    }
    let text: string;
    try {
      text = UTF8_STRICT.decode(raw);
    } catch {
      return null;
    }
    return { kind: 'zstd', text };
  }
  return null;
}

/**
 * Encode edited text back into module contents. A `latin1` asset that gained
 * a non-ASCII char is promoted to UTF-16LE, the form Bun itself uses for such
 * text, so `encoding` must be written back to the module record.
 */
export function encodeTextAsset(
  kind: TextAssetKind,
  text: string
): { contents: Buffer; encoding: number } {
  switch (kind) {
    case 'latin1':
      // eslint-disable-next-line no-control-regex
      return /^[\x00-\x7f]*$/.test(text)
        ? {
            contents: Buffer.from(text, 'latin1'),
            encoding: BUN_ENCODING_LATIN1,
          }
        : {
            contents: Buffer.from(text, 'utf16le'),
            encoding: BUN_ENCODING_UTF16LE,
          };
    case 'utf16le':
      return {
        contents: Buffer.from(text, 'utf16le'),
        encoding: BUN_ENCODING_UTF16LE,
      };
    case 'zstd':
      return {
        contents: zstd.zstdCompressSync!(Buffer.from(text, 'utf8')),
        encoding: BUN_ENCODING_BINARY,
      };
  }
}

const hex4 = (code: number): string =>
  `\\u${code.toString(16).padStart(4, '0')}`;

/**
 * Render text as a JS template literal with no substitutions. The output is
 * pure ASCII like every Bun JS module (non-ASCII becomes `\uXXXX`, the form
 * the prompt applier's Unicode detection expects), keeps `\n` and `\t` raw for
 * readable pieces, and escapes `\r` because template literals normalize a raw
 * CR to LF.
 */
export function textToTemplateLiteral(text: string): string {
  let out = '`';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '`') out += '\\`';
    else if (ch === '$' && text[i + 1] === '{') out += '\\$';
    else if (ch === '\n' || ch === '\t') out += ch;
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code >= 0x7f) out += hex4(code);
    else out += ch;
  }
  return out + '`';
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
};

/**
 * The cooked value of a template literal with no substitutions: the inverse
 * of textToTemplateLiteral, and also accepts whatever escape forms an override
 * splice wrote (raw non-ASCII, `\xHH`, `\u{…}`, line continuations).
 *
 * Throws when the source is not exactly one such literal. An asset has no
 * runtime scope, so a `${…}` left by an override can never resolve, and an
 * unescaped backtick means the literal was cut short.
 */
export function templateLiteralToText(source: string): string {
  if (source.length < 2 || source[0] !== '`' || !source.endsWith('`')) {
    throw new Error('text asset is not a single template literal');
  }
  const end = source.length - 1;
  let out = '';
  let i = 1;
  const hexAt = (from: number, len: number): number => {
    const h = source.slice(from, from + len);
    if (h.length !== len || !/^[0-9a-fA-F]+$/.test(h)) {
      throw new Error(`text asset: bad escape at ${from - 2}`);
    }
    return parseInt(h, 16);
  };
  while (i < end) {
    const ch = source[i];
    if (ch === '\\') {
      if (i + 1 >= end) throw new Error('text asset: dangling backslash');
      const c = source[i + 1];
      i += 2;
      if (c in SIMPLE_ESCAPES) out += SIMPLE_ESCAPES[c];
      else if (c === 'x') {
        out += String.fromCharCode(hexAt(i, 2));
        i += 2;
      } else if (c === 'u') {
        if (source[i] === '{') {
          const close = source.indexOf('}', i);
          if (close < 0 || close >= end) {
            throw new Error(`text asset: bad escape at ${i - 2}`);
          }
          out += String.fromCodePoint(hexAt(i + 1, close - i - 1));
          i = close + 1;
        } else {
          out += String.fromCharCode(hexAt(i, 4));
          i += 4;
        }
      } else if (c === '0' && !/[0-9]/.test(source[i] ?? '')) out += '\0';
      else if (/[0-9]/.test(c)) {
        throw new Error(`text asset: octal escape at ${i - 2}`);
      } else if (c === '\r') {
        if (source[i] === '\n') i++;
      } else if (c === '\n' || c === ' ' || c === ' ') {
        // line continuation: contributes nothing
      } else out += c;
      continue;
    }
    if (ch === '`') {
      throw new Error(`text asset: unescaped backtick at ${i}`);
    }
    if (ch === '$' && source[i + 1] === '{') {
      throw new Error(`text asset: \${…} substitution at ${i}`);
    }
    if (ch === '\r') {
      out += '\n';
      i += source[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Whether this Node can see a text asset the catalogue names. A `.zst` asset
 * without Node zstd never enters the virtual bundle, so its prompt has no site
 * to find; any other asset (or a JS prompt) is always visible.
 */
export function textAssetVisible(assetName: string | undefined): boolean {
  return !assetName?.endsWith('.zst') || zstdAvailable();
}
