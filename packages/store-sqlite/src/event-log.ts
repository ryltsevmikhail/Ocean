import type { RoomHostBinding } from './room-host-storage.js';
/**
 * Durable event log.
 *
 * The log is the write authority for TaskRun streams: it assigns event
 * identity, the per-aggregate sequence number, and the commit envelope around
 * every draft. Appends are fenced by the expected version inside one immediate
 * transaction, so a mismatched writer commits nothing and a batch commits
 * all-or-nothing. The returned promise resolves only after SQLite committed.
 */

import type {
  AppendMeta,
  AppendOutcome,
  EventLogPort,
  IdGenerator,
  CommandCommitPort,
} from '@runnets/application';
import { taskRunId as parseTaskRunId } from '@runnets/domain';
import { sqliteCommands } from './command-commit.js';
import type { EventEnvelope, TaskRunEvent, TaskRunEventDraft, TaskRunId } from '@runnets/domain';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  eventRecordFromRow,
  fromEventRecord,
  toEventRecord,
  type EventRecord,
} from './event-record.js';
import { frozenEnvelope } from './freeze.js';
import { toPromise } from './promise.js';
import { readInteger, type SqliteRow } from './rows.js';
import { withImmediateTransaction } from './transaction.js';

const EVENT_COLUMNS =
  'aggregate_id, sequence, event_id, aggregate_type, type, schema_version, timestamp, ' +
  'causation_id, correlation_id, actor_kind, actor_id, sensitivity, payload';

const INSERT_EVENT_SQL = `INSERT INTO events (${EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_STREAM_SQL = `SELECT ${EVENT_COLUMNS} FROM events WHERE aggregate_id = ? ORDER BY sequence`;

const SELECT_AFTER_SQL = `SELECT ${EVENT_COLUMNS} FROM events WHERE aggregate_id = ? AND sequence > ? ORDER BY sequence`;

const SELECT_RANGE_SQL = `SELECT ${EVENT_COLUMNS} FROM events WHERE aggregate_id = ? AND sequence BETWEEN ? AND ? ORDER BY sequence`;

const SELECT_EVENT_SQL = `SELECT ${EVENT_COLUMNS} FROM events WHERE aggregate_id = ? AND sequence = ?`;

const SELECT_VERSION_SQL =
  'SELECT COALESCE(MAX(sequence), 0) AS version FROM events WHERE aggregate_id = ?';

export class SqliteEventLog implements EventLogPort {
  readonly commands: CommandCommitPort;
  readonly #db: DatabaseSync;
  readonly #ids: IdGenerator;

  constructor(db: DatabaseSync, ids: IdGenerator, host: RoomHostBinding = () => null) {
    this.#db = db;
    this.#ids = ids;
    this.commands = sqliteCommands(
      db,
      (command, version, drafts, meta) =>
        this.#appendWithin(command.taskRunId, version, drafts, meta),
      host,
    );
  }

  /** Current head from the transaction's SQLite snapshot. */
  headVersion(id: TaskRunId): number {
    return committedTaskVersion(this.#db, id);
  }
  /** Read one aggregate stream in committed order. */
  load(taskRunId: TaskRunId): Promise<readonly EventEnvelope[]> {
    return toPromise(() => this.#stream(taskRunId));
  }

  /**
   * Append a batch at the next contiguous sequences.
   *
   * The expected-version read, the envelope numbering and every insert share one
   * `BEGIN IMMEDIATE` transaction; a stale writer therefore observes the real
   * committed version and leaves the log untouched.
   */
  append(
    taskRunId: TaskRunId,
    expectedVersion: number,
    drafts: readonly TaskRunEventDraft[],
    meta: AppendMeta,
  ): Promise<AppendOutcome> {
    return toPromise(() =>
      withImmediateTransaction(this.#db, () =>
        this.#appendWithin(taskRunId, expectedVersion, drafts, meta),
      ),
    );
  }

  /** Enumerate persisted task streams for host recovery. */
  listTaskRuns(): Promise<readonly TaskRunId[]> {
    return toPromise(() =>
      Object.freeze(
        this.#db
          .prepare('SELECT DISTINCT aggregate_id FROM events ORDER BY aggregate_id')
          .all()
          .map((row) => {
            const id = row['aggregate_id'];
            if (typeof id !== 'string') throw new Error('invalid aggregate identity');
            return parseTaskRunId(id);
          }),
      ),
    );
  }

  /** Last committed sequence for an aggregate; 0 when the stream is empty. */
  version(taskRunId: TaskRunId): number {
    const row = this.#db.prepare(SELECT_VERSION_SQL).get(taskRunId);
    return readVersion(row);
  }

  /** Committed events strictly after `position`, used by recovery. */
  loadAfter(taskRunId: TaskRunId, position: number): readonly EventEnvelope[] {
    if (!Number.isInteger(position) || position < 0) {
      throw new RangeError(`event position must be an integer >= 0, received ${position}`);
    }
    const rows = this.#db.prepare(SELECT_AFTER_SQL).all(taskRunId, position);
    return freezeStream(rows);
  }

  /**
   * Committed window `[first, last]`, used to validate a checkpoint snapshot
   * against the authoritative log.
   */
  loadRange(taskRunId: TaskRunId, first: number, last: number): readonly EventEnvelope[] {
    if (!Number.isInteger(first) || first < 1) {
      throw new RangeError(`first event position must be an integer >= 1, received ${first}`);
    }
    if (!Number.isInteger(last) || last < first) {
      throw new RangeError(`last event position must be an integer >= ${first}, received ${last}`);
    }
    const rows = this.#db.prepare(SELECT_RANGE_SQL).all(taskRunId, first, last);
    return freezeStream(rows);
  }

  /** Event committed at a 1-based position, or null when it does not exist. */
  eventAt(taskRunId: TaskRunId, sequence: number): EventEnvelope | null {
    const row = this.#db.prepare(SELECT_EVENT_SQL).get(taskRunId, sequence);
    if (row === undefined) return null;
    return frozenEnvelope(fromEventRecord(eventRecordFromRow(row)));
  }

  #appendWithin(
    taskRunId: TaskRunId,
    expectedVersion: number,
    drafts: readonly TaskRunEventDraft[],
    meta: AppendMeta,
  ): AppendOutcome {
    const actualVersion = this.version(taskRunId);
    if (expectedVersion !== actualVersion) {
      return { ok: false, actualVersion };
    }
    // Envelopes are created and inserted one draft at a time inside the
    // transaction: a throw on a later draft rolls the earlier inserts back.
    const insert = this.#db.prepare(INSERT_EVENT_SQL);
    const committed: TaskRunEvent[] = [];
    for (const [index, source] of drafts.entries()) {
      const event = this.#commit(taskRunId, actualVersion + index + 1, source, meta);
      insertEvent(insert, toEventRecord(event));
      committed.push(event);
    }
    return { ok: true, events: Object.freeze(committed) };
  }

  #stream(taskRunId: TaskRunId): readonly EventEnvelope[] {
    return freezeStream(this.#db.prepare(SELECT_STREAM_SQL).all(taskRunId));
  }

  /**
   * Wrap one draft in a committed envelope.
   *
   * Actor rule: `kind` comes from the draft, because the domain classifies the
   * actor, while `id` comes from `AppendMeta.actorId`, because the application
   * layer is authoritative for the identity committing the command.
   */
  #commit(
    taskRunId: TaskRunId,
    sequence: number,
    source: TaskRunEventDraft,
    meta: AppendMeta,
  ): TaskRunEvent {
    const envelope: EventEnvelope = {
      eventId: this.#ids.eventId(),
      aggregateType: 'task_run',
      aggregateId: taskRunId,
      sequence,
      type: source.type,
      schemaVersion: source.schemaVersion,
      timestamp: meta.timestamp,
      causationId: source.causationId,
      correlationId: meta.correlationId,
      actor: { kind: source.actor.kind, id: meta.actorId },
      sensitivity: source.sensitivity,
      payload: source.payload,
    };
    // The draft pairs `type` with its payload, so the assertion only restores
    // that correlation for the mapped union after the envelope generic widened.
    return frozenEnvelope(envelope) as TaskRunEvent;
  }
}

function insertEvent(statement: StatementSync, record: EventRecord): void {
  statement.run(
    record.aggregate_id,
    record.sequence,
    record.event_id,
    record.aggregate_type,
    record.type,
    record.schema_version,
    record.timestamp,
    record.causation_id,
    record.correlation_id,
    record.actor_kind,
    record.actor_id,
    record.sensitivity,
    record.payload,
  );
}

function freezeStream(rows: readonly SqliteRow[]): readonly EventEnvelope[] {
  return Object.freeze(rows.map((row) => frozenEnvelope(fromEventRecord(eventRecordFromRow(row)))));
}

function readVersion(row: SqliteRow | undefined): number {
  if (row === undefined) throw new Error('SQLite returned no row for the committed version');
  const version = readInteger(row, 'version');
  if (version < 0) throw new Error(`committed version is negative: ${version}`);
  return version;
}

/** Canonical head read; participates in a caller-owned SQLite transaction. */
export function committedTaskVersion(db: DatabaseSync, id: TaskRunId): number {
  const value = db.prepare(SELECT_VERSION_SQL).get(id)?.['version'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('Invalid task version');
  return value;
}
