/**
 * Loopback GitHub-like MCP server used by Task 6's real-adapter qualification.
 *
 * It declares exactly the frozen card's read operations (`list_issues`,
 * `issue_read`) so `requireDeclaredTools` accepts the catalog, and counts every
 * JSON-RPC request so discovery traffic and business `tools/call` dispatches are
 * attributable separately. Nothing leaves 127.0.0.1.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';

export type GithubScenario = 'ok' | 'dropToolReply' | 'extraTool';

export interface GithubMcpCounts {
  total: number;
  toolCalls: number;
  listIssuesCalls: number;
  issueReadCalls: number;
  byMethod: Record<string, number>;
  httpPaths: string[];
}

export interface GithubMcpServer {
  readonly base: string;
  readonly endpoint: string;
  readonly counts: GithubMcpCounts;
  readonly close: () => Promise<void>;
}

const ISSUES = [
  { number: 7, title: 'Composer loses focus', state: 'open', user: 'octocat' },
  { number: 8, title: 'Add keyboard shortcut', state: 'closed', user: 'hubot' },
];

const toolDefinitions = (extra: boolean): readonly unknown[] => [
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
  ...(extra
    ? [
        {
          name: 'create_issue_comment',
          description: 'A write tool the owner never granted and the card never declared',
          inputSchema: { type: 'object', properties: {} },
        },
      ]
    : []),
];

import type { IncomingMessage } from 'node:http';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => resolve(body));
  });
}

export function startGithubMcpServer(scenario: GithubScenario = 'ok'): Promise<GithubMcpServer> {
  const counts: GithubMcpCounts = {
    total: 0,
    toolCalls: 0,
    listIssuesCalls: 0,
    issueReadCalls: 0,
    byMethod: {},
    httpPaths: [],
  };
  const sessionId = 'task6-session-1';
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
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
          params?: { name?: string; arguments?: Record<string, unknown> };
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
                  serverInfo: { name: 'github-issues-fixture', version: '1.0.0' },
                },
              },
              { 'mcp-session-id': sessionId },
            );
            return;
          case 'tools/list':
            send({
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: toolDefinitions(scenario === 'extraTool') },
            });
            return;
          case 'tools/call': {
            if (scenario === 'dropToolReply') {
              counts.toolCalls += 1;
              req.socket.destroy();
              return;
            }
            counts.toolCalls += 1;
            const name = message.params?.name ?? '';
            const args = message.params?.arguments ?? {};
            if (name === 'list_issues') {
              counts.listIssuesCalls += 1;
              send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        repository: `${String(args['owner'])}/${String(args['repo'])}`,
                        issues: ISSUES,
                      }),
                    },
                  ],
                  isError: false,
                },
              });
              return;
            }
            if (name === 'issue_read') {
              counts.issueReadCalls += 1;
              const number = Number(args['issue_number'] ?? 7);
              const issue = ISSUES.find((entry) => entry.number === number) ?? ISSUES[0];
              send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        repository: `${String(args['owner'])}/${String(args['repo'])}`,
                        issue: { ...issue, comments: ['First comment', 'Second comment'] },
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
              result: {
                content: [{ type: 'text', text: 'tool not found' }],
                isError: true,
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
      const base = `http://127.0.0.1:${String(port)}`;
      resolve({
        base,
        endpoint: `${base}/mcp`,
        counts,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Bearer auth template accepted by the pinned MCP plugin. */
export const githubMcpAuthTemplates = [
  {
    slug: 'bearer',
    type: 'apiKey',
    headers: { Authorization: ['Bearer ', { type: 'variable', name: 'token' }] },
  },
];
