// A slot expression whose first identifier sits behind a literal, such as an
// object literal indexed by a variable, has that identifier promoted to a slot.
// Without promotion the minified index stays in the piece text, pinned to one
// platform's build.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sites = require('./lib/bundleSites.cjs');
const ex = require('./promptExtractor.js');
const parser = require('@babel/parser');

const shapeOf = src => {
  const ast = parser.parse(src);
  const node = ast.program.body[0].expression.right;
  return sites.templateShape(node, src);
};

afterEach(() => vi.restoreAllMocks());

describe('slot promotion in templateShape', () => {
  it('makes the index of an indexed object literal a slot', () => {
    const shape = shapeOf(
      'x=`${{here:"Pass `path` here",none:"Pass `content`"}[e]} then write.`'
    );
    expect(shape.pieces).toEqual([
      '${{here:"Pass `path` here",none:"Pass `content`"}[',
      ']} then write.',
    ]);
    expect(shape.identifiers).toEqual([0]);
    expect(shape.legacyShapes).toEqual([
      {
        pieces: [
          '${{here:"Pass `path` here",none:"Pass `content`"}[e]} then write.',
        ],
        identifiers: [],
        occurrences: [],
      },
    ]);
  });

  it('promotes ahead of a later slot and keeps the legacy alignment', () => {
    const shape = shapeOf(
      'x=`Check (${c}) ${{asked:"asked",stderr:"failed"}[n]}: ${r}`'
    );
    expect(shape.pieces).toEqual([
      'Check (${',
      '}) ${{asked:"asked",stderr:"failed"}[',
      ']}: ${',
      '}',
    ]);
    expect(shape.identifiers).toEqual([0, 1, 2]);
    expect(shape.legacyShapes[0].identifiers).toEqual([0, 1]);
    expect(shape.legacyShapes[0].occurrences).toEqual([0, 2]);
  });

  it('promotes bare object values and computed keys ahead of the index', () => {
    const shape = shapeOf('x=`${{a:v,[k]:"w"}[i]} tail`');
    expect(shape.pieces).toEqual(['${{a:', ',[', ']:"w"}[', ']} tail']);
    expect(shape.identifiers).toEqual([0, 1, 2]);
  });

  it('promotes identifiers after the first capture too', () => {
    // `o` and `y` are captured; `k` and `j` follow them. Left in the pieces,
    // they would pin this build's names in the cache key and the write-back.
    const shape = shapeOf('x=`pick ${o[k]} and ${{a:`t ${y}`}[j]} end`');
    expect(shape.pieces).toEqual([
      'pick ${',
      '[',
      ']} and ${{a:`t ${',
      '}`}[',
      ']} end',
    ]);
    expect(shape.identifiers).toEqual([0, 1, 2, 3]);
    expect(shape.legacyShapes).toEqual([
      {
        pieces: ['pick ${', '[k]} and ${{a:`t ${', '}`}[j]} end'],
        identifiers: [0, 1],
        occurrences: [0, 2],
      },
    ]);
  });

  it('promotes object values and spreads that follow a call', () => {
    const shape = shapeOf(
      'x=`${f.line(s.file,{edits:s.edits,...c.copy!==void 0&&{copy:c.copy}})} end`'
    );
    expect(shape.pieces.join('')).toBe(
      '${.line(.file,{edits:.edits,....copy!==void 0&&{copy:.copy}})} end'
    );
    expect(shape.identifiers).toEqual([0, 1, 1, 2, 2]);
  });

  it('does not make a destructuring key a slot', () => {
    const shape = shapeOf(
      'x=`${e.g.map(({group:a,calls:p})=>({group:a,calls:p}))} end`'
    );
    expect(shape.pieces).toEqual([
      '${',
      '.g.map(({group:',
      ',calls:',
      '})=>({group:',
      ',calls:',
      '}))} end',
    ]);
    expect(shape.identifiers).toEqual([0, 1, 2, 1, 2]);
    // The earlier shape captured both keys; they map to no slot now.
    expect(shape.legacyShapes).toHaveLength(1);
    expect(shape.legacyShapes[0].identifiers).toEqual([0, 1, 2, 3, 4]);
    expect(shape.legacyShapes[0].occurrences).toEqual([0, -1, 1, -1, 2]);
  });

  it('keeps a shorthand property literal', () => {
    const shape = shapeOf('x=`${{e}.e} end`');
    expect(shape.pieces).toEqual(['${{e}.e} end']);
    expect(shape.identifiers).toEqual([]);
  });

  it('does not promote property names or string contents', () => {
    const shape = shapeOf('x=`${{k:"v"}.k} ${{m:"n"}["m"]} end`');
    expect(shape.identifiers).toEqual([]);
    expect(shape.legacyShapes).toBeUndefined();
  });
});

describe('carryover across slot promotion', () => {
  const legacyPieces = [
    'Install done (user: ${{none:"not provisioned",ok:"provisioned"}[n]}, filters: ${',
    '.wfp.state}). Run it again to retry.',
  ];
  const oldItem = {
    id: 'tool-result-fixture-objlit-install-status',
    name: 'Tool Result: fixture objlit install status',
    description: 'fixture',
    pieces: legacyPieces,
    identifiers: [0],
    identifierMap: { 0: 'INSTALL_RESULT' },
    version: '2.1.200',
  };
  const newItem = {
    name: '',
    id: '',
    description: '',
    pieces: [
      'Install done (user: ${{none:"not provisioned",ok:"provisioned"}[',
      ']}, filters: ${',
      '.wfp.state}). Run it again to retry.',
    ],
    identifiers: [0, 1],
    identifierMap: { 0: '', 1: '' },
    legacyShapes: [
      { pieces: legacyPieces, identifiers: [0], occurrences: [1] },
    ],
  };

  it('moves each carried name to the slot it named', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { prompts } = ex.mergeWithExisting(
      { prompts: [newItem] },
      { prompts: [oldItem] },
      '2.1.300'
    );
    expect(prompts[0].id).toBe(oldItem.id);
    expect(prompts[0].identifierMap).toEqual({ 1: 'INSTALL_RESULT' });
    // The pristine body changed form, so the override is flagged for review.
    expect(prompts[0].version).toBe('2.1.300');
    ex.fillSlotNames(prompts[0]);
    expect(prompts[0].identifierMap).toEqual({
      0: 'TOOL_RESULT_FIXTURE_OBJLIT_INSTALL_STATUS_VAR_1',
      1: 'INSTALL_RESULT',
    });
  });

  it('names unpromoted slots from their pre-promotion labels', () => {
    const p = {
      ...newItem,
      id: 'tool-result-fixture-objlit-fresh',
      identifierMap: { 0: '', 1: '' },
    };
    ex.fillSlotNames(p);
    expect(p.identifierMap).toEqual({
      0: 'TOOL_RESULT_FIXTURE_OBJLIT_FRESH_VAR_1',
      1: 'TOOL_RESULT_FIXTURE_OBJLIT_FRESH_VAR_0',
    });
  });

  it('drops the names of keys that stopped being slots', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const legacy = {
      pieces: ['Usage ${', '.map(({', ':', '})=>', ')} end'],
      identifiers: [0, 1, 2, 2],
      occurrences: [0, -1, 1, 2],
    };
    const old = {
      id: 'skill-fixture-usage',
      name: 'Skill: fixture usage',
      description: 'fixture',
      pieces: legacy.pieces,
      identifiers: legacy.identifiers,
      identifierMap: { 0: 'GROUPS', 1: 'KEY_NAME', 2: 'GROUP' },
      version: '2.1.200',
    };
    const fresh = {
      name: '',
      id: '',
      description: '',
      pieces: ['Usage ${', '.map(({group:', '})=>', ')} end'],
      identifiers: [0, 1, 1],
      identifierMap: { 0: '', 1: '' },
      legacyShapes: [legacy],
    };
    const { prompts } = ex.mergeWithExisting(
      { prompts: [fresh] },
      { prompts: [old] },
      '2.1.300'
    );
    expect(prompts[0].id).toBe(old.id);
    expect(prompts[0].identifierMap).toEqual({ 0: 'GROUPS', 1: 'GROUP' });
  });

  it('carries a map already in the promoted shape unchanged', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const current = {
      ...oldItem,
      pieces: newItem.pieces,
      identifiers: [0, 1],
      identifierMap: { 0: 'STATUS_KEY', 1: 'INSTALL_RESULT' },
    };
    const { prompts } = ex.mergeWithExisting(
      { prompts: [newItem] },
      { prompts: [current] },
      '2.1.300'
    );
    expect(prompts[0].identifierMap).toEqual(current.identifierMap);
    expect(prompts[0].version).toBe(oldItem.version);
  });
});

describe('upstream identifierMap adoption across slot promotion', () => {
  // Upstream's extractor does not promote, so its map is in the legacy shape.
  const legacyPieces = ['If a ${', '} is armed, ${', '({a:t})} then ${', '}.'];
  const p = () => ({
    id: 'system-prompt-fixture-heartbeat',
    pieces: ['If a ${', '} is armed, ${', '({a:', '})} then ${', '}.'],
    identifiers: [0, 1, 2, 3],
    identifierMap: { 0: 'MONITOR', 1: 'FN', 2: 'FIXTURE_VAR_3', 3: 'STOP' },
    legacyShapes: [
      { pieces: legacyPieces, identifiers: [0, 1, 2], occurrences: [0, 1, 3] },
    ],
  });
  const upstream = {
    pieces: legacyPieces,
    identifiers: [0, 1, 2],
    identifierMap: { 0: 'MONITOR_TOOL_NAME', 1: 'STATUS_FN', 2: 'STOP_TOOL' },
  };

  it('moves upstream names onto the slots they named', () => {
    const q = p();
    expect(ex.adoptUpstreamIdentifierMap(q, upstream)).toBe(true);
    expect(q.identifierMap).toEqual({
      0: 'MONITOR_TOOL_NAME',
      1: 'STATUS_FN',
      2: 'FIXTURE_VAR_3',
      3: 'STOP_TOOL',
    });
  });

  it('takes the map whole when the shapes already agree', () => {
    const q = {
      ...p(),
      pieces: legacyPieces,
      identifiers: [0, 1, 2],
      legacyShapes: undefined,
    };
    expect(ex.adoptUpstreamIdentifierMap(q, upstream)).toBe(true);
    expect(q.identifierMap).toEqual(upstream.identifierMap);
  });

  it('leaves a prompt whose layout matches neither shape alone', () => {
    const q = p();
    const before = { ...q.identifierMap };
    const other = {
      pieces: ['Something ${', '} else ${', '}'],
      identifiers: [0, 1],
      identifierMap: { 0: 'A', 1: 'B' },
    };
    expect(ex.adoptUpstreamIdentifierMap(q, other)).toBe(false);
    expect(q.identifierMap).toEqual(before);
  });
});

// A catalogue entry's labels mean nothing outside the shape its extractor cut:
// dropping a destructuring key and promoting a later name leaves the
// `identifiers` array unchanged over different slots, and the 'main' shape
// (666d0545's leading promotion) is the one catalogues 2.1.294 to 2.1.296 hold.
describe('slot identity across extractor shapes', () => {
  const itemFrom = src => {
    const shape = shapeOf(src);
    delete shape.labels;
    return {
      name: '',
      id: '',
      description: '',
      ...shape,
      identifierMap: Object.fromEntries(
        [...new Set(shape.identifiers)].map(l => [l, ''])
      ),
    };
  };
  const merge = (fresh, old) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return ex.mergeWithExisting(
      { prompts: [fresh] },
      { prompts: [old] },
      '2.1.300'
    ).prompts[0];
  };
  const LONG =
    'Fixture opening sentence that runs well past the fuzzy fingerprint so the carry is decided by the text after it: ';

  it('does not rebind names across equal identifiers arrays over other slots', () => {
    const got = merge(itemFrom('x=`Usage ${xs.map(({key:v})=>({a:w}))} end`'), {
      id: 'skill-fixture-usage-rebind',
      name: 'Skill: fixture usage rebind',
      description: 'fixture',
      pieces: ['Usage ${', '.map(({', ':', '})=>({a:w}))} end'],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'LIST', 1: 'PROPERTY_KEY', 2: 'VALUE' },
      version: '2.1.200',
    });
    expect(got.id).toBe('skill-fixture-usage-rebind');
    expect(got.identifierMap).toEqual({ 0: 'LIST', 1: 'VALUE' });
  });

  it('adopts upstream names slot by slot when the arrays are equal but the slots are not', () => {
    const q = {
      ...itemFrom('x=`Run ${f(({k:y})=>1)[p]} now.`'),
      id: 'tool-result-fixture-run',
    };
    expect(q.identifiers).toEqual([0, 1, 2]);
    const u = {
      pieces: ['Run ${', '(({', ':', '})=>1)[p]} now.'],
      identifiers: [0, 1, 2],
      identifierMap: { 0: 'F', 1: 'K', 2: 'Y' },
    };
    expect(ex.adoptUpstreamIdentifierMap(q, u)).toBe(true);
    expect(q.identifierMap).toEqual({ 0: 'F', 1: 'Y' });
  });

  it("carries a catalogue cut in main's shape by its slots", () => {
    const got = merge(itemFrom('x=`${{a:p}[q]} ${fn({x:r})} ${s}`'), {
      id: 'tool-result-fixture-main-shape',
      name: 'Tool Result: fixture main shape',
      description: 'fixture',
      pieces: ['${{a:', '}[', ']} ${', '({x:r})} ${', '}'],
      identifiers: [0, 1, 2, 3],
      identifierMap: { 0: 'P', 1: 'Q', 2: 'FN', 3: 'S' },
      version: '2.1.200',
    });
    expect(got.id).toBe('tool-result-fixture-main-shape');
    expect(got.identifierMap).toEqual({ 0: 'P', 1: 'Q', 2: 'FN', 4: 'S' });
  });

  it('fuzzy-carries a main-shape catalogue by its slots, not its labels', () => {
    const got = merge(
      itemFrom('x=`' + LONG + '${{a:p}[q]} ${fn({x:r})} ${s} tail now`'),
      {
        id: 'tool-result-fixture-main-shape-edited',
        name: 'Tool Result: fixture main shape edited',
        description: 'fixture',
        pieces: [LONG + '${{a:', '}[', ']} ${', '({x:r})} ${', '} tail before'],
        identifiers: [0, 1, 2, 3],
        identifierMap: { 0: 'P', 1: 'Q', 2: 'FN', 3: 'S' },
        version: '2.1.200',
      }
    );
    expect(got.id).toBe('tool-result-fixture-main-shape-edited');
    expect(got.identifierMap).toEqual({ 0: 'P', 1: 'Q', 2: 'FN', 4: 'S' });
  });

  it('fuzzy-carries past a slot an edit inserted ahead of the others', () => {
    const got = merge(
      itemFrom('x=`' + LONG + 'Hi ${z}. Hello ${a} and ${b} bye`'),
      {
        id: 'tool-result-fixture-inserted-slot',
        name: 'Tool Result: fixture inserted slot',
        description: 'fixture',
        pieces: [LONG + 'Hello ${', '} and ${', '} bye'],
        identifiers: [0, 1],
        identifierMap: { 0: 'A', 1: 'B' },
        version: '2.1.200',
      }
    );
    expect(got.id).toBe('tool-result-fixture-inserted-slot');
    expect(got.identifierMap).toEqual({ 1: 'A', 2: 'B' });
  });
});

// 2.8.40 shipped tool-description-projects with one slot, the memory flag, as
// VAR_0. Promoting the upload-mode index ahead of it must not take that name.
describe('the shipped tool-description-projects names', () => {
  it('keeps VAR_0 on the memory flag and gives the index VAR_1', () => {
    const file = path.join(
      import.meta.dirname,
      '..',
      'data',
      'prompts',
      'prompts-2.1.294.json'
    );
    const p = JSON.parse(fs.readFileSync(file, 'utf8')).prompts.find(
      x => x.id === 'tool-description-projects'
    );
    const nameAfter = tail => {
      const i = p.pieces.findIndex(s => s.endsWith(tail));
      expect(i).toBeGreaterThanOrEqual(0);
      return p.identifierMap[p.identifiers[i]];
    };
    expect(nameAfter('even for a file you have."}[')).toBe(
      'TOOL_DESCRIPTION_PROJECTS_VAR_1'
    );
    expect(nameAfter('remove them from the project in claude.ai.\n${')).toBe(
      'TOOL_DESCRIPTION_PROJECTS_VAR_0'
    );
  });
});
