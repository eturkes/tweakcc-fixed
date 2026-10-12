import { describe, expect, it } from 'vitest';

import { findAllMatchesWithStackFallback } from '../safeRegexMatch';
import { findAllPromptPieceMatches } from '../systemPromptPieceMatcher';
import {
  applyIdentifierMapping,
  buildSearchRegexFromPieces,
  reconstructContentFromPieces,
} from '../systemPromptSync';

/* eslint-disable @typescript-eslint/no-require-imports */
const parser = require('@babel/parser');
const { templateShape } = require('../../tools/lib/bundleSites.cjs');
/* eslint-enable @typescript-eslint/no-require-imports */

// Extract a template the way the catalogue does, then check that the entry
// matches a build whose minifier picked other names, on both match engines, and
// that the override writes that build's own names back.
const version = '2.1.300';

const shapeOf = (src: string) => {
  const ast = parser.parse(src);
  return templateShape(ast.program.body[0].expression.right, src) as {
    pieces: string[];
    identifiers: number[];
  };
};

const matchBoth = async (pieces: string[], haystack: string) => {
  const regex = buildSearchRegexFromPieces(pieces, version);
  const viaRegex = await findAllMatchesWithStackFallback(regex, 'sg', haystack);
  const viaMatcher = await findAllPromptPieceMatches(
    { regex, pieces, version },
    haystack
  );
  expect(viaMatcher.map(m => [m.index, ...m])).toEqual(
    viaRegex.map(m => [m.index, ...m])
  );
  return viaMatcher;
};

describe('an indexed object literal matches across platform builds', () => {
  const body = (key: string, cond: string) =>
    '`Write a doc. ${{here:"Pass `path` or `local_path`.",none:"Pass `path` and `content`."}[' +
    key +
    ']} Then ${' +
    cond +
    '?"list memory.":""} Done.`';
  const darwin = `x=${body('e', 'Mt')};`;
  const linux = `x=${body('t', 'Qa')};`;

  it('captures the index as a slot', () => {
    const shape = shapeOf(darwin);
    expect(shape.identifiers).toEqual([0, 1]);
    expect(shape.pieces.some(p => p.includes('[e]'))).toBe(false);
  });

  it('matches the other build and writes its index back', async () => {
    const { pieces, identifiers } = shapeOf(darwin);
    expect(await matchBoth(pieces, darwin)).toHaveLength(1);
    const [match] = await matchBoth(pieces, linux);
    expect(match).toBeDefined();
    expect(Array.from(match).slice(1)).toEqual(['t', 'Qa']);

    const override =
      'Write a doc. ${{here:"Pass `path`.",none:"Pass `content`."}[DOC_MODE]} Then ${HAS_MEMORY?"list memory.":""} Done.';
    const written = applyIdentifierMapping(
      override,
      identifiers,
      { 0: 'DOC_MODE', 1: 'HAS_MEMORY' },
      Array.from(match).slice(1) as string[],
      version
    );
    expect(written).toBe(
      'Write a doc. ${{here:"Pass `path`.",none:"Pass `content`."}[t]} Then ${Qa?"list memory.":""} Done.'
    );
  });
});

// The pristine override, reconstructed from the catalogue entry, must write
// each build's own names back: a name left in a piece is written verbatim, and
// a destructuring key captured as a slot keeps its label (keys are never
// substituted).
describe('a pristine override round-trips on another build', () => {
  const roundTrip = async (darwin: string, linux: string) => {
    const { pieces, identifiers } = shapeOf(darwin);
    const identifierMap: Record<string, string> = {};
    for (const label of identifiers) identifierMap[label] = `SLOT_${label}`;
    const content = reconstructContentFromPieces(
      pieces,
      identifiers,
      identifierMap
    );
    const [match] = await matchBoth(pieces, linux);
    expect(match).toBeDefined();
    return {
      written: applyIdentifierMapping(
        content,
        identifiers,
        identifierMap,
        Array.from(match).slice(1) as string[],
        version
      ),
      matched: match[0],
    };
  };

  it('re-emits a name inside an arrow body', async () => {
    const body = (p: string, r: string, t: string, m: string) =>
      `x=\`\${${p}??"the arguments"} must be \${${r}.map((${m})=>${t}[String(${m})]??String(${m})).join(" or ")}\`;`;
    const { written, matched } = await roundTrip(
      body('p', 'R', 'br', 'O'),
      body('d', 'Q', 'Zt', 'M')
    );
    expect(written).toBe(matched);
  });

  it('keeps destructuring keys as source text', async () => {
    const body = (e: string, a: string, p: string) =>
      `x=\`Usage \${${e}.groups.map(({group:${a},calls:${p}})=>({group:${a},calls:${p}}))} end\`;`;
    const { written, matched } = await roundTrip(
      body('e', 'a', 'p'),
      body('t', 'n', 'r')
    );
    expect(written).toBe(matched);
  });
});
