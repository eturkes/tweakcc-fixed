import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseExpressionAt } from 'acorn';
import { sha256 } from '../core.mjs';
import {
  extractNative,
  verifyFormatterOnlyPair,
} from '../native-extraction.mjs';
import { writeNativeSearchResults } from './native-search-interleaving.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--pristine', '--out', '--reference'].includes(name) || !value) {
    throw new Error(`Unknown or incomplete option: ${name}`);
  }
  options[name.slice(2)] = resolve(value);
}
if (!options.pristine || !options.out) {
  throw new Error('Use --pristine SOURCE --out NEW_FILE [--reference SOURCE]');
}
if (options.pristine === options.out || options.reference === options.out) {
  throw new Error('The candidate output must differ from the supplied inputs');
}

const parse = source =>
  parseExpressionAt(source, 0, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
const normalizedAst = source =>
  JSON.parse(
    JSON.stringify(parse(source), (key, value) =>
      ['start', 'end', 'raw'].includes(key) ? undefined : value
    )
  );

const before = extractNative(options.pristine);
const candidate = writeNativeSearchResults(before.source);
if (candidate === null || candidate === before.source) {
  throw new Error('The pristine source did not produce a new candidate');
}
const range = before.functions.Foo;
const handler = candidate.slice(range.start);
const handlerSource = handler.slice(0, parse(handler).end);
assert.equal(
  before.source.slice(0, range.start) +
    handlerSource +
    before.source.slice(range.end),
  candidate,
  'Generation must change only the actual native Foo handler'
);
let reference;
if (options.reference) {
  const evaluated = extractNative(options.reference);
  verifyFormatterOnlyPair(before, evaluated);
  assert.deepEqual(
    normalizedAst(handlerSource),
    normalizedAst(evaluated.functions.Foo.source),
    'Generated and evaluated native handlers must have the same normalized AST'
  );
  reference = {
    path: options.reference,
    sourceSha256: evaluated.sourceSha256,
    handlerSha256: evaluated.handlerSha256,
    handlerByteIdentical: handlerSource === evaluated.functions.Foo.source,
    normalizedHandlerAstEqual: true,
  };
}

mkdirSync(dirname(options.out), { recursive: true });
writeFileSync(options.out, candidate, { flag: 'wx' });
console.log(
  JSON.stringify(
    {
      status: 'rejected-evaluation-only',
      output: options.out,
      pristineSha256: before.sourceSha256,
      candidateSha256: sha256(candidate),
      handlerSha256: sha256(handlerSource),
      reference,
    },
    null,
    2
  )
);
