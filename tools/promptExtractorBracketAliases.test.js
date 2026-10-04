// The classification cache is keyed by sha1 of a string's cacheBody, which
// keeps member/index access inside `${…}` slots. A minifier rename of an index
// variable (`${[Ye]}` -> `${[Xe]}`, CC 2.1.284 -> 2.1.285) changed the key of a
// byte-identical prompt and dropped it from the catalogue. Bare-identifier
// bracket indexes are normalized to `[]` for lookup, and aliased on write.

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ex = require('./promptExtractor.js');
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const norm = ex.normalizeBracketIndexes;

const B284 =
  '${[Ye]} holds only values that could not be applied as written, so ${[Tt]} supplies the managed settings while that fail-closed reading still binds beside it (the most restrictive value of each such key applies), until it is fixed.';
const B285 = B284.replace('[Ye]', '[Xe]').replace('[Tt]', '[Mt]');
const M284 =
  '${.map(()=>`"${}"`).join(" and ")} in ${[Tt]} ignored: policy helper configuration ${[ue]}';
const M285 = M284.replace('[Tt]', '[Mt]').replace('[ue]', '[pe]');

afterEach(() => ex._setClassificationCacheForTests(null));

describe('normalizeBracketIndexes', () => {
  it('makes the real 2.1.284 and 2.1.285 bodies equal', () => {
    expect(norm(B284)).toBe(norm(B285));
    expect(norm(B284)).toContain('${[]} holds only');
    expect(norm(M284)).toBe(norm(M285));
  });

  it('handles $ and underscore/digit identifiers', () => {
    expect(norm('${[$e]}${[a_1]}')).toBe('${[]}${[]}');
  });

  it('leaves numeric, quoted, and operator indexes alone', () => {
    for (const s of [
      '${[0]}',
      '${["x"]}',
      "${['x']}",
      '${[P-1]}',
      '${[G.terminal]}',
      '${[a,b]}',
    ])
      expect(norm(s)).toBe(s);
  });

  it('never touches text outside a slot', () => {
    const s = 'see [Ye] and [Xe] here ${[Ye]} and [Ye]';
    expect(norm(s)).toBe('see [Ye] and [Xe] here ${[]} and [Ye]');
  });

  it('does not rewrite brackets inside string literals in a slot', () => {
    expect(norm('${a?"[Ye]":[Ye]}')).toBe('${a?"[Ye]":[]}');
  });

  it('normalizes slots nested in a template literal inside a slot', () => {
    expect(norm('${x.map(()=>`${[Ye]}`)}')).toBe('${x.map(()=>`${[]}`)}');
  });
});

describe('classifyByCache with bracket normalization', () => {
  const verdict = { facing: 'model', id: 'x-managed', name: 'X', desc: 'd' };

  it('finds a verdict stored under the normalized key', () => {
    ex._setClassificationCacheForTests({ [sha(norm(B284))]: verdict });
    expect(ex.classifyByCache(B285)).toEqual(verdict);
    expect(ex.classifyByCache(B284)).toEqual(verdict);
  });

  it('lets an exact raw hit win over the normalized key', () => {
    const raw = { facing: 'internal' };
    ex._setClassificationCacheForTests({
      [sha(B285)]: raw,
      [sha(norm(B285))]: verdict,
    });
    expect(ex.classifyByCache(B285)).toEqual(raw);
  });

  it('does not conflate bodies that differ outside the slots', () => {
    ex._setClassificationCacheForTests({ [sha(norm(B284))]: verdict });
    expect(ex.classifyByCache(B285 + ' extra')).toBeNull();
  });
});

describe('alias backfill', () => {
  const entry = {
    facing: 'model',
    id: 'x-managed',
    name: 'X',
    desc: 'd',
  };
  const other = { facing: 'internal' };
  const prompts = [{ pieces: [B284] }, { pieces: ['no slots here'] }];

  it('inserts the alias right after its source and adds nothing else', () => {
    const cache = {
      a: other,
      [sha(B284)]: entry,
      z: other,
    };
    const { cache: next, added } = ex.withBracketAliases(prompts, cache);
    expect(added).toBe(1);
    expect(Object.keys(next)).toEqual(['a', sha(B284), sha(norm(B284)), 'z']);
    expect(next[sha(norm(B284))]).toEqual(entry);
  });

  it('skips prompts with no raw hit and keys already present', () => {
    expect(ex.withBracketAliases(prompts, { a: other }).added).toBe(0);
    const have = { [sha(B284)]: entry, [sha(norm(B284))]: entry };
    expect(ex.withBracketAliases(prompts, have).added).toBe(0);
  });

  it('writes an insertions-only diff in the canonical format', () => {
    const cache = {
      ['0'.repeat(40)]: other,
      [sha(B284)]: entry,
      ['f'.repeat(40)]: other,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-'));
    const file = path.join(dir, 'c.json');
    const before = ex.serializeClassificationCache(cache);
    fs.writeFileSync(file, before);
    expect(ex.backfillCacheAliases(prompts, file)).toBe(1);
    const after = fs.readFileSync(file, 'utf8');
    const b = before.split('\n');
    const a = after.split('\n');
    let bi = 0;
    for (const line of a) if (bi < b.length && line === b[bi]) bi++;
    expect(bi).toBe(b.length);
    expect(a.length).toBeGreaterThan(b.length);
    expect(JSON.parse(after)[sha(norm(B284))]).toEqual(entry);
    expect(ex.backfillCacheAliases(prompts, file)).toBe(0);
    fs.rmSync(dir, { recursive: true });
  });
});
