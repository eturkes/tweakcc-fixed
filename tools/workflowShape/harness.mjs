// Shared harness for the workflow-shape tests: runs a REAL workflow script from
// .claude/workflows with the runtime's globals stubbed, so a test sees exactly
// the prompts the script would send, the order agents start and finish in, and
// the value the script returns. Not a test file itself (no .test. suffix).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const WF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.claude/workflows'
);
export const hasWorkflow = file => fs.existsSync(path.join(WF, file));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// `reply(label, prompt, opts)` scripts the agent; it may be async. `delay`
// maps a label to how long that agent "works" (default 0).
export async function runWorkflow(file, args, reply, { delay = () => 0 } = {}) {
  const src = fs
    .readFileSync(path.join(WF, file), 'utf8')
    .replace(/^export const meta/m, 'const meta');
  const prompts = [];
  const logs = [];
  const timeline = [];
  const ctx = {
    args,
    agent: async (prompt, opts) => {
      prompts.push({ prompt, opts, label: opts.label });
      timeline.push(`${opts.label}:start`);
      const ms = delay(opts.label);
      if (ms) await sleep(ms);
      const r = await reply(opts.label, prompt, opts);
      timeline.push(`${opts.label}:end`);
      return r;
    },
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
    phase: () => {},
    log: m => logs.push(String(m)),
    JSON, Math, Number, Array, Object, String, Error, Set, Map, Promise, RegExp, Boolean, Date,
    setTimeout, clearTimeout, console,
  };
  const out = await vm.runInNewContext(`(async () => { ${src} })()`, ctx, { timeout: 20000 });
  return { out, prompts, logs, timeline, at: s => timeline.indexOf(s) };
}

// A checker line the scripts accept for (kind, NN[, stage]).
export const passLine = (kind, nn, stage) =>
  `PASS ${kind} ${nn}${stage ? ` ${stage}` : ''} some-id: 1 file(s) written`;

// Agent stub: answer every label with a passing receipt.
export const allPass = (kind, { stageOf = null } = {}) => label => {
  const [which, nn] = label.split(':');
  return { task: nn, checker: passLine(kind, nn, stageOf ? stageOf(which) : undefined) };
};
