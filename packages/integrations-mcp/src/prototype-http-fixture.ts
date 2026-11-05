import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
  ProtocolError,
  UnsupportedProtocolVersionError,
  createMcpHandler,
  inputRequired,
  type Tool,
} from '@modelcontextprotocol/server';

export function definition(version: string): Tool {
  return {
    name: 'write',
    description: 'Synthetic effect',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', 'x-mcp-header': version } },
      required: ['value'],
    },
    outputSchema: {
      type: 'object',
      properties: { version: { type: 'string', const: version } },
      required: ['version'],
    },
  };
}
export async function httpFixture(name: string) {
  const rows: string[] = [];
  const headers: string[] = [];
  const types: string[] = [];
  const stats = { effects: 0, calls: 0, version: 'alpha', notified: 0 };
  const held = name.startsWith('held-') || name === 'status-race';
  const legacy = ['sse', 'notification'].includes(name) || held;
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((r) => {
    releaseResponse = r;
  });
  const factory = () => {
    const protocol = new Server(
      { name: 'fixture', version: '1' },
      {
        supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: { listChanged: true } },
      },
    );
    protocol.setRequestHandler('tools/list', () => ({
      tools: [definition(stats.version)],
      ttlMs: 0,
      cacheScope: 'private',
    }));
    protocol.setRequestHandler('tools/call', async (req) => {
      if (name === 'protocol')
        throw new UnsupportedProtocolVersionError({
          requested: '2026-07-28',
          supported: ['2025-11-25'],
        });
      if (name === 'header') throw new ProtocolError(-32020, 'fixture header mismatch');
      if (name === 'input') return inputRequired({ requestState: 'opaque-fixture-continuation' });
      if (name === 'notification') {
        await protocol.sendToolListChanged();
        stats.notified++;
      }
      stats.effects++;
      const version = name === 'invalid' ? 'invalid' : req.params.arguments?.['value'];
      return { content: [{ type: 'text', text: 'fixture' }], structuredContent: { version } };
    });
    return protocol;
  };
  const protocol = factory();
  const handler = createMcpHandler(factory);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: !legacy,
  });
  await protocol.connect(transport);
  const http = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const message = body
          ? (JSON.parse(body) as { method?: string; params?: { arguments?: { value?: string } } })
          : undefined;
        const method = message ? (message.method ?? 'response') : (req.method ?? 'GET');
        rows.push(method);
        if (method === 'tools/call') {
          stats.calls++;
          headers.push(
            String(req.headers['mcp-param-alpha'] ?? req.headers['mcp-param-bravo'] ?? ''),
          );
          if (
            ['held-concurrent', 'status-race'].includes(name) &&
            message?.params?.arguments?.value === 'bravo'
          ) {
            res.writeHead(401);
            res.end('fixture auth wall');
            return;
          }
          if (['401', '403', '404', '500', 'redirect'].includes(name)) {
            res.writeHead(name === 'redirect' ? 307 : Number(name), {
              'www-authenticate': 'Bearer error="insufficient_scope", scope="write"',
              location: '/redirect-target',
            });
            res.end('fixture fault');
            return;
          }
        }
        const request = new Request('http://127.0.0.1/mcp', {
          method: req.method ?? 'GET',
          headers: Object.entries(req.headers).flatMap(([key, value]) =>
            typeof value === 'string' ? [[key, value] as [string, string]] : [],
          ),
          ...(body ? { body } : {}),
        });
        const response = legacy
          ? await transport.handleRequest(request)
          : await handler.fetch(request);
        if (method === 'tools/call') {
          types.push(response.headers.get('content-type') ?? '');
          if (name === 'drop' || name === 'restart-drop') {
            res.destroy();
            return;
          }
          if (name === 'timeout' || name === 'abort') await delay(230);
          if (name === 'status-race') await responseGate;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.flushHeaders();
        const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
        if (reader) {
          res.on('close', () => {
            void reader.cancel().catch(() => {});
          });
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
      } catch {
        res.destroy();
      }
    })();
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw Error('missing loopback address');
  return {
    legacy,
    releaseResponse,
    url: new URL('http://127.0.0.1:' + addr.port + '/mcp'),
    rows,
    headers,
    types,
    stats,
    async close() {
      releaseResponse();
      await handler.close();
      await protocol.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

export const httpCases = [
  'held-timeout',
  'held-abort',
  'held-concurrent',
  'status-race',
  'json',
  'sse',
  'drop',
  '401',
  '403',
  '404',
  '500',
  'redirect',
  'protocol',
  'header',
  'input',
  'invalid',
  'timeout',
  'abort',
  'revoked',
  'post-revoke',
  'bad-schema',
  'catalog',
  'notification',
  'restart',
  'restart-drop',
] as const;
