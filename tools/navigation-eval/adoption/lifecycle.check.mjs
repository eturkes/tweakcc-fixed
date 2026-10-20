import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { directory, fileHash, saveJson, sha256 } from './common.mjs';
import {
  canonicalTempRoots,
  cloneBinary,
  containment,
  executeNative,
  materialize,
  nativeArguments,
  nativeEnvironment,
  verifyContainment,
  verifyFixture,
} from './runtime.mjs';

const { values } = parseArgs({
  options: {
    'baseline-binary': { type: 'string' },
    'candidate-binary': { type: 'string' },
    'disabled-binary': { type: 'string' },
    wrapper: { type: 'string', multiple: true },
    'contain-home': { type: 'boolean', default: false },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(
    [
      'node tools/navigation-eval/adoption/lifecycle.check.mjs',
      '  --baseline-binary PATH --candidate-binary PATH --disabled-binary PATH',
      '  --wrapper PATH [--wrapper PATH ...] --contain-home [--out FRESH_TMP_PATH]',
      'Uses a local fake API key and end_turn SSE responses; never forwards requests.',
    ].join('\n')
  );
  process.exit(0);
}
assert.equal(process.platform, 'darwin', 'Native containment requires macOS');
assert.ok(values['contain-home'], '--contain-home is mandatory');
assert.ok(values.wrapper?.length, 'Supply every embedded wrapper path');
assert.ok(process.env.HOME, 'The existing HOME must be preserved');
const binaries = Object.fromEntries(
  ['baseline', 'candidate', 'disabled'].map(condition => {
    const source = values[`${condition}-binary`];
    assert.ok(source, `--${condition}-binary is mandatory`);
    return [condition, realpathSync(source)];
  })
);
const wrappers = [...new Set(values.wrapper.map(file => realpathSync(file)))];
const sourceHashes = Object.fromEntries(
  Object.entries(binaries).map(([condition, file]) => [
    condition,
    fileHash(file),
  ])
);
const wrapperHashes = wrappers.map(fileHash);
let root;
if (values.out) {
  const output = resolve(values.out);
  assert.ok(!existsSync(output), '--out must name a fresh temporary directory');
  const parent = realpathSync(dirname(output));
  assert.ok(
    canonicalTempRoots().some(temp => {
      const segment = relative(temp, parent);
      return !isAbsolute(segment) && !segment.split('/').includes('..');
    }),
    '--out must be inside a system temporary directory'
  );
  mkdirSync(output, { mode: 0o700 });
  root = realpathSync(output);
} else {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fff-adoption-lifecycle-')));
  chmodSync(root, 0o700);
}
const contract = JSON.parse(
  readFileSync(new URL('./native-contract.v1.json', import.meta.url), 'utf8')
);
const controls = {
  model: contract.aliases.opus,
  outputTokens: 4096,
  perRunUsd: 1,
  maxTurns: 4,
};
const task = {
  effort: 'low',
  prompt: 'Reply with a short acknowledgement.',
  files: { 'source.txt': 'Synthetic lifecycle fixture.\n' },
};
const coreMarker = 'FFF project navigation:';
const descriptionMarker =
  /Native Grep navigation:|Native search and fff files:/;
const autoMarker =
  'start discovery of unknown project files with fff files in Bash';

function transcript(directory, sessionId) {
  assert.match(sessionId, /^[a-f0-9-]{36}$/i);
  const matches = [];
  const pending = [join(directory, 'claude-config')];
  while (pending.length) {
    const folder = pending.pop();
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name === `${sessionId}.jsonl`)
        matches.push(file);
    }
  }
  assert.equal(matches.length, 1, 'Expected one native session transcript');
  chmodSync(matches[0], 0o600);
  const text = readFileSync(matches[0], 'utf8');
  const snapshots = text
    .split('\n')
    .filter(Boolean)
    .filter(line => JSON.parse(line).attachment?.type === 'prompt_snapshot');
  const stored = snapshots.join('\n');
  return {
    path: matches[0],
    text,
    snapshots,
    metadata: {
      snapshotCount: snapshots.length,
      snapshotSha256: snapshots.map(sha256),
      recordedCoreGuidance: stored.includes(coreMarker),
      recordedOwnedDescriptions: descriptionMarker.test(stored),
      recordedAutoGuidance: text.includes(autoMarker),
    },
  };
}

async function run(directory, binary, action, sessionId) {
  const requests = [];
  const rejected = [];
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.match(request.url, /^\/v1\/messages(?:\?[^\r\n]*)?$/);
      assert.equal(requests.length, 0, 'One end_turn request per phase');
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(
          size <= 8 * 1024 * 1024,
          'Request exceeds the local body cap'
        );
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const body = JSON.parse(bytes.toString('utf8'));
      assert.equal(body.model, controls.model);
      assert.equal(body.output_config?.effort, task.effort);
      assert.ok(body.max_tokens <= controls.outputTokens);
      assert.ok(Array.isArray(body.tools));
      const descriptions = body.tools.map(tool => ({
        name: tool.name,
        text: tool.description ?? '',
      }));
      const system = (body.system ?? [])
        .map(part => part.text ?? '')
        .join('\n');
      requests.push({
        model: body.model,
        effort: body.output_config.effort,
        requestSha256: sha256(bytes),
        coreGuidancePresent: system.includes(coreMarker),
        autoGuidancePresent: JSON.stringify(body.messages).includes(autoMarker),
        ownedDescriptionNames: descriptions
          .filter(tool => descriptionMarker.test(tool.text))
          .map(tool => tool.name)
          .sort(),
        toolNames: descriptions.map(tool => tool.name).sort(),
        inputSchemaSha256: Object.fromEntries(
          body.tools.map(tool => [
            tool.name,
            sha256(JSON.stringify(tool.input_schema)),
          ])
        ),
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const emit = (type, fields) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
        );
      emit('message_start', {
        message: {
          id: `msg_local_lifecycle_${randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      emit('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      emit('content_block_delta', {
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'Synthetic lifecycle probe completed.',
        },
      });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      emit('message_stop', {});
      response.end();
    } catch {
      rejected.push({ reason: 'invalid-local-lifecycle-request' });
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: 'Local lifecycle request rejected.',
          },
        })
      );
    }
  });
  const profile = containment(directory, root, [binary], wrappers, []);
  const isolation = verifyContainment(profile, directory);
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  let result;
  try {
    const args = nativeArguments(binary, profile, task, directory, controls);
    assert.ok(args.includes('--no-session-persistence'));
    args.splice(args.indexOf('--no-session-persistence'), 1);
    args[args.indexOf('--system-prompt-snapshot') + 1] = 'on';
    if (sessionId) args.push('--resume', sessionId);
    const env = nativeEnvironment(
      directory,
      server.address().port,
      task.effort,
      controls
    );
    delete env.CLAUDE_CODE_SKIP_PROMPT_HISTORY;
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.ANTHROPIC_API_KEY, 'synthetic-local-probe');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    result = await executeNative(args, join(directory, 'fixture'), env, 45);
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
  }
  writeFileSync(join(directory, `${action}-events.jsonl`), result.stdout, {
    mode: 0o600,
  });
  writeFileSync(join(directory, `${action}-stderr.txt`), result.stderr, {
    mode: 0o600,
  });
  assert.equal(
    result.status,
    0,
    `Native ${action} failed; private artifacts are under --out`
  );
  assert.equal(result.timedOut, false);
  assert.equal(rejected.length, 0);
  assert.equal(requests.length, 1);
  const events = result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const completed = events.find(event => event.type === 'result');
  assert.ok(
    completed && !completed.is_error,
    'Native result must be successful'
  );
  if (sessionId) assert.equal(completed.session_id, sessionId);
  const saved = transcript(directory, completed.session_id);
  assert.ok(
    saved.snapshots.length > 0,
    'Native prompt recording must be active'
  );
  assert.equal(verifyFixture(task, join(directory, 'fixture')), true);
  const report = {
    action,
    status: result.status,
    sessionId: completed.session_id,
    transcript: saved.path,
    ...saved.metadata,
    requests,
    priorTempReadsDenied: isolation.canonicalTempRoots.every(
      row => row.readsDenied
    ),
    priorTempWritesDenied: isolation.canonicalTempRoots.every(
      row => row.writesDenied
    ),
    currentTrialReadWriteAllowed: isolation.currentTrialReadWriteAllowed,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    forwardedRequests: 0,
    paidRequests: 0,
  };
  saveJson(join(directory, `${action}-report.json`), report);
  return { report, saved };
}

const legacyDirectory = directory(join(root, 'legacy'));
const candidateDirectory = directory(join(root, 'candidate'));
materialize(task, legacyDirectory);
materialize(task, candidateDirectory);
const baseline = cloneBinary(
  binaries.baseline,
  join(legacyDirectory, 'native-baseline')
);
const disabled = cloneBinary(
  binaries.disabled,
  join(legacyDirectory, 'native-disabled')
);
const candidate = cloneBinary(
  binaries.candidate,
  join(candidateDirectory, 'native-candidate')
);
const recorded = await run(legacyDirectory, baseline.path, 'baseline-record');
assert.equal(recorded.report.recordedOwnedDescriptions, true);
assert.equal(recorded.report.recordedCoreGuidance, false);
assert.deepEqual(recorded.report.requests[0].ownedDescriptionNames, [
  'Bash',
  'Grep',
]);
assert.equal(recorded.report.requests[0].coreGuidancePresent, false);
const resumed = await run(
  legacyDirectory,
  disabled.path,
  'disabled-resume',
  recorded.report.sessionId
);
assert.ok(
  resumed.saved.text.startsWith(recorded.saved.text),
  'Resume must only append native transcript rows'
);
assert.deepEqual(
  resumed.saved.snapshots.slice(0, recorded.saved.snapshots.length),
  recorded.saved.snapshots
);
assert.equal(resumed.report.recordedOwnedDescriptions, true);
assert.equal(resumed.report.requests[0].coreGuidancePresent, false);
assert.equal(resumed.report.requests[0].autoGuidancePresent, false);
assert.deepEqual(resumed.report.requests[0].ownedDescriptionNames, []);
const fresh = await run(candidateDirectory, candidate.path, 'candidate-record');
assert.equal(fresh.report.recordedCoreGuidance, false);
assert.equal(fresh.report.recordedOwnedDescriptions, false);
assert.equal(fresh.report.recordedAutoGuidance, false);
assert.equal(fresh.report.requests[0].coreGuidancePresent, true);
assert.deepEqual(fresh.report.requests[0].ownedDescriptionNames, []);
const baselineRequest = recorded.report.requests[0];
const disabledRequest = resumed.report.requests[0];
const candidateRequest = fresh.report.requests[0];
assert.ok(
  ['Bash', 'Grep', 'Glob'].every(name =>
    baselineRequest.toolNames.includes(name)
  )
);
assert.deepEqual(candidateRequest.toolNames, baselineRequest.toolNames);
assert.deepEqual(
  disabledRequest.toolNames,
  baselineRequest.toolNames.filter(name => !['Glob', 'Grep'].includes(name))
);
for (const name of disabledRequest.toolNames)
  assert.equal(
    disabledRequest.inputSchemaSha256[name],
    baselineRequest.inputSchemaSha256[name],
    `Native ${name} input schema changed`
  );
for (const name of candidateRequest.toolNames)
  assert.equal(
    candidateRequest.inputSchemaSha256[name],
    baselineRequest.inputSchemaSha256[name],
    `Candidate ${name} input schema changed`
  );
for (const [condition, file] of Object.entries(binaries))
  assert.equal(fileHash(file), sourceHashes[condition]);
assert.deepEqual(wrappers.map(fileHash), wrapperHashes);
const summary = {
  schemaVersion: 1,
  purpose: 'Local-only native instruction recording, disable, and resume proof',
  nativeVersion: contract.nativeVersion,
  authMode: 'synthetic-api-key',
  paidRequests: 0,
  forwardedRequests: 0,
  sourceBinarySha256: sourceHashes,
  wrapperSha256: [...new Set(wrapperHashes)],
  protocolSourceSha256: Object.fromEntries(
    [
      'lifecycle.check.mjs',
      'runtime.mjs',
      'common.mjs',
      'native-contract.v1.json',
      '../core.mjs',
    ].map(name => [name, fileHash(new URL(name, import.meta.url))])
  ),
  checks: {
    homePreserved: true,
    homeContainmentRequired: true,
    syntheticConfigOnly: true,
    existingInstructionFilesEdited: [],
    inputBinariesAndWrappersUnchanged: true,
    legacySnapshotRowsUnchanged: true,
    resumeOnlyAppendedNativeRows: true,
    nativeOffToolFiltersPreserved: true,
    commonInputSchemasUnchanged: true,
  },
  phases: [recorded.report, resumed.report, fresh.report].map(report => ({
    action: report.action,
    status: report.status,
    snapshotCount: report.snapshotCount,
    recordedCoreGuidance: report.recordedCoreGuidance,
    recordedOwnedDescriptions: report.recordedOwnedDescriptions,
    recordedAutoGuidance: report.recordedAutoGuidance,
    priorTempReadsDenied: report.priorTempReadsDenied,
    priorTempWritesDenied: report.priorTempWritesDenied,
    currentTrialReadWriteAllowed: report.currentTrialReadWriteAllowed,
    requestCount: report.requests.length,
    coreGuidanceSent: report.requests[0].coreGuidancePresent,
    ownedDescriptionNamesSent: report.requests[0].ownedDescriptionNames,
    toolCount: report.requests[0].toolNames.length,
    toolNamesSha256: sha256(JSON.stringify(report.requests[0].toolNames)),
  })),
};
saveJson(join(root, 'lifecycle-summary.json'), summary);
console.log(
  JSON.stringify({
    checked: true,
    paidRequests: 0,
    phases: summary.phases.length,
    artifact: join(root, 'lifecycle-summary.json'),
  })
);
