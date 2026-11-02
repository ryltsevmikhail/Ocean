/**
 * Durable checkpoint store.
 *
 * A checkpoint records a committed event position plus the event schema version
 * the snapshot was produced under. Its optional snapshot is the committed event
 * prefix up to that position, encoded exactly like the log; storing it lets
 * recovery fold the prefix without rescanning earlier events. A checkpoint never
 * replaces the event log: saving validates the position against the committed
 * version, and a snapshot must match the committed prefix column-for-column.
 */

import type { EventEnvelope, TaskRunId } from '@runnets/domain';
import { TASK_RUN_SCHEMA_VERSION, taskRunId as parseTaskRunId } from '@runnets/domain';
import type { DatabaseSync } from 'node:sqlite';

import type { SqliteEventLog } from './event-log.js';
import { fromEventRecord, parseEventRecord, toEventRecord } from './event-record.js';
import { frozenEnvelope } from './freeze.js';
import { toPromise } from './promise.js';
import { readInteger, readNullableText, readText, type SqliteRow } from './rows.js';
import { withImmediateTransaction } from './transaction.js';

const CHECKPOINT_COLUMNS = 'aggregate_id, event_position, schema_version, snapshot';

const SELECT_LATEST_SQL = `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints
WHERE aggregate_id = ?
ORDER BY event_position DESC
LIMIT 1`;

const SELECT_POSITION_SQL = `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints
WHERE aggregate_id = ? AND event_position = ?`;

const INSERT_CHECKPOINT_SQL = `INSERT INTO checkpoints (${CHECKPOINT_COLUMNS})
VALUES (?, ?, ?, ?)
ON CONFLICT (aggregate_id, event_position) DO NOTHING`;

/** One durable checkpoint: a committed position and its optional stream prefix. */
export interface Checkpoint {
  readonly taskRunId: TaskRunId;
  readonly eventPosition: number;
  readonly schemaVersion: number;
  readonly snapshot: readonly EventEnvelope[] | null;
}

export interface CheckpointStore {
  /**
   * Store a checkpoint after validating `1 <= eventPosition <= committed`.
   *
   * The position is immutable once stored; a repeat save keeps the first row.
   */
  save(
    taskRunId: TaskRunId,
    eventPosition: number,
    snapshot?: readonly EventEnvelope[],
  ): Promise<Checkpoint>;
  /** Highest stored checkpoint for the aggregate, or null. */
  latest(taskRunId: TaskRunId): Promise<Checkpoint | null>;
  /** Committed events strictly after a checkpoint position. */
  loadAfter(taskRunId: TaskRunId, position: number): Promise<readonly EventEnvelope[]>;
}

export class SqliteCheckpointStore implements CheckpointStore {
  readonly #db: DatabaseSync;
  readonly #log: SqliteEventLog;

  constructor(db: DatabaseSync, log: SqliteEventLog) {
    this.#db = db;
    this.#log = log;
  }

  save(
    taskRunId: TaskRunId,
    eventPosition: number,
    snapshot?: readonly EventEnvelope[],
  ): Promise<Checkpoint> {
    return toPromise(() => this.#save(taskRunId, eventPosition, snapshot));
  }

  latest(taskRunId: TaskRunId): Promise<Checkpoint | null> {
    return toPromise(() => this.#latest(taskRunId));
  }

  loadAfter(taskRunId: TaskRunId, position: number): Promise<readonly EventEnvelope[]> {
    return toPromise(() => this.#log.loadAfter(taskRunId, position));
  }

  #save(
    taskRunId: TaskRunId,
    eventPosition: number,
    snapshot: readonly EventEnvelope[] | undefined,
  ): Checkpoint {
    const committedVersion = this.#log.version(taskRunId);
    assertEventPosition(eventPosition, committedVersion);
    const snapshotJson =
      snapshot === undefined ? null : this.#encodeSnapshot(taskRunId, eventPosition, snapshot);
    withImmediateTransaction(this.#db, () => {
      this.#db
        .prepare(INSERT_CHECKPOINT_SQL)
        .run(taskRunId, eventPosition, TASK_RUN_SCHEMA_VERSION, snapshotJson);
    });
    const row = this.#db.prepare(SELECT_POSITION_SQL).get(taskRunId, eventPosition);
    if (row === undefined) {
      throw new Error(`checkpoint for ${taskRunId} at position ${eventPosition} was not stored`);
    }
    return parseCheckpointRow(row);
  }

  #latest(taskRunId: TaskRunId): Checkpoint | null {
    const row = this.#db.prepare(SELECT_LATEST_SQL).get(taskRunId);
    if (row === undefined) return null;
    return parseCheckpointRow(row);
  }

  /**
   * Encode a snapshot, after proving it is exactly the committed prefix.
   *
   * The comparison is column-for-column against the log, so a snapshot cannot
   * silently disagree with the stream that recovery will replay.
   */
  #encodeSnapshot(
    taskRunId: TaskRunId,
    eventPosition: number,
    snapshot: readonly EventEnvelope[],
  ): string {
    if (snapshot.length !== eventPosition) {
      throw new RangeError(
        `checkpoint snapshot must cover sequences 1..${eventPosition}, received ${snapshot.length} events`,
      );
    }
    const records = snapshot.map((event, index) => {
      if (event.aggregateId !== taskRunId) {
        throw new Error(
          `checkpoint snapshot event ${index + 1} belongs to ${event.aggregateId}, not ${taskRunId}`,
        );
      }
      if (event.sequence !== index + 1) {
        throw new Error(
          `checkpoint snapshot event ${index + 1} carries sequence ${event.sequence}`,
        );
      }
      return toEventRecord(event);
    });
    const committed = this.#log
      .loadRange(taskRunId, 1, eventPosition)
      .map((event) => toEventRecord(event));
    if (JSON.stringify(records) !== JSON.stringify(committed)) {
      throw new Error(
        `checkpoint snapshot for ${taskRunId} does not match the committed event log`,
      );
    }
    return JSON.stringify(records);
  }
}

function assertEventPosition(eventPosition: number, committedVersion: number): void {
  if (!Number.isInteger(eventPosition) || eventPosition < 1) {
    throw new RangeError(`checkpoint position must be an integer >= 1, received ${eventPosition}`);
  }
  if (eventPosition > committedVersion) {
    throw new RangeError(
      `checkpoint position ${eventPosition} is past the committed version ${committedVersion}`,
    );
  }
}

function parseCheckpointRow(row: SqliteRow): Checkpoint {
  const taskRunId = parseTaskRunId(readText(row, 'aggregate_id'));
  const eventPosition = readInteger(row, 'event_position');
  const schemaVersion = readInteger(row, 'schema_version');
  if (schemaVersion !== TASK_RUN_SCHEMA_VERSION) {
    // Fail closed: a snapshot written under another event schema cannot be
    // replayed safely, so recovery must not pretend it can.
    throw new Error(
      `checkpoint schema version ${schemaVersion} is not supported (expected ${TASK_RUN_SCHEMA_VERSION})`,
    );
  }
  if (eventPosition < 1) {
    throw new Error(`checkpoint position must be >= 1, received ${eventPosition}`);
  }
  const snapshotText = readNullableText(row, 'snapshot');
  const snapshot =
    snapshotText === null ? null : parseSnapshot(snapshotText, taskRunId, eventPosition);
  return Object.freeze({ taskRunId, eventPosition, schemaVersion, snapshot });
}

function parseSnapshot(
  json: string,
  taskRunId: TaskRunId,
  eventPosition: number,
): readonly EventEnvelope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new Error(`checkpoint snapshot for ${taskRunId} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`checkpoint snapshot for ${taskRunId} must be an array of events`);
  }
  if (parsed.length !== eventPosition) {
    throw new Error(
      `checkpoint snapshot for ${taskRunId} must hold ${eventPosition} events, found ${parsed.length}`,
    );
  }
  const events = parsed.map((value, index) => {
    const record = parseEventRecord(value);
    if (record.aggregate_id !== taskRunId) {
      throw new Error(
        `checkpoint snapshot event ${index + 1} belongs to ${record.aggregate_id}, not ${taskRunId}`,
      );
    }
    if (record.sequence !== index + 1) {
      throw new Error(`checkpoint snapshot event ${index + 1} carries sequence ${record.sequence}`);
    }
    return frozenEnvelope(fromEventRecord(record));
  });
  return Object.freeze(events);
}
