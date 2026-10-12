// Text assets (src/nativeTextAssets.ts) arrive as one template literal per
// module. Each is captured whole, handed to classification when it has no
// verdict, and named from the reference catalogue, the pre-split catalogue,
// its frontmatter or its file name.
import { afterEach, describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ex = require('./promptExtractor.js');

const mod = (n, name, body) => `\n/*@@TWEAKCC_MODULE:${n}:${name}@@*/\n${body}`;

const extract = code => {
  const f = path.join(
    os.tmpdir(),
    `pe-asset-${process.pid}-${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(f, code);
  try {
    return ex(f);
  } finally {
    fs.unlinkSync(f);
  }
};

const DOC = '# Tool use\n\nShort.';
const bundle =
  '#!/usr/bin/env node\n' +
  mod(
    0,
    '/$bunfs/root/chunk-a.js',
    'var x=Le("/$bunfs/root/doc-ab12cd34.md");'
  ) +
  mod(1, '/$bunfs/root/doc-ab12cd34.md', `\`${DOC}\``) +
  mod(2, '/$bunfs/root/run.mjs-zz99yy88.txt', '`import x from \\`y\\`;`');

describe('text-asset capture', () => {
  afterEach(() => ex._setClassificationCacheForTests(null));

  it('captures every asset whole, below every prose floor, and asks for a verdict', () => {
    ex._setClassificationCacheForTests({ _: {} });
    const r = extract(bundle);
    const assets = r.prompts.filter(p => p.asset);
    expect(assets.map(p => [p.asset, p.pieces.join('')])).toEqual([
      ['/$bunfs/root/doc-ab12cd34.md', DOC],
      ['/$bunfs/root/run.mjs-zz99yy88.txt', 'import x from \\`y\\`;'],
    ]);
    expect(r.gateCandidates.map(c => c.body)).toEqual(
      expect.arrayContaining([DOC, 'import x from \\`y\\`;'])
    );
  });

  it('lets a non-model verdict drop an asset and a model verdict skip the queue', () => {
    ex._setClassificationCacheForTests({
      [ex.sha1Hex(DOC)]: { facing: 'model' },
      [ex.sha1Hex('import x from \\`y\\`;')]: { facing: 'internal' },
    });
    const r = extract(bundle);
    expect(r.prompts.filter(p => p.asset).map(p => p.asset)).toEqual([
      '/$bunfs/root/doc-ab12cd34.md',
    ]);
    expect(r.gateCandidates.map(c => c.body)).not.toContain(DOC);
  });
});

describe('assetStem', () => {
  it.each([
    ['/$bunfs/root/SKILL-9ddmsnpa.md', 'SKILL'],
    ['/$bunfs/root/state-library.js-wy8y4843.txt', 'state-library.js'],
    ['/$bunfs/root/template.html-f851b5da.txt.zst', 'template.html'],
    ['/$bunfs/root/build-report-lite-jwtbvm49.mjs', 'build-report-lite.mjs'],
    ['/$bunfs/root/drop_block_probe-492dab40.py.zst', 'drop_block_probe.py'],
    ['/$bunfs/root/managed-agents-core-616e30ff.md.zst', 'managed-agents-core'],
  ])('%s -> %s', (p, stem) => {
    expect(ex.assetStem(p)).toBe(stem);
  });
});

describe('applyAssetNames', () => {
  const asset = (text, file, id = '') => ({
    id,
    name: '',
    description: '',
    pieces: [text],
    identifiers: [],
    identifierMap: {},
    asset: `/$bunfs/root/${file}`,
  });

  it('takes the reference id for the same document, escapes aside', () => {
    const [p] = ex.applyAssetNames(
      [asset('Run \\`x\\` now.\n', 'a-11111111.md')],
      [
        {
          id: 'data-up',
          name: 'Data: up',
          description: 'd',
          pieces: ['Run `x`  now.'],
        },
      ]
    );
    expect([p.id, p.name, p.description]).toEqual(['data-up', 'Data: up', 'd']);
  });

  it('restores the pre-split id when the reference catalogue lacks it', () => {
    const [p] = ex.applyAssetNames(
      [asset('Old doc body', 'b-22222222.md')],
      [],
      [{ id: 'data-old', name: 'Data: old', pieces: ['Old doc body'] }]
    );
    expect(p.id).toBe('data-old');
  });

  it('prefers a reference id over one only inferred from frontmatter', () => {
    const text = '---\nname: verify\ndescription: d\n---\nbody';
    const [p] = ex.applyAssetNames(
      [asset(text, 'SKILL-33333333.md.zst', 'skill-verify')],
      [{ id: 'skill-verify-v2', pieces: [text] }]
    );
    expect(p.id).toBe('skill-verify-v2');
  });

  it('keeps an established id', () => {
    const [p] = ex.applyAssetNames(
      [asset('Body', 'c-44444444.md', 'data-kept')],
      [{ id: 'data-other', pieces: ['Body'] }]
    );
    expect(p.id).toBe('data-kept');
  });

  it('names the rest from the file stem, adding the heading on a shared stem', () => {
    const out = ex.applyAssetNames([
      asset('# Tool Use - Python\n', 'tool-use-55555555.md.zst'),
      asset('# Tool Use - Go\n', 'tool-use-66666666.md.zst'),
      asset('# Models\n', 'models-77777777.md.zst'),
    ]);
    expect(out.map(p => p.id)).toEqual([
      'data-tool-use-tool-use-python',
      'data-tool-use-tool-use-go',
      'data-models',
    ]);
    expect(out[2].name).toBe('Data: models');
  });
});

describe('applyAssetNames on an edited pre-split doc', () => {
  const asset = (text, file) => ({
    id: '',
    name: '',
    description: '',
    pieces: [text],
    identifiers: [],
    identifierMap: {},
    asset: `/$bunfs/root/${file}`,
  });
  const para = n =>
    Array.from(
      { length: 12 },
      (_, i) =>
        `Paragraph ${n}.${i} explains one distinct rule of the API in plain words.`
    ).join('\n');

  it('restores the old id when most of the old body survives', () => {
    const old = para('a');
    const edited = `# New title\n${old.replace('Paragraph a.5', 'Changed a.5')}`;
    const [p] = ex.applyAssetNames(
      [asset(edited, 'README-12345678.md.zst')],
      [],
      [{ id: 'data-old-readme', name: 'Data: old', pieces: [old] }]
    );
    expect(p.id).toBe('data-old-readme');
  });

  it('leaves a doc unnamed by history when two old ids tie', () => {
    const text = para('b');
    const [p] = ex.applyAssetNames(
      [asset(text, 'README-87654321.md.zst')],
      [],
      [
        { id: 'data-one', pieces: [`${text}\nA`] },
        { id: 'data-two', pieces: [`${text}\nB`] },
      ]
    );
    expect(p.id).toBe('data-readme');
  });
});
