// Locks the slot-literal gate against the three ways its first three cuts were
// wrong, all reproduced from the real CC 2.1.233 shapes:
//
//   1. Matching a template to a catalogued prompt by joining quasis and
//      comparing to joined `pieces`. Pieces split on the IDENTIFIER inside a
//      substitution, not on the substitution, so the two can never be equal and
//      the gate reported 0 on a bundle with a real finding.
//   2. Resolving a bare-identifier slot to EVERY declarator of that name in the
//      enclosing function. Minified code reuses one-letter names per block, so
//      unrelated text got attributed to the slot.
//   3. Rejecting the founding literal because its last word ends in a colon.

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  findSlotLiterals,
  isCandidateText,
  isReviewed,
  verdictConflicts,
} from './checkSlotLiterals.mjs';
import { keyVariants } from './probeCacheKey.mjs';

const CATALOGUE = {
  prompts: [
    {
      // The real 2.1.233 entry, trimmed to the shape that matters: four
      // substitutions, `identifiers` binding them to three named slots.
      id: 'system-reminder-team-coordination',
      identifiers: [0, 0, 1, 2],
      identifierMap: {
        0: 'TEAM_OBJECT',
        1: 'TASK_LIST_RESOURCE_LINE',
        2: 'TASK_LIST_COORDINATION_INSTRUCTIONS',
      },
      pieces: [
        '<system-reminder>\nTeam Coordination\n- Name: ${',
        '.agentName}\n- Team config: ${',
        '.teamConfigPath}${',
        '}\n\nRead the team config.${',
        '}\n</system-reminder>',
      ],
    },
  ],
};

const SOURCE = `
function render(e) {
  if (e.type === "other") {
    let n = e.flag ? " some unrelated block-scoped text here" : "";
    use(n);
  }
  if (e.type === "team_context") {
    let r = e.hasTaskListTools ?? probe(),
      n = r ? \`\\n- Task list: \${e.taskListPath}\` : "",
      o = r ? " Check the task list periodically and mark tasks resolved." : "";
    return send(\`<system-reminder>
Team Coordination
- Name: \${e.agentName}
- Team config: \${e.teamConfigPath}\${n}

Read the team config.\${o}
</system-reminder>\`);
  }
}
`;

describe('checkSlotLiterals: candidate text', () => {
  it('accepts the founding literal, whose last word ends in a colon', () => {
    // "\\n- Task list: " normalizes to "- Task list:"; a word test that counts
    // "list:" as a non-word leaves one word and rejects the whole finding.
    expect(isCandidateText('\n- Task list: ')).toBe(true);
  });

  it('rejects a bare joiner', () => {
    expect(isCandidateText(', ')).toBe(false);
    expect(isCandidateText(' — ')).toBe(false);
  });

  it('rejects a single word, however long', () => {
    expect(isCandidateText('  Configuration  ')).toBe(false);
  });

  it('rejects pure punctuation and markup', () => {
    expect(isCandidateText('```\n\n---\n')).toBe(false);
  });
});

describe('checkSlotLiterals: findings', () => {
  const findings = findSlotLiterals(SOURCE, CATALOGUE);

  it('matches a template to its prompt despite pieces splitting on the identifier', () => {
    expect(findings.length).toBeGreaterThan(0);
    expect(
      findings.every(f => f.promptId === 'system-reminder-team-coordination')
    ).toBe(true);
  });

  it('finds the uncatalogued task-list resource line', () => {
    const hit = findings.find(f => f.text.includes('Task list'));
    expect(hit).toBeDefined();
    expect(hit.resolvedVia).toBe('identifier n');
  });

  it('names the slot through `identifiers`, not the raw slot index', () => {
    // Slot 2 is the third substitution; identifiers[2] is 1, so the label is
    // TASK_LIST_RESOURCE_LINE. Reading identifierMap[2] directly would report
    // TASK_LIST_COORDINATION_INSTRUCTIONS — the mis-binding class.
    const hit = findings.find(f => f.text.includes('Task list'));
    expect(hit.slot).toBe(2);
    expect(hit.label).toBe('TASK_LIST_RESOURCE_LINE');
  });

  it('does not attribute a same-named declarator from another block', () => {
    // `n` is declared in both `if` bodies. Function-scoped resolution merges
    // them and pins the unrelated string onto this prompt.
    expect(findings.some(f => f.text.includes('unrelated block-scoped'))).toBe(
      false
    );
  });

  it('skips slot text that IS catalogued', () => {
    const withUpkeep = {
      prompts: [
        ...CATALOGUE.prompts,
        {
          id: 'system-reminder-team-coordination-task-list-upkeep',
          pieces: [
            ' Check the task list periodically and mark tasks resolved.',
          ],
          identifiers: [],
        },
      ],
    };
    const f = findSlotLiterals(SOURCE, withUpkeep);
    expect(f.some(x => x.text.includes('Task list'))).toBe(true);
    expect(f.some(x => x.text.includes('Check the task list'))).toBe(false);
  });

  it('reports one row per prompt and content, not per emission site', () => {
    const keys = findings.map(f => f.promptId + f.hash);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// CC 2.1.296: the first cut matched a template to a prompt on its leading text
// alone, so every `Warning: ${…}` template in the bundle was read as a site of
// the one prompt opening "Warning: ", and prompts opening with a substitution
// were never matched at all.
describe('checkSlotLiterals: a template is a site only when its shape matches', () => {
  const catalogue = {
    prompts: [
      {
        id: 'tool-result-workflow-warning',
        identifiers: [0],
        identifierMap: { 0: 'WORKFLOW' },
        pieces: ['Warning: ${', '.warning}\n'],
      },
      {
        id: 'tool-result-leading-slot',
        identifiers: [0, 1],
        identifierMap: { 0: 'SUBJECT', 1: 'REASON' },
        pieces: ['${', '.name} was refused: ${', '}'],
      },
    ],
  };
  const source = `
function a(h){let m=h?"Claude in Chrome is disabled by your organization":"other text here";log(\`Warning: \${m}\`)}
function b(w){return \`Warning: \${w.warning}\n\`}
function c(e){let r=e?"the session is not in auto mode":"the request was empty";return \`\${e.name} was refused: \${r}\`}
`;
  const findings = findSlotLiterals(source, catalogue);

  it('does not attribute a template that only shares the leading text', () => {
    expect(findings.some(f => f.text.includes('Claude in Chrome'))).toBe(false);
  });

  it('matches a prompt that opens with a substitution', () => {
    const hit = findings.find(f => f.text.includes('not in auto mode'));
    expect(hit?.promptId).toBe('tool-result-leading-slot');
    expect(hit?.label).toBe('REASON');
  });

  it('labels a slot by its identifier occurrence, not its substitution index', () => {
    // `${f(a,b)}` holds three slot identifiers, so the second substitution is
    // the fourth occurrence: identifiers[3], where identifiers[1] names `a`.
    const cat = {
      prompts: [
        {
          id: 'tool-result-two-in-one',
          identifiers: [0, 1, 2, 3],
          identifierMap: { 0: 'FORMAT', 1: 'DONE', 2: 'TOTAL', 3: 'REASON' },
          pieces: ['Stopped after ${', '(', ',', ')} steps because ${', '}'],
        },
      ],
    };
    const src =
      'function g(f,a,b,x){let r=x?"the user interrupted the run":"no step was left";return `Stopped after ${f(a,b)} steps because ${r}`}';
    const hit = findSlotLiterals(src, cat).find(f =>
      f.text.includes('interrupted')
    );
    expect(hit?.slot).toBe(1);
    expect(hit?.label).toBe('REASON');
  });
});

// The extractor's pieces decode a printable escape but keep a control-character
// escape raw, so a literal holding one of each is stored in a fourth form: not
// cooked, not raw, not fully decoded. Comparing only those three reported an
// already-catalogued literal as a finding.
describe('checkSlotLiterals: the extractor piece form counts as catalogued', () => {
  const host = {
    id: 'tool-result-fixture-refused',
    identifiers: [0, 1],
    identifierMap: { 0: 'SUBJECT', 1: 'REASON' },
    pieces: ['${', '.name} was refused: ${', '}'],
  };
  const source =
    'function c(e,x){let r=x?"Stop here\\u0008 and wait \\u2014 then retry later":"";return `${e.name} was refused: ${r}`}\n';

  it('reports the literal while it is uncatalogued', () => {
    const f = findSlotLiterals(source, { prompts: [host] });
    expect(f.map(x => x.label)).toEqual(['REASON']);
  });

  it('skips it once a prompt holds it in piece form', () => {
    const catalogue = {
      prompts: [
        host,
        {
          id: 'tool-result-fixture-stop',
          pieces: ['Stop here\\u0008 and wait — then retry later'],
          identifiers: [],
        },
      ],
    };
    expect(findSlotLiterals(source, catalogue)).toEqual([]);
  });
});

// CC 2.1.296: nine slot literals were catalogued here while the classification
// cache ruled the same text ui or internal; the catalogue followed this file.
const sha16 = s =>
  crypto
    .createHash('sha256')
    .update(s.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16);
const cacheKey = s => keyVariants(s)[0].key;

describe('checkSlotLiterals: verdict conflicts with the classification cache', () => {
  const text = 'Remote Control is off for this account.';
  const catalogue = {
    prompts: [
      { id: 'tool-result-fixture-off', pieces: [text], identifiers: [] },
    ],
  };
  const key = cacheKey(text);
  const allow = {
    [sha16(text)]: { verdict: 'catalogue', id: 'tool-result-fixture-off' },
  };

  it('reports a catalogued literal the cache rules ui', () => {
    const c = verdictConflicts(allow, catalogue, { [key]: { facing: 'ui' } });
    expect(
      c.filter(x => x.kind === 'host').map(x => [x.id, x.cacheFacing])
    ).toEqual([['tool-result-fixture-off', 'ui']]);
  });

  it('accepts agreement, a glue verdict, or no cache verdict', () => {
    expect(
      verdictConflicts(allow, catalogue, { [key]: { facing: 'model' } })
    ).toEqual([]);
    expect(
      verdictConflicts(
        {
          [sha16(text)]: { verdict: 'glue', id: 'tool-result-fixture-off' },
        },
        catalogue,
        { [key]: { facing: 'ui' } }
      )
    ).toEqual([]);
    expect(verdictConflicts(allow, catalogue, {})).toEqual([]);
  });

  // The extractor gives one id to every capture of a literal and renames the
  // extra ones `-2`, `-3`…; a carried-over id survives the naming pass. Hosts
  // looked up by the row's id missed all of them (13 on 2.1.296).
  it('finds hosts by content, whatever id they carry', () => {
    const cat = {
      prompts: [
        { id: 'tool-result-fixture-off-2', pieces: [text], identifiers: [] },
      ],
    };
    const c = verdictConflicts(allow, cat, { [key]: { facing: 'ui' } });
    expect(c.map(x => [x.kind, x.host])).toContainEqual([
      'host',
      'tool-result-fixture-off-2',
    ]);
    const noId = { [sha16(text)]: { verdict: 'catalogue' } };
    expect(
      verdictConflicts(noId, cat, { [key]: { facing: 'internal' } }).map(
        x => x.kind
      )
    ).toContain('host');
  });

  it('checks a template host captured through one of its quasis', () => {
    const quasi = ' was refused by the sandbox policy.';
    const cat = {
      prompts: [
        {
          id: 'tool-result-fixture-refused',
          pieces: ['${', '.path}' + quasi],
          identifiers: [0],
          identifierMap: { 0: 'FILE' },
        },
      ],
    };
    const body = '${.path}' + quasi;
    const c = verdictConflicts(
      { [sha16(quasi)]: { verdict: 'catalogue', id: 'x-fixture' } },
      cat,
      { [cacheKey(body)]: { facing: 'ui' } }
    );
    expect(c.map(x => [x.kind, x.host, x.cacheFacing])).toEqual([
      ['host', 'tool-result-fixture-refused', 'ui'],
    ]);
  });

  // A `catalogue` verdict for "\n- Task list: " captures the template
  // "\n- Task list: ${.taskListPath}"; a cache ruling on the literal itself is
  // the contradiction, and the host body never carries it.
  it('checks the literal itself, in raw and cooked form', () => {
    const cat = {
      prompts: [
        {
          id: 'system-reminder-fixture-task-list',
          pieces: ['\\n- Task list: ${', '.taskListPath}'],
          identifiers: [0],
          identifierMap: { 0: 'CTX' },
        },
      ],
    };
    const allowT = {
      [sha16('\n- Task list: ')]: {
        verdict: 'catalogue',
        id: 'system-reminder-fixture-task-list',
        text: '\n- Task list: ',
      },
    };
    for (const form of ['\n- Task list: ', '\\n- Task list: ']) {
      const c = verdictConflicts(allowT, cat, {
        [cacheKey(form)]: { facing: 'ui' },
      });
      expect(c.map(x => [x.kind, x.text])).toEqual([['literal', form]]);
    }
  });

  // The extractor binds the FIRST hit in its lookup order; a later alias saying
  // model does not make the bound ui verdict agree.
  it('compares the verdict the extractor binds, and flags split aliases', () => {
    const body = 'Read ${[Ye]} before you edit the file.';
    const cat = {
      prompts: [
        {
          id: 'tool-result-fixture-read',
          pieces: ['Read ${[', 'Ye]} before you edit the file.'],
          identifiers: [0],
          identifierMap: { 0: 'X' },
        },
      ],
    };
    const [raw, norm] = keyVariants(body);
    expect(norm.variant).toBe('bracket-index');
    const allowR = { [sha16(body)]: { verdict: 'catalogue', id: 'r' } };
    const c = verdictConflicts(allowR, cat, {
      [raw.key]: { facing: 'ui' },
      [norm.key]: { facing: 'model' },
    });
    expect(c.map(x => x.kind).sort()).toEqual(
      ['alias', 'alias', 'host', 'literal'].sort()
    );
    const flipped = verdictConflicts(allowR, cat, {
      [raw.key]: { facing: 'model' },
      [norm.key]: { facing: 'ui' },
    });
    expect([...new Set(flipped.map(x => x.kind))]).toEqual(['alias']);
  });
});

// off-route and not-a-slot are rulings on one host; content-keyed rows must not
// silence the same literal rendering into another host.
describe('checkSlotLiterals: site-specific verdicts cover only their host', () => {
  const f = { hash: 'h', promptId: 'slash-command-a' };
  const g = { hash: 'h', promptId: 'tool-result-b' };
  it('covers the named host only', () => {
    for (const verdict of ['off-route', 'not-a-slot']) {
      const allow = { h: { verdict, promptId: 'slash-command-a' } };
      expect(isReviewed(allow, f)).toBe(true);
      expect(isReviewed(allow, g)).toBe(false);
      expect(
        isReviewed(
          {
            h: {
              verdict,
              promptId: 'slash-command-a',
              promptIds: ['tool-result-b'],
            },
          },
          g
        )
      ).toBe(true);
      expect(isReviewed({ h: { verdict } }, f)).toBe(false);
    }
  });
  it('lets a text verdict cover every host', () => {
    for (const verdict of ['catalogue', 'glue'])
      expect(
        isReviewed({ h: { verdict, promptId: 'slash-command-a' } }, g)
      ).toBe(true);
    expect(isReviewed({ h: { note: 'REVIEW ME' } }, g)).toBe(false);
  });
});
