import { describe, it, expect } from 'vitest';
import {
  catalogueForm,
  catalogueIndex,
  collisionProblems,
  sha1,
} from './classifyVerdicts.mjs';

describe('collisionProblems', () => {
  // After classify-merge and re-extract the catalogue stores the minted id on
  // the placeholder form, while the candidate hash is of the raw body.
  it('accepts an id live on the catalogue form of the candidate body', () => {
    const body =
      'Claude Code 9.9.9 built {BUILD_TIME:"2026-10-10T12:00:00Z"} here';
    const cand = { hash: sha1(body), body };
    const catalogue = catalogueIndex([
      {
        id: 'tool-result-versioned',
        pieces: [
          'Claude Code <<CCVERSION>> built {BUILD_TIME:"<<BUILD_TIME>>"} here',
        ],
      },
    ]);
    const merged = [
      { hash: cand.hash, facing: 'model', id: 'tool-result-versioned' },
    ];
    const run = version =>
      collisionProblems(merged, {
        cands: new Map([[cand.hash, cand]]),
        catalogue,
        label: 'classify',
        version,
      });
    expect(run('9.9.9')).toEqual([]);
    expect(run(undefined)).toHaveLength(1);
  });

  it('still rejects an id live on a different body', () => {
    const body = 'Claude Code 9.9.9 other text';
    const cand = { hash: sha1(body), body };
    const catalogue = catalogueIndex([
      {
        id: 'tool-result-versioned',
        pieces: ['Claude Code <<CCVERSION>> here'],
      },
    ]);
    const problems = collisionProblems(
      [{ hash: cand.hash, facing: 'model', id: 'tool-result-versioned' }],
      {
        cands: new Map([[cand.hash, cand]]),
        catalogue,
        label: 'classify',
        version: '9.9.9',
      }
    );
    expect(problems[0]).toMatch(/live on a different body/);
  });

  it('normalises the build stamp and every version occurrence', () => {
    expect(
      catalogueForm('v1.2.3 BUILD_TIME:"2026-01-02T03:04:05Z" v1.2.3', '1.2.3')
    ).toBe('v<<CCVERSION>> BUILD_TIME:"<<BUILD_TIME>>" v<<CCVERSION>>');
  });
});
