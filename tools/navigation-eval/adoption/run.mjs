import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { directory, fileHash, redactor, saveJson, sha256 } from './common.mjs';
import { inspectEvidence, parseEvents } from './evidence.mjs';
import { startProxy } from './proxy.mjs';
import {
  accountAuth,
  canonicalTempRoots,
  cloneBinary,
  containment,
  executeNative,
  materialize,
  nativeArguments,
  nativeEnvironment,
  promptPersistence,
  verifyArtifacts,
  verifyContainment,
  verifyFixture,
} from './runtime.mjs';

const owningDirectory = dirname(fileURLToPath(import.meta.url));
const nativeContract = JSON.parse(
  readFileSync(join(owningDirectory, 'native-contract.v1.json'), 'utf8')
);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'baseline-binary': { type: 'string' },
    'candidate-binary': { type: 'string' },
    wrapper: { type: 'string', multiple: true },
    tasks: { type: 'string', default: join(owningDirectory, 'tasks.v1.json') },
    only: { type: 'string', multiple: true },
    out: { type: 'string' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    'contain-home': { type: 'boolean', default: false },
    'allow-live': { type: 'boolean', default: false },
    'probe-account-auth': { type: 'boolean', default: false },
    'max-runs': { type: 'string', default: '4' },
    'max-api-requests': { type: 'string', default: '48' },
    'per-run-usd': { type: 'string', default: '1.10' },
    'total-usd': { type: 'string', default: '4' },
    'previous-spend-usd': { type: 'string', default: '0' },
    'max-turns': { type: 'string', default: '12' },
    'timeout-seconds': { type: 'string', default: '150' },
    'output-tokens': { type: 'string', default: '4096' },
    'guidance-marker': { type: 'string', default: 'FFF project navigation:' },
    'probe-report': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
const action = positionals[0] ?? 'plan';
if (values.help) {
  console.log(
    [
      'node tools/navigation-eval/adoption/run.mjs plan|probe|run',
      '  --baseline-binary PATH --candidate-binary PATH --wrapper PATH',
      '  --only approximate-proration-filename --only unhelpful-filename-cue',
      '  --contain-home [--out PATH]',
      '  probe --probe-account-auth matches the live OAuth tool catalog',
      '  run requires --allow-live --probe-report PATH',
      '  Budget: --per-run-usd 1.10 --total-usd 4 --previous-spend-usd AMOUNT',
      '  --max-runs 4 --max-api-requests 48 --max-turns 12',
      '  --timeout-seconds 150 --output-tokens 4096',
    ].join('\n')
  );
  process.exit(0);
}
assert.ok(['plan', 'probe', 'run'].includes(action));
assert.ok(values['baseline-binary'] && values['candidate-binary']);
assert.ok(
  values.wrapper?.length > 0,
  'Explicit embedded wrapper paths are required'
);
const suiteBytes = readFileSync(values.tasks);
if (resolve(values.tasks) === join(owningDirectory, 'tasks.v1.json')) {
  const lock = JSON.parse(
    readFileSync(join(owningDirectory, 'integrity.v1.json'), 'utf8')
  );
  assert.equal(sha256(suiteBytes), lock.tasksSha256, 'Frozen tasks changed');
}
const suite = JSON.parse(suiteBytes);
const selectedIds = values.only ?? [
  'approximate-proration-filename',
  'unhelpful-filename-cue',
];
const tasks = selectedIds.map(id => {
  const task = suite.tasks.find(item => item.id === id);
  assert.ok(task, `Unknown task: ${id}`);
  assert.ok(['low', 'medium'].includes(task.effort));
  for (const [file, body] of Object.entries(task.files)) {
    assert.ok(!file.startsWith('/') && !file.split('/').includes('..'));
    assert.equal(typeof body, 'string');
    assert.ok(
      !/(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.claude|\.mcp\.json)(?:\/|$)/.test(
        file
      )
    );
  }
  return task;
});
assert.equal(new Set(selectedIds).size, selectedIds.length);
const ranked = [...tasks].sort((a, b) =>
  sha256(`${suite.seed}/pair/${a.id}`).localeCompare(
    sha256(`${suite.seed}/pair/${b.id}`)
  )
);
const first = [...tasks].sort((a, b) =>
  sha256(`${suite.seed}/order/${a.id}`).localeCompare(
    sha256(`${suite.seed}/order/${b.id}`)
  )
);
const plan = ranked.flatMap(task => {
  const baselineFirst = first.findIndex(item => item.id === task.id) % 2 === 0;
  return (
    baselineFirst ? ['baseline', 'candidate'] : ['candidate', 'baseline']
  ).map(condition => ({ taskId: task.id, effort: task.effort, condition }));
});
const controls = {
  model: values.model,
  tools: 'native defaults; no --tools or --allowedTools option',
  mechanism: 'paired native binaries; no CLI system appendix',
  tasksSha256: sha256(suiteBytes),
  selectedTaskIds: selectedIds,
  seed: suite.seed,
  maxRuns: Number(values['max-runs']),
  maxApiRequests: Number(values['max-api-requests']),
  perRunUsd: Number(values['per-run-usd']),
  totalUsd: Number(values['total-usd']),
  previousSpendUsd: Number(values['previous-spend-usd']),
  maxTurns: Number(values['max-turns']),
  timeoutSeconds: Number(values['timeout-seconds']),
  outputTokens: Number(values['output-tokens']),
  sourceBinarySha256: {
    baseline: fileHash(values['baseline-binary']),
    candidate: fileHash(values['candidate-binary']),
  },
  wrapperSha256: values.wrapper.map(fileHash),
  homeContainmentRequested: values['contain-home'],
  canonicalTempRoots: canonicalTempRoots(),
  noSpeedClaim: true,
  authMode:
    action === 'probe' && !values['probe-account-auth']
      ? 'synthetic-api-key'
      : 'account-oauth',
  nativeVersion: nativeContract.nativeVersion,
  nativeModelIds: [
    ...new Set([values.model, ...Object.values(nativeContract.aliases)]),
  ],
  nativeRequestClasses: nativeContract.requestClasses,
  nativeEfforts: nativeContract.efforts,
  provenanceHeadersEnabled: nativeContract.enableProvenance,
  descriptionGuidance: {
    baseline: { grep: true, bash: true },
    candidate: { grep: false, bash: false },
  },
  protocolSourceSha256: Object.fromEntries(
    [
      'run.mjs',
      'runtime.mjs',
      'proxy.mjs',
      'evidence.mjs',
      'common.mjs',
      'native-contract.v1.json',
      '../core.mjs',
    ].map(name => [name, fileHash(join(owningDirectory, name))])
  ),
};
for (const key of [
  'maxRuns',
  'maxApiRequests',
  'perRunUsd',
  'totalUsd',
  'maxTurns',
  'timeoutSeconds',
  'outputTokens',
]) {
  assert.ok(Number.isFinite(controls[key]) && controls[key] > 0);
}
assert.ok(
  Number.isFinite(controls.previousSpendUsd) && controls.previousSpendUsd >= 0
);
assert.ok(plan.length <= controls.maxRuns);
assert.equal(
  new Set(controls.wrapperSha256).size,
  1,
  'Paired conditions must share wrapper bytes'
);
if (action === 'plan') {
  console.log(JSON.stringify({ controls, plan, paidRequests: 0 }, null, 2));
  process.exit(0);
}
assert.equal(
  process.platform,
  'darwin',
  'Native containment currently requires macOS'
);
assert.ok(values['contain-home'], 'Explicit --contain-home is required');
assert.ok(
  action === 'probe' || values['allow-live'],
  'Live runs require --allow-live'
);
if (values.out && existsSync(values.out)) {
  assert.equal(
    readdirSync(values.out).length,
    0,
    'Output directory must be new or empty'
  );
}
const outputRoot = directory(
  values.out
    ? resolve(values.out)
    : mkdtempSync(join(tmpdir(), 'fff-adoption-'))
);
const binaries = Object.fromEntries(
  ['baseline', 'candidate'].map((condition, index) => [
    condition,
    cloneBinary(
      values[`${condition}-binary`],
      join(outputRoot, `native-${index + 1}`)
    ),
  ])
);
const state = { requests: 0, reportedSpend: controls.previousSpendUsd };
let auth = { secrets: [] };
let expectedToolNames;
if (action === 'run') {
  assert.ok(
    values['probe-report'],
    'A successful same-binary default-tool probe is required'
  );
  const probe = JSON.parse(readFileSync(values['probe-report'], 'utf8'));
  assert.equal(probe.isolationVerified, true);
  assert.equal(probe.nativeAgentVerified, true);
  assert.equal(probe.controls.authMode, controls.authMode);
  assert.deepEqual(
    probe.controls.sourceBinarySha256,
    controls.sourceBinarySha256
  );
  assert.deepEqual(probe.controls.wrapperSha256, controls.wrapperSha256);
  assert.equal(probe.controls.model, controls.model);
  assert.equal(probe.controls.tasksSha256, controls.tasksSha256);
  assert.equal(probe.controls.outputTokens, controls.outputTokens);
  assert.deepEqual(
    probe.controls.protocolSourceSha256,
    controls.protocolSourceSha256
  );
  assert.deepEqual(probe.controls.nativeModelIds, controls.nativeModelIds);
  assert.deepEqual(
    probe.controls.descriptionGuidance,
    controls.descriptionGuidance
  );
  expectedToolNames = probe.rows[0].requests.find(
    request => request.requestClass === 'main'
  ).toolNames;
}
if (action === 'run' || (action === 'probe' && values['probe-account-auth']))
  auth = accountAuth();
const clean = redactor(auth.secrets);
const rows = [];
const sequence =
  action === 'probe'
    ? [
        { taskId: 'probe', effort: 'low', condition: 'baseline' },
        { taskId: 'probe', effort: 'medium', condition: 'candidate' },
        {
          taskId: 'probe-agent',
          effort: 'medium',
          condition: 'baseline',
          scenario: 'agent',
        },
        {
          taskId: 'probe-agent',
          effort: 'low',
          condition: 'candidate',
          scenario: 'agent',
        },
      ]
    : plan;
saveJson(join(outputRoot, 'plan.json'), { controls, plan }, clean);
for (const name of Object.keys(controls.protocolSourceSha256)) {
  const target = name.startsWith('../')
    ? join(outputRoot, 'protocol', name.slice(3))
    : join(outputRoot, 'protocol', 'adoption', name);
  directory(dirname(target));
  const bytes = readFileSync(join(owningDirectory, name));
  assert.equal(sha256(bytes), controls.protocolSourceSha256[name]);
  writeFileSync(target, bytes, { mode: 0o600 });
}
for (const [index, item] of sequence.entries()) {
  if (
    action === 'run' &&
    state.reportedSpend + controls.perRunUsd > controls.totalUsd
  )
    break;
  const task =
    action === 'probe'
      ? {
          id: item.taskId,
          effort: item.effort,
          prompt:
            item.scenario === 'agent'
              ? 'Local-only native Agent capability probe.'
              : 'Local-only transport smoke.',
          files: {
            'src/RetryPolicy.ts': 'export const syntheticMarker = true;\n',
          },
          requiredFiles:
            item.scenario === 'agent' ? ['src/RetryPolicy.ts'] : [],
        }
      : tasks.find(task => task.id === item.taskId);
  const root = directory(
    join(outputRoot, `trial-${String(index + 1).padStart(2, '0')}`)
  );
  const cwd = materialize(task, root);
  const profile = containment(
    root,
    outputRoot,
    Object.values(binaries).map(binary => binary.path),
    values.wrapper,
    [values.tasks]
  );
  const proxy = await startProxy({
    controls,
    effort: task.effort,
    state,
    mock: action === 'probe',
    marker: values['guidance-marker'],
    expectedToolNames,
    expectedGuidancePresence: item.condition === 'candidate',
    expectedDescriptionGuidance: controls.descriptionGuidance[item.condition],
    mockScenario: item.scenario ?? 'fff',
    mockSourceFile: join(cwd, 'src/RetryPolicy.ts'),
  });
  const containmentValidation = verifyContainment(profile, root);
  const args = nativeArguments(
    binaries[item.condition].path,
    profile,
    task,
    root,
    controls
  );
  const env = nativeEnvironment(
    root,
    proxy.port,
    task.effort,
    controls,
    auth.token
  );
  let processResult;
  try {
    processResult = await executeNative(
      args,
      cwd,
      env,
      controls.timeoutSeconds
    );
  } finally {
    await proxy.close();
  }
  const events = parseEvents(processResult.stdout);
  const final = events.findLast(event => event.type === 'result');
  const evidence = inspectEvidence(events, cwd, task.requiredFiles);
  const cost = action === 'probe' ? 0 : (final?.total_cost_usd ?? null);
  state.reportedSpend += cost ?? controls.perRunUsd;
  const row = {
    ...item,
    number: index + 1,
    status: processResult.status,
    timedOut: processResult.timedOut,
    resultType: final?.subtype ?? null,
    isError: final?.is_error ?? null,
    cost,
    nativeAccounting: final
      ? {
          totalCostUsd: final.total_cost_usd,
          modelUsage: final.modelUsage,
          usage: final.usage,
          numTurns: final.num_turns,
          subagentStats: final.subagentStats,
        }
      : null,
    answer: final?.result ?? '',
    fixtureUnchanged: verifyFixture(task, cwd),
    containmentValidation,
    possiblePromptPersistenceArtifacts: promptPersistence(root),
    requests: proxy.requests,
    evidence,
    agentStreamProvenance: events
      .filter(
        event =>
          event.agent_id ||
          event.parent_tool_use_id ||
          ['task_started', 'task_progress', 'task_notification'].includes(
            event.subtype
          )
      )
      .map(event => ({
        type: event.type,
        subtype: event.subtype,
        agentIdSha256: event.agent_id ? sha256(event.agent_id) : null,
        taskIdSha256: event.task_id ? sha256(event.task_id) : null,
        parentToolUseId: event.parent_tool_use_id ?? null,
        toolUseId: event.tool_use_id ?? null,
        subagentType: event.subagent_type ?? null,
      })),
    nativeInit: events
      .filter(event => event.type === 'system' && event.subtype === 'init')
      .map(event => ({
        tools: event.tools,
        model: event.model,
        plugins: event.plugins,
        mcpServers: event.mcp_servers,
      })),
  };
  writeFileSync(join(root, 'output.jsonl'), clean(processResult.stdout), {
    mode: 0o600,
  });
  writeFileSync(join(root, 'stderr.txt'), clean(processResult.stderr), {
    mode: 0o600,
  });
  saveJson(join(root, 'tool-evidence.json'), evidence, clean);
  saveJson(join(root, 'request-metadata.json'), proxy.requests, clean);
  saveJson(
    join(root, 'timing.json'),
    { elapsedSeconds: processResult.elapsedSeconds, noSpeedClaim: true },
    clean
  );
  saveJson(
    join(root, 'checked-facts.json'),
    {
      answer: row.answer,
      expectedFacts: task.expectedFacts ?? [],
      requiresManualReview: true,
    },
    clean
  );
  saveJson(join(root, 'summary.json'), row, clean);
  assert.ok(row.fixtureUnchanged, 'Synthetic fixture changed');
  verifyArtifacts(root, auth.secrets);
  for (const [condition, binary] of Object.entries(binaries)) {
    assert.equal(fileHash(binary.path), binary.sha256);
    assert.equal(fileHash(values[`${condition}-binary`]), binary.sourceSha256);
  }
  assert.deepEqual(values.wrapper.map(fileHash), controls.wrapperSha256);
  rows.push(row);
  saveJson(
    join(outputRoot, 'report.json'),
    {
      controls,
      plan,
      rows,
      forwardedRequests: state.requests,
      totalReportedSpendUsd: state.reportedSpend,
    },
    clean
  );
  console.log(
    JSON.stringify({
      number: row.number,
      ...item,
      status: row.status,
      isError: row.isError,
      cost,
      fffAttempts: evidence.fff.length,
      successfulFffHeaders: evidence.fff.filter(call => call.successfulHeader)
        .length,
      coreGuidancePresent: proxy.requests
        .filter(request => request.model)
        .map(request => request.coreGuidancePresent),
      fixtureUnchanged: row.fixtureUnchanged,
    })
  );
  if (
    action === 'run' &&
    (cost === null || state.reportedSpend >= controls.totalUsd)
  )
    break;
}
if (action === 'probe') {
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.status, 0);
    assert.equal(row.isError, false);
    if (row.scenario === 'agent') {
      const launch = row.evidence.calls.find(call => call.name === 'Agent');
      assert.ok(launch);
      assert.equal(launch.input.model, undefined);
      assert.equal(launch.input.effort, undefined);
      const childRequests = row.requests.filter(
        request => request.requestClass === 'subagent'
      );
      assert.ok(childRequests.length >= 2);
      for (const request of childRequests) {
        assert.equal(request.agentType, 'Explore');
        assert.equal(request.model, controls.model);
        assert.equal(request.effort, row.effort);
        assert.equal(request.maxTokens, controls.outputTokens);
        assert.ok(request.agentIdSha256);
        assert.ok(
          row.agentStreamProvenance.some(
            event =>
              event.agentIdSha256 === request.agentIdSha256 &&
              event.parentToolUseId === launch.id
          )
        );
      }
      assert.ok(
        row.evidence.requiredFiles[0].evidence.some(
          location =>
            location.kind === 'Read' && location.parentToolUseId === launch.id
        )
      );
    } else {
      assert.ok(row.evidence.fff.some(call => call.successfulHeader));
    }
    assert.ok(
      row.requests
        .filter(request => request.model)
        .every(
          request =>
            request.coreGuidancePresent === (row.condition === 'candidate')
        )
    );
  }
  const defaultTools = rows[0].requests.find(
    request => request.requestClass === 'main'
  ).toolNames;
  for (const row of rows)
    assert.deepEqual(
      row.requests.find(request => request.requestClass === 'main').toolNames,
      defaultTools
    );
  saveJson(
    join(outputRoot, 'report.json'),
    {
      controls,
      rows,
      paidRequests: 0,
      forwardedRequests: state.requests,
      isolationVerified: true,
      nativeAgentVerified: true,
    },
    clean
  );
}
console.log(
  JSON.stringify({
    report: join(outputRoot, 'report.json'),
    completedRuns: rows.length,
    forwardedRequests: state.requests,
    totalReportedSpendUsd: state.reportedSpend,
    noSpeedClaim: true,
  })
);
