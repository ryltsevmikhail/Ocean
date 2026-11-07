import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  MAX_PANEL_LENGTH,
  PREVIEW_CHUNK,
  type CodingChangesetSummary,
  type CodingTaskPreparation,
  type CodingTaskReservation,
  type LocalDecision,
} from '@runnets/contracts';
import { reserveFixture } from '../../test-fixtures/project-reserve-fixture.ts';

type Fixture = Awaited<ReturnType<typeof reserveFixture>>;
type Peer = ReturnType<Fixture['launch']>;
const raw = (p: Peer, method: string, params: unknown) => p.call('raw', { method, params });
const captureScope = (f: Fixture) => ({
  workspaceId: f.input.workspaceId,
  roomId: f.input.ownerRoomId,
  taskId: f.input.taskId,
});
const vote = (p: Peer, d: LocalDecision) =>
  p.call('resolveDecision', {
    workspaceId: d.workspaceId,
    roomId: d.roomId,
    runId: d.runId,
    decisionId: d.decisionId,
    expectedVersion: d.version,
    bindingDigest: d.bindingDigest,
    choice: 'allow-once',
  });

it('replays the original capture and reads its exact diff after changes and restart', async () => {
  const f = await reserveFixture();
  try {
    const owner = f.launch('project-read-owner.test.ts', 'normal');
    await owner.ready;
    const peer = (mode: string) => f.launch('model-process-client.test.ts', mode);
    const a = peer('sdk'),
      b = peer('sdk');
    await Promise.all([a.ready, b.ready]);
    const reservation = await a.call<CodingTaskReservation>('reserveCodingTask', f.input);
    await vote(a, reservation.decision);
    await expect
      .poll(() => a.call('reserveCodingTask', f.input))
      .toMatchObject({ status: 'reserved' });

    const scope = captureScope(f);
    const prepare = { ...scope, requestId: 'prepare', expectedPolicyVersion: 1 };
    const pending = await a.call<CodingTaskPreparation>('prepareCodingTask', prepare);
    await vote(a, pending.decision!);
    await expect
      .poll(() => a.call('prepareCodingTask', prepare))
      .toMatchObject({ status: 'prepared' });
    const ready = await a.call<CodingTaskPreparation>('prepareCodingTask', prepare);
    const worktreeFile = join(ready.worktree!.root, 'file');
    const body = 'first-' + 'x'.repeat(PREVIEW_CHUNK + 100);
    writeFileSync(worktreeFile, body + '\n');
    const request = { ...prepare, requestId: 'capture' };
    const [saved, duplicate] = await Promise.all([
      a.call<CodingChangesetSummary>('captureCodingChangeset', request),
      b.call<CodingChangesetSummary>('captureCodingChangeset', request),
    ]);
    expect(duplicate).toEqual(saved);
    const baseCommit = f.git('rev-parse', 'HEAD').toString().trim();
    expect(saved).toEqual({
      ...scope,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      baseCommit,
      beforeTreeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      afterTreeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileCount: 1,
    });
    const query = { ...scope, hash: saved.hash };
    const expected = {
      ...saved,
      diff:
        'diff --git "a/file" "b/file"\n--- "a/file"\n+++ "b/file"\n@@ -1,1 +1,1 @@\n-base\n\\ No newline at end of file\n+' +
        body +
        '\n',
    };
    expect(await a.call('readCodingChangeset', query)).toEqual(expected);
    expect(readFileSync(worktreeFile, 'utf8')).toBe(body + '\n');
    writeFileSync(worktreeFile, 'second\n');
    expect(await b.call('captureCodingChangeset', request)).toEqual(saved);
    const next = await b.call<CodingChangesetSummary>('captureCodingChangeset', {
      ...request,
      requestId: 'next',
    });
    expect(next.hash).not.toBe(saved.hash);
    expect(await b.call('readCodingChangeset', { ...scope, hash: next.hash })).toMatchObject({
      diff: expect.stringContaining('+second\n'),
    });

    const old = peer('rc2'),
      wire = peer('workspace'),
      other = peer('workspace');
    await Promise.all([old.ready, wire.ready, other.ready]);
    await expect(raw(old, 'coding.changesets.capture', request)).rejects.toThrow(
      'client_upgrade_required',
    );
    await expect(raw(old, 'coding.changesets.read', { ...query, offset: 0 })).rejects.toThrow(
      'client_upgrade_required',
    );
    expect(
      await raw(old, 'coding.diff', {
        workspaceId: scope.workspaceId,
        roomId: scope.roomId,
        id: scope.taskId,
        offset: 0,
      }),
    ).toMatchObject({ text: expect.stringContaining('second') });
    for (const changed of [
      { roomId: f.input.reviewRoomId },
      { taskId: 'another-task' },
      { expectedPolicyVersion: 2 },
    ])
      await expect(b.call('captureCodingChangeset', { ...request, ...changed })).rejects.toThrow(
        'coding_denied',
      );
    await expect(
      b.call('captureCodingChangeset', { ...request, workspaceId: 'foreign' }),
    ).rejects.toThrow('coding_denied');
    await expect(
      b.call('captureCodingChangeset', {
        ...request,
        requestId: 'foreign-room',
        roomId: f.input.reviewRoomId,
      }),
    ).rejects.toThrow('coding_denied');
    for (const changed of [
      { workspaceId: 'foreign' },
      { roomId: f.input.reviewRoomId },
      { taskId: 'another-task' },
      { hash: '0'.repeat(64) },
    ])
      await expect(b.call('readCodingChangeset', { ...query, ...changed })).rejects.toThrow(
        'coding_denied',
      );
    await expect(
      raw(wire, 'coding.changesets.capture', { ...request, projectRoot: f.project }),
    ).rejects.toThrow('invalid_params');
    await expect(
      raw(wire, 'coding.changesets.read', { ...query, offset: MAX_PANEL_LENGTH + 1 }),
    ).rejects.toThrow('invalid_params');
    const first = await wire.call<{ version: string; length: number }>('raw', {
      method: 'coding.changesets.read',
      params: { ...query, offset: 0 },
    });
    const continuation = { ...query, offset: PREVIEW_CHUNK, version: first.version };
    await expect(raw(other, 'coding.changesets.read', continuation)).rejects.toThrow(
      'stale_capture',
    );
    for (const changed of [
      { hash: next.hash },
      { roomId: f.input.reviewRoomId },
      { version: '0'.repeat(64) },
      { offset: first.length },
    ])
      await expect(
        raw(wire, 'coding.changesets.read', { ...continuation, ...changed }),
      ).rejects.toThrow('stale_capture');
    expect(await raw(wire, 'coding.changesets.read', continuation)).toMatchObject({
      version: first.version,
    });

    await a.call('stop');
    await owner.kill();
    const restarted = f.launch('project-read-owner.test.ts', 'normal');
    await restarted.ready;
    const c = peer('sdk');
    await c.ready;
    const worktree = ready.worktree!.root;
    renameSync(worktree, worktree + '-moved');
    try {
      expect(await c.call('captureCodingChangeset', request)).toEqual(saved);
      expect(await c.call('readCodingChangeset', query)).toEqual(expected);
    } finally {
      renameSync(worktree + '-moved', worktree);
    }
    await expect(
      c.call('captureCodingChangeset', { ...request, expectedPolicyVersion: 2 }),
    ).rejects.toThrow('coding_denied');
    expect(await c.call('readCodingChangeset', query)).toEqual(expected);
    expect(readFileSync(worktreeFile, 'utf8')).toBe('second\n');
    expect(readFileSync(join(f.project, 'file'), 'utf8')).toBe('base');
    expect(f.git('rev-parse', 'HEAD').toString().trim()).toBe(baseCommit);
    expect(f.git('status', '--porcelain').toString()).toBe('');
    await c.call('stop');
  } finally {
    await f.close();
  }
}, 20000);

it.each(['restore', 'drain'])(
  'refuses changeset requests on a %s host',
  async (mode) => {
    const f = await reserveFixture();
    try {
      const owner = f.launch('project-read-owner.test.ts', mode);
      await owner.ready;
      const client = f.launch('model-process-client.test.ts', 'workspace');
      await client.ready;
      if (mode === 'drain') await owner.call('start-drain');
      const scope = captureScope(f);
      const error = mode === 'drain' ? 'runtime_draining' : 'client_upgrade_required';
      await expect(
        raw(client, 'coding.changesets.capture', {
          ...scope,
          requestId: 'capture',
          expectedPolicyVersion: 1,
        }),
      ).rejects.toThrow(error);
      await expect(
        raw(client, 'coding.changesets.read', { ...scope, hash: '0'.repeat(64), offset: 0 }),
      ).rejects.toThrow(error);
      if (mode === 'drain') await owner.call('finish-drain');
    } finally {
      await f.close();
    }
  },
  20000,
);
