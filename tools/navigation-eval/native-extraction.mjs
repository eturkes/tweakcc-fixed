import { parseExpressionAt } from 'acorn';
import { readFileSync } from 'node:fs';
import { sha256 } from './core.mjs';

export const nativeVersion = '2.1.296';
export const grepModule = '/$bunfs/root/chunk-sfn1dbxq.js';
const parseOptions = { ecmaVersion: 'latest', sourceType: 'module' };

export function extractModule(source, name) {
  const markers = [
    ...source.matchAll(/\/\*@@TWEAKCC_MODULE:(\d+):([^@]*)@@\*\//g),
  ];
  const found = markers
    .map((marker, index) => ({ marker, index }))
    .filter(({ marker }) => marker[2] === name);
  if (found.length !== 1) throw new Error(`Expected one module: ${name}`);
  const { marker, index } = found[0];
  const start = marker.index + marker[0].length;
  const end = markers[index + 1]?.index ?? source.length;
  return {
    name,
    index: Number(marker[1]),
    start,
    end,
    source: source.slice(start, end),
  };
}

function uniqueExpression(source, pattern, offset) {
  const found = [...source.matchAll(pattern)];
  if (found.length !== 1)
    throw new Error(`Expected one extraction anchor: ${pattern}`);
  const start = found[0].index + offset(found[0]);
  return parseExpressionAt(source, start, parseOptions);
}

function extractFunction(module, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = uniqueExpression(
    module.source,
    new RegExp(`(?:async )?function ${escaped}\\(`, 'g'),
    () => 0
  );
  if (
    expression.type !== 'FunctionExpression' ||
    expression.id?.name !== name
  ) {
    throw new Error(`Unexpected function shape: ${name}`);
  }
  return {
    source: module.source.slice(expression.start, expression.end),
    start: module.start + expression.start,
    end: module.start + expression.end,
  };
}

function extractConstant(module, name) {
  const parsed = uniqueExpression(
    module.source,
    new RegExp(`[,;]${name}=`, 'g'),
    match => match[0].length
  );
  const expression =
    parsed.type === 'SequenceExpression' ? parsed.expressions[0] : parsed;
  if (!['Literal', 'ArrayExpression'].includes(expression.type)) {
    throw new Error(`Unexpected constant shape: ${name}`);
  }
  return module.source.slice(expression.start, expression.end);
}

function extractMapper(module) {
  const expression = uniqueExpression(
    module.source,
    /[,;]EI=Kt\(/g,
    match => match[0].length
  );
  if (expression.type !== 'ObjectExpression')
    throw new Error('EI is not an object');
  const properties = expression.properties.filter(
    property => property.key?.name === 'mapToolResultToToolResultBlockParam'
  );
  if (properties.length !== 1 || !properties[0].method) {
    throw new Error('Expected the native EI result mapper method');
  }
  return module.source.slice(properties[0].start, properties[0].end);
}

export function extractNative(sourcePath, expectedSha256) {
  const bytes = readFileSync(sourcePath);
  const sourceSha256 = sha256(bytes);
  if (expectedSha256 && expectedSha256 !== sourceSha256) {
    throw new Error(
      'Native source SHA-256 differs from the prepared condition'
    );
  }
  const source = bytes.toString('utf8');
  const module = extractModule(source, grepModule);
  if (
    module.index !== 415 ||
    !module.source.includes(`// Version: ${nativeVersion}\n`)
  ) {
    throw new Error(
      `This adapter supports only the inspected ${nativeVersion} module 415`
    );
  }
  const functions = {};
  for (const name of ['Foo', 'Hoo', 'Uoo', '$oo', '$Fe', 'BFe']) {
    functions[name] = extractFunction(module, name);
  }
  for (const [name, moduleName] of [
    ['yMt', '/$bunfs/root/chunk-wh2vcbh8.js'],
    ['I', '/$bunfs/root/chunk-ax7r0qj7.js'],
    ['Mmr', '/$bunfs/root/chunk-qxmpnv25.js'],
  ]) {
    functions[name] = extractFunction(extractModule(source, moduleName), name);
  }
  const constants = {
    voo: extractConstant(module, 'voo'),
    xoo: extractConstant(module, 'xoo'),
  };
  const mapper = extractMapper(module);
  const components = {
    ...Object.fromEntries(
      Object.entries(functions).map(([name, value]) => [name, value.source])
    ),
    ...constants,
    mapper,
  };
  return {
    source,
    sourcePath,
    sourceSha256,
    moduleSha256: sha256(module.source),
    handlerSha256: sha256(functions.Foo.source),
    componentSha256: Object.fromEntries(
      Object.entries(components).map(([name, value]) => [name, sha256(value)])
    ),
    functions,
    constants,
    mapper,
  };
}

export function verifyFormatterOnlyPair(before, after) {
  if (before.handlerSha256 === after.handlerSha256)
    throw new Error('The native handlers are identical');
  const range = before.functions.Foo;
  const replaced =
    before.source.slice(0, range.start) +
    after.functions.Foo.source +
    before.source.slice(range.end);
  if (replaced !== after.source)
    throw new Error('Candidate differs outside the actual Foo handler');
  for (const [name, hash] of Object.entries(before.componentSha256)) {
    if (name !== 'Foo' && after.componentSha256[name] !== hash) {
      throw new Error(`Candidate unexpectedly changes ${name}`);
    }
  }
}
