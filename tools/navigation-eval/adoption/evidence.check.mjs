import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectEvidence } from './evidence.mjs';
import { nativeArguments } from './runtime.mjs';

const corpus = mkdtempSync(join(tmpdir(), 'adoption-evidence-'));
mkdirSync(join(corpus, 'src'));
const alpha = 'export function alphaPolicy() {\n  return 17000;\n}\n';
const beta = 'export function betaPolicy() {\n  return 117000;\n}\n';
writeFileSync(join(corpus, 'src/alpha.ts'), alpha);
writeFileSync(join(corpus, 'src/beta.ts'), beta);
const use = (id, name, input) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id, content, isError = false) => ({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: id, content, is_error: isError },
    ],
  },
});
try {
  const brace = inspectEvidence(
    [
      use('brace', 'Bash', { command: 'cat src/alpha.ts' }),
      result('brace', '}'),
    ],
    corpus,
    ['src/alpha.ts']
  );
  assert.equal(brace.requiredFiles[0].evidence.length, 0);
  const wrongOperand = inspectEvidence(
    [
      use('wrong', 'Bash', { command: 'cat src/beta.ts' }),
      result('wrong', alpha),
    ],
    corpus,
    ['src/alpha.ts']
  );
  assert.equal(wrongOperand.requiredFiles[0].evidence.length, 0);
  const candidates = inspectEvidence(
    [
      use('fff', 'Bash', { command: "fff files 'alpha'" }),
      result(
        'fff',
        '# fff: ranked fuzzy filenames; verify candidate files by reading them\nsrc/alpha.ts [modified] -> Read\n'
      ),
      use('read', 'Bash', { command: 'cd src; cat -n alpha.ts' }),
      result(
        'read',
        '     1\texport function alphaPolicy() {\n     2\t  return 17000;\n     3\t}\n'
      ),
    ],
    corpus,
    ['src/alpha.ts']
  );
  assert.deepEqual(candidates.fff[0].candidates, ['src/alpha.ts']);
  assert.deepEqual(candidates.fff[0].inspectedCandidatePaths, ['src/alpha.ts']);
  assert.ok(candidates.requiredFiles[0].evidence.length > 0);
  const loop = inspectEvidence(
    [
      use('loop', 'Bash', {
        command: 'for f in src/alpha.ts src/beta.ts; do cat -n "$f"; done',
      }),
      result(
        'loop',
        '     1\texport function alphaPolicy() {\n     2\t  return 17000;\n     3\t}\n     1\texport function betaPolicy() {\n     2\t  return 117000;\n     3\t}\n'
      ),
    ],
    corpus,
    ['src/alpha.ts', 'src/beta.ts']
  );
  assert.ok(loop.requiredFiles.every(file => file.evidence.length > 0));
  const emptyFff = inspectEvidence(
    [
      use('empty', 'Bash', { command: "fff files 'missing'" }),
      result(
        'empty',
        '# fff: ranked fuzzy filenames; verify candidate files by reading them\n'
      ),
    ],
    corpus
  );
  assert.equal(emptyFff.fff[0].successfulHeader, true);
  assert.deepEqual(emptyFff.fff[0].candidates, []);
  const earlyRead = inspectEvidence(
    [
      use('early', 'Read', { file_path: join(corpus, 'src/alpha.ts') }),
      result(
        'early',
        '1→export function alphaPolicy() {\n2→  return 17000;\n3→}\n'
      ),
      use('later', 'Bash', { command: "fff files 'alpha'" }),
      result(
        'later',
        '# fff: ranked fuzzy filenames; verify candidate files by reading them\nsrc/alpha.ts -> Read\n'
      ),
    ],
    corpus
  );
  assert.deepEqual(earlyRead.fff[0].inspectedCandidatePaths, []);
  const childRead = use('child-read', 'Bash', { command: 'cat src/beta.ts' });
  childRead.agent_id = 'synthetic-child';
  childRead.parent_tool_use_id = 'parent-agent-call';
  const scopes = inspectEvidence(
    [
      use('parent-read', 'Bash', { command: 'cd src; cat alpha.ts' }),
      result('parent-read', alpha),
      childRead,
      result('child-read', beta),
    ],
    corpus,
    ['src/beta.ts']
  );
  assert.ok(scopes.requiredFiles[0].evidence.length > 0);
  assert.equal(scopes.requiredFiles[0].evidence[0].agentId, 'synthetic-child');
  assert.equal(
    scopes.requiredFiles[0].evidence[0].parentToolUseId,
    'parent-agent-call'
  );
  const args = nativeArguments(
    '/tmp/binary',
    '/tmp/profile',
    { prompt: 'fixture', effort: 'low' },
    '/tmp/trial',
    { model: 'fixture', perRunUsd: 1.1, maxTurns: 12 }
  );
  assert.ok(
    !args.some(value =>
      /^(?:--tools|--allowedTools|--append-system-prompt)/.test(value)
    )
  );
  console.log(JSON.stringify({ checked: true, paidRequests: 0, cases: 8 }));
} finally {
  rmSync(corpus, { recursive: true, force: true });
}
