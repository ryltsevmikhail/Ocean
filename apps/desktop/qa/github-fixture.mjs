/* eslint-disable no-undef -- Node QA harness, not renderer code. */
// Loopback GitHub-like MCP server + deterministic provider for the Task 6
// client demonstrations. Counts discovery traffic and business tool calls
// separately; nothing leaves 127.0.0.1.
import { createServer } from 'node:http';

export function startGithubMcpServer(port = 0) {
  const counts = {
    total: 0,
    toolCalls: 0,
    listIssues: 0,
    issueRead: 0,
    byMethod: {},
    httpPaths: [],
  };
  const sessionId = 'qa-session-1';
  const tools = [
    {
      name: 'list_issues',
      description: 'List issues in one repository',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' } },
        required: ['owner', 'repo'],
        additionalProperties: false,
      },
    },
    {
      name: 'issue_read',
      description: 'Read one issue and its comments',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          issue_number: { type: 'number' },
        },
        required: ['owner', 'repo', 'issue_number'],
        additionalProperties: false,
      },
    },
  ];
  const issues = [
    { number: 7, title: 'Composer loses focus', state: 'open' },
    { number: 8, title: 'Add keyboard shortcut', state: 'closed' },
  ];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      counts.httpPaths.push(`${req.method ?? 'GET'} ${url.pathname}`);
      if (req.method === 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('no stream');
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        let message;
        try {
          message = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        counts.total += 1;
        const method = message.method ?? '(response)';
        counts.byMethod[method] = (counts.byMethod[method] ?? 0) + 1;
        const send = (payload, headers = {}) => {
          res.writeHead(200, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(payload));
        };
        if (message.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        if (method === 'initialize') {
          send(
            {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'github-issues-qa', version: '1.0.0' },
              },
            },
            { 'mcp-session-id': sessionId },
          );
          return;
        }
        if (method === 'tools/list') {
          send({ jsonrpc: '2.0', id: message.id, result: { tools } });
          return;
        }
        if (method === 'tools/call') {
          counts.toolCalls += 1;
          const name = message.params?.name ?? '';
          const args = message.params?.arguments ?? {};
          const repository = `${String(args.owner)}/${String(args.repo)}`;
          if (name === 'list_issues') {
            counts.listIssues += 1;
            send({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ repository, issues }) }],
                isError: false,
              },
            });
            return;
          }
          if (name === 'issue_read') {
            counts.issueRead += 1;
            const issue =
              issues.find((entry) => entry.number === Number(args.issue_number)) ?? issues[0];
            send({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      repository,
                      issue: { ...issue, comments: ['Первый комментарий', 'Второй комментарий'] },
                    }),
                  },
                ],
                isError: false,
              },
            });
            return;
          }
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: 'unknown tool' }], isError: true },
          });
          return;
        }
        if (method === 'ping') {
          send({ jsonrpc: '2.0', id: message.id, result: {} });
          return;
        }
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not found: ${method}` },
        });
      });
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        server,
        port: actualPort,
        base: `http://127.0.0.1:${actualPort}`,
        endpoint: `http://127.0.0.1:${actualPort}/mcp`,
        counts,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Deterministic provider: one `issue_read` tool call, then the bounded result answer. */
export function deterministicProvider() {
  const requests = [];
  let callId = 0;
  return {
    id: 'deepseek',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    capabilities: { streaming: true, usage: true, reasoning: false, toolCalls: true },
    requestCount: () => requests.length,
    async *stream(request) {
      requests.push({
        tools: (request.tools ?? []).map((tool) => tool.name),
        roles: request.messages.map((message) => message.role),
      });
      const last = request.messages[request.messages.length - 1];
      if (last?.role === 'tool') {
        yield { type: 'text_delta', text: 'Прочитал issue #7 «Composer loses focus» в team/api.' };
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32 } };
        yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        return;
      }
      if ((request.tools ?? []).length > 0) {
        callId += 1;
        yield {
          type: 'tool_call',
          call: {
            id: 'qa_call_' + String(callId),
            name: 'issue_read',
            arguments: JSON.stringify({ issue_number: 7 }),
          },
        };
        yield { type: 'usage', usage: { inputTokens: 18, outputTokens: 6, totalTokens: 24 } };
        yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'tool_calls' };
        return;
      }
      yield { type: 'text_delta', text: 'Обычный ответ без инструментов.' };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
}
