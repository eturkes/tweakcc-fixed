import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'auditMisbinds.mjs'
);
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misbind-test-'));
  fs.mkdirSync(path.join(dir, 'set'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
// `ours` and `upstream` are one fixture prompt, or arrays of prompts with ids
// and `body` maps each id to its override.
const run = (ours, upstream, body) => {
  const write = (name, prompts) => {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: '2.1.296',
        prompts: Array.isArray(prompts)
          ? prompts
          : [{ id: 'fixture', ...prompts }],
      })
    );
    return file;
  };
  const bodies = typeof body === 'string' ? { fixture: body } : body;
  for (const [id, text] of Object.entries(bodies))
    fs.writeFileSync(path.join(dir, 'set', `${id}.md`), text);
  return spawnSync(
    process.execPath,
    [
      TOOL,
      write('ours.json', ours),
      write('upstream.json', upstream),
      path.join(dir, 'set'),
    ],
    { encoding: 'utf8' }
  );
};
const before = {
  pieces: ['Pick ${', '[String(O)]} then ${', '} done'],
  identifiers: [0, 1],
  identifierMap: { 0: 'TABLE', 1: 'TAIL' },
};
const promoted = {
  pieces: ['Pick ${', '[', '(', ')]} then ${', '} done'],
  identifiers: [0, 1, 2, 3],
  identifierMap: { 0: 'TABLE', 1: 'CONVERT', 2: 'KEY', 3: 'TAIL' },
};

describe('auditMisbinds', () => {
  it('passes labels mapped to their original slots after promotion', () => {
    const r = run(promoted, before, '${TABLE} ${TAIL} ${CONVERT}');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('mis-bind audit: 0');
    expect(r.stdout).not.toContain('— not comparable:');
  });

  it('catches a carried label at a promoted slot instead of its old slot', () => {
    const r = run(
      {
        ...promoted,
        identifierMap: { ...promoted.identifierMap, 1: 'TAIL', 3: 'CONVERT' },
      },
      before,
      '${TAIL}'
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'ours=slot1 upstream=slot1 (maps to ours=slot3)'
    );
  });

  it('catches equal identifier arrays whose slots moved after a key was dropped', () => {
    const ours = {
      pieces: ['Choose ${', '(({key: ', '})=>', '.value)} done'],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'VALUES', 1: 'KEY', 2: 'VALUE' },
    };
    const upstream = {
      pieces: ['Choose ${', '(({', ': ', '})=>item.value)} done'],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'VALUES', 1: 'KEY', 2: 'VALUE' },
    };
    const r = run(ours, upstream, '${VALUE}');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'ours=slot2 upstream=slot2 (maps to ours=slot1)'
    );
  });

  it('catches a misbind in unchanged layouts', () => {
    const r = run(
      { ...before, identifierMap: { 0: 'TAIL', 1: 'TABLE' } },
      before,
      '${TABLE}'
    );
    expect(r.status).toBe(1);
  });

  it('fails a retained common label whose original slot became a literal key', () => {
    const ours = {
      pieces: ['Choose ${', '(({key: ', '})=>', '.value)} done'],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'VALUES', 1: 'KEY', 2: 'VALUE' },
    };
    const upstream = {
      pieces: ['Choose ${', '(({', ': ', '})=>item.value)} done'],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'VALUES', 1: 'KEY', 2: 'VALUE' },
    };
    const r = run(ours, upstream, '${KEY}');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      '${KEY} ours=slot1 upstream=slot1 has no unique current expression slot'
    );
    expect(r.stderr).toContain('removed or ambiguous binding');
    expect(r.stdout).not.toContain('— not comparable:');
  });

  it('compares changed text label for label when the identifiers agree', () => {
    const changed = {
      ...before,
      pieces: ['Changed text ${', '} finish ${', '}'],
    };
    const ok = run(changed, before, '${TABLE}');
    expect(ok.status).toBe(0);
    expect(ok.stdout).not.toContain('— not comparable:');
    expect(ok.stdout).toContain('1 compared (1 by identifiers)');
    const bad = run(
      { ...changed, identifierMap: { 0: 'TAIL', 1: 'TABLE' } },
      before,
      '${TABLE}'
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('${TABLE} ours=slot1 upstream=slot0');
  });

  it('skips changed text whose identifiers differ, and counts it', () => {
    const r = run(
      {
        pieces: ['Changed text ${', '} finish ${', '} and ${', '}'],
        identifiers: [0, 1, 2],
        identifierMap: { 0: 'TABLE', 1: 'TAIL', 2: 'NEW' },
      },
      before,
      '${TABLE}'
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not comparable: fixture');
    expect(r.stdout).toContain(
      '0 compared (0 by identifiers), 1 not comparable'
    );
  });

  it('matches a body that carries the version and build placeholders', () => {
    const stamped = {
      pieces: [
        'VERSION:"<<CCVERSION>>",BUILD_TIME:"<<BUILD_TIME>>" ${',
        '} then ${',
        '} done',
      ],
      identifiers: [1, 0],
      identifierMap: { 0: 'TAIL', 1: 'TABLE' },
    };
    const r = run(
      stamped,
      {
        ...stamped,
        identifiers: [0, 1],
        identifierMap: { 0: 'TABLE', 1: 'TAIL' },
      },
      '${TABLE}'
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 compared (0 by identifiers)');
  });

  it('fails when too many prompts are not comparable', () => {
    const prompts = n =>
      Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        pieces: [`Prompt ${i} ours \${`, '} end'],
        identifiers: [0],
        identifierMap: { 0: 'TABLE' },
      }));
    const ours = prompts(11);
    const upstream = ours.map(p => ({
      ...p,
      pieces: [`Prompt upstream ${p.id} \${`, '} mid ${', '} end'],
      identifiers: [0, 1],
      identifierMap: { 0: 'TABLE', 1: 'TAIL' },
    }));
    const bodies = Object.fromEntries(ours.map(p => [p.id, '${TABLE}']));
    const r = run(ours, upstream, bodies);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('11 prompts not comparable');
    expect(r.stderr).toContain('limit of 10');
    const under = run(ours.slice(0, 10), upstream.slice(0, 10), bodies);
    expect(under.status).toBe(0);
    // Prompts reshaped after the upstream reference are upstream lag.
    const newer = ours.map(p => ({ ...p, version: '2.1.297' }));
    const lag = run(newer, upstream, bodies);
    expect(lag.status).toBe(0);
    expect(lag.stdout).toContain('11 newer than upstream');
    // Same version as upstream is not lag.
    const same = ours.map(p => ({ ...p, version: '2.1.296' }));
    expect(run(same, upstream, bodies).status).toBe(1);
    // Lag has a ceiling of its own.
    const many = prompts(26).map(p => ({ ...p, version: '2.1.297' }));
    const manyUp = many.map(p => ({
      ...p,
      pieces: [`Prompt upstream ${p.id} \${`, '} mid ${', '} end'],
      identifiers: [0, 1],
      identifierMap: { 0: 'TABLE', 1: 'TAIL' },
    }));
    const manyBodies = Object.fromEntries(many.map(p => [p.id, '${TABLE}']));
    expect(run(many, manyUp, manyBodies).status).toBe(1);
  });

  it('does not mistake an escaped placeholder for a live binding', () => {
    const r = run(
      { ...before, identifierMap: { 0: 'TAIL', 1: 'TABLE' } },
      before,
      '\\${TABLE}'
    );
    expect(r.status).toBe(0);
  });

  it('fails a common label when two upstream slots align to one current binding', () => {
    const r = run(
      { ...before, identifiers: [0, 0], identifierMap: { 0: 'TABLE' } },
      before,
      '${TABLE}'
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('removed or ambiguous binding');
    expect(r.stdout).not.toContain('— not comparable:');
  });
});
