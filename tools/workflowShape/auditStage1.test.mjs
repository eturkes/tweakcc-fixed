// The stage-1 audit workflow's path-only contract and its prompt rules.
//
// The script takes {version, packetDir, groupCount, activeSet}, derives every
// path itself, and must carry the audit rules verbatim: a rule that silently
// drops out of the agent prompt still produces well-formed verdicts, so only a
// test that reads the prompt sees it. Skips when .claude/workflows is absent.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.claude/workflows'
);
const FILE = path.join(WF, 'audit-new-prompts-stage1.workflow.js');
const has = fs.existsSync(FILE);

const run = async (
  args,
  reply = g => ({
    group: g,
    verdictsFile: 'x',
    checker: `PASS ${g} 3/3 verdicts sha256=0123456789ab`,
  })
) => {
  const src = fs
    .readFileSync(FILE, 'utf8')
    .replace(/^export const meta/m, 'const meta');
  const prompts = [];
  const logs = [];
  const agent = async (prompt, opts) => {
    prompts.push({ prompt, opts });
    return reply(opts.label.split(':')[1]);
  };
  const parallel = async thunks =>
    Promise.all(
      thunks.map(t =>
        Promise.resolve()
          .then(t)
          .catch(() => null)
      )
    );
  const fn = new Function(
    'args',
    'agent',
    'parallel',
    'phase',
    'log',
    `return (async () => {${src}})();`
  );
  const out = await fn(
    args,
    agent,
    parallel,
    () => {},
    m => logs.push(m)
  );
  return { out, prompts, logs };
};

const ARGS = {
  version: '2.1.288',
  packetDir: '/p/',
  groupCount: 3,
  activeSet: '/sets/system-prompts-lcc',
  repoDir: '/work/tweakcc-fixed',
  remindersDir: '/work/lcc/system-reminders',
  model: 'opus',
  effort: 'medium',
};

describe.skipIf(!has)('audit-new-prompts-stage1 contract', () => {
  it('derives packet, verdicts and search paths from packetDir and groupCount', async () => {
    const { out, prompts } = await run(ARGS);
    expect(prompts).toHaveLength(3);
    expect(prompts[1].prompt).toContain('/p/audit-packet-01.json');
    expect(prompts[1].prompt).toContain('/p/verdicts-01.json');
    expect(prompts[1].prompt).toContain('/p/search-01.json');
    expect(out.failed).toEqual([]);
    expect(out.groups.map(g => g.name)).toEqual(['g00', 'g01', 'g02']);
    expect(out.harvest).toBe(
      'node /work/tweakcc-fixed/tools/harvestAudit.mjs /p'
    );
  });

  it('throws before spawning anything when a required arg is missing', async () => {
    for (const k of [
      'version',
      'packetDir',
      'groupCount',
      'activeSet',
      'repoDir',
      'remindersDir',
      'model',
      'effort',
    ]) {
      const a = { ...ARGS };
      delete a[k];
      const r = run(a);
      await expect(r).rejects.toThrow(new RegExp(k));
    }
  });

  it('reruns only the named groups', async () => {
    const { prompts } = await run({ ...ARGS, only: ['g02'] });
    expect(prompts.map(p => p.opts.label)).toEqual(['audit:g02']);
    await expect(run({ ...ARGS, only: ['g07'] })).rejects.toThrow(/outside/);
  });

  it('reports a group whose checker never passed', async () => {
    const { out } = await run(ARGS, g =>
      g === 'g01'
        ? { group: g, verdictsFile: 'x', checker: 'FAIL g01: 1 error(s)' }
        : {
            group: g,
            verdictsFile: 'x',
            checker: `PASS ${g} 3/3 verdicts sha256=0123456789ab`,
          }
    );
    expect(out.failed).toEqual(['g01']);
  });

  it('carries every audit rule into the agent prompt', async () => {
    const { prompts } = await run(ARGS);
    const p = prompts[0].prompt;
    for (const rule of [
      'Read the complete packet, every assigned pristine body, all sites for repeated ids',
      "Open every cited sibling's deployed body.",
      'Tripwire: a pristine sentence is FROZEN verbatim-or-delete',
      'Text something OUTSIDE the prompt depends on is FROZEN too',
      'If externalRefs.rewriteReplacement is true, the whole prompt IS the replacement half of a rewrite pair',
      "If the body opensWithSlot, find that slot's value in the bundle",
      'an alternative arm (the other branch of a ternary, or a sibling constant chosen INSTEAD of this one) never co-renders and is never coverage',
      "use carrierId MODEL_DEFAULT only for a claim verified in BOTH served models' digests",
      'A conditional prompt costs zero when off, so feature disuse alone is not a wipe reason.',
      'Return exactly one verdict for every assigned id.',
      'prove from the bundle that whenever the target renders, the carrier renders too',
      'A suppressed or shadowed carrier renders nothing and is never coverage.',
      'The batched search tool IS that corpus-wide search',
      'commands.check',
      '/sets/system-prompts-lcc',
      'Run every command from /work/tweakcc-fixed.',
      '/work/tweakcc-fixed/data/prompts/prompts-2.1.288.json',
      '/work/lcc/system-reminders. The batched search tool',
      'Apply the LCC decision rule from /work/lcc/CLAUDE.md',
      '(the file /work/lcc/system-reminders/<name>.md)',
      'grep the bundle /tmp/cli-2.1.288.js for the literal AND for the const it is built from',
      'if the carrier is stale AND the quote lives only in its stale text, the coverage is about to evaporate — never cite it',
      'Never rewrite/compress/reorder frozen text.',
    ]) {
      expect(p, rule).toContain(rule);
    }
    expect(p).not.toMatch(
      /\/Users\/batricperovic\/(dev\/tweakcc-fixed|\.tweakcc)/
    );
  });

  it('points the agent at the one-Read markdown packet and the batched tools', async () => {
    const { prompts } = await run(ARGS);
    const p = prompts[2].prompt;
    for (const rule of [
      'Audit every assigned Claude Code 2.1.288 prompt in /p/audit-packet-02.md',
      'Do not load any skill (in particular not the audit-new-prompts-stage1 skill)',
      'Read /p/audit-packet-02.md with ONE Read call, the whole file; do not read the JSON packet.',
      "IS that tool's output for every claim sentence",
      'node /work/tweakcc-fixed/tools/bundleQuery.mjs --cli /tmp/cli-2.1.288.js --catalogue /work/tweakcc-fixed/data/prompts/prompts-2.1.288.json',
      'send them in ONE bundleQuery call (two at most)',
      'Never python, grep or slice the bundle /tmp/cli-2.1.288.js: ask bundleQuery.',
      'node /work/tweakcc-fixed/tools/writeAuditVerdicts.mjs /p/audit-packet-02.json',
      'resending only the failing ids with --merge',
      '(the packet reproduces its decision sections verbatim; do not re-read the file)',
      '(bundleQuery text/refs queries do both in one call',
      'Frozen means verbatim-or-delete, NOT keep: a frozen sentence fully covered by a co-rendering carrier may be deleted whole',
      'A sentence that crosses a fragment boundary is cut whole across both ids or not at all',
      'name the neighbour id in trimPlan or why',
      'give the neighbour its own matching verdict in this stage',
      'PROVABLE co-render, not an unproven hint',
      '/p/search-02.json',
    ]) {
      expect(p, rule).toContain(rule);
    }
  });

  it('resumes from the verdicts file through the merge write', async () => {
    let n = 0;
    const { prompts } = await run({ ...ARGS, groupCount: 1 }, g =>
      n++ === 0
        ? { group: g, verdictsFile: 'x', checker: 'FAIL g00: 1 error(s)' }
        : {
            group: g,
            verdictsFile: 'x',
            checker: `PASS ${g} 3/3 verdicts sha256=0123456789ab`,
          }
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1].prompt).toContain('RESUME');
    expect(prompts[1].prompt).toContain(
      'Read /p/audit-packet-00.md (one Read)'
    );
    expect(prompts[1].prompt).toContain('with --merge');
  });
});
