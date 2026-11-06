import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
it.each(['http', 'revoke', 'refresh'])(
  'qualifies normal owner/socket and independent client: %s',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-process-'));
    try {
      const child = await exec(
        process.execPath,
        [resolve('apps/cli/test-fixtures/mcp-normal-host.ts'), dir, mode],
        { timeout: 30000 },
      );
      const result = JSON.parse(child.stdout) as {
        model: number;
        calls: number;
        effects: number;
        preparedClaims: number;
        stopped: { outcome: string };
      };
      expect(result.model).toBe(mode === 'drop' ? 1 : 2);
      expect(result.calls).toBe(['http', 'drop'].includes(mode) ? 1 : 0);
      expect(result.effects).toBe(result.calls);
      if (mode === 'revoke' || mode === 'refresh') expect(result.preparedClaims).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);

it('observes no replay against a reachable peer across both owner lifetimes and asserts both stop verdicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-reachable-restart-'));
  const peer = await httpFixture('drop', dir, 60000);
  try {
    const first = await exec(
      process.execPath,
      [resolve('apps/cli/test-fixtures/mcp-normal-host.ts'), dir, 'drop', peer.url.href],
      { timeout: 30000 },
    );
    const a = JSON.parse(first.stdout) as {
      model: number;
      journal: unknown[];
      stopped: { outcome: string; state: string };
    };
    expect([peer.stats.calls, peer.stats.effects]).toEqual([1, 1]);
    expect(a.model).toBe(1);
    expect(a.stopped).toMatchObject({ outcome: 'uncertain', state: 'stop_incomplete' });
    expect(a.journal).toEqual([
      expect.objectContaining({
        id: expect.any(String) as unknown,
        tool: 'write',
        task_run_id: expect.any(String) as unknown,
        attempt_id: expect.any(String) as unknown,
        outcome: 'uncertain',
      }),
    ]);
    const lists = peer.rows.filter((m) => m === 'tools/list').length;
    const second = await exec(
      process.execPath,
      [resolve('apps/cli/test-fixtures/mcp-restart-owner.ts'), join(dir, 'profile')],
      { timeout: 20000 },
    );
    const b = JSON.parse(second.stdout) as {
      model: number;
      journal: unknown[];
      stopped: { outcome: string; state: string };
    };
    expect(peer.rows.filter((m) => m === 'tools/list').length).toBeGreaterThan(lists);
    expect([peer.stats.calls, peer.stats.effects, b.model]).toEqual([1, 1, 0]);
    expect(b.journal).toEqual(a.journal);
    expect(b.stopped).toMatchObject({ outcome: 'complete', state: 'stopped' });
    console.log(
      JSON.stringify({
        scenario: 'reachable-restart',
        firstStop: a.stopped,
        secondStop: b.stopped,
        beforeLists: lists,
        afterLists: peer.rows.filter((m) => m === 'tools/list').length,
        received: peer.stats.calls,
        effects: peer.stats.effects,
        model: [a.model, b.model],
        journalUnchanged: true,
      }),
    );
  } finally {
    await peer.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
