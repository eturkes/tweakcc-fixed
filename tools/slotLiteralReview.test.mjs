// Locks the slot-literal review round trip: packets cover every unreviewed
// literal once, merge refuses a bad verdict set without writing, and a good one
// is appended to the allowlist leaving every existing byte in place.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  const ENV = ['TWEAKCC_CLASSIFY_DIR', 'SHOWTIME_TMP'];
  let savedEnv;
  let cands;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slotlit-'));
    out = path.join(dir, 'review');
    cli = path.join(dir, 'cli.js');
    json = path.join(dir, 'prompts.json');
    allowlistPath = path.join(dir, 'allowlist.json');
    fs.writeFileSync(cli, SOURCE);
    fs.writeFileSync(json, JSON.stringify(CATALOGUE));
    fs.writeFileSync(allowlistPath, EXISTING);
    cands = path.join(dir, 'cands');
    fs.mkdirSync(cands);
  });

  afterEach(() => {
    for (const k of ENV)
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
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
    const opts = { allowlistPath, candidatesDir: cands };
    expect(checkVerdicts(out, opts).problems).toEqual([]);
    expect(mergeVerdicts(out, opts).appended).toBe(2);
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

  const writeVerdicts = rows =>
    fs.writeFileSync(path.join(out, 'verdicts-00.json'), JSON.stringify(rows));
  const valid = () => {
    const [a, b] = hashes();
    return [
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
    ];
  };
  const problems = (opts = {}) =>
    checkVerdicts(out, {
      allowlistPath,
      candidatesDir: cands,
      ...opts,
    }).problems.join('\n');

  it('refuses an id the live catalogue gained after the build', () => {
    buildPackets(cli, json, out, { allowlistPath });
    writeVerdicts(valid());
    expect(problems()).toBe('');
    fs.writeFileSync(
      json,
      JSON.stringify({
        prompts: [
          ...CATALOGUE.prompts,
          {
            id: 'tool-result-fixture-refused-reason',
            pieces: ['some other body'],
          },
        ],
      })
    );
    expect(problems()).toMatch(
      /tool-result-fixture-refused-reason is already live in the catalogue/
    );
  });

  it('accepts an id the live catalogue holds for this same literal', () => {
    buildPackets(cli, json, out, { allowlistPath });
    const rows = valid();
    writeVerdicts(rows);
    const text = findSlotLiterals(SOURCE, CATALOGUE).find(
      f => f.hash === rows[0].hash
    ).fullText;
    fs.writeFileSync(
      json,
      JSON.stringify({
        prompts: [...CATALOGUE.prompts, { id: rows[0].id, pieces: [text] }],
      })
    );
    expect(problems()).toBe('');
  });

  it('refuses an id another review merged into the allowlist after the build', () => {
    buildPackets(cli, json, out, { allowlistPath });
    writeVerdicts(valid());
    fs.writeFileSync(
      allowlistPath,
      EXISTING.slice(0, -3) +
        ',\n  "1111111111111111": {"verdict": "catalogue", "id": "tool-result-fixture-refused-reason"}\n}\n'
    );
    expect(problems()).toMatch(
      /already live in the allowlist for 1111111111111111/
    );
  });

  it('fails when a hash file or the manifest is gone', () => {
    buildPackets(cli, json, out, { allowlistPath });
    writeVerdicts(valid());
    fs.unlinkSync(path.join(out, 'hashes-00.json'));
    expect(problems()).toMatch(/hashes-00\.json does not exist/);
    fs.unlinkSync(path.join(out, 'manifest.json'));
    const r = checkVerdicts(out, { allowlistPath, candidatesDir: cands });
    expect(r.problems.join('\n')).toMatch(/manifest\.json does not exist/);
    expect(mergeVerdicts(out, { allowlistPath, candidatesDir: cands })).toEqual(
      expect.objectContaining({ appended: 0 })
    );
    expect(fs.readFileSync(allowlistPath, 'utf8')).toBe(EXISTING);
  });

  it('fails when a whole packet is missing', () => {
    buildPackets(cli, json, out, { allowlistPath });
    fs.unlinkSync(path.join(out, 'hashes-00.json'));
    expect(problems()).toMatch(/verdicts-00\.json does not exist/);
  });

  it('matches a pending classify candidate on the full text of a long literal', () => {
    const long =
      'Stop and ask the user before retrying, because ' +
      'the session cannot continue unattended. '.repeat(10);
    const src = `function c(e,x){let r=x?${JSON.stringify(long)}:"";return \`\${e.name} was refused: \${r}\`}\n`;
    fs.writeFileSync(cli, src);
    buildPackets(cli, json, out, { allowlistPath });
    const [f] = findSlotLiterals(src, CATALOGUE);
    expect(f.text.endsWith('...')).toBe(true);
    expect(f.fullText).toBe(long);
    writeVerdicts([
      {
        hash: f.hash,
        verdict: 'catalogue',
        id: 'tool-result-fixture-stop-and-ask',
        name: 'N',
        desc: 'D',
        reason: 'bound to r in c(), rendered as the reason',
      },
    ]);
    fs.writeFileSync(
      path.join(cands, 'classify-chunk-00.json'),
      JSON.stringify([{ body: long }])
    );
    expect(problems()).toMatch(/pending classify candidate/);
  });

  it('resolves the candidates dir from the flag, the env, then the build, and fails with none', () => {
    buildPackets(cli, json, out, { allowlistPath });
    writeVerdicts(valid());
    const none = { allowlistPath };
    expect(checkVerdicts(out, none).problems.join('\n')).toMatch(
      /no classify candidates dir/
    );
    expect(
      checkVerdicts(out, { ...none, noCandidates: true }).problems
    ).toEqual([]);
    process.env.TWEAKCC_CLASSIFY_DIR = cands;
    expect(checkVerdicts(out, none).problems).toEqual([]);
    delete process.env.TWEAKCC_CLASSIFY_DIR;
    expect(
      checkVerdicts(out, {
        ...none,
        candidatesDir: path.join(dir, 'nope'),
      }).problems.join('\n')
    ).toMatch(/does not exist/);

    fs.unlinkSync(path.join(out, 'verdicts-00.json'));
    process.env.SHOWTIME_TMP = cands;
    buildPackets(cli, json, out, { allowlistPath });
    delete process.env.SHOWTIME_TMP;
    writeVerdicts(valid());
    expect(checkVerdicts(out, none).problems).toEqual([]);
  });

  it('merges into an empty allowlist', () => {
    fs.writeFileSync(allowlistPath, '{\n}\n');
    buildPackets(cli, json, out, { allowlistPath });
    writeVerdicts(valid());
    expect(
      mergeVerdicts(out, { allowlistPath, candidatesDir: cands }).appended
    ).toBe(2);
    expect(
      Object.keys(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')))
    ).toHaveLength(2);
  });

  it('refuses to rebuild over finished verdicts unless forced', () => {
    buildPackets(cli, json, out, { allowlistPath });
    writeVerdicts(valid());
    expect(() => buildPackets(cli, json, out, { allowlistPath })).toThrow(
      /verdicts-00\.json.*--force/
    );
    expect(fs.existsSync(path.join(out, 'verdicts-00.json'))).toBe(true);
    buildPackets(cli, json, out, { allowlistPath, force: true });
    expect(fs.existsSync(path.join(out, 'verdicts-00.json'))).toBe(false);
  });
});
