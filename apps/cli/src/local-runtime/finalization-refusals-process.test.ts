import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { startLocalRuntime } from './host.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import {
  codingRows,
  leaseRegistryRows,
  preparedFinalizationTask,
} from '../../test-fixtures/coding-finalization-fixture.js';
import { runCli } from '../../test-fixtures/cli-command.js';
it('refuses the full owner matrix and keeps two racing clients to one exact release', async () => {
  const f = await preparedFinalizationTask();
  const host = await startLocalRuntime({
    profile: f.profile,
    provider: null,
    codingTools: { sandbox: f.sandbox, inspectSandbox: f.sandbox },
  });
  const one = await connectLocalRuntime({ profile: f.profile }),
    two = await connectLocalRuntime({ profile: f.profile });
  try {
    const selection = {
      workspaceId: 'ws_ocean',
      roomId: f.room,
      taskId: 'task',
      requestId: 'race-1',
    };
    await expect(one.previewFinalization({ ...selection, roomId: 'unknown-room' })).rejects.toThrow(
      'finalization_scope_conflict',
    );
    await expect(one.previewFinalization({ ...selection, taskId: 'unknown-task' })).rejects.toThrow(
      'finalization_scope_conflict',
    );
    // Unresolved effect or pending work keeps the reservation.
    const db = new DatabaseSync(f.db);
    try {
      db.prepare('INSERT INTO tool_invocations_v2 VALUES(?,?,?,?,?,?)').run(
        'held-effect',
        'command',
        'run',
        'attempt',
        'fingerprint',
        'started',
      );
    } finally {
      db.close();
    }
    await expect(one.previewFinalization(selection)).rejects.toThrow('finalization_effects_held');
    const cleanup = new DatabaseSync(f.db);
    try {
      cleanup.prepare("DELETE FROM tool_invocations_v2 WHERE id='held-effect'").run();
    } finally {
      cleanup.close();
    }
    // CLI preview uses the same public SDK contract; confirmation without a TTY is refused.
    const preview = await runCli([
      'coding',
      'finalize',
      'preview',
      '--profile',
      f.profile,
      '--room',
      f.room,
      '--task-id',
      'task',
      '--request-id',
      'cli-1',
    ]);
    expect(preview.code).toBe(0);
    const cliData = preview.output as {
      data: {
        card: {
          kind: string;
          decisionId: string;
          runId: string;
          bindingDigest: string;
          version: number;
        };
      };
    };
    expect(cliData.data.card.kind).toBe('task-finalization');
    const confirm = await runCli([
      'coding',
      'finalize',
      'confirm',
      '--profile',
      f.profile,
      '--room',
      f.room,
      '--task-id',
      'task',
      '--request-id',
      'cli-1',
    ]);
    expect(confirm.code).not.toBe(0);
    expect(confirm.output).toMatchObject({ ok: false, error: { code: 'approval_required' } });
    // A non-TTY confirmation is refused before it can open a new preview or card.
    const fresh = await runCli([
      'coding',
      'finalize',
      'confirm',
      '--profile',
      f.profile,
      '--room',
      f.room,
      '--task-id',
      'task',
      '--request-id',
      'cli-fresh',
    ]);
    expect(fresh.code).not.toBe(0);
    expect(fresh.output).toMatchObject({ ok: false, error: { code: 'approval_required' } });
    const cardDb = new DatabaseSync(f.db, { readOnly: true });
    try {
      expect(
        cardDb
          .prepare(
            "SELECT count(*) AS n FROM ocean_owner_decisions WHERE runId='finalize-cli-fresh'",
          )
          .get(),
      ).toMatchObject({ n: 0 });
      expect(
        cardDb
          .prepare(
            "SELECT count(*) AS n FROM ocean_coding_finalizations WHERE request_id='cli-fresh'",
          )
          .get(),
      ).toMatchObject({ n: 0 });
    } finally {
      cardDb.close();
    }
    await one.resolveDecision({
      workspaceId: 'ws_ocean',
      roomId: f.room,
      runId: cliData.data.card.runId,
      decisionId: cliData.data.card.decisionId,
      bindingDigest: cliData.data.card.bindingDigest,
      expectedVersion: cliData.data.card.version,
      choice: 'deny',
    });
    // First client opens the pending decision; a second confirmation request cannot race it.
    const card = await one.previewFinalization(selection);
    expect(await two.previewFinalization(selection)).toMatchObject({
      decisionId: card.decisionId,
      status: 'pending',
    });
    await expect(two.previewFinalization({ ...selection, requestId: 'race-2' })).rejects.toThrow(
      'finalization_in_progress',
    );
    expect(leaseRegistryRows(f.registryPath).leases).toHaveLength(2);
    const ref = {
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
      bindingDigest: card.bindingDigest,
      expectedVersion: card.version,
    };
    const results = await Promise.all([
      one.resolveDecision({ ...ref, choice: 'allow-once' }),
      two.resolveDecision({ ...ref, choice: 'allow-once' }),
    ]);
    expect(results.every((result) => result.status === 'allowed')).toBe(true);
    const finalized = await vi.waitFor(
      async () => {
        const result = await one.finalizationResult(selection);
        if (result.state !== 'finalized') throw Error('not finalized: ' + result.state);
        return result;
      },
      { timeout: 15000 },
    );
    expect(finalized.release.receipt?.operationId).toBe('ocean-finalize-v2-' + card.bindingDigest);
    const registry = leaseRegistryRows(f.registryPath);
    expect(registry.receipts).toHaveLength(1);
    expect(registry.leases).toHaveLength(1);
    // A third preview cannot authorise a second release of the same task.
    await expect(two.previewFinalization({ ...selection, requestId: 'race-3' })).rejects.toThrow(
      'finalization_already_disabled',
    );
  } finally {
    one.close();
    two.close();
    await host.stop();
  }
  try {
    const offline = await runCli([
      'coding',
      'finalize',
      'preview',
      '--profile',
      f.profile,
      '--room',
      f.room,
      '--task-id',
      'task',
      '--request-id',
      'cli-offline',
    ]);
    expect(offline.code).not.toBe(0);
    expect(offline.output).toMatchObject({ ok: false, error: { code: 'runtime_required' } });
  } finally {
    f.close();
  }
}, 60000);
it('closes a pending finalization preview while stopping instead of reporting stop_incomplete', async () => {
  const f = await preparedFinalizationTask();
  const host = await startLocalRuntime({
    profile: f.profile,
    provider: null,
    codingTools: { sandbox: f.sandbox, inspectSandbox: f.sandbox },
    drainDeadlineMs: 3000,
  });
  const client = await connectLocalRuntime({ profile: f.profile });
  try {
    const selection = {
      workspaceId: 'ws_ocean',
      roomId: f.room,
      taskId: 'task',
      requestId: 'drain-1',
    };
    expect(await client.previewFinalization(selection)).toMatchObject({ status: 'pending' });
  } finally {
    client.close();
  }
  expect((await host.stop()).outcome).toBe('complete');
  await host.closed;
  // The pending preview became a durable refusal; nothing was released.
  expect(
    codingRows(f.db, 'task').finalization.map((row) => JSON.parse(row)['state'] as string),
  ).toEqual(['refused']);
  const registry = leaseRegistryRows(f.registryPath);
  expect(registry.leases).toHaveLength(2);
  expect(registry.receipts).toHaveLength(0);
  f.close();
}, 60000);
