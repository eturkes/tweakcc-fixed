// A call group ruled both model and ui/internal must be raised until a review
// naming the differing routes covers each of its non-model arms and each model
// arm that joined it after its first review; only arms no review covers are
// raised again.
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
const WRONG = 'Wrongly ruled model text for UI';
const THIRD = 'Third model facing call text';
const program = (...lines) =>
  ['function p(m){return {error:m}}', ...lines].join('\n');
const CODE = program(
  `function a(x){if(x)return p("${MODEL}");return p("${LOGGED}")}`
);
const WHY = 'the model call returns a tool result; the other is only logged';
const MODEL_WHY = 'the new arm is returned as a tool result like the first';

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

  it('raises a model arm the carried reviews never saw', () => {
    const mixed = scan(ruled('internal')).mixed;
    const old = mixed[0].fingerprint;
    const { allowlist } = recordReviews({}, [{ key: old, why: WHY }], mixed);
    const code = program(
      `function a(x){if(x)return p("${MODEL}");if(x>1)return p("${WRONG}");return p("${LOGGED}")}`
    );
    const cache = ruled('internal', { [key(WRONG)]: { facing: 'model' } });
    const moved = scan(cache, [], code).mixed;
    expect(moved[0].fingerprint).not.toBe(old);
    const open = unreviewedMixed(moved, allowlist);
    expect(open).toHaveLength(1);
    expect(open[0].carriedFrom).toEqual([old]);
    expect(open[0].uncovered).toEqual([
      { key: key(WRONG), facing: 'model', body: WRONG },
    ]);

    const partial = pruneReviews(allowlist, moved);
    expect(partial.rekeyed).toEqual([{ from: old, to: moved[0].fingerprint }]);
    expect(Object.keys(partial.allowlist[moved[0].fingerprint].model)).toEqual([
      key(MODEL),
    ]);
    expect(unreviewedMixed(moved, partial.allowlist)[0].uncovered).toEqual(
      open[0].uncovered
    );

    const rec = recordReviews(
      allowlist,
      [{ key: moved[0].fingerprint, why: MODEL_WHY }],
      moved
    );
    expect(rec.problems).toEqual([]);
    expect(Object.keys(rec.allowlist)).toEqual([moved[0].fingerprint]);
    const entry = rec.allowlist[moved[0].fingerprint];
    expect(Object.keys(entry.model).sort()).toEqual(
      [key(MODEL), key(WRONG)].sort()
    );
    expect(entry.reviews).toEqual([
      allowlist[old].reviews[0],
      {
        arms: { [key(WRONG)]: { facing: 'model', preview: WRONG } },
        why: MODEL_WHY,
      },
    ]);
    expect(unreviewedMixed(moved, rec.allowlist)).toEqual([]);
    const same = pruneReviews(rec.allowlist, moved);
    expect(same).toMatchObject({
      removedEntries: [],
      removedArms: [],
      rekeyed: [],
    });
    expect(same.allowlist).toEqual(rec.allowlist);

    const grown = scan(
      { ...cache, [key(THIRD)]: { facing: 'model' } },
      [],
      program(
        `function a(x){if(x)return p("${MODEL}");if(x>1)return p("${WRONG}");if(x>2)return p("${THIRD}");return p("${LOGGED}")}`
      )
    ).mixed;
    expect(
      unreviewedMixed(grown, rec.allowlist)[0].uncovered.map(a => a.body)
    ).toEqual([THIRD]);
    const p = pruneReviews(rec.allowlist, grown);
    expect(p.rekeyed).toEqual([
      { from: moved[0].fingerprint, to: grown[0].fingerprint },
    ]);
    expect(p.removedArms).toEqual([]);
    const rekeyed = p.allowlist[grown[0].fingerprint];
    expect(Object.keys(rekeyed.model).sort()).toEqual(
      [key(MODEL), key(WRONG)].sort()
    );
    expect(rekeyed.reviews).toEqual(entry.reviews);
    expect(
      unreviewedMixed(grown, p.allowlist)[0].uncovered.map(a => a.body)
    ).toEqual([THIRD]);
  });

  it('keeps an entry whose model arms all changed as a suggestion', () => {
    const three = program(
      `function a(x){if(x)return p("${MODEL}");if(x>1)return p("${SECOND}");return p("${LOGGED}")}`
    );
    const before = scan(
      ruled('internal', { [key(SECOND)]: { facing: 'internal' } }),
      [],
      three
    ).mixed;
    const old = before[0].fingerprint;
    const { allowlist } = recordReviews({}, [{ key: old, why: WHY }], before);
    const cache = {
      [key(THIRD)]: { facing: 'model' },
      [key(LOGGED)]: { facing: 'internal' },
    };
    const after = scan(
      cache,
      [],
      program(`function a(x){if(x)return p("${THIRD}");return p("${LOGGED}")}`)
    ).mixed;
    const fp = after[0].fingerprint;
    const [open] = unreviewedMixed(after, allowlist);
    expect(open.carriedFrom).toBeUndefined();
    expect(open.uncovered.map(a => a.body)).toEqual([LOGGED]);
    expect(open.suggested).toEqual([
      { entry: old, why: WHY, arms: [key(LOGGED)] },
    ]);

    const p = pruneReviews(allowlist, after);
    expect(p.removedEntries).toEqual([]);
    expect(p.rekeyed).toEqual([]);
    expect(p.removedArms).toEqual([
      { entry: old, key: key(SECOND), facing: 'internal', preview: SECOND },
    ]);
    expect(p.allowlist[old].reviews).toEqual([
      {
        arms: { [key(LOGGED)]: allowlist[old].reviews[0].arms[key(LOGGED)] },
        why: WHY,
      },
    ]);
    const again = pruneReviews(p.allowlist, after);
    expect(again).toMatchObject({
      removedEntries: [],
      removedArms: [],
      rekeyed: [],
    });
    expect(again.allowlist).toEqual(p.allowlist);
    expect(unreviewedMixed(after, p.allowlist)[0].suggested).toEqual(
      open.suggested
    );

    const rec = recordReviews(p.allowlist, [{ key: fp, why: WHY }], after);
    expect(rec.problems).toEqual([]);
    expect(Object.keys(rec.allowlist)).toEqual([fp]);
    expect(unreviewedMixed(after, rec.allowlist)).toEqual([]);
    expect(
      pruneReviews(p.allowlist, []).removedEntries.map(e => e.key)
    ).toEqual([old]);
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

  it('rejects a review that picks no arm', () => {
    const mixed = scan(ruled('internal')).mixed;
    const fp = mixed[0].fingerprint;
    const r = recordReviews({}, [{ key: fp, why: WHY, arms: [] }], mixed);
    expect(r).toEqual({
      allowlist: {},
      recorded: 0,
      problems: [`${fp}: arms picks no arm`],
    });
  });

  it('lists a group split only by a literal used elsewhere as advisory', () => {
    const elsewhere = program(
      `function a(x){if(x)return p("${MODEL}");return p("${LOGGED}")}`,
      `function b(){console.log("${MODEL}")}`
    );
    const r = scan(ruled('internal'), [], elsewhere);
    expect(r.mixed).toEqual([]);
    expect(r.unearnedMixed).toHaveLength(1);
    expect(r.unearnedMixed[0]).toMatchObject({
      callee: 'p',
      position: 0,
      model: [
        {
          key: key(MODEL),
          body: MODEL,
          elsewhere: [elsewhere.lastIndexOf(`"${MODEL}"`)],
        },
      ],
      other: [{ key: key(LOGGED), facing: 'internal', body: LOGGED }],
    });
    const viaVariable = program(
      'function q(m){console.log(m)}',
      `function a(x){let s="${MODEL}";q(s);if(x)return p(s);return p("${LOGGED}")}`
    );
    expect(scan(ruled('internal'), [], viaVariable).unearnedMixed).toEqual([]);
    expect(scan(ruled('internal')).unearnedMixed).toEqual([]);
  });

  // CC 2.1.296: an array or `+` chain argument was read only as its leaves, so
  // a verdict on its joined text (`p("app_scroll only supports vertical " +
  // "…")` ruled internal beside 200 model arms) never reached the gate.
  describe('composite arguments', () => {
    const CHAIN = ['Model facing ', 'chain argument text'];
    const LINES = ['Array model line one', 'Array model line two'];
    const chain = CHAIN.map(s => `"${s}"`).join('+');
    const array = `[${LINES.map(s => `"${s}"`).join(',')}]`;
    const composites = (extra = {}) =>
      ruled('internal', {
        [key(CHAIN.join(''))]: { facing: 'model' },
        [key(LINES.join('\n'))]: { facing: 'model' },
        ...extra,
      });

    it('counts a `+` chain or array written in the call as earned', () => {
      const code = program(
        `function a(x){if(x)return p(${chain});if(x>1)return p(${array});return p("${LOGGED}")}`
      );
      const r = scan(composites({ [key(MODEL)]: undefined }), [], code);
      expect(r.mixed).toHaveLength(1);
      expect(r.mixed[0].model).toEqual(
        [
          { key: key(CHAIN.join('')), body: CHAIN.join('') },
          { key: key(LINES.join('\n')), body: LINES.join('\n') },
        ].sort((x, y) => x.key.localeCompare(y.key))
      );
      expect(r.mixed[0].other).toEqual([
        { key: key(LOGGED), facing: 'internal', body: LOGGED },
      ]);
    });

    it('reads a joined array argument by its separator', () => {
      const code = program(
        `function a(x){if(x)return p(${array}.join(" "));return p("${LOGGED}")}`
      );
      const r = scan(
        ruled('internal', { [key(LINES.join(' '))]: { facing: 'model' } }),
        [],
        code
      );
      expect(r.mixed[0].model).toEqual([
        { key: key(LINES.join(' ')), body: LINES.join(' ') },
      ]);
    });

    it('raises a ruling on the whole beside its own ruled parts', () => {
      const code = program(
        `function a(x){if(x)return p("${MODEL}");return p("${LOGGED}"+" tail line")}`
      );
      const r = scan(
        ruled('model', { [key(`${LOGGED} tail line`)]: { facing: 'ui' } }),
        [],
        code
      );
      expect(r.mixed).toHaveLength(1);
      expect(r.mixed[0].model.map(a => a.body).sort()).toEqual(
        [LOGGED, MODEL].sort()
      );
      expect(r.mixed[0].other).toEqual([
        {
          key: key(`${LOGGED} tail line`),
          facing: 'ui',
          body: `${LOGGED} tail line`,
        },
      ]);
    });

    it('leaves a composite reached through a variable unearned', () => {
      for (const value of [chain, array]) {
        const code = program(
          'function q(m){console.log(m)}',
          `function a(x){let s=${value};q(s);if(x)return p(s);return p("${LOGGED}")}`,
          `function b(){return p("${SECOND}")}`
        );
        const r = scan(composites(), [], code);
        expect(r.mixed).toEqual([]);
        expect(r.unearnedMixed).toEqual([]);
      }
    });

    it('gives the parts of an unruled composite its route', () => {
      const parts = `["${MODEL}","Unruled array partner line"]`;
      const direct = program(
        `function a(x){if(x)return p(${parts});return p("${LOGGED}")}`
      );
      const [m] = scan(ruled('internal'), [], direct).mixed;
      expect(m.model).toEqual([{ key: key(MODEL), body: MODEL }]);
      const bound = program(
        'function q(m){console.log(m)}',
        `function a(x){let s=${parts};q(s);if(x)return p(s);return p("${LOGGED}")}`
      );
      const r = scan(ruled('internal'), [], bound);
      expect(r.mixed).toEqual([]);
      expect(r.unearnedMixed).toEqual([]);
    });

    it('lists a composite whose joined text occurs elsewhere as advisory', () => {
      const joined = CHAIN.join('');
      const code = program(
        `function a(x){if(x)return p(${chain});return p("${LOGGED}")}`,
        `function b(){console.log("${joined}")}`
      );
      const r = scan(composites(), [], code);
      expect(r.mixed).toEqual([]);
      expect(r.unearnedMixed).toHaveLength(1);
      expect(r.unearnedMixed[0].model).toEqual([
        {
          key: key(joined),
          body: joined,
          elsewhere: [code.indexOf(`"${joined}"`)],
        },
      ]);
      // A joined array is one occurrence, though the call and its array are
      // both composites of that text.
      const twice = program(
        `function a(x){if(x)return p(${array});return p("${LOGGED}")}`,
        `function c(){console.log(${array}.join("\\n"))}`
      );
      const u = scan(composites(), [], twice).unearnedMixed;
      expect(u).toHaveLength(1);
      expect(u[0].model).toEqual([
        {
          key: key(LINES.join('\n')),
          body: LINES.join('\n'),
          elsewhere: [twice.lastIndexOf(array)],
        },
      ]);
    });
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

  it('records onto a file that already holds reviews', async () => {
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
    expect(await formatAllowlist(allow)).toBe(text);
    r = gate(...opts);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/mixed call verdicts: 0 unreviewed of 2/);
  });

  it('prints advisory and suggestion lines without failing on them', () => {
    const opts = files(
      ruled('internal', { [key(THIRD)]: { facing: 'model' } })
    );
    fs.writeFileSync(
      cli,
      program(
        `function a(x){if(x)return p("${MODEL}");return p("${LOGGED}")}`,
        `function b(){console.log("${MODEL}")}`
      )
    );
    let r = gate(...opts);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /^UNEARNED-MIXED [0-9a-f]{16} @\d+ p\(\) arg 0: 1 model/m
    );
    expect(r.stdout).toContain(`  internal ${key(LOGGED)} "${LOGGED}"`);
    expect(r.stdout).toMatch(/unearned mixed call groups: 1 \(advisory/);
    expect(r.stdout).toMatch(/mixed call verdicts: 0 unreviewed of 0 /);

    fs.writeFileSync(cli, CODE);
    const [m] = scan(ruled('internal')).mixed;
    expect(
      gate(...opts, '--record', reviews([{ key: m.fingerprint, why: WHY }]))
        .status
    ).toBe(0);
    fs.writeFileSync(
      cli,
      program(`function a(x){if(x)return p("${THIRD}");return p("${LOGGED}")}`)
    );
    r = gate(...opts);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      `  suggested by entry ${m.fingerprint} for ${key(LOGGED)} (not coverage): ${JSON.stringify(WHY)}`
    );
    expect(r.stdout).toMatch(/mixed call verdicts: 1 unreviewed of 1 /);
    expect(r.stdout).not.toMatch(/run --prune/);
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
