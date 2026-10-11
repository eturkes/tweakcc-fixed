// A call group ruled both model and ui/internal must be raised until a review
// naming the differing routes covers each of its non-model arms; only arms no
// review covers are raised again.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSiblingArms } from './checkSiblingArms.mjs';
import { keyVariants } from './probeCacheKey.mjs';
import {
  fingerprintCollisions,
  formatAllowlist,
  pruneReviews,
  recordReviews,
  unreviewedMixed,
} from './checkMixedCallVerdicts.mjs';

const GATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'checkMixedCallVerdicts.mjs'
);
const key = body => keyVariants(body)[0].key;
const MODEL = 'Model facing call text';
const LOGGED = 'Logged only call text';
const SECOND = 'Second logged call text';
const program = (...lines) =>
  ['function p(m){return {error:m}}', ...lines].join('\n');
const CODE = program(
  `function a(x){if(x)return p("${MODEL}");return p("${LOGGED}")}`
);
const WHY = 'the model call returns a tool result; the other is only logged';

describe('checkMixedCallVerdicts', () => {
  let dir;
  let cli;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-'));
    cli = path.join(dir, 'cli-9.9.5.js');
    fs.writeFileSync(cli, CODE);
  });
  const scan = (cache, catalogue = [], code) => {
    if (code) fs.writeFileSync(cli, code);
    return scanSiblingArms(cli, { catalogue, cache });
  };
  const ruled = (second, extra = {}) => ({
    [key(MODEL)]: { facing: 'model', id: 'tool-result-fixture-model-call' },
    [key(LOGGED)]: { facing: second },
    ...extra,
  });

  it('raises a call group ruled both model and internal', () => {
    const r = scan(ruled('internal'));
    expect(r.mixed).toHaveLength(1);
    expect(r.mixed[0]).toMatchObject({
      position: 0,
      model: [{ key: key(MODEL), body: MODEL }],
      other: [{ key: key(LOGGED), facing: 'internal', body: LOGGED }],
    });
    expect(r.mixed[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not raise a group ruled one way', () => {
    expect(scan(ruled('model')).mixed).toEqual([]);
  });

  it('ignores a model verdict earned at another use of its text', () => {
    const code = program(
      'function q(m){console.log(m)}',
      `function a(x){let s="${MODEL}";q(s);if(x)return p(s);return p("${LOGGED}")}`,
      `function b(){return p("${SECOND}")}`
    );
    expect(scan(ruled('internal'), [], code).mixed).toEqual([]);
  });

  it('rules a catalogued arm by its cache verdict', () => {
    const catalogue = [{ id: 'logged-fixture', pieces: [LOGGED] }];
    const [m] = scan(ruled('internal'), catalogue).mixed;
    expect(m.other).toEqual([
      { key: key(LOGGED), facing: 'internal', body: LOGGED },
    ]);
    const uncached = { [key(MODEL)]: { facing: 'model' } };
    expect(
      scan(uncached, [{ id: 'x', pieces: [MODEL] }, ...catalogue]).mixed
    ).toEqual([]);
  });

  it('fingerprints by argument position, not by callee name or offset', () => {
    const pairs = program(
      `function a(x){if(x)return p("${MODEL}","${MODEL}");return p("${LOGGED}","${LOGGED}")}`
    );
    const mixed = scan(ruled('internal'), [], pairs).mixed;
    expect(mixed.map(m => m.position).sort()).toEqual([0, 1]);
    expect(new Set(mixed.map(m => m.fingerprint)).size).toBe(2);
    expect(fingerprintCollisions(mixed)).toEqual([]);
    const [before] = scan(ruled('internal'), [], CODE).mixed;
    const renamed = `var pad=1;\n${CODE.replace(/\bp\(/g, 'zz(')}`;
    const [after] = scan(ruled('internal'), [], renamed).mixed;
    expect(after.at).not.toBe(before.at);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(
      fingerprintCollisions([before, { ...after, at: 1 }, mixed[0]])
    ).toEqual([before.fingerprint]);
  });

  it('raises only the arms no review covers', () => {
    const code = program(
      `function a(x){if(x)return p("${MODEL}");if(x>1)return p("${SECOND}");return p("${LOGGED}")}`
    );
    const cache = ruled('internal', {
      [key(SECOND)]: { facing: 'internal' },
    });
    const short = recordReviews({}, [{ key: 'x', why: 'differs' }], []);
    expect(short.problems.join()).toMatch(/bad key/);
    const mixed = scan(cache).mixed;
    const [m] = mixed;
    const tooShort = recordReviews(
      {},
      [{ key: m.fingerprint, why: 'x' }],
      mixed
    );
    expect(tooShort.problems.join()).toMatch(/why must name/);
    const ok = recordReviews({}, [{ key: m.fingerprint, why: WHY }], mixed);
    expect(ok.problems).toEqual([]);
    expect(Object.keys(ok.allowlist[m.fingerprint].reviews[0].arms)).toEqual([
      key(LOGGED),
    ]);
    expect(unreviewedMixed(mixed, ok.allowlist)).toEqual([]);

    const grown = scan(cache, [], code).mixed;
    expect(grown[0].fingerprint).toBe(m.fingerprint);
    const open = unreviewedMixed(grown, ok.allowlist);
    expect(open).toHaveLength(1);
    expect(open[0].uncovered.map(a => a.body)).toEqual([SECOND]);

    const turned = scan(
      ruled('ui', { [key(SECOND)]: { facing: 'internal' } }),
      [],
      CODE
    ).mixed;
    expect(
      unreviewedMixed(turned, ok.allowlist)[0].uncovered.map(a => a.facing)
    ).toEqual(['ui']);
  });

  it('carries reviews to a group whose model arms changed', () => {
    const mixed = scan(ruled('internal')).mixed;
    const { allowlist } = recordReviews(
      {},
      [{ key: mixed[0].fingerprint, why: WHY }],
      mixed
    );
    const code = program(
      `function a(x){if(x)return p("${MODEL}");if(x>1)return p("${SECOND}");return p("${LOGGED}")}`
    );
    const moved = scan(
      ruled('internal', { [key(SECOND)]: { facing: 'model' } }),
      [],
      code
    ).mixed;
    expect(moved[0].fingerprint).not.toBe(mixed[0].fingerprint);
    expect(unreviewedMixed(moved, allowlist)).toEqual([]);
    const p = pruneReviews(allowlist, moved);
    expect(p.rekeyed).toEqual([
      { from: mixed[0].fingerprint, to: moved[0].fingerprint },
    ]);
    expect(Object.keys(p.allowlist)).toEqual([moved[0].fingerprint]);
    expect(unreviewedMixed(moved, p.allowlist)).toEqual([]);
  });

  it('prunes entries and arms the scan no longer has', () => {
    const code = program(
      `function a(x){if(x)return p("${MODEL}");if(x>1)return p("${SECOND}");return p("${LOGGED}")}`
    );
    const cache = ruled('internal', {
      [key(SECOND)]: { facing: 'internal' },
    });
    const mixed = scan(cache, [], code).mixed;
    const { allowlist } = recordReviews(
      {},
      [{ key: mixed[0].fingerprint, why: WHY }],
      mixed
    );
    const stale = {
      ...allowlist,
      ffffffffffffffff: {
        at: 1,
        model: { [key('gone')]: 'gone' },
        position: 0,
        reviews: [{ arms: {}, why: WHY }],
      },
    };
    const p = pruneReviews(stale, scan(cache, [], CODE).mixed);
    expect(p.removedEntries.map(e => e.key)).toEqual(['ffffffffffffffff']);
    expect(p.removedArms).toEqual([
      {
        entry: mixed[0].fingerprint,
        key: key(SECOND),
        facing: 'internal',
        preview: SECOND,
      },
    ]);
    expect(
      Object.keys(p.allowlist[mixed[0].fingerprint].reviews[0].arms)
    ).toEqual([key(LOGGED)]);
  });

  it('rejects a group listed twice in one batch', () => {
    const mixed = scan(ruled('internal')).mixed;
    const fp = mixed[0].fingerprint;
    const r = recordReviews(
      {},
      [
        { key: fp, why: WHY },
        { key: fp, why: `${WHY}, again` },
      ],
      mixed
    );
    expect(r.recorded).toBe(0);
    expect(r.problems).toEqual([`${fp}: listed twice in this batch`]);
    expect(
      recordReviews({}, [{ key: 'ffffffffffffffff', why: WHY }], mixed).problems
    ).toEqual(['ffffffffffffffff: not a current mixed group']);
  });

  const gate = (...args) =>
    spawnSync(process.execPath, [GATE, cli, catalogueFile(), ...args], {
      encoding: 'utf8',
    });
  const catalogueFile = () => {
    const f = path.join(dir, 'prompts.json');
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ prompts: [] }));
    return f;
  };
  const files = cache => {
    const c = path.join(dir, 'cache.json');
    fs.writeFileSync(c, JSON.stringify(cache));
    return ['--cache', c, '--allowlist', path.join(dir, 'allow.json')];
  };
  const reviews = rows => {
    const f = path.join(dir, `reviews-${Math.random()}.json`);
    fs.writeFileSync(f, JSON.stringify(rows));
    return f;
  };

  it('records onto a file that already holds reviews', () => {
    const code = program(
      `function a(x){if(x)return p("${MODEL}");return p("${LOGGED}")}`,
      `function q(m){return m}`,
      `function b(x){if(x)return q("${SECOND}");return q("Third logged call text")}`
    );
    fs.writeFileSync(cli, code);
    const cache = ruled('internal', {
      [key(SECOND)]: { facing: 'model' },
      [key('Third logged call text')]: { facing: 'ui' },
    });
    const opts = files(cache);
    const [m1, m2] = scan(cache).mixed;
    let r = gate(
      ...opts,
      '--record',
      reviews([{ key: m1.fingerprint, why: WHY }])
    );
    expect(r.status).toBe(0);
    r = gate(...opts, '--record', reviews([{ key: m2.fingerprint, why: WHY }]));
    expect(r.status).toBe(0);
    const text = fs.readFileSync(opts[3], 'utf8');
    const allow = JSON.parse(text);
    expect(Object.keys(allow).sort()).toEqual(
      [m1.fingerprint, m2.fingerprint].sort()
    );
    expect(formatAllowlist(allow)).toBe(text);
    r = gate(...opts);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/mixed call verdicts: 0 unreviewed of 2/);
  });

  it('refuses to record or prune when a segment did not parse', () => {
    const opts = files(ruled('internal'));
    fs.writeFileSync(
      cli,
      [
        '\n/*@@TWEAKCC_MODULE:0:good.js@@*/\n',
        CODE,
        '\n/*@@TWEAKCC_MODULE:1:broken.js@@*/\n',
        'function ((( {',
      ].join('')
    );
    const before = '{}\n';
    fs.writeFileSync(opts[3], before);
    const fp = '0123456789abcdef';
    for (const args of [
      ['--record', reviews([{ key: fp, why: WHY }])],
      ['--prune'],
    ]) {
      const r = gate(...opts, ...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/UNPARSED/);
      expect(fs.readFileSync(opts[3], 'utf8')).toBe(before);
    }
  });
});
