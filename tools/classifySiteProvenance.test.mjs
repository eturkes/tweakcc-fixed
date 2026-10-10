import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouteProgram } from './lib/emissionRoute.mjs';
import {
  buildSiteIndex,
  routesForCandidates,
  sha1,
} from './lib/classifyRoutes.mjs';

const temporary = async fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-source-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('classification source provenance', () => {
  it('indexes every occurrence of requested one-character and single-token bodies', () => {
    const recs = [
      { start: 0, end: 3, kind: 'string', cacheBody: '#' },
      { start: 9, end: 12, kind: 'string', cacheBody: '#' },
      { start: 20, end: 31, kind: 'string', cacheBody: 'operation' },
      { start: 40, end: 47, kind: 'string', cacheBody: 'other' },
      {
        start: 50,
        end: 90,
        kind: 'string',
        cacheBody: 'Existing prose remains indexed',
      },
      { start: 100, end: 106, kind: 'template', cacheBody: '${}' },
    ];
    const index = buildSiteIndex(recs, {
      includeHashes: new Set([sha1('#'), sha1('operation'), sha1('${}')]),
    });
    expect(index.get(sha1('#'))).toEqual([
      [0, 3, 's'],
      [9, 12, 's'],
    ]);
    expect(index.get(sha1('operation'))).toEqual([[20, 31, 's']]);
    expect(index.get(sha1('${}'))).toEqual([[100, 106, 't']]);
    expect(index.has(sha1('other'))).toBe(false);
    expect(index.has(sha1('Existing prose remains indexed'))).toBe(true);
  });

  it('augments a warm cache for new tiny candidates and traces every canonical occurrence', async () =>
    temporary(async dir => {
      const cli = path.join(dir, 'cli-9.9.9.js');
      const code =
        'function first(){return"#"}function second(){return"#"}function later(){return"operation"}function prose(){return"Existing prose remains indexed"}';
      fs.writeFileSync(cli, code);
      const first = await routesForCandidates({
        cliPath: cli,
        cacheDir: dir,
        cands: [{ hash: sha1('#'), body: '#' }],
      });
      const sites = first.routesByHash.get(sha1('#')).sites;
      expect(sites.map(s => s.start)).toEqual([
        code.indexOf('"#"'),
        code.lastIndexOf('"#"'),
      ]);
      expect(sites.every(s => s.route)).toBe(true);
      const at = code.indexOf('"operation"');
      const logs = [];
      const next = await routesForCandidates({
        cliPath: cli,
        cacheDir: dir,
        log: s => logs.push(s),
        cands: [
          {
            hash: sha1('operation'),
            body: 'operation',
            sourceSites: [{ start: at, end: at + 11, kind: 'string' }],
          },
        ],
      });
      expect(logs.some(s => s.startsWith('route cache hit:'))).toBe(true);
      expect(logs.some(s => s.startsWith('route cache augmented:'))).toBe(true);
      expect(next.routesByHash.get(sha1('operation'))).toMatchObject({
        method: 'ast-exact',
        sites: [{ start: at, end: at + 11 }],
      });
      expect(
        next.routesByHash.get(sha1('operation')).sites[0].route
      ).toBeDefined();
      const stored = JSON.parse(fs.readFileSync(next.cachePath, 'utf8'));
      expect(new Map(stored.sites).get(sha1('#'))).toHaveLength(2);
      expect(new Map(stored.sites).has(sha1('operation'))).toBe(true);
      expect(
        new Map(stored.sites).get(sha1('Existing prose remains indexed'))
      ).toEqual(first.siteIndex.get(sha1('Existing prose remains indexed')));
    }));

  it('rejects stale source ranges instead of routing them as the candidate body', async () =>
    temporary(async dir => {
      const cli = path.join(dir, 'cli-9.9.9.js');
      const code = 'function first(){return"#"}function other(){return"wrong"}';
      fs.writeFileSync(cli, code);
      const at = code.indexOf('"wrong"');
      await expect(
        routesForCandidates({
          cliPath: cli,
          cacheDir: dir,
          cands: [
            {
              hash: sha1('#'),
              body: '#',
              sourceSites: [{ start: at, end: at + 7 }],
            },
          ],
        })
      ).rejects.toThrow(/does not match its canonical literal body/);
    }));
  it('traces interleaved candidates and shared variant sites once in source order', async () =>
    temporary(async dir => {
      const cli = path.join(dir, 'cli-9.9.9.js');
      const code =
        'function first(id){return{type:"tool_result",tool_use_id:id,content:"Early candidate text"}}function version(){return"Variant for 9.9.9"}console.log("Later candidate text");function also(id){return{type:"tool_result",tool_use_id:id,content:"Later candidate text"}}';
      fs.writeFileSync(cli, code);
      const early = code.indexOf('"Early candidate text"');
      const variants = code.indexOf('"Variant for 9.9.9"');
      const range = {
        start: early,
        end: early + '"Early candidate text"'.length,
      };
      const bodies = [
        'Later candidate text',
        'Variant for <<CCVERSION>>',
        'Early candidate text',
        'Variant for 9.9.9',
      ];
      const candidates = bodies.map(body => ({
        hash: sha1(body),
        body,
        ...(body === 'Early candidate text'
          ? { sourceSites: [range, range] }
          : {}),
      }));
      const seen = [];
      const original = RouteProgram.prototype.trace;
      const spy = vi
        .spyOn(RouteProgram.prototype, 'trace')
        .mockImplementation(function (offset, options) {
          seen.push(offset);
          return original.call(this, offset, options);
        });
      let result;
      try {
        result = await routesForCandidates({
          cliPath: cli,
          cands: candidates,
          version: '9.9.9',
          cacheDir: dir,
        });
      } finally {
        spy.mockRestore();
      }
      const expectedOffsets = [
        early,
        variants,
        code.indexOf('"Later candidate text"'),
        code.lastIndexOf('"Later candidate text"'),
      ];
      expect(seen).toEqual(expectedOffsets);
      const reference = new RouteProgram(code);
      for (const candidate of candidates) {
        const located = result.routesByHash.get(candidate.hash);
        expect(located.sites.length).toBeGreaterThan(0);
        for (const site of located.sites)
          expect(site.route).toEqual(reference.trace(site.start));
      }
      expect(
        result.routesByHash.get(sha1('Early candidate text')).route.verdict
      ).toBe('model');
      expect(
        result.routesByHash.get(sha1('Variant for <<CCVERSION>>')).sites
      ).toEqual(result.routesByHash.get(sha1('Variant for 9.9.9')).sites);
      expect(
        result.routesByHash.get(sha1('Later candidate text')).sites
      ).toHaveLength(2);
    }));
  it('rejects missing bodies before tracing any previously valid candidate', async () =>
    temporary(async dir => {
      const cli = path.join(dir, 'cli-9.9.9.js');
      const code = 'function first(){return"Existing candidate text"}';
      fs.writeFileSync(cli, code);
      const at = code.indexOf('"Existing candidate text"');
      const spy = vi.spyOn(RouteProgram.prototype, 'trace');
      try {
        await expect(
          routesForCandidates({
            cliPath: cli,
            cacheDir: dir,
            cands: [
              {
                hash: sha1('Existing candidate text'),
                body: 'Existing candidate text',
              },
              {
                hash: sha1('Missing body'),
                body: 'Missing body',
                sourceSites: [{ start: at, end: at + 25 }],
              },
            ],
          })
        ).rejects.toThrow(/does not match its canonical literal body/);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }));
});
