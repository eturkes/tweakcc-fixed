// Contracts of the classify evidence directory: site location, family
// packing, the per-chunk checker every agent runs, and the harvest.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sitesFor, buildSiteIndex, combineRoutes, compactRoute, sha1 } from './lib/classifyRoutes.mjs';
import { packFamilies } from './buildClassifyEvidence.mjs';
import { needsVerify } from './lib/classifyVerdicts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = c => c.repeat(40);

describe('sitesFor', () => {
  const recs = [
    { start: 10, end: 60, kind: 'string', cacheBody: 'The plugin could not be installed from this marketplace.' },
    { start: 900, end: 950, kind: 'string', cacheBody: 'The plugin could not be installed from this marketplace.' },
    { start: 2000, end: 2040, kind: 'string', cacheBody: 'first line of a composite body' },
    { start: 2050, end: 2090, kind: 'string', cacheBody: 'second line of a composite body' },
    { start: 3000, end: 3060, kind: 'template', cacheBody: 'Claude Code <<VER>> ${} is ready' },
  ];
  const siteIndex = buildSiteIndex(recs);

  it('returns EVERY literal that carries the body, not the first match', () => {
    const r = sitesFor({ body: 'The plugin could not be installed from this marketplace.' }, { siteIndex });
    expect(r.method).toBe('ast-exact');
    expect(r.sites.map(s => s.start)).toEqual([10, 900]);
  });

  it('maps a newline-joined composite to its fragments', () => {
    const r = sitesFor({ body: 'first line of a composite body\nsecond line of a composite body' }, { siteIndex });
    expect(r.method).toBe('ast-composite');
    expect(r.sites.map(s => s.start)).toEqual([2000, 2050]);
    expect(r.sites.every(s => s.fragment)).toBe(true);
  });

  it('falls back to a text search that enumerates every occurrence', () => {
    const code = 'x'.repeat(100) + '"a long distinctive sentence that only text search can find"' + 'y'.repeat(50) + '"a long distinctive sentence that only text search can find, again"';
    const r = sitesFor({ body: 'a long distinctive sentence that only text search can find' }, { siteIndex: new Map(), code, sortedSites: [[100, 161, 's'], [211, 279, 's']] });
    expect(r.method).toBe('text-search');
    expect(r.sites.map(s => s.start)).toEqual([100, 211]);
  });

  it('reports a body it cannot place instead of inventing a site', () => {
    expect(sitesFor({ body: 'nowhere' }, { siteIndex, code: 'abc', sortedSites: [] }).sites).toEqual([]);
  });
});

describe('routes across sites', () => {
  const ui = { verdict: 'ui', resolved: true, sinks: [{ kind: 'jsx-children', facing: 'ui', at: 1 }], unresolved: [] };
  const model = { verdict: 'model', resolved: false, sinks: [{ kind: 'local-jsx-ondone', facing: 'model', at: 2, via: ['a', 'b', 'c', 'd'] }], unresolved: [{ reason: 'x', at: 3 }] };

  it('any site proving model makes the candidate model; resolved needs every site', () => {
    const c = combineRoutes([ui, model]);
    expect(c.verdict).toBe('model');
    expect(c.resolved).toBe(false);
    expect(combineRoutes([ui, ui]).verdict).toBe('ui');
    expect(combineRoutes([]).verdict).toBe(null);
  });

  it('keeps the proof chain for model sinks and only counts UI sinks', () => {
    const c = compactRoute(combineRoutes([ui, model]));
    expect(c.sinks).toEqual([{ kind: 'local-jsx-ondone', facing: 'model', at: 2, via: 'b > c > d' }]);
    expect(c.nonModel).toEqual({ 'jsx-children': 1 });
    expect(c.open).toEqual(['x @3']);
  });
});

describe('packFamilies', () => {
  const fam = (key, ws) => ({ key, items: ws.map((w, i) => ({ hash: `${key}${i}`, weight: w })) });

  it('cuts families in order into the asked number of chunks, each family whole', () => {
    const chunks = packFamilies([fam('a', [4000, 4000]), fam('b', [5000]), fam('c', [3000]), fam('d', [2000, 2000])], { agents: 2 });
    expect(chunks.map(c => c.items.map(x => x.hash))).toEqual([['a0', 'a1'], ['b0', 'c0', 'd0', 'd1']]);
    expect(chunks.flatMap(c => c.families.map(f => f.split))).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('splits a family heavier than an even share across consecutive chunks and labels the parts', () => {
    const chunks = packFamilies([fam('a', [1000]), fam('big', [9000, 9000, 9000]), fam('z', [1000])], { agents: 3 });
    expect(chunks.map(c => c.items.map(x => x.hash))).toEqual([['a0', 'big0'], ['big1'], ['big2', 'z0']]);
    expect(chunks[1].families).toEqual([{ key: 'big', head: undefined, hashes: ['big1'], split: { part: 2, of: 3 } }]);
  });

  it('merges a split family back when its parts land in one chunk', () => {
    const chunks = packFamilies([fam('big', [10, 10, 10, 10])], { agents: 1 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].families).toEqual([{ key: 'big', head: undefined, hashes: ['big0', 'big1', 'big2', 'big3'] }]);
  });
});

describe('needsVerify', () => {
  it('scopes model verdicts, continuity and piebald ids, hedges and drafts against the traced model route', () => {
    const settled = { verdict: 'ui', resolved: true };
    const open = { verdict: null, resolved: false };
    const v = (facing, evidence) => ({ facing, evidence });
    expect(needsVerify(v('model', 'console.error'), { route: settled })).toBe(true);
    expect(needsVerify(v('ui', 'console.log, probably the CLI'), { route: settled })).toBe(true);
    expect(needsVerify(v('ui', 'console.log at 5'), { route: { verdict: 'model', resolved: true } })).toBe(true);
    expect(needsVerify(v('internal', 'debug log at 5'), { route: { verdict: 'model', resolved: false } })).toBe(true);
    expect(needsVerify(v('ui', 'console.log at 5'), { route: settled, reusedFrom: { id: 'x' } })).toBe(true);
    expect(needsVerify(v('ui', 'console.log at 5'), { route: settled, possibleSuccessorOf: { id: 'x' } })).toBe(true);
    expect(needsVerify(v('ui', 'console.log at 5'), { route: settled, piebaldExact: { id: 'x' } })).toBe(true);
    // Settled by the classifier: a non-model draft on a non-model or open route.
    expect(needsVerify(v('ui', 'Ink children at 99'), { route: settled })).toBe(false);
    expect(needsVerify(v('ui', 'followed both open branches to Ink children @12'), { route: open })).toBe(false);
  });
});

describe('checker and harvest over an evidence directory', () => {
  let dir;
  let bundlePath;
  let promptsJson;
  const A = H('a'), B = H('b'), C = H('c');
  const cand = (hash, extra = {}) => ({ hash, len: 10, body: 'b', sites: [], route: { verdict: 'ui', resolved: true }, allowedIds: [], ...extra });
  const write = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
  const run = (tool, ...a) => spawnSync(process.execPath, [path.join(HERE, tool), dir, ...a], { encoding: 'utf8' });
  let man;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-ev-'));
    bundlePath = path.join(dir, 'cli.js');
    promptsJson = path.join(dir, 'prompts.json');
    fs.writeFileSync(bundlePath, 'bundle bytes');
    fs.writeFileSync(promptsJson, JSON.stringify({ version: '9.9.9', prompts: [] }));
    const bundle = { path: bundlePath, sha256: crypto.createHash('sha256').update('bundle bytes').digest('hex') };
    const corpus = { promptsJson, digest: crypto.createHash('sha256').update(fs.readFileSync(promptsJson)).digest('hex').slice(0, 16) };
    man = { format: 1, version: '9.9.9', bundle, corpus, catalogueIndex: 'catalogue-index.json', chunkCount: 2, chunks: [{ chunk: '00', hashes: [A, B] }, { chunk: '01', hashes: [C] }] };
    write('manifest.json', man);
    write('catalogue-index.json', { 'tool-result-live-elsewhere': [H('f')], 'tool-result-own-body': [B] });
    write('chunk-00.json', { bundle, corpus, candidates: [cand(A), cand(B, { route: { verdict: 'model', resolved: true } })] });
    write('chunk-01.json', { bundle, corpus, candidates: [cand(C, { reusedFrom: { id: 'tool-result-live-elsewhere' }, allowedIds: ['tool-result-live-elsewhere'] })] });
  });
  const env = (nn, verdicts) => ({ chunk: nn, bundleSha: man.bundle.sha256, corpusDigest: man.corpus.digest, verdicts });
  const ui = h => ({ hash: h, facing: 'ui', id: null, name: null, desc: null, evidence: 'console.error at 12 in the CLI entry point' });
  const model = (h, id) => ({ hash: h, facing: 'model', id, name: 'Name', desc: 'What the model reads here.', evidence: 'route sink local-jsx-ondone @ 4242' });

  it('passes a complete, well-formed chunk and writes its verify scope', () => {
    write('verdicts-00.json', env('00', [ui(A), model(B, 'tool-result-own-body')]));
    const r = run('checkClassifyVerdicts.mjs', '00');
    expect(r.stdout).toContain('PASS chunk 00 (classify)');
    expect(r.status).toBe(0);
    const scope = JSON.parse(fs.readFileSync(path.join(dir, 'verify-scope-00.json'), 'utf8')).scope;
    expect(scope).toEqual([B]);
  });

  it('names every defect: missing hash, unnamed model verdict, string "null", foreign hash, reserved prefix, digest', () => {
    write('verdicts-00.json', { chunk: '00', bundleSha: 'nope', corpusDigest: man.corpus.digest, verdicts: [
      { hash: A, facing: 'ui', id: 'null', name: null, desc: null, evidence: 'console.error at 12 in the CLI' },
      { hash: H('d'), facing: 'model', id: 'inline-x', name: '', desc: null, evidence: 'x' },
    ] });
    const r = run('checkClassifyVerdicts.mjs', '00');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/bundleSha/);
    expect(r.stdout).toMatch(/facing:ui must set id to JSON null/);
    expect(r.stdout).toMatch(/not a candidate of this chunk/);
    expect(r.stdout).toMatch(/missing 1 of 2/);
  });

  it('refuses a live catalogue id on another body unless the candidate is licensed', () => {
    write('verdicts-00.json', env('00', [ui(A), model(B, 'tool-result-live-elsewhere')]));
    expect(run('checkClassifyVerdicts.mjs', '00').stdout).toMatch(/reuses catalogue id tool-result-live-elsewhere/);
    write('verdicts-00.json', env('00', [ui(A), model(B, 'tool-result-own-body')]));
    write('verdicts-01.json', env('01', [model(C, 'tool-result-live-elsewhere')]));
    expect(run('checkClassifyVerdicts.mjs', '01').stdout).toContain('PASS');
  });

  it('catches one id minted for two bodies in different chunks', () => {
    write('verdicts-00.json', env('00', [ui(A), model(B, 'tool-result-shared-name')]));
    write('verdicts-01.json', env('01', [model(C, 'tool-result-shared-name')]));
    expect(run('checkClassifyVerdicts.mjs', '01').stdout).toMatch(/also used by chunk 00/);
  });

  it('notices a bundle that changed after the evidence was built', () => {
    write('verdicts-00.json', env('00', [ui(A), model(B, 'tool-result-own-body')]));
    fs.writeFileSync(bundlePath, 'other bytes');
    expect(run('checkClassifyVerdicts.mjs', '00').stdout).toMatch(/changed since the evidence was built/);
  });

  it('verify stage requires exactly the scope and applies the corrections', () => {
    write('verdicts-00.json', env('00', [ui(A), model(B, 'tool-result-own-body')]));
    run('checkClassifyVerdicts.mjs', '00');
    write('verify-00.json', env('00', [ui(A)]));
    const bad = run('checkClassifyVerdicts.mjs', '00', '--stage', 'verify');
    expect(bad.stdout).toMatch(/not in this chunk's verify scope/);
    write('verify-00.json', env('00', [{ ...ui(B), evidence: 'Ink children at 77; the route proof does not hold' }]));
    expect(run('checkClassifyVerdicts.mjs', '00', '--stage', 'verify').stdout).toContain('PASS chunk 00 (verify)');
  });

  it('harvest reports classify and verify completion separately and writes only when complete', () => {
    write('verdicts-00.json', env('00', [ui(A), model(B, 'tool-result-own-body')]));
    const h1 = run('harvestClassify.mjs');
    expect(h1.status).toBe(1);
    expect(h1.stdout).toMatch(/classified: 1\/2 {3}verified: 0\/2/);
    expect(h1.stdout).toMatch(/rerun classify for chunks: 01/);
    expect(h1.stdout).toMatch(/rerun verify for chunks: 00/);
    expect(fs.existsSync(path.join(dir, 'verdicts-merged.json'))).toBe(false);

    write('verify-00.json', env('00', [{ ...model(B, 'tool-result-own-body'), name: 'Corrected name' }]));
    write('verdicts-01.json', env('01', [ui(C)]));
    // C carries reusedFrom, so it is in scope even as ui.
    write('verify-01.json', env('01', [{ ...ui(C), roleChange: 'the old id named a model message; this is a CLI line' }]));
    const h2 = run('harvestClassify.mjs');
    expect(h2.stdout, h2.stdout).toContain('COMPLETE');
    expect(h2.status, h2.stdout + h2.stderr).toBe(0);
    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'verdicts-merged.json'), 'utf8'));
    expect(merged.map(v => v.hash)).toEqual([A, B, C]);
    expect(merged.find(v => v.hash === B).name).toBe('Corrected name');
  });

  it('a chunk with an empty verify scope is verified without a verify file', () => {
    write('verdicts-00.json', env('00', [ui(A), model(B, 'tool-result-own-body')]));
    write('verify-00.json', env('00', [model(B, 'tool-result-own-body')]));
    write('chunk-01.json', { bundle: man.bundle, corpus: man.corpus, candidates: [cand(C)] });
    write('verdicts-01.json', env('01', [ui(C)]));
    expect(run('checkClassifyVerdicts.mjs', '01').stdout).toMatch(/verify scope 0/);
    const h = run('harvestClassify.mjs');
    expect(h.stdout).toMatch(/verified: 2\/2/);
    expect(h.status).toBe(0);
  });

  it('every hash in the packets is sha1-shaped (the extractor key)', () => {
    expect(sha1('x')).toMatch(/^[0-9a-f]{40}$/);
  });
});
