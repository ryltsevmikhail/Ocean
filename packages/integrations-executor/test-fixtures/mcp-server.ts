/**
 * Minimal streamable-HTTP MCP server for the real `@executor-js/plugin-mcp`
 * counter tests. It counts JSON-RPC requests by method so a `tools/call`
 * dispatch is distinguishable from the session handshake.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { readBody, writeJson } from './loopback.js';

export type McpScenario = 'ok' | 'toolError' | 'transport401' | 'drop' | 'manyTools';

export interface McpCounts {
  total: number;
  toolCalls: number;
  byMethod: Record<string, number>;
  httpPaths: string[];
}

export interface McpServer {
  readonly server: Server;
  readonly base: string;
  readonly counts: McpCounts;
  readonly close: () => Promise<void>;
}

const toolsFor = (scenario: McpScenario): readonly unknown[] => {
  if (scenario === 'manyTools') {
    return Array.from({ length: 300 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Synthetic tool ${index}`,
      inputSchema: { type: 'object', properties: {} },
    }));
  }
  return [
    {
      name: 'write_thing',
      description: 'Synthetic MCP write for the RC2 qualification probe.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    {
      name: 'read_secret_other_grant',
      description: 'A tool the owner never granted; must not be callable.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
};

export function startMcpServer(scenario: McpScenario): Promise<McpServer> {
  const counts: McpCounts = { total: 0, toolCalls: 0, byMethod: {}, httpPaths: [] };
  const sessionId = 'probe-session-1';

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      counts.httpPaths.push(`${req.method ?? 'GET'} ${url.pathname}`);
      if (req.method === 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('no server-initiated stream');
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
      void readBody(req).then((body) => {
        let message: {
          id?: unknown;
          method?: string;
          params?: { name?: string; arguments?: { value?: string } };
        };
        try {
          message = JSON.parse(body) as typeof message;
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        counts.total += 1;
        const method = message.method ?? '(response)';
        counts.byMethod[method] = (counts.byMethod[method] ?? 0) + 1;
        const send = (payload: unknown, headers: Record<string, string> = {}): void => {
          res.writeHead(200, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(payload));
        };
        if (message.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        switch (method) {
          case 'initialize':
            send(
              {
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  protocolVersion: '2025-06-18',
                  capabilities: { tools: { listChanged: false } },
                  serverInfo: { name: 'probe-mcp', version: '1.0.0' },
                },
              },
              { 'mcp-session-id': sessionId },
            );
            return;
          case 'server/discover':
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'server/discover not supported (legacy probe)' },
            });
            return;
          case 'tools/list':
            send({
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: toolsFor(scenario) },
            });
            return;
          case 'tools/call': {
            if (scenario === 'transport401') {
              res.writeHead(401, {
                'content-type': 'application/json',
                'www-authenticate': 'Bearer error="invalid_token"',
              });
              res.end(JSON.stringify({ error: 'invalid_token', message: 'expired' }));
              return;
            }
            counts.toolCalls += 1;
            if (scenario === 'drop') {
              req.socket.destroy();
              return;
            }
            if (scenario === 'toolError') {
              send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  content: [{ type: 'text', text: '401 Unauthorized' }],
                  isError: true,
                },
              });
              return;
            }
            send({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                content: [
                  { type: 'text', text: `wrote ${String(message.params?.arguments?.value)}` },
                ],
                isError: false,
              },
            });
            return;
          }
          case 'ping':
            send({ jsonrpc: '2.0', id: message.id, result: {} });
            return;
          default:
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `method not found: ${method}` },
            });
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        counts,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Bearer template accepted by `executor.mcp.addServer`. */
export const mcpAuthTemplates = [
  {
    slug: 'bearer',
    type: 'apiKey',
    headers: { Authorization: ['Bearer ', { type: 'variable', name: 'token' }] },
  },
];

void writeJson;
