import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { startProxy } from './proxy.mjs';

const contract = JSON.parse(
  readFileSync(new URL('./native-contract.v1.json', import.meta.url), 'utf8')
);
const controls = {
  model: contract.aliases.opus,
  nativeModelIds: Object.values(contract.aliases),
  nativeRequestClasses: contract.requestClasses,
  nativeEfforts: contract.efforts,
  outputTokens: 4096,
  maxApiRequests: 1,
};
const main = {
  model: controls.model,
  output_config: { effort: 'low' },
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'Local-only guard validation.' }],
  stream: true,
  system: [],
  tools: [
    {
      name: 'Bash',
      description: 'Native Bash description',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  ],
};
const child = {
  ...main,
  model: contract.aliases.sonnet,
  output_config: { effort: 'high' },
  tools: [
    {
      name: 'Read',
      description: 'Native Read description',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    },
  ],
};
async function send(proxy, body, requestClass, agentId) {
  const result = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(requestClass && { 'x-claude-code-request-class': requestClass }),
      ...(agentId && { 'x-claude-code-agent-id': agentId }),
    },
    body: JSON.stringify(body),
  });
  await result.text();
  return result.status;
}
async function sendTarget(proxy, target) {
  const body = JSON.stringify(main);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: proxy.port,
        path: target,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'x-claude-code-request-class': 'main',
          authorization: 'Bearer synthetic-negative-test',
        },
      },
      response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      }
    );
    request.setTimeout(5000, () =>
      request.destroy(new Error('Local guard timeout'))
    );
    request.once('error', reject);
    request.end(body);
  });
}
const proxy = await startProxy({
  controls,
  effort: 'low',
  state: { requests: 0 },
  mock: true,
  marker: 'FFF project navigation:',
  expectedToolNames: ['Bash'],
  expectedGuidancePresence: false,
  expectedDescriptionGuidance: { grep: false, bash: false },
});
try {
  assert.equal(await send(proxy, main, 'main'), 200);
  assert.equal(await send(proxy, child, 'subagent', 'synthetic-child'), 200);
  assert.equal(
    await send(proxy, { ...main, model: contract.aliases.sonnet }, 'main'),
    403
  );
  assert.equal(
    await send(proxy, { ...main, output_config: { effort: 'medium' } }, 'main'),
    403
  );
  assert.equal(await send(proxy, child, 'subagent'), 403);
  assert.equal(
    await send(
      proxy,
      { ...child, max_tokens: 4097 },
      'subagent',
      'synthetic-child'
    ),
    403
  );
  assert.equal(
    await send(
      proxy,
      { ...child, model: 'unverified-model' },
      'subagent',
      'synthetic-child'
    ),
    403
  );
  assert.equal(await send(proxy, main), 403);
  assert.equal(await sendTarget(proxy, '/v1/messages?beta=true'), 200);
  assert.ok(proxy.requests.every(request => request.forwarded === false));
  assert.equal(proxy.requests[1].requestClass, 'subagent');
  assert.ok(proxy.requests[1].agentIdSha256);
} finally {
  await proxy.close();
}
const targetState = { requests: 0 };
const targetGuard = await startProxy({
  controls,
  effort: 'low',
  state: targetState,
  mock: false,
  marker: 'FFF project navigation:',
  expectedToolNames: ['Bash'],
  expectedGuidancePresence: false,
  expectedDescriptionGuidance: { grep: false, bash: false },
});
try {
  for (const target of [
    'https://other.invalid/v1/messages',
    '//other.invalid/v1/messages',
    '/\\other.invalid/v1/messages',
    'https://api.anthropic.com/v1/messages',
  ]) {
    assert.equal(await sendTarget(targetGuard, target), 403);
  }
  assert.equal(targetState.requests, 0);
  assert.ok(targetGuard.requests.every(request => request.forwarded === false));
  assert.ok(
    targetGuard.requests.every(
      request => request.rejected === 'invalid-request-target'
    )
  );
  assert.ok(
    !JSON.stringify(targetGuard.requests).includes('synthetic-negative-test')
  );
} finally {
  await targetGuard.close();
}
const capped = await startProxy({
  controls,
  effort: 'low',
  state: { requests: controls.maxApiRequests },
  mock: false,
  marker: 'FFF project navigation:',
  expectedGuidancePresence: false,
});
try {
  assert.equal(await send(capped, main, 'main'), 403);
  assert.equal(await send(capped, child, 'subagent', 'synthetic-child'), 403);
  assert.ok(capped.requests.every(request => request.forwarded === false));
} finally {
  await capped.close();
}
console.log(JSON.stringify({ checked: true, paidRequests: 0, cases: 15 }));
