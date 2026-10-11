/**
 * CC 2.1.246 code-split the app: `/$bunfs/root/cli` became a ~20 KB ESM entry
 * loader and the real code moved into ~1,400 sibling modules, 128 of which
 * carry model-facing prompt text. Every downstream consumer (patches, prompt
 * overrides, the extractor) is written against ONE `cli.js` string, so instead
 * of threading a module array through all of them we hand them a single
 * VIRTUAL bundle: every JS module concatenated, each preceded by a sentinel
 * comment naming its module-table index, then every text asset as one
 * template literal behind its own sentinel. Repack splits on the same sentinel
 * and writes each segment back to its own module.
 *
 * The sentinel is a block comment, so the bundle stays valid-ish JS, and
 * `/*@@` appears in zero of the 1,411 real modules (checked on 2.1.246).
 */
export const MODULE_SENTINEL_RE =
  /\n\/\*@@TWEAKCC_MODULE:(\d+):([^@]*)@@\*\/\n/g;

export const moduleSentinel = (index: number, name: string): string =>
  `\n/*@@TWEAKCC_MODULE:${index}:${name}@@*/\n`;

// The preamble's JS-module count: the first that many segments are JS, every
// later one is a text asset.
export const moduleCountDeclaration = (count: number): string =>
  `var __ccVirtualBundleModules = ${count};\n`;

const MODULE_COUNT_RE = /^var __ccVirtualBundleModules = (\d+);$/m;

interface Span {
  start: number;
  end: number;
}

/**
 * Where a virtual bundle's JS ends and each text asset's template literal
 * sits, kept current through splices.
 *
 * A prompt is either JS text or a whole text asset, and the two must not
 * borrow each other's sites: a short JS prompt also occurs inside the docs
 * (`/model` gained 127 extra candidate sites when the assets joined the
 * bundle), which made seven JS prompts ambiguous and skipped them, and an
 * asset prompt only ever means its own document.
 */
export class BundleRegions {
  private constructor(
    private jsEnd: number,
    private assets: Span[]
  ) {}

  /** Null for a single-file cli.js or a bundle without text assets. */
  static of(content: string): BundleRegions | null {
    const declared = content.slice(0, 4096).match(MODULE_COUNT_RE);
    if (!declared) return null;
    const jsModules = Number(declared[1]);
    const marks: Span[] = [];
    MODULE_SENTINEL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODULE_SENTINEL_RE.exec(content)) !== null) {
      marks.push({ start: m.index, end: m.index + m[0].length });
    }
    if (marks.length <= jsModules) return null;
    const assets: Span[] = [];
    for (let i = jsModules; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].start : content.length;
      assets.push({ start: marks[i].end, end });
    }
    return new BundleRegions(marks[jsModules].start, assets);
  }

  /**
   * Whether a match may be a site of a prompt: a JS prompt's sites lie in
   * the JS, an asset prompt's inside one asset's template literal.
   */
  allows(start: number, end: number, asset: boolean): boolean {
    if (!asset) return end <= this.jsEnd;
    let lo = 0;
    let hi = this.assets.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const span = this.assets[mid];
      if (start < span.start) hi = mid - 1;
      else if (start >= span.end) lo = mid + 1;
      else return start > span.start && end < span.end;
    }
    return false;
  }

  recordSplice(start: number, end: number, replacementLength: number): void {
    const shift = (at: number): number =>
      at >= end
        ? at + replacementLength - (end - start)
        : at > start
          ? Math.min(at, start + replacementLength)
          : at;
    this.jsEnd = shift(this.jsEnd);
    for (const span of this.assets) {
      span.start = shift(span.start);
      span.end = shift(span.end);
    }
  }
}

/**
 * The matches a catalogue entry may splice: `regions.allows` applied to each,
 * or every match when the content is not a virtual bundle with assets.
 */
export const matchesInRegion = <T extends RegExpMatchArray>(
  matches: T[],
  regions: BundleRegions | null,
  asset: boolean
): T[] =>
  regions
    ? matches.filter(match =>
        regions.allows(
          match.index ?? 0,
          (match.index ?? 0) + match[0].length,
          asset
        )
      )
    : matches;
