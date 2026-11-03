import { it, expect, vi } from 'vitest';
import { chmodSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { remoteTerminal } from '../../test-fixtures/remote-terminal.test.js';
import { DatabaseSync } from 'node:sqlite';
it('reads the complete task-bound F6 diff without publishing a changeset or exposing the owner view in another room', async () => {
  const f = await codingWorkflowFixture('direct');
  writeFileSync(join(f.worktree, 'math.cjs'), 'a'.repeat(40000) + 'FINAL-DIFF\n');
  const expected = await f.capture('baseline');
  const other = f.runtime.conversations.rooms('ws_ocean');
  if (!other.ok) throw Error('rooms');
  const foreign = other.value.find((r) => r.id !== f.room)!.id;
  f.runtime.close();
  chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
  const run = join(f.directory, 'run');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const host = await startLocalRuntime({ profile: f.directory, provider: null });
  try {
    for (const id of [f.room, foreign]) {
      const ui = await remoteTerminal(f.directory, id, 'task');
      try {
        ui.input.write('\x1b[17~');
        await ui.app.idle();
        const lines = ui.app.selectedRun()?.codingLines?.join('\n');
        if (id === f.room) {
          expect(lines).toContain(expected.hash);
          expect(lines).toContain('FINAL-DIFF');
          expect(lines).toContain('test: no recorded result');
          ui.input.write('\x1b[F');
          expect(ui.app.frame()).toContain('FINAL-DIFF');
        } else {
          expect(lines).toContain('coding_denied');
          expect(lines).not.toContain(expected.hash);
        }
      } finally {
        ui.app.stop();
        await ui.app.idle();
      }
    }
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM ocean_capture_receipts').get()?.['n']).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await host.stop();
    await host.closed;
    vi.unstubAllEnvs();
    f.close();
  }
});

it('F6 reads only the latest registered evidence and refuses its oversized payload before parsing', async () => {
  const f = await codingWorkflowFixture('direct');
  const { directory, room } = f;
  writeFileSync(join(f.worktree, 'math.cjs'), 'a'.repeat(40000) + 'end\n');
  const artifact = await f.capture('frozen');
  const task = f.runtime.coding.inspect('ws_ocean', 'task');
  if (!task.ok) throw Error('fixture task');
  const binding = {
    operation: 'test',
    roomId: room,
    workspaceId: 'ws_ocean',
    taskId: 'task',
    projectRoot: f.project,
    worktreeRoot: f.worktree,
    botId: task.value.devBotId,
    policyVersion: task.value.policyVersion,
    sourceTreeHash: artifact.afterTreeHash,
  };
  const evidence = {
    id: 'current',
    presetId: 'test',
    hash: 'current-hash',
    binding,
    beforeTreeHash: artifact.afterTreeHash,
    afterTreeHash: artifact.afterTreeHash,
    exitCode: 0,
    reason: 'exit',
    cleanupConfirmed: true,
    truncated: false,
    dependenciesUnchanged: true,
    output: 'latest-output',
  };
  f.runtime.close();
  chmodSync(join(directory, 'runtime.sqlite'), 0o600);
  const seed = new DatabaseSync(join(directory, 'runtime.sqlite'));
  seed.exec('DROP INDEX IF EXISTS ocean_evidence_preset');
  const insert = seed.prepare('INSERT INTO ocean_coding_test_evidence VALUES(?,?,?,?)');
  for (let n = 0; n < 32; n++)
    insert.run(
      'old' + n,
      'oldhash' + n,
      'task',
      JSON.stringify({
        ...evidence,
        id: 'old' + n,
        output: 'HISTORICAL-DO-NOT-PARSE' + 'x'.repeat(65536),
      }),
    );
  insert.run(
    'ignored',
    'unregistered',
    'task',
    JSON.stringify({ ...evidence, presetId: 'other', output: 'HISTORICAL-DO-NOT-PARSE' }),
  );
  insert.run(evidence.id, evidence.hash, 'task', JSON.stringify(evidence));
  seed.close();
  const run = join(directory, 'run');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const host = await startLocalRuntime({ profile: directory, provider: null });
  const ui = await remoteTerminal(directory, room, 'task');
  const parse = JSON.parse;
  const expensive: string[] = [];
  const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string) => {
    if (text.includes('HISTORICAL-DO-NOT-PARSE') || text.includes('EXCEEDS-PANEL-BUDGET')) {
      expensive.push(text.slice(0, 40));
      throw Error('unbounded_evidence_parse');
    }
    return parse(text);
  });
  try {
    ui.input.write('\x1b[17~');
    await ui.app.idle();
    expect(expensive).toHaveLength(0);
    expect(ui.app.selectedRun()?.codingLines).toContain('latest-output');
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    try {
      db.prepare(
        "INSERT INTO ocean_coding_test_evidence SELECT 'large','large-hash',task_id,json_set(payload,'$.output','EXCEEDS-PANEL-BUDGET'||printf('%.*c',?,'L')) FROM ocean_coding_test_evidence WHERE id='current'",
      ).run(16 * 1024 * 1024 - 4096);
    } finally {
      db.close();
    }
    ui.input.write('\x1b[17~');
    await ui.app.idle();
    expect(expensive).toHaveLength(0);
    expect(ui.app.selectedRun()?.codingLines).toEqual(['Changeset unavailable: changeset_limit']);
  } finally {
    spy.mockRestore();
    ui.app.stop();
    await host.stop();
    await host.closed;
    vi.unstubAllEnvs();
    f.close();
  }
});
