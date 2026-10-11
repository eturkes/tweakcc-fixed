// The stage-1 audit workflow's path-only contract and its prompt rules.
//
// The script takes {version, packetDir, groupCount, mdParts, activeSet}, derives every
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
  mdParts: [1, 1, 2],
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
      'mdParts',
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
    await expect(run({ ...ARGS, mdParts: [1, 1] })).rejects.toThrow(/mdParts/);
  });

  it('runs every agent as the lean showtime-worker type', async () => {
    const { prompts } = await run(ARGS);
    expect(prompts.map(p => p.opts.agentType)).toEqual(['showtime-worker', 'showtime-worker', 'showtime-worker']);
    expect(prompts[0].prompt).not.toMatch(/load any skill|showtime rules/);
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

  it('carries the stage-1 rules into the agent prompt', async () => {
    const { prompts } = await run(ARGS);
    const p = prompts[0].prompt;
    for (const rule of [
      'Audit every Claude Code 2.1.288 prompt assigned in your packet: verdicts only.',
      'Write nothing except /p/search-00.json',
      'Run every command from /work/tweakcc-fixed.',
      '(from /work/lcc/CLAUDE.md; do not re-read the file)',
      '/sets/system-prompts-lcc (inline-*.md included) and /work/lcc/system-reminders',
      'put every remaining claim of every id into ONE query file /p/search-00.json',
      'node /work/tweakcc-fixed/tools/bundleQuery.mjs --cli /tmp/cli-2.1.288.js --catalogue /work/tweakcc-fixed/data/prompts/prompts-2.1.288.json',
      '(1) slop check',
      '(2) corpus-wide duplication check',
      '(3) build the strongest LEGITIMATE cut',
      '(4) rule honestly whether that cut holds',
      'A cut that fails any rule is pristine-keep, and why names the rule that stopped it.',
      'gets its own matching verdict here, and the trimPlan or why names the neighbour',
      'wipe-merge (full coverage only)',
      'system-reminders/<name> (the file /work/lcc/system-reminders/<name>.md)',
      'MODEL_DEFAULT',
      'exactly one object per assigned id',
      'node /work/tweakcc-fixed/tools/writeAuditVerdicts.mjs /p/audit-packet-00.json',
      'with --merge until its first line reads PASS',
    ]) {
      expect(p, rule).toContain(rule);
    }
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(4096);
    expect(p).not.toMatch(/\/Users\/batricperovic\/(dev\/tweakcc-fixed|\.tweakcc)/);
  });

  it('points the agent at every part of the markdown packet', async () => {
    const { prompts } = await run(ARGS);
    expect(prompts[0].prompt).toContain('Read the markdown packet, /p/audit-packet-00.md in full.');
    expect(prompts[2].prompt).toContain('Read the markdown packet, all 2 parts of it in full — /p/audit-packet-02.part1.md, /p/audit-packet-02.part2.md — in one message.');
    expect(prompts[2].prompt).toContain('/p/search-02.json');
  });

  it('resumes from the verdicts file through the merge write', async () => {
    let n = 0;
    const { prompts } = await run({ ...ARGS, groupCount: 1, mdParts: [1] }, g =>
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
      'Read the markdown packet, /p/audit-packet-00.md in full, and that file'
    );
    expect(prompts[1].prompt).toContain('with --merge');
  });
});
