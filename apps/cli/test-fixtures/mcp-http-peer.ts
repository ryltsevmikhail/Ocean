import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export async function normalHttpPeer(proof: string, path: string, mode: string) {
  const stats = { calls: 0, effects: 0, claims: 0 };
  const http = createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const data of req) body += String(data);
      const message = JSON.parse(body) as { id?: string; method: string };
      appendFileSync(join(proof, 'metadata'), message.method + '\n');
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'owned', version: '1' },
        };
      else if (message.method === 'tools/list')
        result = {
          ...(mode === 'refresh' ? { ttlMs: 1000 } : {}),
          tools: [
            {
              name: 'write',
              description: 'Synthetic operation',
              inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
            },
          ],
        };
      else if (message.method === 'tools/call') {
        stats.calls++;
        const db = new DatabaseSync(path);
        const rows = db
          .prepare("SELECT COUNT(*) AS n FROM tool_invocations_v2 WHERE outcome='started'")
          .get();
        db.close();
        stats.claims += Number(rows?.['n']);
        appendFileSync(join(proof, 'received'), 'tools/call\n');
        stats.effects++;
        appendFileSync(join(proof, 'effects'), 'effect\n');
        if (mode === 'drop') {
          res.destroy();
          return;
        }
        result = { content: [{ type: 'text', text: 'synthetic result' }] };
      } else throw Error('unexpected method');
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch {
      res.writeHead(500).end();
    }
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw Error('address');
  return { http, url: `http://127.0.0.1:${address.port}/mcp`, stats };
}
