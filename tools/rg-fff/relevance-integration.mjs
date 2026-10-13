import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapper =
  process.env.RG_FFF_TEST_BINARY ||
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'target/debug/rg-fff'
  );
const temp = mkdtempSync('/tmp/fff-relevance-');
chmodSync(temp, 0o700);
const root = path.join(temp, 'repo');
mkdirSync(root);
const referenceLines = 4500;
const definitionLine = 4005;
const files = {
  'references.ts': 'navTarget();\n'.repeat(referenceLines),
  'late.ts':
    [
      'navTarget();',
      ...Array(definitionLine - 2).fill('unrelated();'),
      'export function navTarget() {}',
      'after();',
    ].join('\n') + '\n',
  'zeta.ts': 'before();\nexport function navTarget() {}\nafter();\n',
  'crlf.ts':
    'before();\r\nnavTarget();\r\nafter();\r\nquiet();\r\nquiet();\r\nbefore();\r\nexport function navTarget() {}\r\nafter();\r\n',
  'false.ts':
    [
      'function other() { navTarget(); }',
      'function another(navTarget) {}',
      'const note = "function navTarget() {}";',
      '// function navTarget() {}',
      '/* function navTarget() {} */',
      'const navTargetAlias = navTarget;',
    ].join('\n') + '\n',
  'upper.ts': 'before();\nexport function NAVTARGET() {}\nafter();\n',
  'colon:name.ts': 'ColonSignal();\n',
  'colon-peer.ts': 'ColonSignal();\n',
};
for (const [name, contents] of Object.entries(files))
  writeFileSync(path.join(root, name), contents);
assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
const baseEnv = {
  ...process.env,
  RG_FFF_NO_FUZZY_FALLBACK: '1',
  RG_FFF_IDLE_SECONDS: '30',
  RG_FFF_DEBUG: '1',
  RIPGREP_CONFIG_PATH: '',
};
delete baseEnv.RG_FFF_FIRST;
delete baseEnv.RG_FFF_LOG;
const children = [];
let comparisons = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(binary, argv, env, argv0) {
  const result = spawnSync(binary, argv, {
    cwd: root,
    env,
    argv0,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function control(argv, env) {
  const result = run(wrapper, argv, env);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function normalized(output) {
  return output
    .split('\n')
    .filter(line => line && line !== '--')
    .map(line => line.replace(/ \[def\]$/, ''))
    .sort();
}

function assertEquivalent(actual, expected, label) {
  assert.equal(actual.status, expected.status, `${label}: status`);
  const actualLines = normalized(actual.stdout);
  const expectedLines = normalized(expected.stdout);
  assert.equal(
    actualLines.length,
    expectedLines.length,
    `${label}: match count`
  );
  const mismatch = actualLines.findIndex(
    (line, index) => line !== expectedLines[index]
  );
  assert.equal(
    mismatch,
    -1,
    `${label}: ${JSON.stringify({ actual: actualLines[mismatch], expected: expectedLines[mismatch] })}`
  );
}

function search(flags, symbol, env, mode) {
  const args = [...flags, symbol];
  const expected = run('rg', ['--no-config', ...args], env);
  const actual = run(wrapper, ['--no-fallback', ...args], env, 'rg');
  assertEquivalent(actual, expected, `${mode} ${args}`);
  assert.match(
    actual.stderr,
    mode === 'warm' ? /daemon hit/ : /fff served \(cold\)/,
    `${mode} ${args}: backend`
  );
  comparisons++;
  return actual.stdout;
}

function matches(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .filter(line => line !== '--')
    .map(line => {
      const match = /^(.+):([0-9]+):([^\n]*)$/.exec(line);
      assert.ok(match, `Invalid match line ${JSON.stringify(line)}`);
      return {
        path: match[1],
        number: Number(match[2]),
        content: match[3],
        definition: line.endsWith(' [def]'),
      };
    });
}

function fileOrder(output) {
  return [...new Set(matches(output).map(item => item.path))];
}

function assertDefinitions(output, ignoreCase = false) {
  const rows = matches(output);
  assert.equal(
    rows.filter(row => row.path === 'references.ts').length,
    referenceLines
  );
  assert.equal(rows.filter(row => row.definition).length, ignoreCase ? 4 : 3);
  assert.ok(rows[0].definition, 'A reference preceded all definitions');
  const definedFiles = new Set(
    rows.filter(row => row.definition).map(row => row.path)
  );
  assert.equal(
    fileOrder(output).findIndex(name => !definedFiles.has(name)),
    definedFiles.size,
    'A reference-only file outranked a definition-bearing file'
  );
  assert.ok(
    rows.filter(row => row.path === 'false.ts').every(row => !row.definition),
    'An unrelated declaration, comment, or string received a definition hint'
  );
  const late = rows.filter(row => row.path === 'late.ts');
  assert.equal(late[0].number, definitionLine);
  assert.equal(late[0].definition, true);
  assert.equal(late[1].number, 1);
  return rows;
}

function assertContext(output) {
  const blocks = output.trimEnd().split('\n--\n');
  assert.ok(
    blocks[0].includes(' [def]'),
    'The first context block contains no definition'
  );
  for (const block of blocks) {
    const rows = block
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const match = /^(.+?)([:-])([0-9]+)\2([^\n]*)$/.exec(line);
        assert.ok(match, `Invalid context line ${JSON.stringify(line)}`);
        return { path: match[1], number: Number(match[3]) };
      });
    assert.ok(rows.every(row => row.path === rows[0].path));
    assert.ok(
      rows.every(
        (row, index) => index === 0 || row.number === rows[index - 1].number + 1
      ),
      'A context window was reordered internally'
    );
  }
  const late = blocks.filter(block => block.startsWith('late.ts'));
  assert.ok(late[0].includes(`late.ts:${definitionLine}:`));
  assert.ok(late[1].includes('late.ts:1:'));
}

function record(name, env, session = '', count = 1, navigation = undefined) {
  for (let index = 0; index < count; index++)
    control(
      ['--record-access', name, session, ...(navigation ? [navigation] : [])],
      env
    );
}

async function rpc(socket, request) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let body = '';
    connection.setTimeout(2000, () =>
      connection.destroy(new Error('Daemon readiness timeout'))
    );
    connection.on('connect', () => connection.end(request));
    connection.on('data', data => {
      body += data.toString();
    });
    connection.on('end', () => resolve(body));
    connection.on('error', reject);
  });
}

async function warm(env) {
  const child = spawn(wrapper, ['--daemon', root], {
    cwd: root,
    env,
    stdio: 'ignore',
  });
  children.push(child);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const dir = path.join(env.RG_FFF_STATE_DIR, 'daemons');
      const name = readdirSync(dir).find(name => name.endsWith('.sock'));
      if (
        name &&
        (await rpc(path.join(dir, name), 'v11\nping\n{}\n')) === '0\n5\nREADY'
      )
        return;
    } catch (error) {
      assert.ok(
        child.exitCode === null,
        `Daemon exited before readiness: ${error.message}`
      );
    }
    await pause(50);
  }
  throw new Error('Daemon did not become ready');
}

try {
  for (const mode of ['cold', 'warm']) {
    const env = {
      ...baseEnv,
      RG_FFF_STATE_DIR: path.join(temp, `${mode}-state`),
      RG_FFF_SESSION: `${mode}-search`,
    };
    if (mode === 'cold') env.RG_FFF_NO_DAEMON = '1';
    else delete env.RG_FFF_NO_DAEMON;
    record('references.ts', env, '', 24);
    if (mode === 'warm') await warm(env);
    const initial = search(['-n'], 'navTarget', env, mode);
    assertDefinitions(initial);
    const contentOrder = fileOrder(initial);
    assert.deepEqual(
      search(['-l'], 'navTarget', env, mode).trim().split('\n'),
      contentOrder,
      'Files-only output lost late definitions or file rank'
    );
    assert.deepEqual(
      search(['-c'], 'navTarget', env, mode)
        .trim()
        .split('\n')
        .map(line => line.slice(0, line.lastIndexOf(':'))),
      contentOrder,
      'Count output changed file rank'
    );
    assertContext(search(['-n', '-C1'], 'navTarget', env, mode));
    record('references.ts', env, env.RG_FFF_SESSION);
    assertDefinitions(search(['-n'], 'navTarget', env, mode));
    assertDefinitions(search(['-n', '-i'], 'navTarget', env, mode), true);
    const definitions = contentOrder.filter(name =>
      ['late.ts', 'zeta.ts', 'crlf.ts'].includes(name)
    );
    const historyTarget = definitions.at(-1);
    record(historyTarget, env, '', 24);
    assert.equal(
      matches(search(['-n'], 'navTarget', env, mode))[0].path,
      historyTarget,
      'Frecency did not order files within the definition tier'
    );
    const preferredDefinition = definitions.find(
      name => name !== historyTarget
    );
    record(preferredDefinition, env, env.RG_FFF_SESSION);
    assert.equal(
      matches(search(['-n'], 'navTarget', env, mode))[0].path,
      preferredDefinition,
      'Query preference did not outrank frecency within the definition tier'
    );
    record('colon-peer.ts', env, '', 24);
    assert.equal(
      matches(search(['-n'], 'ColonSignal', env, mode))[0].path,
      'colon-peer.ts'
    );
    record('colon:name.ts', env, env.RG_FFF_SESSION, 1, `${mode}-navigation`);
    assert.equal(
      matches(search(['-n'], 'ColonSignal', env, mode))[0].path,
      'colon:name.ts',
      'A colon-containing search result was absent from typed query receipts'
    );
    assert.deepEqual(
      JSON.parse(control(['--context', `${mode}-navigation`], env)),
      ['colon:name.ts']
    );
  }
  mkdirSync(path.join(root, 'limits'));
  const overflowingMatches = 50002;
  writeFileSync(
    path.join(root, 'limits/overflow.ts'),
    'OverflowNeedle();\n'.repeat(overflowingMatches)
  );
  const overflowEnv = {
    ...baseEnv,
    RG_FFF_NO_DAEMON: '1',
    RG_FFF_STATE_DIR: path.join(temp, 'overflow-state'),
  };
  const overflowArgs = ['-n', 'OverflowNeedle', 'limits'];
  assert.equal(
    run(wrapper, ['--no-fallback', ...overflowArgs], overflowEnv, 'rg').status,
    2,
    'Exceeded per-file match limits did not request faithful fallback'
  );
  const expectedOverflow = run(
    'rg',
    ['--no-config', ...overflowArgs],
    overflowEnv
  );
  const actualOverflow = run(wrapper, overflowArgs, overflowEnv, 'rg');
  assertEquivalent(
    actualOverflow,
    expectedOverflow,
    'Per-file match limit fallback'
  );
  assert.equal(normalized(actualOverflow.stdout).length, overflowingMatches);
  comparisons++;
  const contextArgs = ['-n', '-C10000', 'navTarget'];
  assert.equal(
    run(wrapper, ['--no-fallback', ...contextArgs], overflowEnv, 'rg').status,
    2,
    'Excessive requested context did not request faithful fallback'
  );
  assertEquivalent(
    run(wrapper, contextArgs, overflowEnv, 'rg'),
    run('rg', ['--no-config', ...contextArgs], overflowEnv),
    'Requested context budget fallback'
  );
  comparisons++;
  process.stdout.write(
    `${comparisons} relevance comparisons passed: cold/warm paging, definitions, context/CRLF, history, query preference, typed receipts, and complete match/context-budget fallback\n`
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(timer);
    }
  }
  rmSync(temp, { recursive: true, force: true });
}
