// Locks the slot-literal review round trip: packets cover every unreviewed
// literal once, merge refuses a bad verdict set without writing, and a good one
// is appended to the allowlist leaving every existing byte in place.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPackets,
  checkVerdicts,
  mergeVerdicts,
} from './slotLiteralReview.mjs';
import { findSlotLiterals } from './checkSlotLiterals.mjs';

const CATALOGUE = {
  prompts: [
    {
      id: 'tool-result-fixture-refused',
      identifiers: [0, 1],
      identifierMap: { 0: 'SUBJECT', 1: 'REASON' },
      pieces: ['${', '.name} was refused: ${', '}'],
    },
  ],
};
const SOURCE =
  'function c(e,x){let r=x?"the session is not in auto mode":"no step was left";return `${e.name} was refused: ${r}`}\n';

describe('slotLiteralReview', () => {
  let dir;
  let out;
  let cli;
  let json;
  let allowlistPath;
  const EXISTING =
    '{\n  "0000000000000000": {\n    "verdict": "glue",\n    "text": "kept — as written"\n  }\n}\n';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slotlit-'));
    out = path.join(dir, 'review');
    cli = path.join(dir, 'cli.js');
    json = path.join(dir, 'prompts.json');
    allowlistPath = path.join(dir, 'allowlist.json');
    fs.writeFileSync(cli, SOURCE);
    fs.writeFileSync(json, JSON.stringify(CATALOGUE));
    fs.writeFileSync(allowlistPath, EXISTING);
  });

  const hashes = () => findSlotLiterals(SOURCE, CATALOGUE).map(f => f.hash);

  it('builds one packet holding every unreviewed literal once', () => {
    const r = buildPackets(cli, json, out, { allowlistPath });
    expect(r).toEqual({ literals: 2, packets: 1 });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(out, 'hashes-00.json'), 'utf8')
      ).sort()
    ).toEqual(hashes().sort());
    const md = fs.readFileSync(path.join(out, 'packet-00.md'), 'utf8');
    expect(md).toContain('${SUBJECT.name} was refused: ${REASON}');
    expect(
      fs.readFileSync(path.join(out, 'existing-ids.txt'), 'utf8')
    ).toContain('tool-result-fixture-refused');
  });

  it('refuses a live id, a missing hash and a pending classify candidate, writing nothing', () => {
    buildPackets(cli, json, out, { allowlistPath });
    const [a] = hashes();
    fs.writeFileSync(
      path.join(out, 'verdicts-00.json'),
      JSON.stringify([
        {
          hash: a,
          verdict: 'catalogue',
          id: 'tool-result-fixture-refused',
          name: 'N',
          desc: 'D',
          reason: 'bound to r in c(), rendered as the reason',
        },
      ])
    );
    const cands = path.join(dir, 'cands');
    fs.mkdirSync(cands);
    const text = findSlotLiterals(SOURCE, CATALOGUE).find(
      f => f.hash === a
    ).text;
    fs.writeFileSync(
      path.join(cands, 'classify-chunk-00.json'),
      JSON.stringify([{ body: `x ${text} y` }])
    );
    const r = mergeVerdicts(out, { allowlistPath, candidatesDir: cands });
    expect(r.appended).toBe(0);
    expect(r.problems.join('\n')).toMatch(/already live/);
    expect(r.problems.join('\n')).toMatch(/missing/);
    expect(r.problems.join('\n')).toMatch(/pending classify candidate/);
    expect(fs.readFileSync(allowlistPath, 'utf8')).toBe(EXISTING);
  });

  it('appends a valid verdict set as insertions only', () => {
    buildPackets(cli, json, out, { allowlistPath });
    const [a, b] = hashes();
    fs.writeFileSync(
      path.join(out, 'verdicts-00.json'),
      JSON.stringify([
        {
          hash: a,
          verdict: 'catalogue',
          id: 'tool-result-fixture-refused-reason',
          name: 'Tool Result: Fixture — reason',
          desc: 'Why the call was refused.',
          reason: 'bound to r in c(), rendered as the reason',
        },
        {
          hash: b,
          verdict: 'glue',
          reason: 'the other arm of r, a placeholder phrase',
        },
      ])
    );
    expect(checkVerdicts(out, { allowlistPath }).problems).toEqual([]);
    expect(mergeVerdicts(out, { allowlistPath }).appended).toBe(2);
    const next = fs.readFileSync(allowlistPath, 'utf8');
    expect(next.startsWith(EXISTING.slice(0, -3))).toBe(true);
    const parsed = JSON.parse(next);
    expect(parsed[a]).toMatchObject({
      verdict: 'catalogue',
      id: 'tool-result-fixture-refused-reason',
      promptId: 'tool-result-fixture-refused',
      label: 'REASON',
    });
    expect(parsed[b]).toMatchObject({ verdict: 'glue' });
  });
});
