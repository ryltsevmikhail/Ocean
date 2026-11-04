/**
 * Row mapping for the durable plugin operation journal.
 *
 * Shared by the admission settlement path and the owner operation views so both
 * read and write exactly one shape. Every value is plain data: bounded strings,
 * counters and timestamps.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { PluginOperationRecord, PluginOperationState } from '@runnets/domain';
import type { PluginAdmissionSettlement } from '@runnets/application';
import type { PluginOperationFilter } from '@runnets/application';
import { PluginRefusedError } from '@runnets/application';

const COLUMNS = `id, task_run_id, attempt_id, workspace_id, room_id, bot_id, plugin_id,
  connection_id, connection_generation, endpoint, tool, repository, schema_digest,
  arguments_digest, arguments, state, outcome_code, detail, result_summary, result_bytes,
  truncated, revision, created_at, settled_at, acknowledged_at, acknowledged_reason`;

type Row = Readonly<Record<string, unknown>>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function operationRecord(row: Row): PluginOperationRecord {
  return {
    id: text(row['id']),
    taskRunId: text(row['task_run_id']),
    attemptId: text(row['attempt_id']),
    workspaceId: text(row['workspace_id']),
    roomId: text(row['room_id']),
    botId: text(row['bot_id']),
    pluginId: text(row['plugin_id']),
    connectionId: text(row['connection_id']),
    connectionGeneration: Number(row['connection_generation']),
    endpoint: text(row['endpoint']),
    tool: text(row['tool']),
    repository: text(row['repository']),
    schemaDigest: text(row['schema_digest']),
    argumentsDigest: text(row['arguments_digest']),
    arguments: text(row['arguments']),
    state: text(row['state']) as PluginOperationState,
    outcomeCode: optionalText(row['outcome_code']),
    detail: optionalText(row['detail']),
    resultSummary: optionalText(row['result_summary']),
    resultBytes: optionalNumber(row['result_bytes']),
    truncated: row['truncated'] === 1 || row['truncated'] === true,
    revision: Number(row['revision']),
    createdAt: text(row['created_at']),
    settledAt: optionalText(row['settled_at']),
    acknowledgedAt: optionalText(row['acknowledged_at']),
    acknowledgedReason: optionalText(row['acknowledged_reason']),
  };
}

export function readOperation(db: DatabaseSync, id: string): PluginOperationRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM ocean_plugin_operations WHERE id = ?`).get(id);
  return row === undefined ? null : operationRecord(row);
}

export function readOperations(
  db: DatabaseSync,
  filter: PluginOperationFilter = {},
): readonly PluginOperationRecord[] {
  const where: string[] = [];
  const values: (string | number)[] = [];
  for (const [column, value] of [
    ['workspace_id', filter.workspaceId],
    ['room_id', filter.roomId],
    ['bot_id', filter.botId],
    ['state', filter.state],
  ] as const) {
    if (value !== undefined) {
      where.push(`${column} = ?`);
      values.push(value);
    }
  }
  const limit = filter.limit ?? 50;
  const clause = where.length === 0 ? '' : 'WHERE ' + where.join(' AND ');
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM ocean_plugin_operations ${clause}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...values, limit);
  return rows.map(operationRecord);
}

/** One INSERT per admitted invocation, in the admission transaction. */
export function insertOperation(db: DatabaseSync, record: PluginOperationRecord): void {
  db.prepare(
    `INSERT INTO ocean_plugin_operations (${COLUMNS}) VALUES
     (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    record.id,
    record.taskRunId,
    record.attemptId,
    record.workspaceId,
    record.roomId,
    record.botId,
    record.pluginId,
    record.connectionId,
    record.connectionGeneration,
    record.endpoint,
    record.tool,
    record.repository,
    record.schemaDigest,
    record.argumentsDigest,
    record.arguments,
    record.state,
    record.outcomeCode,
    record.detail,
    record.resultSummary,
    record.resultBytes,
    record.truncated ? 1 : 0,
    record.revision,
    record.createdAt,
    record.settledAt,
    record.acknowledgedAt,
    record.acknowledgedReason,
  );
}

/** Only a `started` row can be settled once; a second settlement refuses. */
export function settleOperationRow(
  db: DatabaseSync,
  id: string,
  settlement: PluginAdmissionSettlement,
): void {
  const result = db
    .prepare(
      `UPDATE ocean_plugin_operations
       SET state = ?, outcome_code = ?, detail = ?, result_summary = ?, result_bytes = ?,
           truncated = ?, settled_at = ?, revision = revision + 1
       WHERE id = ? AND state = 'started'`,
    )
    .run(
      settlement.state,
      settlement.outcomeCode,
      settlement.detail,
      settlement.resultSummary,
      settlement.resultBytes,
      settlement.truncated ? 1 : 0,
      settlement.settledAt,
      id,
    );
  if (result.changes !== 1) throw Error('plugin operation is missing or already settled');
}

/** Starts are lowered to uncertainty on startup; never to success and never replayable. */
export function lowerStartedOperations(
  db: DatabaseSync,
  at: string,
): readonly PluginOperationRecord[] {
  const started = readOperations(db, { state: 'started', limit: 200 });
  for (const record of started) {
    db.prepare(
      `UPDATE ocean_plugin_operations
       SET state = 'uncertain', outcome_code = 'interrupted',
           detail = 'runtime restarted before the operation settled',
           settled_at = ?, revision = revision + 1
       WHERE id = ? AND state = 'started'`,
    ).run(at, record.id);
  }
  return started;
}

/** Owner acknowledgement is a compare-and-set on the visible revision. */
export function acknowledgeOperationRow(
  db: DatabaseSync,
  input: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly reason: string;
    readonly at: string;
  },
): PluginOperationRecord {
  const current = readOperation(db, input.operationId);
  if (current === null) throw refuse('operation_unknown');
  if (current.state !== 'uncertain') throw refuse('operation_not_uncertain');
  if (current.revision !== input.expectedRevision) throw refuse('operation_conflict');
  const result = db
    .prepare(
      `UPDATE ocean_plugin_operations
       SET state = 'acknowledged', acknowledged_at = ?, acknowledged_reason = ?,
           revision = revision + 1
       WHERE id = ? AND state = 'uncertain' AND revision = ?`,
    )
    .run(
      input.at,
      input.reason.length === 0 ? null : input.reason,
      input.operationId,
      input.expectedRevision,
    );
  if (result.changes !== 1) throw refuse('operation_conflict');
  const updated = readOperation(db, input.operationId);
  if (updated === null) throw refuse('operation_unknown');
  return updated;
}

function refuse(code: string): PluginRefusedError {
  return new PluginRefusedError(code, 'plugin operation refused: ' + code);
}
