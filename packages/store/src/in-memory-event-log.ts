/**
 * In-memory event log.
 *
 * The log is the write authority for TaskRun streams: it assigns event
 * identity, the per-aggregate sequence number, and the commit envelope around
 * every draft. Stored events and every value handed to callers are frozen, so
 * committed history cannot be mutated through an alias.
 */

import type {
  AppendMeta,
  AppendOutcome,
  EventLogPort,
  IdGenerator,
  CommandCommitPort,
} from '@runnets/application';
import type { EventEnvelope, TaskRunEvent, TaskRunEventDraft, TaskRunId } from '@runnets/domain';

import { memoryCommands } from './command-commit.js';

import { SequentialIdGenerator } from './id-generator.js';

const EMPTY_STREAM: readonly TaskRunEvent[] = Object.freeze([]);

/**
 * Deep-copy a payload and freeze every object and array in the copy.
 *
 * Event payloads are JSON-like by domain contract (plain objects, arrays,
 * primitives, null), so a structural walk is sufficient. Copying detaches the
 * committed event from the draft the caller still holds.
 */
function freezeCopy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    return Object.freeze(items.map((item) => freezeCopy(item)));
  }
  const source = value as Readonly<Record<string, unknown>>;
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) copy[key] = freezeCopy(nested);
  return Object.freeze(copy);
}

export class InMemoryEventLog implements EventLogPort {
  readonly commands: CommandCommitPort;
  readonly #ids: IdGenerator;
  readonly #streams = new Map<TaskRunId, readonly TaskRunEvent[]>();

  /**
   * `ids` mints event identities. When omitted the log creates a private
   * sequential generator; hosts that share identity across adapters pass the
   * application-wide generator explicitly.
   */
  constructor(ids: IdGenerator = new SequentialIdGenerator()) {
    this.#ids = ids;
    this.commands = memoryCommands((command, version, drafts, meta) =>
      this.#append(command.taskRunId, version, drafts, meta),
    );
  }

  /** The port is asynchronous; this adapter resolves without scheduling work. */
  load(taskRunId: TaskRunId): Promise<readonly EventEnvelope[]> {
    return Promise.resolve(this.#streams.get(taskRunId) ?? EMPTY_STREAM);
  }

  append(
    taskRunId: TaskRunId,
    expectedVersion: number,
    drafts: readonly TaskRunEventDraft[],
    meta: AppendMeta,
  ): Promise<AppendOutcome> {
    return Promise.resolve(this.#append(taskRunId, expectedVersion, drafts, meta));
  }

  /** Enumerate only task streams with committed events. */
  listTaskRuns(): Promise<readonly TaskRunId[]> {
    return Promise.resolve(Object.freeze([...this.#streams.keys()]));
  }

  #append(
    taskRunId: TaskRunId,
    expectedVersion: number,
    drafts: readonly TaskRunEventDraft[],
    meta: AppendMeta,
  ): AppendOutcome {
    const stream = this.#streams.get(taskRunId) ?? EMPTY_STREAM;
    const actualVersion = stream.length;
    if (expectedVersion !== actualVersion) {
      return { ok: false, actualVersion };
    }

    // Every envelope is built before the stream is replaced, and this method
    // never awaits, so a batch is committed atomically and sequences stay
    // contiguous even under concurrent `append` calls.
    const committed = drafts.map((source, index) =>
      this.#commit(taskRunId, actualVersion + index + 1, source, meta),
    );
    this.#streams.set(taskRunId, Object.freeze([...stream, ...committed]));
    return { ok: true, events: Object.freeze(committed) };
  }

  /**
   * Wrap one draft in a committed envelope.
   *
   * Actor rule: `kind` comes from the draft, because the domain classifies the
   * actor, while `id` comes from `AppendMeta.actorId`, because the application
   * layer is authoritative for the identity committing the command. The
   * command path passes the same actor in both places, so they agree in normal
   * use.
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
      payload: freezeCopy(source.payload),
    };
    // The draft pairs `type` with its payload, so the assertion only restores
    // that correlation for the mapped union after the envelope generic widened.
    return Object.freeze(envelope) as TaskRunEvent;
  }
}
