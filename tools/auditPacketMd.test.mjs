// Helpers behind the stage-1 markdown packet: the LCC rule extraction, claim
// splitting, carrier excerpts, fragment boundaries and line wrapping.

import { describe, it, expect } from 'vitest';
import {
  extractLccRules,
  splitClaims,
  carrierExcerpt,
  compactDiff,
  wrapLong,
  fence,
  cmpVersion,
  bindingBefore,
  FULL_BODY_MAX,
} from './lib/auditPacketMd.mjs';
import { crossesSentence } from './lib/concatNeighbours.mjs';
import { sameToolFamily } from './lib/auditCorpus.mjs';

describe('LCC rule extraction', () => {
  const doc = [
    '# Top',
    '### The decision rule (read this every time)',
    'one',
    '### Middle',
    'two',
    '~~~',
    '## inside a fence',
    '~~~',
    '### Test for every cut',
    'three',
    '#### a sub-heading stays',
    'four',
    '### Next section',
    'gone',
  ].join('\n');

  it('runs from the decision rule through the end of "Test for every cut"', () => {
    const r = extractLccRules(doc);
    expect(r.startsWith('### The decision rule')).toBe(true);
    expect(r).toContain('## inside a fence');
    expect(r).toContain('four');
    expect(r).not.toContain('gone');
  });

  it('throws when either heading is missing', () => {
    expect(() => extractLccRules('# x\n### Test for every cut\n')).toThrow(
      /decision-rule sections/
    );
    expect(() => extractLccRules('### The decision rule\nx\n')).toThrow(
      /decision-rule sections/
    );
  });
});

describe('claims', () => {
  it('splits at sentences and slots, drops list markers and short scraps', () => {
    expect(
      splitClaims(
        '- Use jq for JSON files. Then stop it now.\n${X_VAR} is the path to the file\nok.'
      )
    ).toEqual([
      'Use jq for JSON files.',
      'Then stop it now.',
      'is the path to the file',
    ]);
  });
});

describe('carrier excerpts', () => {
  it('keeps a short body whole', () => {
    expect(carrierExcerpt('Short body.', ['x'])).toEqual({
      text: 'Short body.',
      full: true,
    });
  });

  it('keeps the matching sentence with one sentence either side', () => {
    const filler = n =>
      Array.from(
        { length: n },
        (_, i) => `Filler sentence number ${i} here.`
      ).join(' ');
    const body = `${filler(15)} Before the match. The version token goes in if_version. After the match. ${filler(15)}`;
    expect(body.length).toBeGreaterThan(FULL_BODY_MAX);
    const r = carrierExcerpt(body, ['The version token goes in if_version.']);
    expect(r.full).toBe(false);
    expect(r.text).toBe(
      '… Before the match. The version token goes in if_version. After the match. …'
    );
  });
});

describe('fragment boundaries', () => {
  it('crosses only when the left text does not end a sentence', () => {
    expect(crossesSentence('Err on the side of not ', 'suggesting it.')).toBe(
      true
    );
    expect(crossesSentence('Done. ', 'Next one.')).toBe(false);
    expect(crossesSentence('A list:\n', '- item')).toBe(false);
    expect(crossesSentence('text', null)).toBe(null);
  });
});

describe('same-tool family', () => {
  it('matches a tool result to its own tool description or schema', () => {
    expect(
      sameToolFamily(
        'tool-result-memory-version-token-hint',
        'tool-description-memory-version-token-requirement'
      )
    ).toBe('memory');
    expect(
      sameToolFamily(
        'tool-result-send-message-teammate-x',
        'tool-description-sendmessagetool'
      )
    ).toBe('sendmessage');
    expect(sameToolFamily('tool-result-bash-x', 'tool-result-bash-y')).toBe(
      null
    );
    expect(sameToolFamily('tool-result-bash-x', 'tool-description-read')).toBe(
      null
    );
  });
});

describe('rendering helpers', () => {
  it('diffs a small change compactly and gives up on a rewrite', () => {
    expect(compactDiff('Use jq now.', 'Use yq now.')).toBe(
      'Use [-jq-]{+yq+} now.'
    );
    expect(compactDiff('alpha beta', 'gamma delta epsilon')).toBe(null);
  });

  it('wraps only over-long lines, at a space', () => {
    const line = 'word '.repeat(50).trim();
    const w = wrapLong(line, 60);
    expect(w.split('\n').every(l => l.length <= 60)).toBe(true);
    expect(w.replace(/\n/g, ' ')).toBe(line);
    expect(wrapLong('short\nlines', 60)).toBe('short\nlines');
  });

  it('picks a fence the content does not contain', () => {
    expect(fence('a ~~~ b')).toBe('~~~~text\na ~~~ b\n~~~~');
  });

  it('orders versions numerically and finds a literal binding', () => {
    expect(cmpVersion('2.1.99', '2.1.288')).toBeLessThan(0);
    expect(cmpVersion('2.1.288', '2.1.288')).toBe(0);
    const src = 'x,AKn=` (pass as if_version)`';
    expect(bindingBefore(src, src.indexOf(' (pass'))).toEqual({
      name: 'AKn',
      kind: 'binding',
    });
    const obj = '{cause:`its location`';
    expect(bindingBefore(obj, obj.indexOf('its'))).toEqual({
      name: 'cause',
      kind: 'property',
    });
  });
});
