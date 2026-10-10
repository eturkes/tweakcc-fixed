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
const run = (ours, upstream, body) => {
  const write = (name, prompt) => {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: '2.1.296',
        prompts: [{ id: 'fixture', ...prompt }],
      })
    );
    return file;
  };
  fs.writeFileSync(path.join(dir, 'set', 'fixture.md'), body);
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
    expect(r.stdout).not.toContain('not comparable');
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
    expect(r.stdout).not.toContain('not comparable');
  });

  it('skips prompt text that belongs to a different release', () => {
    const r = run(
      { ...before, pieces: ['Changed text ${', '} finish ${', '}'] },
      before,
      '${TABLE}'
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not comparable');
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
    expect(r.stdout).not.toContain('not comparable');
  });
});
