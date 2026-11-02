/**
 * Aggregate recovery.
 *
 * Rebuilds state from the latest checkpoint and the events after it. The
 * checkpoint is an optimization, never a second source of truth: its position
 * must be committed, its snapshot must end at the event the log committed at
 * that position, and a checkpoint without a snapshot falls back to replaying
 * the whole stream.
 */

import { replay, type TaskRunAggregate, type TaskRunId } from '@runnets/domain';

import type { Checkpoint, SqliteCheckpointStore } from './checkpoints.js';
import type { SqliteEventLog } from './event-log.js';

/** Recovered aggregate state and the checkpoint used, if any. */
export interface RecoveryResult {
  readonly taskRunId: TaskRunId;
  readonly state: TaskRunAggregate;
  readonly checkpoint: Checkpoint | null;
}

export interface RecoveryPort {
  recover(taskRunId: TaskRunId): Promise<RecoveryResult>;
}

/** Create the recovery helper over one database's log and checkpoints. */
export function createRecovery(
  log: SqliteEventLog,
  checkpoints: SqliteCheckpointStore,
): RecoveryPort {
  return {
    async recover(taskRunId: TaskRunId): Promise<RecoveryResult> {
      const checkpoint = await checkpoints.latest(taskRunId);
      if (checkpoint === null) {
        return { taskRunId, state: replay(await log.load(taskRunId)), checkpoint: null };
      }
      const committedVersion = log.version(taskRunId);
      if (checkpoint.eventPosition > committedVersion) {
        throw new Error(
          `checkpoint position ${checkpoint.eventPosition} is past the committed version ${committedVersion} for ${taskRunId}`,
        );
      }
      if (checkpoint.snapshot === null) {
        return { taskRunId, state: replay(await log.load(taskRunId)), checkpoint };
      }
      // The log stays authoritative: the snapshot may only be used when its
      // last event is the one stored at the checkpoint position.
      const boundary = log.eventAt(taskRunId, checkpoint.eventPosition);
      const snapshotEnd = checkpoint.snapshot[checkpoint.snapshot.length - 1];
      if (
        boundary === null ||
        snapshotEnd === undefined ||
        boundary.eventId !== snapshotEnd.eventId
      ) {
        throw new Error(
          `checkpoint snapshot for ${taskRunId} does not end at committed position ${checkpoint.eventPosition}`,
        );
      }
      const laterEvents = await checkpoints.loadAfter(taskRunId, checkpoint.eventPosition);
      return {
        taskRunId,
        state: replay([...checkpoint.snapshot, ...laterEvents]),
        checkpoint,
      };
    },
  };
}
