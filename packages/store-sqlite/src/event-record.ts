/**
 * Persisted event records.
 *
 * One committed envelope maps to one flat record. The event table uses a
 * composite `(aggregate_id, sequence)` primary key and keeps the payload in a
 * JSON text column. Command receipts and checkpoint snapshots reuse this exact
 * encoding, so a checkpoint can be compared column-for-column with the log.
 */

import type { ActorKind, EventEnvelope, Sensitivity } from '@runnets/domain';
import { AGGREGATE_TYPES } from '@runnets/domain';

import { readInteger, readNullableText, readText } from './rows.js';

const ACTOR_KINDS = [
  'user',
  'runtime',
  'scheduler',
  'tool',
  'provider',
  'policy',
] as const satisfies readonly ActorKind[];

const SENSITIVITIES = [
  'public',
  'internal',
  'restricted',
] as const satisfies readonly Sensitivity[];

/** Column-for-column shape of one committed event row. */
export interface EventRecord {
  readonly aggregate_id: string;
  readonly sequence: number;
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly type: string;
  readonly schema_version: number;
  readonly timestamp: string;
  readonly causation_id: string | null;
  readonly correlation_id: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly sensitivity: string;
  readonly payload: string;
}

/** Project a committed envelope onto its persisted record. */
export function toEventRecord(event: EventEnvelope): EventRecord {
  return {
    aggregate_id: event.aggregateId,
    sequence: event.sequence,
    event_id: event.eventId,
    aggregate_type: event.aggregateType,
    type: event.type,
    schema_version: event.schemaVersion,
    timestamp: event.timestamp,
    causation_id: event.causationId,
    correlation_id: event.correlationId,
    actor_kind: event.actor.kind,
    actor_id: event.actor.id,
    sensitivity: event.sensitivity,
    payload: JSON.stringify(event.payload),
  };
}

/** Rebuild an envelope from a record that has already been validated. */
export function fromEventRecord(record: EventRecord): EventEnvelope {
  return {
    eventId: record.event_id,
    aggregateType: pick(AGGREGATE_TYPES, record.aggregate_type, 'aggregate_type'),
    aggregateId: record.aggregate_id,
    sequence: record.sequence,
    type: record.type,
    schemaVersion: record.schema_version,
    timestamp: record.timestamp,
    causationId: record.causation_id,
    correlationId: record.correlation_id,
    actor: { kind: pick(ACTOR_KINDS, record.actor_kind, 'actor_kind'), id: record.actor_id },
    sensitivity: pick(SENSITIVITIES, record.sensitivity, 'sensitivity'),
    payload: parsePayload(record.payload),
  };
}

/** Read one event row selected with the event column list. */
export function eventRecordFromRow(row: Readonly<Record<string, unknown>>): EventRecord {
  return readEventRecord(row);
}

/** Validate one record decoded from checkpoint snapshot JSON. */
export function parseEventRecord(value: unknown): EventRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('checkpoint snapshot event must be an object');
  }
  return readEventRecord(value as Readonly<Record<string, unknown>>);
}

function readEventRecord(source: Readonly<Record<string, unknown>>): EventRecord {
  return {
    aggregate_id: readText(source, 'aggregate_id'),
    sequence: readInteger(source, 'sequence'),
    event_id: readText(source, 'event_id'),
    aggregate_type: readText(source, 'aggregate_type'),
    type: readText(source, 'type'),
    schema_version: readInteger(source, 'schema_version'),
    timestamp: readText(source, 'timestamp'),
    causation_id: readNullableText(source, 'causation_id'),
    correlation_id: readText(source, 'correlation_id'),
    actor_kind: readText(source, 'actor_kind'),
    actor_id: readText(source, 'actor_id'),
    sensitivity: readText(source, 'sensitivity'),
    payload: readText(source, 'payload'),
  };
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('stored event payload is not valid JSON');
  }
}

function pick<TValue extends string>(
  allowed: readonly TValue[],
  value: string,
  field: string,
): TValue {
  for (const candidate of allowed) {
    if (candidate === value) return candidate;
  }
  throw new Error(`stored event ${field} is not supported`);
}
