import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadMatcherCore,
  matchInBundle,
  parseBundleSpec,
  presenceInBundle,
  scanEntry,
} from './checkBakedIdentifiers.mjs';

const TOOL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'checkBakedIdentifiers.mjs'
);

const bundle = (label, body, platform = label) => ({
  label,
  platform,
  content: `var a=1;${body};var z=2;`,
  version: '2.1.300',
  buildTime: undefined,
});

describe('checkBakedIdentifiers', () => {
  let core;
  beforeAll(async () => {
    core = await loadMatcherCore();
  }, 60000);

  const darwin = bundle(
    'darwin',
    'x=`Pick ${p??"the arguments"}: ${R.map((O)=>br[String(O)]).join(" or ")}`'
  );
  const linux = bundle(
    'linux',
    'x=`Pick ${t??"the arguments"}: ${n.map((M)=>Qx[String(M)]).join(" or ")}`'
  );

  it('reports a name that a slot expression keeps and another build renamed', () => {
    const r = scanEntry(
      core,
      {
        id: 'fixture-baked',
        pieces: [
          'Pick ${',
          '??"the arguments"}: ${',
          '.map((',
          ')=>',
          '[String(O)]).join(" or ")}',
        ],
      },
      [darwin, linux]
    );
    expect(r.found).toEqual({ darwin: 1, linux: 1 });
    expect(r.differing).toEqual([
      { piece: 4, name: 'O', seen: { linux: ['M'] } },
    ]);
  });

  it('passes the same entry once the name is a slot', () => {
    const r = scanEntry(
      core,
      {
        id: 'fixture-promoted',
        pieces: [
          'Pick ${',
          '??"the arguments"}: ${',
          '.map((',
          ')=>',
          '[',
          '(',
          ')]).join(" or ")}',
        ],
      },
      [darwin, linux]
    );
    expect(r.names).toEqual([]);
    expect(r.differing).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('does not count a name both builds share', () => {
    const r = scanEntry(
      core,
      {
        id: 'fixture-stable',
        pieces: [
          'Pick ${',
          '??"the arguments"}: ${',
          '.map((',
          ')=>',
          '[String(',
          ')]).join(" or ")}',
        ],
      },
      [darwin, linux]
    );
    expect(r.names).toEqual(['String']);
    expect(r.differing).toEqual([]);
  });

  it('reads a name inside a complete nested slot in one piece at its own group', () => {
    const r = scanEntry(
      core,
      {
        id: 'fixture-nested',
        pieces: ['Pick ${', '[`${k}`]} then ${', '} done'],
      },
      [
        bundle('darwin', 'x=`Pick ${o[`${k}`]} then ${z} done`'),
        bundle('linux', 'x=`Pick ${o[`${q}`]} then ${w} done`'),
      ]
    );
    expect(r.found).toEqual({ darwin: 1, linux: 1 });
    expect(r.differing).toEqual([
      { piece: 1, name: 'k', seen: { linux: ['q'] } },
    ]);
  });

  it('preserves apply presence while failing closed on an uninspectable baked expression', () => {
    const entry = { pieces: ['Pick ${', '[`${k.foo()}`]} done'] };
    const builds = [
      bundle('darwin', 'x=`Pick ${p[`${k.foo()}`]} done`'),
      bundle('linux', 'x=`Pick ${q[`${m.bar()}`]} done`'),
    ];
    for (const b of builds) {
      const direct = new RegExp(
        core.buildSearchRegexFromPieces(entry.pieces, b.version, b.buildTime),
        's'
      ).test(b.content);
      expect(direct).toBe(true);
      expect(presenceInBundle(core, entry, b).count).toBe(Number(direct));
    }
    const r = matchInBundle(core, entry, builds[1]);
    expect(r.count).toBe(1);
    expect(r.error).toContain('baked-name inspection could not match');
    expect(scanEntry(core, entry, builds).missing).toEqual([]);
  });

  it('matches an entry with no baked name for presence', () => {
    const entry = {
      id: 'fixture-promoted-missing',
      pieces: [
        'Pick ${',
        '??"the arguments"}: ${',
        '.map((',
        ')=>',
        '[',
        '(',
        ')]).join(" or ")}',
      ],
    };
    const empty = bundle('linux', 'x=1');
    const r = scanEntry(core, entry, [darwin, empty]);
    expect(r.found).toEqual({ darwin: 1, linux: 0 });
    expect(r.missing).toEqual(['linux']);
    const tagged = scanEntry(core, { ...entry, platforms: ['darwin'] }, [
      darwin,
      empty,
    ]);
    expect(tagged.missing).toEqual([]);
    const gone = scanEntry(core, { ...entry, platforms: ['darwin'] }, [
      bundle('darwin', 'x=1'),
      linux,
    ]);
    expect(gone.missing).toEqual(['darwin']);
  });

  it('reads a bundle platform from its spec or its path', () => {
    expect(parseBundleSpec('linux=/tmp/a.js')).toEqual({
      platform: 'linux',
      file: '/tmp/a.js',
    });
    expect(parseBundleSpec('/tmp/xplat/linux-arm64/cli.js').platform).toBe(
      'linux'
    );
    expect(parseBundleSpec('/tmp/cli.js').platform).toBe(process.platform);
  });
});

describe('checkBakedIdentifiers CLI fails closed', () => {
  let dir;
  let json;
  let mac;
  let lin;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baked-cli-'));
    json = path.join(dir, 'prompts.json');
    fs.writeFileSync(
      json,
      JSON.stringify({
        version: '2.1.300',
        prompts: [
          {
            id: 'fixture-shared',
            pieces: ['Fixture shared text ${', '} here'],
          },
          {
            id: 'fixture-mac-only',
            pieces: ['Fixture mac text'],
            platforms: ['darwin'],
          },
        ],
      })
    );
    mac = path.join(dir, 'mac.js');
    lin = path.join(dir, 'lin.js');
    fs.writeFileSync(
      mac,
      'x=`Fixture shared text ${a} here`;y="Fixture mac text";'
    );
    fs.writeFileSync(lin, 'x=`Fixture shared text ${b} here`;');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...bundles) =>
    spawnSync('node', [TOOL, json, ...bundles], { encoding: 'utf8' });

  it('passes two builds that carry every entry they should', () => {
    const r = run(`darwin=${mac}`, `linux=${lin}`);
    expect(r.stdout).toMatch(/0 differ across builds; 0 missing/);
    expect(r.status).toBe(0);
  });

  it('fails an entry missing from a build that should carry it', () => {
    const r = run(`darwin=${lin}`, `linux=${mac}`);
    expect(r.stdout).toMatch(/MISSING fixture-mac-only/);
    expect(r.status).toBe(1);
  });

  it('rejects an empty or unreadable bundle and a single build', () => {
    expect(run(`darwin=${mac}`, `linux=${lin}`, '/dev/null').status).toBe(2);
    expect(run(`darwin=${mac}`, path.join(dir, 'nope.js')).status).toBe(2);
    expect(run(`darwin=${mac}`).status).toBe(2);
    expect(run(`darwin=${mac}`, `linux=${mac}`).status).toBe(2);
  });

  it('reports an inspection failure without reporting false platform absence', () => {
    const fixture = path.join(dir, 'inline-prompts.json');
    const macFixture = path.join(dir, 'inline-mac.js');
    const linFixture = path.join(dir, 'inline-linux.js');
    fs.writeFileSync(
      fixture,
      JSON.stringify({
        version: '2.1.300',
        prompts: [
          {
            id: 'inline',
            pieces: ['Pick ${', '[`${k.foo()}`]} done'],
          },
        ],
      })
    );
    fs.writeFileSync(macFixture, 'x=`Pick ${p[`${k.foo()}`]} done`;');
    fs.writeFileSync(linFixture, 'x=`Pick ${q[`${m.bar()}`]} done`;');
    const r = spawnSync(
      process.execPath,
      [TOOL, fixture, `darwin=${macFixture}`, `linux=${linFixture}`, '--json'],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(1);
    const result = JSON.parse(r.stdout);
    expect(result.missing).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('inspection could not match');
  });
});
