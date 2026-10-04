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

// Run a workflow script with stubbed globals, timing every agent turn so the
// interleaving is observable. `slow` names the one label that takes long.
const runShaped = async (file, ctxExtra, slow) => {
  const src = fs
    .readFileSync(path.join(WF, file), 'utf8')
    .replace(/^export const meta/m, 'const meta');
  const timeline = [];
  const logs = [];
  const ctx = {
    ...ctxExtra,
    pipeline: async (items, ...stages) =>
      Promise.all(
        items.map(async (it, i) => {
          let v = it;
          for (const s of stages) {
            try {
              v = await s(v, it, i);
            } catch {
              return null;
            }
          }
          return v;
        })
      ),
    parallel: async thunks =>
      Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null))),
    agent: async () => null,
    phase: () => {},
    log: m => logs.push(String(m)),
    console,
    JSON, Math, Number, Array, Object, String, Error, Set, Map, Promise, RegExp, Date,
    setTimeout, clearTimeout,
  };
  const patched =
    'globalThis.__t = [];' +
    src.replace(
      /async function agentWithRetry\([\s\S]*?\n}\n/,
      `async function agentWithRetry(prompt, o) {
         const [which, id] = String(o.label || '').split(':');
         globalThis.__t.push(which + ':start:' + id);
         await new Promise(r => setTimeout(r, ${JSON.stringify(slow)} === (which + ':' + id) ? 220 : 25));
         globalThis.__t.push(which + ':end:' + id);
         return { id, verdicts: [], filesWritten: [], summary: '', pass: true, issue: '', requiredAction: '' };
       }\n`
    );
  try {
    await vm.runInNewContext(`(async () => { ${patched} })()`, ctx, { timeout: 20000 });
  } catch {
    /* completeness checks over stub data are not what is under test */
  }
  timeline.push(...(vm.runInNewContext('globalThis.__t', ctx) || []));
  return { timeline, logs, at: s => timeline.indexOf(s) };
};

describe.skipIf(!has('classify-and-name-prompts.workflow.js'))(
  'classify-and-name-prompts is a per-item pipeline over file handoffs',
  () => {
    const base = {
      version: '9.9.9',
      evidenceDir: '/tmp/classify-evidence-9.9.9',
      chunkCount: 4,
      model: 'sonnet',
      verifyModel: 'opus',
      classifyEffort: 'high',
      verifyEffort: 'medium',
      repoDir: '/work/tweakcc-fixed',
    };
    const src = () =>
      fs
        .readFileSync(path.join(WF, 'classify-and-name-prompts.workflow.js'), 'utf8')
        .replace(/^export const meta/m, 'const meta');
    // Real agentWithRetry, scripted agent receipts.
    const runWith = async (input, reply) => {
      const prompts = [];
      const logs = [];
      const ctx = {
        args: input,
        agent: async (prompt, o) => { prompts.push({ prompt, label: o.label }); return reply(o.label, prompt); },
        pipeline: async (items, ...stages) =>
          Promise.all(items.map(async it => {
            let v = it;
            for (const s of stages) {
              try { v = await s(v); } catch { return null; }
            }
            return v;
          })),
        parallel: async () => [],
        phase: () => {},
        log: m => logs.push(String(m)),
        JSON, Math, Number, Array, Object, String, Error, Set, Map, Promise, RegExp,
      };
      const out = await vm.runInNewContext(`(async () => { ${src()} })()`, ctx, { timeout: 5000 });
      return { out, prompts, logs };
    };

    it('verifies one chunk while another is still classifying', async () => {
      const { timeline, at } = await runShaped(
        'classify-and-name-prompts.workflow.js',
        { input: base, args: base },
        'classify:00'
      );
      const firstVerify = timeline.findIndex(e => e.startsWith('verify:start'));
      const lastClassifyEnd = timeline.reduce(
        (acc, e, i) => (e.startsWith('classify:end') ? i : acc),
        -1
      );
      expect(firstVerify).toBeGreaterThan(-1);
      expect(firstVerify).toBeLessThan(lastClassifyEnd);
      expect(at('verify:end:01')).toBeLessThan(at('classify:end:00'));
    });

    it('takes paths and counts only, and refuses anything less before any agent runs', async () => {
      for (const drop of ['evidenceDir', 'chunkCount', 'model', 'verifyModel', 'classifyEffort', 'verifyEffort', 'repoDir']) {
        const input = { ...base };
        delete input[drop];
        let spawned = 0;
        await expect(
          runWith(input, () => { spawned += 1; return null; })
        ).rejects.toThrow(new RegExp(drop));
        expect(spawned).toBe(0);
      }
      // The old inline-hash contract is not silently accepted.
      await expect(
        runWith({ version: '9.9.9', chunks: ['/tmp/c0.json'], expectedHashes: { '/tmp/c0.json': ['0'.repeat(40)] } }, () => null)
      ).rejects.toThrow(/evidenceDir/);
    });

    it('names zero-based padded chunks and points every agent at files, never inline hashes', async () => {
      const { out, prompts } = await runWith({ ...base, chunkCount: 2 }, (label) => {
        const nn = label.split(':')[1];
        return label.startsWith('classify')
          ? { chunk: nn, pass: true, verdicts: 3, scope: 2, note: '' }
          : { chunk: nn, pass: true, audited: 2, changed: 0, note: '' };
      });
      expect(prompts.map(p => p.label).sort()).toEqual(['classify:00', 'classify:01', 'verify:00', 'verify:01']);
      const c0 = prompts.find(p => p.label === 'classify:00').prompt;
      expect(c0).toContain('/tmp/classify-evidence-9.9.9/chunk-00.json');
      expect(c0).toContain('/tmp/classify-evidence-9.9.9/verdicts-00.json');
      expect(c0).toContain('checkClassifyVerdicts.mjs /tmp/classify-evidence-9.9.9 00');
      const v1 = prompts.find(p => p.label === 'verify:01').prompt;
      expect(v1).toContain('/tmp/classify-evidence-9.9.9/verify-scope-01.json');
      expect(v1).toContain('--stage verify');
      // Turn economy: one Read of a markdown packet, batched bundle queries,
      // write+check in one step, no skill loads.
      expect(c0).toContain('/tmp/classify-evidence-9.9.9/chunk-00.md');
      expect(c0).toContain('with ONE Read call');
      expect(c0).toContain('writeClassifyVerdicts.mjs /tmp/classify-evidence-9.9.9 00');
      expect(c0).toContain('Do not load any skill');
      expect(c0).toContain('bundleQuery');
      expect(c0).toContain('confirm the branch that yields this string is reachable from the model-bound caller');
      expect(c0).toContain('"roleChange"');
      expect(c0).toContain('Ids belong on FRAGMENTS');
      expect(c0).toContain('settings-oracle');
      expect(c0).toContain('"the model can run it" is not a route');
      expect(c0).toContain("never extend a family ruling to a member without checking THAT member's own sink");
      expect(c0).toContain('Confirm which local is which before ruling');
      expect(c0).toContain('A gate on the CALLER side closes a route');
      expect(c0).toContain('Setter wiring can be crosswise at the CALLER');
      expect(c0).toContain('Never rule ui or internal while a branch of the route is still open');
      expect(c0).toContain('check whether ANY reachable caller sets the option');
      expect(c0).toContain('sent OUTBOUND as a control_response');
      expect(v1).toContain('/tmp/classify-evidence-9.9.9/verify-01.md');
      expect(v1).toContain('writeClassifyVerdicts.mjs /tmp/classify-evidence-9.9.9 01 --stage verify');
      expect(out).toMatchObject({ classified: 2, verified: 2, chunkCount: 2 });
      expect(out.next).toContain('harvestClassify.mjs /tmp/classify-evidence-9.9.9');
    });

    it('keeps every facing rule and adds the local-command and metaMessages rules', async () => {
      const { prompts } = await runWith({ ...base, chunkCount: 1 }, (label) =>
        label.startsWith('classify')
          ? { chunk: '00', pass: true, verdicts: 1, scope: 1, note: '' }
          : { chunk: '00', pass: true, audited: 1, changed: 0, note: '' });
      for (const p of prompts) {
        expect(p.prompt).toContain('{behavior:"ask", message}');
        expect(p.prompt).toContain('[runner:warn]');
        expect(p.prompt).toContain('check the SECOND argument of the onDone call');
        expect(p.prompt).toContain('starts with \`@internal\`'.replace(/\\/g, ''));
        expect(p.prompt).toContain('{type:"text", value}');
        expect(p.prompt).toContain('metaMessages to the model on every branch except');
        expect(p.prompt).toContain('Never mint an inline- id');
        expect(p.prompt).toContain('workflow-script-');
        expect(p.prompt).toContain('possibleSuccessorOf');
      }
    });

    it('re-asks a chunk whose checker did not pass, and skips verify on an empty scope', async () => {
      let tries = 0;
      const { out, prompts, logs } = await runWith({ ...base, chunkCount: 1 }, (label) => {
        if (label.startsWith('verify')) return { chunk: '00', pass: true, audited: 0, changed: 0, note: '' };
        tries += 1;
        return tries === 1
          ? { chunk: '00', pass: false, verdicts: 5, scope: 0, note: 'missing 2 hashes' }
          : { chunk: '00', pass: true, verdicts: 7, scope: 0, note: '' };
      });
      expect(tries).toBe(2);
      expect(prompts[1].prompt).toContain('YOUR PREVIOUS ATTEMPT WAS REJECTED');
      expect(prompts[1].prompt).toContain('missing 2 hashes');
      expect(prompts.some(p => p.label.startsWith('verify'))).toBe(false);
      expect(logs.join(' ')).toContain('empty scope');
      expect(out).toMatchObject({ classified: 1, verified: 1 });
    });

    it('reruns only the chunks it is told to', async () => {
      const { out, prompts } = await runWith({ ...base, only: ['2', 'chunk-03'] }, (label) => {
        const nn = label.split(':')[1];
        return label.startsWith('classify')
          ? { chunk: nn, pass: true, verdicts: 1, scope: 0, note: '' }
          : null;
      });
      expect(prompts.map(p => p.label)).toEqual(['classify:02', 'classify:03']);
      expect(out.ran).toBe(2);
      await expect(runWith({ ...base, only: ['09'] }, () => null)).rejects.toThrow(/outside 0..3/);
    });

    it('reports a chunk that never passes instead of throwing the run away', async () => {
      const { out } = await runWith({ ...base, chunkCount: 2 }, (label) => {
        const nn = label.split(':')[1];
        if (label === 'classify:01') return { chunk: '01', pass: false, verdicts: 0, scope: 0, note: 'bad' };
        return label.startsWith('classify')
          ? { chunk: nn, pass: true, verdicts: 1, scope: 1, note: '' }
          : { chunk: nn, pass: true, audited: 1, changed: 1, note: '' };
      });
      expect(out.notClassified).toEqual(['01']);
      expect(out.classified).toBe(1);
      expect(out.changedByVerifier).toBe(1);
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
