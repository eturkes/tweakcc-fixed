import { describe, it, expect } from 'vitest';
import { buildSearchRegexFromPieces } from './systemPromptSync';

describe('systemPromptSync.ts', () => {
  describe('buildSearchRegexFromPieces — member-access keys', () => {
    // Pieces for system-prompt-code-review-inline-command: the 3rd interpolation
    // is a member access ${OBJ[f]}, stored as a literal "[f]}…" in piece index 3.
    const pieces = ['${', '}${', '}${', '[f]}${', '?', ':""}${', '?', ':""}'];

    it('generalizes a minified member-access key instead of pinning the Mac key', () => {
      const pattern = buildSearchRegexFromPieces(pieces, '2.1.179');
      expect(pattern).toContain('\\[[\\w$]+\\]');
      expect(pattern).not.toContain('\\[f\\]');
    });

    it('matches the member key under both Mac and Linux minification', () => {
      const re = new RegExp(buildSearchRegexFromPieces(pieces, '2.1.179'), 's');
      // Mac build keys the member [f]; Linux minifies the same key differently.
      expect(re.test('${a0}${b1}${c2[f]}${d3?e4:""}${f5?g6:""}')).toBe(true);
      expect(re.test('${a0}${b1}${c2[q]}${d3?e4:""}${f5?g6:""}')).toBe(true);
    });

    it('leaves a literal bracket in prompt text untouched', () => {
      // [note] is mid-piece prose, not a member access closing an interpolation.
      const prose = ['before [note] ${', '} after'];
      const pattern = buildSearchRegexFromPieces(prose, '2.1.179');
      expect(pattern).toContain('\\[note\\]');
      expect(pattern).not.toContain('\\[[\\w$]+\\]');
    });
  });
  describe('buildSearchRegexFromPieces — identifiers deep in a slot expression', () => {
    // CC 2.1.286's html-saved viewed-once clause: `At` is `kt` on linux-x64.
    const viewedOnce = ['file${', '(', ',', '.slug,', '.ver,{ignoreHold:At})}'];

    it('generalizes a minified value behind an object-literal key', () => {
      const re = new RegExp(buildSearchRegexFromPieces(viewedOnce, '2.1.286'));
      expect(re.test('file${WOe(n,e.slug,r.ver,{ignoreHold:At})}')).toBe(true);
      expect(re.test('file${NHe(n,e.slug,r.ver,{ignoreHold:kt})}')).toBe(true);
      expect(re.test('file${NHe(n,e.slug,r.ver,{ignoreHeld:kt})}')).toBe(false);
    });

    // CC 2.1.286's live-doc shim: the spreads repeat `Oe`, which is `Le` on
    // linux-x64, and each occurrence must match on its own.
    const shim = [
      '${',
      '.line(',
      '.file,{edits:',
      '.edits,...',
      '.copy!==void 0&&{copy:Oe.copy},...typeof Oe.live==="string"&&{live:Oe.live}})}',
    ];

    it('generalizes every repeated minified name in spreads', () => {
      const pattern = buildSearchRegexFromPieces(shim, '2.1.286');
      const re = new RegExp(pattern);
      const darwin =
        '${se.line(Oe.file,{edits:Oe.edits,...Oe.copy!==void 0&&{copy:Oe.copy},...typeof Oe.live==="string"&&{live:Oe.live}})}';
      expect(re.test(darwin)).toBe(true);
      expect(re.test(darwin.replace(/Oe/g, 'Le'))).toBe(true);
      expect(re.test(darwin.replace(/Oe\.live\}/, 'Zz.live}'))).toBe(true);
      expect(pattern).toContain('\\.copy');
      expect(pattern).toContain('typeof ');
      expect(pattern).toContain('void 0');
      expect(re.test(darwin.replace('{copy:', '{kopy:'))).toBe(false);
      expect(re.test(darwin.replace('.live}', '.life}'))).toBe(false);
    });

    it('keeps keywords, strings, regex literals and private names literal', () => {
      const pattern = buildSearchRegexFromPieces(
        ['a ${', '?this.#p:n.replace(/^Not here/,"keep me")} b'],
        '2.1.286'
      );
      expect(pattern).toContain('this\\.#p');
      expect(pattern).toContain('/\\^Not here/');
      expect(pattern).toContain('keep me');
      expect(pattern).not.toContain('n\\.replace');
    });

    it('leaves prose after the interpolation closes untouched', () => {
      const pattern = buildSearchRegexFromPieces(
        ['x ${', '[q]} then words here'],
        '2.1.286'
      );
      expect(pattern).toContain('then words here');
    });
  });
});
