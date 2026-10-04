import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  READ_CAP_TOKENS,
  partByteCap,
  readCapTokens,
  splitMarkdown,
  partPaths,
  writeMarkdownParts,
} from './packetParts.mjs';
import { partitionContiguous, agentsFor } from './packByWeight.mjs';

const bytes = s => Buffer.byteLength(s);
const section = (title, n, fill = 'x') => `## ${title}\n${Array.from({ length: n }, (_, i) => `${fill.repeat(70)} ${i}`).join('\n')}`;

describe('part byte cap', () => {
  it('derives from the Read cap, the measured bytes-per-token floor and headroom', () => {
    expect(READ_CAP_TOKENS).toBe(25000);
    expect(partByteCap({ tokens: 25000 })).toBe(37125);
    expect(readCapTokens({ CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '10000' })).toBe(10000);
    expect(readCapTokens({})).toBe(25000);
  });
});

describe('splitMarkdown', () => {
  it('returns the packet whole when it fits', () => {
    expect(splitMarkdown('# a\nb\n', 1000)).toEqual(['# a\nb\n']);
  });

  it('splits at headings only, every part under the cap, and loses nothing', () => {
    const md = ['# Header', 'intro', ...Array.from({ length: 12 }, (_, i) => section(`${i + 1}/12 \`id-${i}\``, 8))].join('\n') + '\n';
    const parts = splitMarkdown(md, 2000);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(2000);
    expect(parts.join('\n')).toBe(md);
    // No id section is cut: each one sits whole in exactly one part.
    for (let i = 0; i < 12; i++) expect(parts.filter(p => p.includes(`\`id-${i}\``) && p.includes(`${'x'.repeat(70)} 7`)).length).toBe(1);
  });

  it('never splits at a heading-looking line inside a fence', () => {
    const fenced = ['## outer', '~~~text', ...Array.from({ length: 30 }, (_, i) => `# not a heading ${i} ${'y'.repeat(40)}`), '~~~'].join('\n');
    const md = `${section('a', 10)}\n${fenced}\n${section('b', 10)}`;
    const parts = splitMarkdown(md, 2600);
    const holder = parts.filter(p => p.includes('# not a heading 0'));
    expect(holder).toHaveLength(1);
    expect(holder[0]).toContain('# not a heading 29');
  });

  it('splits an oversized section at lines, closing and reopening an open fence', () => {
    const big = ['## huge', '~~~~text', ...Array.from({ length: 200 }, (_, i) => `line ${i} ${'z'.repeat(60)}`), '~~~~', 'after'].join('\n');
    const parts = splitMarkdown(big, 3000);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(bytes(p)).toBeLessThanOrEqual(3000);
    for (const p of parts.slice(1)) expect(p.startsWith('(continued from the previous part)\n~~~~text')).toBe(true);
    for (const p of parts.slice(0, -1)) expect(p.endsWith('\n~~~~')).toBe(true);
    const body = parts.join('\n');
    for (let i = 0; i < 200; i++) expect(body).toContain(`line ${i} `);
  });

  it('counts bytes, not characters', () => {
    const md = Array.from({ length: 20 }, (_, i) => `## s${i}\n${'é'.repeat(100)}`).join('\n');
    for (const p of splitMarkdown(md, 1000)) expect(bytes(p)).toBeLessThanOrEqual(1000);
  });
});

describe('writeMarkdownParts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-parts-'));

  it('writes the whole packet, and parts that name each other when it is larger than one Read', () => {
    const f = path.join(dir, 'chunk-03.md');
    const md = Array.from({ length: 40 }, (_, i) => section(`k${i}`, 10)).join('\n');
    const paths = writeMarkdownParts(f, md, { maxBytes: 4000 });
    expect(fs.readFileSync(f, 'utf8')).toBe(md);
    expect(paths).toEqual(partPaths(f, paths.length));
    expect(paths[0]).toBe(path.join(dir, 'chunk-03.part1.md'));
    for (const p of paths) {
      const t = fs.readFileSync(p, 'utf8');
      expect(bytes(t)).toBeLessThanOrEqual(4000);
      expect(t.split('\n')[0]).toContain(`of ${paths.length} of chunk-03.md`);
      expect(t.split('\n')[0]).toContain(`${paths[0]} … ${paths[paths.length - 1]}`);
    }
    const rejoined = paths.map(p => fs.readFileSync(p, 'utf8').split('\n').slice(1).join('\n').replace(/\n$/, '')).join('\n');
    expect(rejoined).toBe(md);
  });

  it('removes stale parts of the same packet and leaves other packets alone', () => {
    const f = path.join(dir, 'chunk-04.md');
    const other = path.join(dir, 'chunk-14.part1.md');
    fs.writeFileSync(other, 'keep');
    writeMarkdownParts(f, Array.from({ length: 40 }, (_, i) => section(`k${i}`, 10)).join('\n'), { maxBytes: 4000 });
    expect(fs.existsSync(path.join(dir, 'chunk-04.part2.md'))).toBe(true);
    expect(writeMarkdownParts(f, '# small\n', { maxBytes: 4000 })).toEqual([f]);
    expect(fs.readdirSync(dir).filter(x => x.startsWith('chunk-04.part'))).toEqual([]);
    expect(fs.readFileSync(other, 'utf8')).toBe('keep');
  });
});

describe('partitionContiguous', () => {
  it('keeps order and minimises the heaviest run', () => {
    const items = [5, 1, 1, 1, 5, 1, 1, 1, 5, 3];
    const runs = partitionContiguous(items, 3, x => x);
    expect(runs.flat()).toEqual(items);
    expect(runs).toHaveLength(3);
    expect(Math.max(...runs.map(r => r.reduce((a, b) => a + b, 0)))).toBe(8);
  });

  it('never makes more runs than asked and handles a heavy item', () => {
    const runs = partitionContiguous([1, 100, 1, 1], 3, x => x);
    expect(runs.length).toBeLessThanOrEqual(3);
    expect(runs.some(r => r.length === 1 && r[0] === 100)).toBe(true);
    expect(partitionContiguous([], 4, x => x)).toEqual([]);
  });

  it('sizes the fan-out from items per agent', () => {
    expect(agentsFor(1067, 67)).toBe(16);
    expect(agentsFor(451, 29)).toBe(16);
    expect(agentsFor(450, 29)).toBe(16);
    expect(agentsFor(3, 29)).toBe(1);
  });
});
