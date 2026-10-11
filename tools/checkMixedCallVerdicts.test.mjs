// A call group ruled both model and ui/internal must be raised until a review
// naming the differing routes is recorded, and raised again when its rulings
// change.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSiblingArms } from './checkSiblingArms.mjs';
import { keyVariants } from './probeCacheKey.mjs';
import { recordReviews, unreviewedMixed } from './checkMixedCallVerdicts.mjs';

const key = body => keyVariants(body)[0].key;
const CODE = [
  'function p(m){return {error:m}}',
  'function a(x){if(x)return p("Model facing call text");return p("Logged only call text")}',
].join('\n');

describe('checkMixedCallVerdicts', () => {
  let dir;
  let cli;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-'));
    cli = path.join(dir, 'cli-9.9.5.js');
    fs.writeFileSync(cli, CODE);
  });
  const scan = cache => scanSiblingArms(cli, { catalogue: [], cache });
  const ruled = second => ({
    [key('Model facing call text')]: {
      facing: 'model',
      id: 'tool-result-fixture-model-call',
    },
    [key('Logged only call text')]: { facing: second },
  });

  it('raises a call group ruled both model and internal', () => {
    const r = scan(ruled('internal'));
    expect(r.mixed).toHaveLength(1);
    expect(r.mixed[0].model).toEqual(['Model facing call text']);
    expect(r.mixed[0].other).toEqual([
      { facing: 'internal', body: 'Logged only call text' },
    ]);
  });

  it('does not raise a group ruled one way', () => {
    expect(scan(ruled('model')).mixed).toEqual([]);
  });

  it('keeps a recorded group quiet until a ruling changes', () => {
    const allowlistPath = path.join(dir, 'allow.json');
    fs.writeFileSync(allowlistPath, '{\n}\n');
    const [m] = scan(ruled('internal')).mixed;
    const byKey = new Map([[m.key, m]]);
    const short = recordReviews(
      allowlistPath,
      [{ key: m.key, why: 'differs' }],
      byKey
    );
    expect(short.appended).toBe(0);
    expect(short.problems.join()).toMatch(/why must name/);
    const ok = recordReviews(
      allowlistPath,
      [
        {
          key: m.key,
          why: 'the model call returns a tool result; the other is only logged',
        },
      ],
      byKey
    );
    expect(ok).toEqual({ appended: 1, problems: [] });
    const allow = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    expect(unreviewedMixed(scan(ruled('internal')).mixed, allow)).toEqual([]);
    expect(unreviewedMixed(scan(ruled('ui')).mixed, allow)).toHaveLength(1);
    expect(
      recordReviews(
        allowlistPath,
        [
          {
            key: 'ffffffffffffffff',
            why: 'a group that is not current any more',
          },
        ],
        byKey
      ).problems.join()
    ).toMatch(/not a current mixed group/);
  });
});
