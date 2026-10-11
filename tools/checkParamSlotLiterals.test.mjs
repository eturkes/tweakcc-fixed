// `off-route` and `not-a-slot` are rulings on one site, but the allowlist is
// keyed by content: a literal ruled off-route where one host drops it must
// still be raised where another host renders it to the model. The site is the
// HOST prompt, never the builder's minified name, which changes every build and
// collides across modules.

import { describe, it, expect } from 'vitest';
import {
  findParamSlotLiterals,
  rowCovers,
  unreviewedSites,
} from './checkParamSlotLiterals.mjs';

const PROMPTS = [
  {
    id: 'tool-result-fixture-refused',
    pieces: ['The tool call was refused because ${', '}'],
  },
  {
    id: 'tool-result-fixture-rejected-edit',
    pieces: ['The edit was rejected by the hook: ${', '} (see the log)'],
  },
  {
    id: 'tool-result-fixture-rejected-write',
    pieces: ['The edit was rejected by the hook: ${', '}, retry'],
  },
];
const REASON = 'the path escapes the working directory tree';
const SRC =
  'function a(p){return `The tool call was refused because ${p}`}\n' +
  'function b(q){return `The edit was rejected by the hook: ${q} (see the log)`}\n' +
  `a(${JSON.stringify(REASON)});b(${JSON.stringify(REASON)});\n`;
// Same text, builders renamed and swapped the way a rebuild renames them.
const REBUILT =
  'function b(x){return `The tool call was refused because ${x}`}\n' +
  'function a(y){return `The edit was rejected by the hook: ${y} (see the log)`}\n' +
  `b(${JSON.stringify(REASON)});a(${JSON.stringify(REASON)});\n`;

describe('checkParamSlotLiterals: site verdicts cover only their host', () => {
  const findings = findParamSlotLiterals(SRC, PROMPTS);
  const [[key, finding]] = [...findings];
  const hostsOf = f =>
    unreviewedSites(f, {}).map(([, , s]) => s.hosts.join(','));

  it('resolves each site to the catalogued template it renders into', () => {
    expect(finding.text).toBe(REASON);
    expect(finding.sites.map(s => [s.builder, s.hosts])).toEqual([
      ['a', ['tool-result-fixture-refused']],
      // A shared head admits the template; its full shape picks the one host.
      ['b', ['tool-result-fixture-rejected-edit']],
    ]);
  });

  it('raises the other host again under an off-route or not-a-slot row', () => {
    for (const verdict of ['off-route', 'not-a-slot']) {
      const allow = {
        [key]: { verdict, promptId: 'tool-result-fixture-refused' },
      };
      expect(
        unreviewedSites(findings, allow).map(([, , s]) => s.builder)
      ).toEqual(['b']);
      allow[key].promptIds = ['tool-result-fixture-rejected-edit'];
      expect(unreviewedSites(findings, allow)).toEqual([]);
    }
  });

  it('keeps a site verdict across a rebuild that renames the builders', () => {
    const allow = {
      [key]: {
        verdict: 'off-route',
        promptId: 'tool-result-fixture-refused',
        builder: 'a',
        param: 'p',
      },
    };
    const rebuilt = findParamSlotLiterals(REBUILT, PROMPTS);
    expect(hostsOf(rebuilt).sort()).toEqual(
      [
        'tool-result-fixture-refused',
        'tool-result-fixture-rejected-edit',
      ].sort()
    );
    expect(
      unreviewedSites(rebuilt, allow).map(([, , s]) => s.hosts[0])
    ).toEqual(['tool-result-fixture-rejected-edit']);
  });

  it('lets a verdict on the text cover every site', () => {
    for (const verdict of ['catalogue', 'glue'])
      expect(unreviewedSites(findings, { [key]: { verdict } })).toEqual([]);
  });

  it('ignores builder names and needs a named host', () => {
    const site = { hosts: ['h'], builder: 'a', param: 'p' };
    expect(
      rowCovers({ verdict: 'off-route', builder: 'a', param: 'p' }, site)
    ).toBe(false);
    expect(rowCovers({ verdict: 'off-route', promptId: 'h' }, site)).toBe(true);
    expect(rowCovers({ note: 'REVIEW ME', promptId: 'h' }, site)).toBe(false);
  });
});
