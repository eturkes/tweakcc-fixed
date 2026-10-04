// The writer / verify workflows take a path-only contract:
// {version, tasksPath, count, tasksDigest, model, effort} (trim-and-verify:
// trimEffort, verifyEffort and `coupled`), printed by `driver tasks-args`.
// Each agent reads entry NN of the tasks file, writes its result next to it,
// runs `driver tasks-check` until it passes, and returns a receipt. These tests
// run the real scripts with a stubbed agent. They skip when .claude/workflows
// is absent (it is a symlink into the local-only pipeline repo).

import { describe, it, expect } from 'vitest';
import { runWorkflow, hasWorkflow, passLine } from './harness.mjs';

const DIGEST = '0123456789abcdef';
const DIR = '/tmp/showtime-tasks-test';
// The checkout and reminders folder arrive as args; nothing host-specific is
// baked into a script (a replay against another checkout must not read the
// main one's accepted verdicts).
const REPO_DIR = '/work/tweakcc-fixed';
const REMINDERS_DIR = '/work/lcc/system-reminders';
const DRIVER = `${REPO_DIR}/.claude/skills/showtime-skrabe/driver.mjs`;

const WORKFLOWS = [
  {
    file: 'realign-conflicts.workflow.js',
    kind: 'realign',
    efforts: { effort: 'medium' },
    rules: [
      'Tripwire: pristine sentences containing restrictive quantifiers',
      'An EMPTY body in a set is a deliberate SUPPRESSION, never a file waiting to be filled',
      "match each slot's SHAPE exactly",
      'quotedElsewhere, rewriteNeedles, predicateRuns',
      'If externalRefs.rewriteReplacement is true, the whole prompt IS the replacement half of a rewrite pair',
      'If the body opensWithSlot, find that slot',
      'A slot pristine ADDS goes where pristine puts it',
      'Match the escaping the file already uses',
      'A ccVersion-only bump is right only when no sentence the override KEEPS was reworded',
      'Never cut a sentence that a KEPT sentence depends on',
      'for each cut check whether a kept sentence refers back to it',
      'grep the bundle /tmp/cli-9.9.9.js for the literal AND for the const it is built from',
      'check the sentence reads correctly against EVERY branch the slot can resolve to',
      'Preserve existing code comments verbatim. Do not edit ledger, unrelated prompts, or the catalogue.',
    ],
  },
  {
    file: 'audit-new-prompts-stage2-trim.workflow.js',
    kind: 'trim',
    reminders: true,
    efforts: { effort: 'medium' },
    rules: [
      'If the packet carries a non-null mainLoopCorrection field, it OVERRIDES the stage-1 plan',
      'Write the resulting override to EVERY exact path listed in the packet.',
      'An EMPTY body in a set is a deliberate SUPPRESSION: leave it empty, and never copy a body into it.',
      'Tripwire: a pristine sentence is FROZEN verbatim-or-delete',
      'If externalRefs.rewriteReplacement is true',
      'If the body opensWithSlot',
      'every current identifierMap slot must still occur at least once',
      'preserve all existing code comments verbatim and do not refactor executable code',
      'grep the bundle /tmp/cli-9.9.9.js for the literal AND for the const it is built from',
      'check the sentence reads correctly against EVERY branch the slot can resolve to',
      "the override set is the directory holding the entry's paths; system reminders are in /work/lcc/system-reminders",
      'the relevant current pristine entry in /work/tweakcc-fixed/data/prompts/prompts-9.9.9.json',
      "A MODEL_DEFAULT coverage claim holds only when BOTH served models' system-card digests",
      'Match the escaping the file already uses',
    ],
  },
  {
    file: 'audit-new-prompts-stage2b-repair.workflow.js',
    kind: 'repair',
    efforts: { effort: 'xhigh' },
    rules: [
      'a deterministic gate (tools/checkFactCoverage.mjs)',
      "The facts to restore are the entry's `facts` array, each verbatim from the current pristine body",
      'A bare list of method names with no indication of what they do is not a restoration',
      '4. Change NOTHING else.',
      '5. Verify before finishing: every listed fact must appear as an exact substring of the file you wrote.',
      "Write the resulting override to EVERY exact path in the packet's `setFiles`.",
      'An EMPTY body is a deliberate SUPPRESSION: leave it empty.',
      'Never reword a restored limit, field name, enum, endpoint, parameter, or ordering rule.',
      'Match the escaping the file already uses',
    ],
  },
  {
    file: 'audit-new-prompts-stage3-verify.workflow.js',
    kind: 'verify',
    reminders: true,
    captures: true,
    efforts: { effort: 'high' },
    rules: [
      'You are a DIFFERENT agent from the verdict author and file writer.',
      'Refute by default.',
      'An alternative arm — the other branch of a ternary',
      'A wipe of a rewrite-table REPLACEMENT (externalRefs.rewriteReplacement',
      "For MODEL_DEFAULT, read both served models' system-card digests rather than looking for a file — ~/dev/anthropic-reference/Opus-5.5-Card-Digest.md and ~/dev/anthropic-reference/Fable-5.1-Card-Digest.md — and refute the claim unless BOTH state that default",
      'Do not trust the stage-1 rationale, writer summary, or claimed pristine quote.',
      'The mechanics tripwire is verbatim-or-delete',
      'Return exactly one finding per assigned id.',
      'must have the quoted claim found in the captured request bodies in /tmp/turnprobe-9.9.9-1',
      'so its absence from the capture is NOT a refutation: prove co-rendering from the bundle instead',
      'if the carrier is stale AND the quote lives only in its stale text, the coverage is about to evaporate — treat it as REFUTED',
      'the byte offset in /tmp/cli-9.9.9.js or the JSON entry (id and piece) in /work/tweakcc-fixed/data/prompts/prompts-9.9.9.json',
    ],
  },
  {
    file: 'audit-trim-and-verify.workflow.js',
    kind: 'trim-verify',
    reminders: true,
    captures: true,
    efforts: { trimEffort: 'medium', verifyEffort: 'xhigh', coupled: [] },
    rules: [
      'Tripwire: a pristine sentence is FROZEN verbatim-or-delete',
      'An EMPTY body in a set is a deliberate SUPPRESSION',
      'If externalRefs.rewriteReplacement is true',
      'Your job is to REFUTE.',
      'a claim whose carrier lost that text in this same pass is not coverage',
      'Default to pass=false when uncertain.',
      'in the assembled `system` text or in a `tools[].description`',
      'so its absence from the capture is NOT a refutation',
      'treat it as REFUTED',
      'grep the bundle /tmp/cli-9.9.9.js for the literal AND for the const it is built from',
      "the override set is the directory holding the entry's paths",
      "A MODEL_DEFAULT coverage claim holds only when BOTH served models' system-card digests",
      "For MODEL_DEFAULT, read both served models' system-card digests",
      'Match the escaping the file already uses',
    ],
  },
];

const stageOf = (kind, label) => (kind === 'trim-verify' ? label.split(':')[0] : undefined);
const resultFile = (kind, nn, stage) =>
  kind === 'trim-verify' ? `${DIR}/trim-verify-${stage}-${nn}.json` : `${DIR}/${kind}-result-${nn}.json`;

for (const w of WORKFLOWS) {
  const tasksPath = `${DIR}/${w.kind}-tasks.json`;
  const base = {
    version: '9.9.9',
    tasksPath,
    count: 3,
    tasksDigest: DIGEST,
    model: 'sonnet',
    repoDir: REPO_DIR,
    ...(w.reminders ? { remindersDir: REMINDERS_DIR } : {}),
    ...(w.captures ? { capturesDir: '/tmp/turnprobe-9.9.9-1' } : {}),
    ...w.efforts,
  };
  const pass = label => {
    const nn = label.split(':')[1];
    return { task: nn, checker: passLine(w.kind, nn, stageOf(w.kind, label)) };
  };

  describe.skipIf(!hasWorkflow(w.file))(`${w.file} — path-only tasks contract`, () => {
    it('throws before spawning when any required key is missing', async () => {
      for (const key of Object.keys(base)) {
        const input = { ...base };
        delete input[key];
        let spawned = 0;
        await expect(
          runWorkflow(w.file, input, () => {
            spawned += 1;
            return null;
          })
        ).rejects.toThrow(new RegExp(`${key}[\\s\\S]*tasks-args`));
        expect(spawned).toBe(0);
      }
    });

    it('has no default model or effort', async () => {
      for (const key of ['model', ...Object.keys(w.efforts).filter(k => k !== 'coupled')]) {
        const input = { ...base, [key]: undefined };
        await expect(runWorkflow(w.file, input, () => null)).rejects.toThrow(new RegExp(key));
      }
    });

    it('refuses the old inline shape and points at tasksPath', async () => {
      for (const extra of [{ tasks: [{ id: 'a', packet: '/tmp/a.json', paths: [] }] }, { groups: [{ name: 'g0', packet: '/tmp/g.json', ids: ['a'] }] }]) {
        let spawned = 0;
        await expect(
          runWorkflow(w.file, { ...base, ...extra }, () => {
            spawned += 1;
            return null;
          })
        ).rejects.toThrow(/tasksPath/);
        expect(spawned).toBe(0);
      }
    });

    it('points each agent at its entry of the tasks file, never at inline ids or paths', async () => {
      const { prompts, out } = await runWorkflow(w.file, base, pass);
      const p01 = prompts.filter(p => p.label.endsWith(':01'));
      expect(p01.length).toBe(w.kind === 'trim-verify' ? 2 : 1);
      for (const p of p01) {
        const stage = stageOf(w.kind, p.label);
        expect(p.prompt).toContain(`entry 01 (zero-based) of the JSON task array in ${tasksPath}`);
        expect(p.prompt).toContain(resultFile(w.kind, '01', stage));
        expect(p.prompt).toContain(`${DRIVER} tasks-check ${w.kind} ${tasksPath} 01${stage ? ` --stage ${stage}` : ''}`);
        expect(p.prompt).toContain(`"tasksDigest":"${DIGEST}"`);
        expect(p.prompt).not.toMatch(/entry 0[02]\b/);
        expect(p.prompt).not.toMatch(/undefined|\[object Object\]/);
        expect(p.prompt).toContain(`Run every command from ${REPO_DIR}.`);
        expect(p.prompt).not.toMatch(/\/Users\/|<repoDir>/);
        if (w.reminders) expect(p.prompt).toContain(`${REMINDERS_DIR}/<name>.md`);
        expect(p.opts.model).toBe('sonnet');
        expect(p.opts.agentType).toBe('showtime-worker');
        expect(p.opts.schema.required).toEqual(['task', 'checker']);
      }
      expect(out).toEqual({
        kind: w.kind,
        tasksPath,
        count: 3,
        passed: ['00', '01', '02'],
        failed: [],
        next: `node ${DRIVER} tasks-harvest ${w.kind} ${tasksPath}`,
      });
    });

    it('keeps every rule of the agent prompt', async () => {
      const { prompts } = await runWorkflow(w.file, { ...base, count: 1 }, pass);
      const all = prompts.map(p => p.prompt).join('\n');
      for (const rule of w.rules) expect(all).toContain(rule);
    });

    it('resumes a task from disk quoting the checker, and reports one that never passes instead of throwing', async () => {
      const first = w.kind === 'trim-verify' ? 'trim' : w.kind;
      const fail = `FAIL ${w.kind === 'trim-verify' ? 'trim-verify 01 trim' : `${w.kind} 01`}: 2 problem(s)`;
      let wrongTask = true;
      const { out, prompts } = await runWorkflow(w.file, base, label => {
        const nn = label.split(':')[1];
        if (nn === '01') return { task: nn, checker: fail };
        // A PASS line for ANOTHER task is not this task's pass.
        if (label === `${first}:02` && wrongTask) {
          wrongTask = false;
          return { task: nn, checker: passLine(w.kind, '00', stageOf(w.kind, label)) };
        }
        return pass(label);
      });
      const tries01 = prompts.filter(p => p.label.endsWith(':01'));
      expect(tries01).toHaveLength(3);
      expect(tries01[1].prompt).toMatch(/RESUME|PARTIAL RETRY/);
      expect(tries01[1].prompt).toContain(fail);
      expect(tries01[1].prompt).toContain(resultFile(w.kind, '01', stageOf(w.kind, tries01[0].label)));
      expect(prompts.filter(p => p.label === `${first}:02`)).toHaveLength(2);
      expect(out.passed).toEqual(['00', '02']);
      expect(out.failed).toHaveLength(1);
      expect(out.failed[0]).toMatchObject({ task: '01', checker: fail });
    });

    it('reruns only the tasks it is told to, with ids padded to the task count', async () => {
      const { prompts, out } = await runWorkflow(w.file, { ...base, count: 120, only: ['7', '011'] }, pass);
      const nns = [...new Set(prompts.map(p => p.label.split(':')[1]))].sort();
      expect(nns).toEqual(['007', '011']);
      expect(out.passed).toEqual(['007', '011']);
      await expect(runWorkflow(w.file, { ...base, only: ['05'] }, pass)).rejects.toThrow(/outside 00..02/);
    });
  });
}
