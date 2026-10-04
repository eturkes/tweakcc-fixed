// The stage-1 cut hunt: deterministic selection, packet assembly, the merge
// rule (a hunter's cut counts only when it passes the checker and holds
// against the merged result), and the workflow's path-only contract.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickHunt, splitStageMd, familyOf, renderHuntMd } from './selectCutHunt.mjs';
import { mergeHunt } from './harvestCutHunt.mjs';
import { leadScore } from './lib/cutLeads.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = path.resolve(HERE, '../.claude/workflows');
const FILE = path.join(WF, 'audit-stage1-cut-hunt.workflow.js');

describe('selection', () => {
  it('ranks by score, caps a share of the keeps and a family, skips ids without a lead', () => {
    const rows = [
      ...['a', 'b', 'c', 'd'].map((x, i) => ({ id: `tool-result-plugin-switch-${x}`, score: 5 - i * 0.1 })),
      { id: 'tool-result-memory-version-hint', score: 4 },
      { id: 'system-prompt-x-y-z', score: 1 },
      ...Array.from({ length: 14 }, (_, i) => ({ id: `system-reminder-none-${i}-x`, score: 0 })),
    ];
    const { cap, picked } = pickHunt(rows, { share: 0.25, familyCap: 3 });
    expect(cap).toBe(5);
    const ids = picked.map(r => r.id);
    expect(ids.filter(i => familyOf(i) === 'tool-result-plugin-switch')).toHaveLength(3);
    expect(ids).toContain('tool-result-memory-version-hint');
    expect(ids).toContain('system-prompt-x-y-z');
    expect(ids.some(i => i.startsWith('system-reminder-none'))).toBe(false);
  });

  it('counts a carrier named by two kinds of evidence above a lone lead', () => {
    const lone = leadScore([{ kind: 'restated', carrier: 'a', weight: 3 }]);
    const twice = leadScore([{ kind: 'restated', carrier: 'a', weight: 3 }, { kind: 'near-body', carrier: 'a', weight: 1 }]);
    expect(twice).toBeGreaterThan(lone);
    expect(leadScore([])).toBe(0);
  });
});

describe('packet assembly', () => {
  const md = [
    '# Stage-1 audit packet g01 — Claude Code 9.9.9 (2 ids)', '', '## Commands', 'x', '',
    '## How to read it', '- rules', '', '## LCC decision rule (verbatim)', 'the rule', '',
    '# Assigned ids (2)', '', '## 1/2 `id-a`', 'body a cites `carrier-x`', '', '## 2/2 `id-b`', 'body b', '',
    '# Carriers (2, each once)', '', '### `carrier-x`', 'text x', '', '### `carrier-y`', 'text y', '',
  ].join('\n');

  it('splits a stage-1 markdown packet into the shared rules, per-id sections and carriers', () => {
    const s = splitStageMd(md);
    expect(s.common).toContain('## How to read it');
    expect(s.common).toContain('the rule');
    expect(s.sections.get('id-a')).toContain('cites `carrier-x`');
    expect(s.sections.get('id-b')).toBe('body b');
    expect([...s.carriers.keys()]).toEqual(['carrier-x', 'carrier-y']);
  });

  it('renders the hunt brief with stage 1 reasoning, leads and only the carriers it needs', () => {
    const s = splitStageMd(md);
    const out = renderHuntMd({
      group: 'h00', version: '9.9.9', ids: ['id-a'],
      stage1: new Map([['id-a', { why: 'unique', duplicateCheck: 'none', slopCheck: 'clean' }]]),
      leadsById: new Map([['id-a', [{ kind: 'restated', carrier: 'carrier-x', rel: 'carrier-conditional', share: 1 }]]]),
      parts: { common: s.common, sections: new Map([['id-a', s.sections.get('id-a')]]), carriers: new Map([['carrier-x', 'text x']]) },
      commands: { query: 'Q', search: 'S', write: 'W', queries: '/h/search-00.json' },
      extraCarriers: new Map([['lead-z', 'live · text z']]),
    });
    expect(out).toContain('STRONGEST LEGITIMATE cut');
    expect(out).toContain('Stage 1 ruled pristine-keep.** why: unique');
    expect(out).toContain('restated → `carrier-x` (carrier-conditional, restates 100% of the claims)');
    expect(out).toContain('### `carrier-x`');
    expect(out).toContain('### `lead-z`');
    expect(out).not.toContain('carrier-y');
  });
});

describe('merge', () => {
  const keep = id => ({ id, verdict: 'pristine-keep', slopCheck: 's', duplicateCheck: 'd', why: 'w', coveredBy: [], trimPlan: null });
  const wipe = (id, carrierId) => ({ id, verdict: 'wipe-merge', slopCheck: 's', duplicateCheck: 'd', why: 'w', coveredBy: [{ carrierId, quote: 'q' }], trimPlan: null });
  const trim = id => ({ id, verdict: 'trim', slopCheck: 's', duplicateCheck: 'd', why: 'w', coveredBy: [], trimPlan: 'cut the second sentence' });
  const packet = (group, ids, extra = {}) => ({ group, prompts: ids.map(id => ({ id, ...(extra[id] || {}) })) });
  // A stub checker: errors are given per id.
  const stub = errorsById => ({ packet, verdictsText }) => {
    const verdicts = JSON.parse(verdictsText).verdicts;
    const errors = verdicts.flatMap(v => (errorsById[v.id] || []).map(e => `${v.id}: ${e}`));
    return { ok: !errors.length, errors, warnings: [], verdicts, group: packet.group };
  };
  const stage1 = ['a', 'b', 'c', 'd', 'e'].map(keep);

  it('adopts a passing cut, keeps stage 1 for a failing one and for a hunter keep', () => {
    const groups = [{ packet: packet('h00', ['a', 'b', 'c']), verdictsText: JSON.stringify({ verdicts: [wipe('a', 'x'), trim('b'), keep('c')] }) }];
    const m = mergeHunt({ stage1Verdicts: stage1, groups, index: null, check: stub({ b: ['quote not found'] }) });
    expect(m.adopted.map(a => a.id)).toEqual(['a']);
    expect(m.rejected.map(r => r.id)).toEqual(['b']);
    expect(m.verdicts.find(v => v.id === 'a').verdict).toBe('wipe-merge');
    expect(m.verdicts.find(v => v.id === 'b').verdict).toBe('pristine-keep');
    expect(m.rerun).toEqual(['h00']);
  });

  it('rejects circular coverage and a wipe that leaves a crossing neighbour broken', () => {
    const groups = [
      { packet: packet('h00', ['a', 'b']), verdictsText: JSON.stringify({ verdicts: [wipe('a', 'b'), wipe('b', 'a')] }) },
      { packet: packet('h01', ['c'], { c: { concatNeighbours: [{ id: 'd', side: 'after', crossesSentence: true }] } }), verdictsText: JSON.stringify({ verdicts: [wipe('c', 'x')] }) },
    ];
    const m = mergeHunt({ stage1Verdicts: stage1, groups, index: null, check: stub({}) });
    // Mutual coverage: the first wipe falls back to keep, which makes its
    // partner's carrier live again, so exactly one of the pair survives.
    expect(m.adopted.map(a => a.id)).toEqual(['b']);
    expect(m.rejected.map(r => r.id).sort()).toEqual(['a', 'c']);
    expect(m.verdicts.find(v => v.id === 'c').verdict).toBe('pristine-keep');
  });

  it('names a group with no verdicts file for a rerun and keeps its ids', () => {
    const m = mergeHunt({ stage1Verdicts: stage1, groups: [{ packet: packet('h02', ['e']), verdictsText: null }], index: null, check: stub({}) });
    expect(m.rerun).toEqual(['h02']);
    expect(m.verdicts.find(v => v.id === 'e').verdict).toBe('pristine-keep');
  });
});

const has = fs.existsSync(FILE);
const run = async (args, reply) => {
  const src = fs.readFileSync(FILE, 'utf8').replace(/^export const meta/m, 'const meta');
  const prompts = [];
  const agent = async (prompt, opts) => {
    prompts.push({ prompt, opts });
    return reply(opts.label.split(':')[1]);
  };
  const parallel = async thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)));
  const fn = new Function('args', 'agent', 'parallel', 'phase', 'log', `return (async () => {${src}})();`);
  const out = await fn(args, agent, parallel, () => {}, () => {});
  return { out, prompts };
};
const ARGS = { version: '2.1.288', huntDir: '/h', groupCount: 2, activeSet: '/sets/system-prompts-lcc', repoDir: '/work/tweakcc-fixed', remindersDir: '/work/lcc/system-reminders', model: 'opus', effort: 'medium' };

describe.skipIf(!has)('audit-stage1-cut-hunt workflow', () => {
  it('derives hunt paths, carries the hunter role and the stage-1 rules, and names the harvest', async () => {
    const { out, prompts } = await run(ARGS, g => ({ group: g, verdictsFile: 'x', checker: `PASS ${g} 4/4 verdicts sha256=0123456789ab` }));
    expect(prompts).toHaveLength(2);
    const p = prompts[1].prompt;
    expect(p).toContain('/h/hunt-packet-01.md');
    expect(p).toContain('writeAuditVerdicts.mjs /h/hunt-packet-01.json');
    expect(p).toContain('CUT HUNTER');
    expect(p).toContain('Do not load any skill');
    expect(p).toContain('Do not cut to have cut');
    for (const rule of [
      'Tripwire: a pristine sentence is FROZEN verbatim-or-delete',
      'Frozen means verbatim-or-delete, NOT keep',
      'an alternative arm (the other branch of a ternary, or a sibling constant chosen INSTEAD of this one) never co-renders and is never coverage',
      'prove from the bundle that whenever the target renders, the carrier renders too',
      'If externalRefs.rewriteReplacement is true',
      'A sentence that crosses a fragment boundary is cut whole across both ids or not at all',
      'A suppressed or shadowed carrier renders nothing and is never coverage.',
      'A conditional prompt costs zero when off, so feature disuse alone is not a wipe reason.',
    ]) expect(p, rule).toContain(rule);
    expect(out.harvest).toBe('node /work/tweakcc-fixed/tools/harvestCutHunt.mjs /h');
    expect(out.failed).toEqual([]);
  });

  it('requires every path-only arg, model and effort; reruns only named groups', async () => {
    for (const k of ['version', 'huntDir', 'groupCount', 'activeSet', 'repoDir', 'remindersDir', 'model', 'effort']) {
      const a = { ...ARGS };
      delete a[k];
      await expect(run(a, () => null)).rejects.toThrow(new RegExp(k));
    }
    const { prompts } = await run({ ...ARGS, only: ['h01'] }, g => ({ group: g, verdictsFile: 'x', checker: `PASS ${g} 1/1 verdicts sha256=0123456789ab` }));
    expect(prompts.map(p => p.opts.label)).toEqual(['hunt:h01']);
  });
});
