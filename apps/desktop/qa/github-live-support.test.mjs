import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { liveCli, observeGithubRequests } from './github-live-support.mjs';

test('child CLI leaves the owning parent event loop free to answer runtime requests', async () => {
  const server = createServer((_request, response) =>
    response.end(JSON.stringify({ ok: true, data: { ownerAnswered: true } })),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = mkdtempSync(join(tmpdir(), 'ogqa-'));
  const cli = join(root, 'cli.mjs');
  writeFileSync(
    cli,
    `const response = await fetch('http://127.0.0.1:${server.address().port}');
    process.stdout.write(await response.text());`,
  );
  try {
    const run = liveCli(cli, root, { PATH: process.env.PATH });
    assert.deepEqual(await run('status'), { ownerAnswered: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('attributes the SDK byte-body RPC without recording credential headers', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const observer = observeGithubRequests('selected/project');
  try {
    await globalThis.fetch('https://api.githubcopilot.com/mcp/', {
      method: 'POST',
      headers: {
        Authorization: 'synthetic-only',
        'X-MCP-Tools': 'list_issues,issue_read',
        'X-MCP-Readonly': 'true',
      },
      body: new TextEncoder().encode(
        JSON.stringify({
          method: 'tools/call',
          params: {
            name: 'list_issues',
            arguments: { owner: 'selected', repo: 'project' },
          },
        }),
      ),
    });
    assert.equal(observer.business(), 1);
    assert.equal(observer.requests[0].status, 200);
    assert.doesNotMatch(JSON.stringify(observer.requests), /synthetic-only|Authorization/);
  } finally {
    observer.close();
    globalThis.fetch = original;
  }
});
const { Response, TextEncoder } = globalThis;
