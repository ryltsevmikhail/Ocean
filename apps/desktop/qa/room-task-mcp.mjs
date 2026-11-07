// Small task-owned loopback peer, using the MCP dependency's public package export.
import { createRequire } from 'node:module';
import { pathToFileURL, URL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
const require = createRequire(
  new URL('../../../packages/integrations-mcp/package.json', import.meta.url),
);
const { Server, createMcpHandler } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/server'))
);
export async function taskMcp(root) {
  const stats = { calls: 0, effects: 0 },
    methods = [];
  let releaseResponse;
  const gate = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: 'e20-fixture', version: '1' },
      {
        supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: { listChanged: true } },
      },
    );
    server.setRequestHandler('tools/list', () => ({
      tools: [
        {
          name: 'write',
          description: 'E20 synthetic effect',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
          outputSchema: {
            type: 'object',
            properties: { version: { type: 'string', const: 'alpha' } },
            required: ['version'],
          },
        },
      ],
      ttlMs: 60000,
      cacheScope: 'private',
    }));
    server.setRequestHandler('tools/call', (request) => {
      stats.effects++;
      appendFileSync(join(root, 'effects'), 'effect\n', { flush: true });
      return {
        content: [{ type: 'text', text: 'fixture' }],
        structuredContent: { version: request.params.arguments.value },
      };
    });
    return server;
  });
  const server = createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString(),
        input = body ? JSON.parse(body) : {};
      methods.push(input.method ?? req.method);
      if (input.method === 'tools/call') {
        stats.calls++;
        appendFileSync(join(root, 'dispatches'), 'send\n', { flush: true });
      }
      const response = await handler.fetch(
        new globalThis.Request('http://127.0.0.1/mcp', {
          method: req.method,
          headers: Object.entries(req.headers).filter(([, value]) => typeof value === 'string'),
          ...(body ? { body } : {}),
        }),
      );
      if (input.method === 'tools/call') await gate;
      if (input.method === 'tools/call' && existsSync(join(root, 'drop-effect-response'))) {
        res.destroy();
        return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => res.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: new URL('http://127.0.0.1:' + server.address().port + '/mcp'),
    stats,
    methods,
    releaseResponse,
    async close() {
      releaseResponse();
      await handler.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
