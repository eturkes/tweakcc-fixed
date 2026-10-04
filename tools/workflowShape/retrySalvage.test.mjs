// Resume-from-file on retry: stage 1, stage 3 and classify all keep the work
// an earlier attempt left on disk instead of starting over.
//
// A group agent is handed 15-30 prompts and must return one object covering all
// of them. A single bad id, a dropped entry or a malformed answer used to discard
// the whole answer and restart from prompt one — on CC 2.1.237 that hit 3 of 10
// stage-1 agents, each re-judging ~24 prompts when a couple were wrong.
//
// These tests exercise the real script's agentWithRetry through stubbed globals.
// They skip when .claude/workflows is absent, since that directory is gitignored.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './harness.mjs';

const WF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.claude/workflows'
);
const FILE = 'audit-new-prompts-stage1.workflow.js';
const has = fs.existsSync(path.join(WF, FILE));
const S3 = 'audit-new-prompts-stage3-verify.workflow.js';
const hasS3 = fs.existsSync(path.join(WF, S3));
const CLS = 'classify-and-name-prompts.workflow.js';
const hasCls = fs.existsSync(path.join(WF, CLS));

// Pull agentWithRetry out of the real script and run it against a scripted
// sequence of agent replies.
const harness = (replies, { file = FILE } = {}) => {
  const src = fs.readFileSync(path.join(WF, file), 'utf8');
  const fn = src.match(/async function agentWithRetry[\s\S]*?\n}\n/)[0];
  // Stage 1's retry calls the script's own `passed` acceptance check.
  const passedFn = (src.match(/const passed = [\s\S]*?;\n/) || [''])[0];
  const prompts = [];
  const logs = [];
  let call = 0;
  const ctx = {
    agent: async prompt => {
      prompts.push(prompt);
      return replies[call++];
    },
    log: m => logs.push(String(m)),
    Array,
    Object,
    String,
    Error,
    Set,
    Map,
    Promise,
    JSON,
    Math,
    Number,
    Boolean,
    RegExp,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(`${passedFn}${fn}; globalThis.__f = agentWithRetry;`, ctx);
  return { run: (...a) => ctx.__f(...a), prompts, logs };
};

// Stage 1 hands off through files: the agent writes verdicts-NN.json, runs
// tools/checkAuditVerdicts.mjs, and returns only the checker's PASS line. A
// retry therefore resumes from the file on disk instead of re-judging.
describe.skipIf(!has)('stage-1 retry resumes from the verdicts file', () => {
  const group = {
    name: 'g03',
    verdicts: '/p/verdicts-03.json',
    md: '/p/audit-packet-03.md',
    read: '/p/audit-packet-03.md in full',
  };
  const pass = {
    group: 'g03',
    verdictsFile: '/p/verdicts-03.json',
    checker: 'PASS g03 14/14 verdicts sha256=0123456789ab',
  };

  it('accepts a PASS line on the first attempt and sends the prompt unmodified', async () => {
    const h = harness([pass]);
    const out = await h.run('BASE', { label: 'audit:g03' }, group, 3);
    expect(out.ok).toBe(true);
    expect(out.attempts).toBe(1);
    expect(h.prompts[0]).toBe('BASE');
  });

  it('resumes from the file after a FAIL line, quoting what the checker said', async () => {
    const h = harness([
      {
        ...pass,
        checker: 'FAIL g03: 2 error(s) — fix the verdicts file and re-run',
      },
      pass,
    ]);
    const out = await h.run('BASE', { label: 'audit:g03' }, group, 3);
    expect(out.ok).toBe(true);
    expect(h.prompts[1]).toContain('RESUME');
    expect(h.prompts[1]).toContain('/p/verdicts-03.json');
    expect(h.prompts[1]).toContain('FAIL g03: 2 error(s)');
    // It re-reads the markdown packet and merges fixes into the file.
    expect(h.prompts[1]).toContain('Read the markdown packet, /p/audit-packet-03.md in full, and that file');
    expect(h.prompts[1]).toContain('--merge');
  });

  it('survives an attempt that returns nothing at all', async () => {
    const h = harness([null, pass]);
    const out = await h.run('BASE', { label: 'audit:g03' }, group, 3);
    expect(out.ok).toBe(true);
    expect(h.logs.join(' ')).toContain('returned nothing');
  });

  it('rejects a PASS line for another group or an incomplete count', async () => {
    const h = harness([
      { ...pass, checker: 'PASS g04 14/14 verdicts sha256=0123456789ab' },
      { ...pass, checker: 'PASS g03 13/14 verdicts sha256=0123456789ab' },
      { ...pass, checker: 'all good' },
    ]);
    const out = await h.run('BASE', { label: 'audit:g03' }, group, 3);
    expect(out.ok).toBe(false);
    expect(h.prompts).toHaveLength(3);
  });

  it('gives up after the last attempt without throwing, so siblings keep their results', async () => {
    const h = harness([null, null, null]);
    const out = await h.run('BASE', { label: 'audit:g03' }, group, 3);
    expect(out).toMatchObject({
      group: 'g03',
      ok: false,
      checker: 'no result',
    });
  });
});

// Stage 3 used to salvage findings in memory across attempts. The findings now
// live in verify-result-NN.json, and `driver tasks-check verify` names every
// missing, unassigned or malformed finding, so a retry keeps what is on disk
// and adds exactly the ids the checker lists as missing.
describe.skipIf(!hasS3)(
  'stage-3 verify resumes from the findings on disk',
  () => {
    const args = {
      version: '9.9.9',
      tasksPath: '/tmp/s3-test/verify-tasks.json',
      count: 1,
      tasksDigest: '0123456789abcdef',
      model: 'opus',
      effort: 'high',
      repoDir: '/work/tweakcc-fixed',
      remindersDir: '/work/lcc/system-reminders',
      capturesDir: '/tmp/turnprobe-9.9.9-1',
    };
    const pass = {
      task: '00',
      checker: 'PASS verify 00 g00: 3 finding(s), 0 refuted',
    };

    it('re-asks with a partial-retry prompt that keeps the file and adds only the missing ids', async () => {
      const replies = [
        { task: '00', checker: 'FAIL verify 00: 2 problem(s)' },
        pass,
      ];
      const { out, prompts, logs } = await runWorkflow(S3, args, () =>
        replies.shift()
      );
      expect(prompts).toHaveLength(2);
      const retry = prompts[1].prompt;
      expect(retry).toContain('PARTIAL RETRY');
      expect(retry).toContain('FAIL verify 00: 2 problem(s)');
      expect(retry).toContain('/tmp/s3-test/verify-result-00.json');
      expect(retry).toContain(
        'Keep every finding already in the file that the checker does not flag'
      );
      expect(retry).toContain(
        'add a finding for exactly the ids the checker lists as missing'
      );
      expect(logs.join(' ')).toContain('recovered on attempt 2');
      expect(out.passed).toEqual(['00']);
    });

    it('survives an attempt that returns nothing and gives up without throwing', async () => {
      const { out, prompts } = await runWorkflow(S3, args, () => null);
      expect(prompts).toHaveLength(3);
      expect(out.failed).toEqual([{ task: '00', checker: 'no result' }]);
    });

    it('takes the findings from disk, never from the receipt', async () => {
      const { out } = await runWorkflow(S3, args, () => ({
        ...pass,
        findings: [{ id: 'x', pass: true }],
      }));
      expect(JSON.stringify(out)).not.toContain('findings');
    });
  }
);

describe.skipIf(!hasCls)(
  'classify retries continue from the file on disk',
  () => {
    const ok = { chunk: '00', pass: true, verdicts: 2, scope: 1, note: '' };

    it('re-asks with the rejection reason and returns the first passing receipt', async () => {
      const reject = r =>
        r.pass ? null : `the checker did not pass (${r.note})`;
      const h = harness([{ ...ok, pass: false, note: 'missing 1 hash' }, ok], {
        file: CLS,
      });
      const out = await h.run('BASE', { label: 'classify:00' }, 3, reject);
      expect(out).toEqual(ok);
      expect(h.prompts[1]).toContain('YOUR PREVIOUS ATTEMPT WAS REJECTED');
      expect(h.prompts[1]).toContain('missing 1 hash');
      expect(h.prompts[1]).toContain('still on disk');
      expect(h.logs.join(' ')).toContain('recovered on attempt 2');
    });

    it('retries a null result and gives up loudly after the attempts run out', async () => {
      const h = harness([null, null, null], { file: CLS });
      await expect(
        h.run('BASE', { label: 'classify:00' }, 3, null)
      ).rejects.toThrow(/no passing receipt after 3 attempts/);
      expect(h.prompts).toHaveLength(3);
    });
  }
);
