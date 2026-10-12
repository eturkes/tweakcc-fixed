// The workflow scripts live under .claude/, which is gitignored, so these tests
// skip cleanly when the scripts are absent. They exist because the property
// under test is a SCHEDULING shape that nothing else can see: a workflow that
// silently reverts to stage-major still produces correct output, just slower,
// and no other check would notice.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { runWorkflow, passLine } from './harness.mjs';

const WF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.claude/workflows'
);
const has = f => fs.existsSync(path.join(WF, f));

describe.skipIf(!has('classify-and-name-prompts.workflow.js'))(
  'classify-and-name-prompts is one classify pass over file handoffs',
  () => {
    const base = {
      version: '9.9.9',
      evidenceDir: '/tmp/classify-evidence-9.9.9',
      chunkCount: 4,
      mdParts: [1, 2, 1, 1],
      model: 'opus',
      effort: 'medium',
      repoDir: '/work/tweakcc-fixed',
    };
    const src = () =>
      fs
        .readFileSync(path.join(WF, 'classify-and-name-prompts.workflow.js'), 'utf8')
        .replace(/^export const meta/m, 'const meta');
    const runWith = async (input, reply) => {
      const prompts = [];
      const logs = [];
      const ctx = {
        args: input,
        agent: async (prompt, o) => { prompts.push({ prompt, label: o.label, agentType: o.agentType, model: o.model, effort: o.effort }); return reply(o.label, prompt); },
        parallel: async thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null))),
        phase: () => {},
        log: m => logs.push(String(m)),
        JSON, Math, Number, Array, Object, String, Error, Set, Map, Promise, RegExp,
      };
      const out = await vm.runInNewContext(`(async () => { ${src()} })()`, ctx, { timeout: 5000 });
      return { out, prompts, logs };
    };
    const ok = label => ({ chunk: label.split(':')[1], pass: true, verdicts: 3, note: '' });

    it('runs one classifier per chunk and no verifier', async () => {
      const { out, prompts } = await runWith(base, ok);
      expect(prompts.map(p => p.label).sort()).toEqual(['classify:00', 'classify:01', 'classify:02', 'classify:03']);
      expect(prompts.every(p => p.agentType === 'showtime-worker' && p.model === 'opus' && p.effort === 'medium')).toBe(true);
      expect(out).toMatchObject({ classified: 4, chunkCount: 4, notClassified: [] });
    });

    it('takes paths and counts only, and refuses anything less before any agent runs', async () => {
      for (const drop of ['evidenceDir', 'chunkCount', 'mdParts', 'model', 'effort', 'repoDir']) {
        const input = { ...base };
        delete input[drop];
        let spawned = 0;
        await expect(runWith(input, () => { spawned += 1; return null; })).rejects.toThrow(new RegExp(drop));
        expect(spawned).toBe(0);
      }
      await expect(runWith({ ...base, mdParts: [1, 1] }, () => null)).rejects.toThrow(/mdParts/);
      await expect(runWith({ ...base, mdParts: [1, 0, 1, 1] }, () => null)).rejects.toThrow(/mdParts/);
    });

    it('points every agent at its packet parts, the write step and the checker', async () => {
      const { out, prompts } = await runWith({ ...base, chunkCount: 2, mdParts: [1, 2] }, ok);
      const c0 = prompts.find(p => p.label === 'classify:00').prompt;
      expect(c0).toContain('/tmp/classify-evidence-9.9.9/chunk-00.md');
      expect(c0).toContain('/tmp/classify-evidence-9.9.9/verdicts-00.json');
      expect(c0).toContain('node /work/tweakcc-fixed/tools/writeClassifyVerdicts.mjs /tmp/classify-evidence-9.9.9 00');
      expect(c0).toContain('node /work/tweakcc-fixed/tools/checkClassifyVerdicts.mjs /tmp/classify-evidence-9.9.9 00');
      expect(c0).toContain('bundleQuery');
      const c1 = prompts.find(p => p.label === 'classify:01').prompt;
      expect(c1).toContain('/tmp/classify-evidence-9.9.9/chunk-01.part1.md, /tmp/classify-evidence-9.9.9/chunk-01.part2.md');
      expect(c1).not.toContain('chunk-01.md');
      expect(Buffer.byteLength(c1)).toBeLessThanOrEqual(4096);
      expect(out.next).toContain('classify-harvest 9.9.9');
    });

    it('keeps the facing and naming rules agents get wrong', async () => {
      const { prompts } = await runWith({ ...base, chunkCount: 1, mdParts: [1] }, ok);
      const p = prompts[0].prompt;
      for (const rule of [
        '{behavior:"ask", message}',
        'check the SECOND argument',
        'metaMessages reach the model on every branch except "skip"',
        '{type:"text", value}',
        'crosswise at the caller',
        'A caller-side gate closes a route',
        'control_response is transport',
        '@internal',
        'is not a route',
        'Never rule ui/internal while a branch is open',
        'possibleSuccessorOf',
        'roleChange',
        'Ids go on fragments, never on a JOIN',
        'Never mint inline- or workflow-script- ids',
      ]) expect(p, rule).toContain(rule);
    });

    it('re-asks a chunk whose checker did not pass', async () => {
      let tries = 0;
      const { out, prompts } = await runWith({ ...base, chunkCount: 1, mdParts: [1] }, () => {
        tries += 1;
        return tries === 1 ? { chunk: '00', pass: false, verdicts: 5, note: 'missing 2 hashes' } : { chunk: '00', pass: true, verdicts: 7, note: '' };
      });
      expect(tries).toBe(2);
      expect(prompts[1].prompt).toContain('YOUR PREVIOUS ATTEMPT WAS REJECTED');
      expect(prompts[1].prompt).toContain('missing 2 hashes');
      expect(out).toMatchObject({ classified: 1 });
    });

    it('reruns only the chunks it is told to', async () => {
      const { out, prompts } = await runWith({ ...base, only: ['2', 'chunk-03'] }, ok);
      expect(prompts.map(p => p.label)).toEqual(['classify:02', 'classify:03']);
      expect(out.ran).toBe(2);
      await expect(runWith({ ...base, only: ['09'] }, () => null)).rejects.toThrow(/outside 0..3/);
    });

    it('reports a chunk that never passes instead of throwing the run away', async () => {
      const { out } = await runWith({ ...base, chunkCount: 2, mdParts: [1, 1] }, label =>
        label === 'classify:01' ? { chunk: '01', pass: false, verdicts: 0, note: 'bad' } : ok(label));
      expect(out.notClassified).toEqual(['01']);
      expect(out.classified).toBe(1);
    });
  }
);

describe.skipIf(!has('audit-trim-and-verify.workflow.js'))(
  'audit-trim-and-verify keeps the barrier only where citations require it',
  () => {
    // The script cannot read the tasks file, so `driver tasks-args trim-verify`
    // computes the citation graph and passes `coupled`: tasks 00 and 01 cite
    // each other's ids (in either direction); 02..04 cite nothing in the batch.
    const args = {
      version: '9.9.9',
      tasksPath: '/tmp/tv-test/trim-verify-tasks.json',
      count: 5,
      tasksDigest: '0123456789abcdef',
      model: 'sonnet',
      trimEffort: 'medium',
      verifyEffort: 'xhigh',
      coupled: ['00', '1'],
      repoDir: '/work/tweakcc-fixed',
      remindersDir: '/work/lcc/system-reminders',
      capturesDir: '/tmp/turnprobe-9.9.9-1',
    };
    const reply = label => {
      const [stage, nn] = label.split(':');
      return { task: nn, checker: passLine('trim-verify', nn, stage) };
    };
    const run = (input = args, r = reply) =>
      runWorkflow('audit-trim-and-verify.workflow.js', input, r, {
        delay: label => (label === 'trim:02' ? 220 : 25),
      });

    it('partitions on the coupled list the driver computed', async () => {
      const { logs } = await run();
      expect(logs[0]).toContain('3 independent task(s) pipeline trim->verify');
      expect(logs[0]).toContain('2 coupled by in-batch citations and hold the barrier');
    });

    it('pipelines an independent item past a slow sibling', async () => {
      const { at } = await run();
      expect(at('verify:03:start')).toBeGreaterThan(-1);
      expect(at('verify:03:start')).toBeLessThan(at('trim:02:end'));
    });

    it('holds coupled verifies until every coupled trim has landed', async () => {
      const { at } = await run();
      const firstCoupledVerify = Math.min(at('verify:00:start'), at('verify:01:start'));
      const lastCoupledTrim = Math.max(at('trim:00:end'), at('trim:01:end'));
      expect(firstCoupledVerify).toBeGreaterThan(lastCoupledTrim);
    });

    it('never verifies a trim that did not pass, and reports it by stage', async () => {
      const { out, prompts } = await run(args, label => {
        const [stage, nn] = label.split(':');
        if (label === 'trim:03') return { task: nn, checker: 'FAIL trim-verify 03 trim: 1 problem(s)' };
        if (label === 'verify:04') return { task: nn, checker: 'FAIL trim-verify 04 verify: 1 problem(s)' };
        return { task: nn, checker: passLine('trim-verify', nn, stage) };
      });
      expect(prompts.some(p => p.label === 'verify:03')).toBe(false);
      expect(out.passed).toEqual(['00', '01', '02']);
      expect(out.failed).toEqual([
        { task: '03', stage: 'trim', checker: 'FAIL trim-verify 03 trim: 1 problem(s)' },
        { task: '04', stage: 'verify', checker: 'FAIL trim-verify 04 verify: 1 problem(s)' },
      ]);
    });

    it('takes a trim PASS line only for the trim stage', async () => {
      // A verify-stage PASS line returned by the trim agent is not a trim pass.
      let n = 0;
      const { prompts } = await run({ ...args, count: 1, coupled: [] }, label => {
        const [stage, nn] = label.split(':');
        if (label === 'trim:00' && n++ === 0) return { task: nn, checker: passLine('trim-verify', nn, 'verify') };
        return { task: nn, checker: passLine('trim-verify', nn, stage) };
      });
      expect(prompts.filter(p => p.label === 'trim:00')).toHaveLength(2);
    });

    it('requires `coupled`, and refuses one outside the task range', async () => {
      const { coupled: _drop, ...noCoupled } = args;
      await expect(run(noCoupled)).rejects.toThrow(/coupled/);
      await expect(run({ ...args, coupled: ['09'] })).rejects.toThrow(/outside 00..04/);
    });
  }
);


// A static guard alongside the behavioural ones. The wave loop is easy to
// reintroduce by habit and produces correct output, so nothing else notices —
// but it reimposes a barrier per wave, which is what this whole change removed.
describe('no workflow reintroduces a wave loop', () => {
  const files = fs.existsSync(WF) ? fs.readdirSync(WF).filter(f => f.endsWith('.workflow.js')) : [];

  it.skipIf(!files.length)('has no `+= batchSize` loop anywhere', () => {
    const offenders = files.filter(f =>
      /(?:off|offset|i)\s*\+=\s*batchSize/.test(fs.readFileSync(path.join(WF, f), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it.skipIf(!files.length)('throttles with a sliding-window gate where it throttles at all', () => {
    // Every workflow that still accepts `batchSize` must implement it as the
    // sliding-window gate, never as slice-and-await.
    const bad = files.filter(f => {
      const src = fs.readFileSync(path.join(WF, f), 'utf8');
      return src.includes('batchSize') && !src.includes('const gate = ');
    });
    expect(bad).toEqual([]);
  });
});
