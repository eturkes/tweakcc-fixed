import http from 'node:http';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { sha256 } from './common.mjs';

function excerpt(text, marker) {
  const start = text.indexOf(marker);
  return start < 0 ? null : text.slice(start, start + 1600).split('\n\n')[0];
}

function mockResponse(response, model, tool) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  const emit = (type, data) => {
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    );
  };
  emit('message_start', {
    message: {
      id: `msg_probe_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  const block = tool
    ? {
        type: 'tool_use',
        id: `probe_${randomUUID()}`,
        name: tool.name,
        input: {},
      }
    : { type: 'text', text: '' };
  emit('content_block_start', { index: 0, content_block: block });
  emit('content_block_delta', {
    index: 0,
    delta: tool
      ? {
          type: 'input_json_delta',
          partial_json: JSON.stringify(tool.input),
        }
      : { type: 'text_delta', text: 'Local transport smoke completed.' },
  });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', {
    delta: {
      stop_reason: tool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: 1 },
  });
  emit('message_stop', {});
  response.end();
}

export async function startProxy({
  controls,
  effort,
  state,
  mock,
  marker,
  expectedToolNames,
  expectedGuidancePresence,
  expectedDescriptionGuidance,
  mockScenario = 'fff',
  mockSourceFile,
}) {
  const requests = [];
  const sockets = new Set();
  const mockCounts = new Map();
  let checkedCatalog = false;
  const server = http.createServer(async (request, response) => {
    let requestTarget;
    try {
      if (
        typeof request.url !== 'string' ||
        !request.url.startsWith('/') ||
        request.url.startsWith('//')
      )
        throw new Error('Invalid request target');
      requestTarget = new URL(request.url, 'http://localhost');
      if (requestTarget.origin !== 'http://localhost' || requestTarget.hash)
        throw new Error('Invalid request target');
    } catch {
      requests.push({
        path: null,
        method: request.method,
        status: 403,
        forwarded: false,
        rejected: 'invalid-request-target',
      });
      request.resume();
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'Invalid harness request target',
          },
        })
      );
      return;
    }
    const pieces = [];
    for await (const piece of request) pieces.push(piece);
    let body = Buffer.concat(pieces);
    const pathname = requestTarget.pathname;
    let data;
    try {
      if (request.headers['content-encoding'] === 'gzip')
        body = gunzipSync(body);
      data = JSON.parse(body.toString());
    } catch {
      requests.push({
        path: pathname,
        method: request.method,
        status: 403,
        forwarded: false,
      });
      response.writeHead(403);
      response.end('Unsupported harness request');
      return;
    }
    const definitions = Array.isArray(data.tools) ? data.tools : [];
    const toolNames = definitions.map(tool => tool.name).sort();
    const system = (Array.isArray(data.system) ? data.system : [])
      .map(block => block.text ?? '')
      .join('\n');
    const tools = definitions
      .map(tool => `${tool.name}\n${tool.description ?? ''}`)
      .join('\n');
    const nativeClass = request.headers['x-claude-code-request-class'];
    const nativeAgentType = request.headers['x-claude-code-agent-type'];
    const agentId = request.headers['x-claude-code-agent-id'];
    const parentAgentId = request.headers['x-claude-code-parent-agent-id'];
    const requestClass = controls.nativeRequestClasses.includes(nativeClass)
      ? nativeClass
      : null;
    const agentType =
      typeof nativeAgentType === 'string' &&
      /^[A-Za-z0-9_.:-]{1,80}$/.test(nativeAgentType)
        ? nativeAgentType
        : null;
    const entry = {
      number: requests.length + 1,
      path: pathname,
      model: data.model,
      effort: data.output_config?.effort ?? null,
      maxTokens: data.max_tokens,
      requestClass,
      agentType,
      agentIdSha256: typeof agentId === 'string' ? sha256(agentId) : null,
      parentAgentIdSha256:
        typeof parentAgentId === 'string' ? sha256(parentAgentId) : null,
      toolNames,
      toolsDescriptionSha256: sha256(tools),
      systemPromptSha256: sha256(system),
      coreGuidancePresent: system.includes(marker),
      coreGuidanceExcerpt: excerpt(system, marker),
      grepGuidanceExcerpt: excerpt(tools, 'Native Grep navigation:'),
      bashGuidanceExcerpt: excerpt(tools, 'Native search and fff files:'),
      forwarded: false,
      status: null,
    };
    requests.push(entry);
    let valid =
      pathname === '/v1/messages' &&
      request.method === 'POST' &&
      requestClass !== null &&
      controls.nativeModelIds.includes(data.model) &&
      Number.isInteger(data.max_tokens) &&
      data.max_tokens > 0 &&
      data.max_tokens <= controls.outputTokens &&
      (data.output_config?.effort === undefined ||
        controls.nativeEfforts.includes(data.output_config.effort));
    if (requestClass === 'main') {
      valid &&=
        data.model === controls.model &&
        data.output_config?.effort === effort &&
        toolNames.includes('Bash') &&
        entry.coreGuidancePresent === expectedGuidancePresence;
    } else if (['subagent', 'workflow'].includes(requestClass)) {
      valid &&= typeof agentId === 'string' && agentId.length > 0;
    }
    if (valid && requestClass === 'main' && !checkedCatalog) {
      valid =
        (expectedToolNames === undefined ||
          toolNames.join(',') === expectedToolNames.join(',')) &&
        (expectedDescriptionGuidance === undefined ||
          (Boolean(entry.grepGuidanceExcerpt) ===
            expectedDescriptionGuidance.grep &&
            Boolean(entry.bashGuidanceExcerpt) ===
              expectedDescriptionGuidance.bash));
      if (valid) checkedCatalog = true;
    }
    if (!valid || (!mock && state.requests >= controls.maxApiRequests)) {
      entry.status = 403;
      entry.rejected = 'control-mismatch-or-request-cap';
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'permission_error',
            message: 'Harness request controls rejected',
          },
        })
      );
      return;
    }
    if (mock) {
      entry.status = 200;
      const key = `${requestClass}/${agentId ?? 'root'}`;
      const first = (mockCounts.get(key) ?? 0) === 0;
      mockCounts.set(key, (mockCounts.get(key) ?? 0) + 1);
      let tool;
      if (first && requestClass === 'main') {
        tool =
          mockScenario === 'agent'
            ? {
                name: 'Agent',
                input: {
                  description: 'Verify native Explore inheritance',
                  prompt: `Read ${mockSourceFile} and report its exported constant.`,
                  subagent_type: 'Explore',
                  run_in_background: false,
                },
              }
            : {
                name: 'Bash',
                input: {
                  command: 'fff files RetryPolicy',
                  description: 'Verify isolated filename discovery',
                },
              };
      } else if (
        first &&
        mockScenario === 'agent' &&
        requestClass === 'subagent'
      ) {
        tool = { name: 'Read', input: { file_path: mockSourceFile } };
      }
      mockResponse(response, data.model, tool);
      return;
    }
    state.requests++;
    entry.forwarded = true;
    const target = new URL('https://api.anthropic.com/v1/messages');
    target.search = requestTarget.search;
    const headers = {
      ...request.headers,
      host: target.host,
      'content-length': String(body.length),
    };
    delete headers['transfer-encoding'];
    delete headers['content-encoding'];
    const upstream = https.request(
      target,
      { method: request.method, headers },
      reply => {
        entry.status = reply.statusCode;
        response.writeHead(reply.statusCode, reply.headers);
        reply.pipe(response);
      }
    );
    upstream.on('error', () => {
      entry.status = 502;
      if (!response.headersSent)
        response.writeHead(502, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: 'Harness upstream transport failed',
          },
        })
      );
    });
    response.on('close', () => upstream.destroy());
    upstream.end(body);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
