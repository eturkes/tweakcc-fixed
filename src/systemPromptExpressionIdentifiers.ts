// Stands in for a minified identifier that both prompt matchers must accept
// under any name: `[\w$]+` in the RegExp engine, a word run in the piece matcher.
export const IDENTIFIER_SENTINEL = '\x00IDENT\x00';

const KEYWORDS = new Set([
  'arguments',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'in',
  'Infinity',
  'instanceof',
  'let',
  'NaN',
  'new',
  'null',
  'of',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

type Frame = '${' | '{' | '(' | '[' | '`';

const OPENERS: Record<string, Frame> = { '{': '{', '(': '(', '[': '[' };

const isIdentStart = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z_$]/.test(ch);

const isIdentPart = (ch: string | undefined): boolean =>
  ch !== undefined && /[\w$]/.test(ch);

const regexLiteralEnd = (piece: string, start: number): number => {
  let inClass = false;
  for (let i = start + 1; i < piece.length; i++) {
    const ch = piece[i];
    if (ch === '\\') i++;
    else if (ch === '\n') return start;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let end = i + 1;
      while (/[a-z]/.test(piece[end] ?? '')) end++;
      return end;
    }
  }
  return start;
};

/**
 * A piece at index > 0 begins inside the `${…}` its preceding capture sits in.
 * The extractor captures only the leading identifiers of that expression, so
 * any deeper minified name (`[f]`, `{ignoreHold:At}`, `...Oe.copyPath`) stays
 * as darwin text and pins the prompt to one platform build. This replaces every
 * identifier in VALUE position within that expression with
 * IDENTIFIER_SENTINEL, keeping property names after `.`, object-literal keys,
 * keywords and string contents literal. The bracket state carries across
 * pieces, so a key whose `{` opened in an earlier piece is still recognized.
 * Text after the interpolation closes is left untouched.
 */
export const generalizeExpressionIdentifiers = (pieces: string[]): string[] => {
  const stack: Frame[] = [];
  const result: string[] = [];
  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p];
    if (p > 0 && stack.length === 0) stack.push('${');
    let active = p > 0;
    let out = '';
    let previous = p > 0 ? 'ident' : '';
    let i = 0;
    while (i < piece.length) {
      const ch = piece[i];
      const top = stack[stack.length - 1];
      if (top === undefined || top === '`') {
        if (ch === '\\') {
          out += piece.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === '$' && piece[i + 1] === '{') {
          stack.push('${');
          previous = '{';
          out += '${';
          i += 2;
          continue;
        }
        if (ch === '`' && top === '`') {
          stack.pop();
          previous = 'value';
        }
        out += ch;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let end = i + 1;
        while (end < piece.length && piece[end] !== ch) {
          end += piece[end] === '\\' ? 2 : 1;
        }
        out += piece.slice(i, end + 1);
        i = end + 1;
        previous = 'value';
        continue;
      }
      if (ch === '/' && previous !== 'ident' && previous !== 'value') {
        const end = regexLiteralEnd(piece, i);
        if (end > i) {
          out += piece.slice(i, end);
          i = end;
          previous = 'value';
          continue;
        }
      }
      if (ch === '`') {
        stack.push('`');
        out += ch;
        i++;
        continue;
      }
      if (OPENERS[ch]) {
        stack.push(OPENERS[ch]);
        previous = ch;
        out += ch;
        i++;
        continue;
      }
      if (ch === '}' || ch === ')' || ch === ']') {
        stack.pop();
        if (stack.length === 0) active = false;
        previous = 'value';
        out += ch;
        i++;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(piece[i + 1]))) {
        let end = i + 1;
        while (end < piece.length && /[\w.]/.test(piece[end])) end++;
        out += piece.slice(i, end);
        i = end;
        previous = 'value';
        continue;
      }
      if (isIdentStart(ch)) {
        let end = i + 1;
        while (isIdentPart(piece[end])) end++;
        const name = piece.slice(i, end);
        const isProperty =
          piece[i - 1] === '#' ||
          (piece[i - 1] === '.' &&
            piece.slice(Math.max(0, i - 3), i) !== '...');
        const isKey =
          top === '{' &&
          (previous === '{' || previous === ',') &&
          piece[end] === ':';
        const generalize =
          active && !isProperty && !isKey && !KEYWORDS.has(name);
        out += generalize ? IDENTIFIER_SENTINEL : name;
        i = end;
        previous = KEYWORDS.has(name) ? 'keyword' : 'ident';
        continue;
      }
      if (!/\s/.test(ch)) previous = ch;
      out += ch;
      i++;
    }
    result.push(out);
  }
  return result;
};
