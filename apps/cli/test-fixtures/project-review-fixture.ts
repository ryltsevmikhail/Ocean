import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type {
  CodingChangesetSummary,
  CodingTaskPreparation,
  CodingTaskReservation,
  LocalDecision,
} from '@runnets/contracts';
import type { CodingTestEvidence } from '@runnets/domain';
import { openSqliteStore } from '@runnets/store-sqlite';
import type { reserveFixture } from './project-reserve-fixture.ts';

type Fixture = Awaited<ReturnType<typeof reserveFixture>>;
type Peer = ReturnType<Fixture['launch']>;
export const ref = (d: LocalDecision) => ({
  workspaceId: d.workspaceId,
  roomId: d.roomId,
  runId: d.runId,
  decisionId: d.decisionId,
});
export const vote = (peer: Peer, d: LocalDecision, expectedVersion = d.version) =>
  peer.call('resolveDecision', {
    ...ref(d),
    expectedVersion,
    bindingDigest: d.bindingDigest,
    choice: 'allow-once',
  });
export const launchOwner = (f: Fixture, mode = 'normal') =>
  f.launch('project-review-owner.test.ts', mode);
export const launchPeer = (f: Fixture, mode = 'sdk') =>
  f.launch('model-process-client.test.ts', mode);
export const calls = (
  f: Fixture,
): { messages: { role: string; content: string }[]; tools: unknown[] }[] => {
  const path = join(f.directory, 'review-calls.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
};
export async function prepare(f: Fixture, peer: Peer) {
  const reservation = await peer.call<CodingTaskReservation>('reserveCodingTask', f.input);
  await vote(peer, reservation.decision);
  await expect
    .poll(() => peer.call('reserveCodingTask', f.input))
    .toMatchObject({ status: 'reserved' });
  const scope = {
    workspaceId: f.input.workspaceId,
    roomId: f.input.ownerRoomId,
    taskId: f.input.taskId,
  };
  const prepare = { ...scope, requestId: 'prepare', expectedPolicyVersion: 1 };
  const pending = await peer.call<CodingTaskPreparation>('prepareCodingTask', prepare);
  await vote(peer, pending.decision!);
  await expect
    .poll(() => peer.call<CodingTaskPreparation>('prepareCodingTask', prepare))
    .toMatchObject({ status: 'prepared' });
  const worktree = await peer.call<CodingTaskPreparation>('prepareCodingTask', prepare);
  const path = join(worktree.worktree!.root, 'file');
  writeFileSync(path, 'immutable selected bytes\n');
  const saved = await peer.call<CodingChangesetSummary>('captureCodingChangeset', {
    ...prepare,
    requestId: 'capture',
  });
  writeFileSync(path, 'later mutable bytes\n');
  const later = await peer.call<CodingChangesetSummary>('captureCodingChangeset', {
    ...prepare,
    requestId: 'later',
  });
  return {
    saved,
    later,
    path,
    query: { ...scope, roomId: f.input.reviewRoomId, requestId: 'review', hash: saved.hash },
  };
}

/** Inserts recorded evidence without running an external sandbox in this SDK fixture. */
export function injectEvidence(
  f: Fixture,
  artifact: CodingChangesetSummary,
  path: string,
  id: string,
) {
  const store = openSqliteStore({ path: join(f.directory, 'runtime.sqlite') });
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const row: Omit<CodingTestEvidence, 'hash'> = {
    id,
    presetId: 'test',
    binding: {
      workspaceId: artifact.workspaceId,
      taskId: artifact.taskId,
      projectRoot: f.project,
      worktreeRoot: path,
      roomId: artifact.roomId,
      botId: f.input.devBotId,
      runId: 'fixture-run',
      attemptId: 'fixture-attempt',
      invocationId: id,
      operation: 'test',
      operationHash: sha('operation'),
      sourceTreeHash: artifact.afterTreeHash,
      policyVersion: 1,
      limitsHash: sha('limits'),
      toolchainHash: sha('toolchain'),
    },
    invocationHash: sha(id),
    beforeTreeHash: artifact.afterTreeHash,
    afterTreeHash: artifact.afterTreeHash,
    dependencyHash: sha('dependencies'),
    dependenciesUnchanged: true,
    exitCode: 0,
    reason: 'exit',
    cleanupConfirmed: true,
    truncated: false,
    output: 'synthetic test evidence',
  };
  const value = { ...row, hash: sha(JSON.stringify(row)) };
  try {
    store.codingEvidence.put(value);
  } finally {
    store.close();
  }
  return value;
}
