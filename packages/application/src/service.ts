/**
 * TaskRun application service.
 *
 * One command in, zero or more committed events out. The service is the only
 * place where decision, optimistic concurrency, and idempotency meet; it holds
 * no state of its own.
 */

import {
  DomainError,
  decide,
  err,
  ok,
  replay,
  type AnyCommand,
  type EventEnvelope,
  type Result,
  type TaskRunAggregate,
  type TaskRunId,
} from '@runnets/domain';

import { commandConflict, snapshotCommand } from './command-commit.js';

import type {
  CommandDedupPort,
  CommandReceipt,
  EventLogPort,
  Clock,
  IdGenerator,
} from './ports.js';

export interface TaskRunServiceDeps {
  readonly log: EventLogPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly dedup?: CommandDedupPort;
}

export class TaskRunService {
  readonly #deps: TaskRunServiceDeps;

  constructor(deps: TaskRunServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Execute a command.
   *
   * Ordering matters: duplicate detection happens before loading, so a retried
   * submission returns the original receipt instead of failing on a stale
   * expected version.
   */
  async execute(submitted: AnyCommand): Promise<Result<CommandReceipt>> {
    const command = snapshotCommand(submitted);
    const { dedup } = this.#deps;
    const commands = this.#deps.log.commands;
    if (commands !== undefined) {
      const previous = await commands.lookup(command);
      if (!previous.ok) return previous;
      if (previous.value !== null) return ok(previous.value);
    } else if (dedup !== undefined) {
      const previous = await dedup.get(command.commandId);
      if (previous !== null) return commandConflict();
    }

    const stream = await this.#deps.log.load(command.taskRunId);
    const aggregate = replay(stream);
    const decision = decide(aggregate, command);
    if (!decision.ok) {
      // Another caller may have committed after our first lookup but before load.
      // Recheck before returning a stale-version or transition rejection.
      if (commands !== undefined) {
        const concurrent = await commands.lookup(command);
        if (!concurrent.ok) return concurrent;
        if (concurrent.value !== null) return ok(concurrent.value);
      }
      return decision;
    }

    const meta = {
      correlationId: command.taskRunId,
      timestamp: this.#deps.clock.now().toISOString(),
      actorId: command.actor.id,
    };
    if (commands !== undefined) {
      const result = await commands.commit(command, aggregate.version, decision.value, meta);
      if (result.ok && dedup !== undefined) {
        try {
          await dedup.put(result.value);
        } catch {
          // The atomic log owns the authoritative receipt. A legacy mirror is
          // best-effort and cannot turn a durable success into a reported failure.
        }
      }
      return result;
    }
    const outcome = await this.#deps.log.append(
      command.taskRunId,
      aggregate.version,
      decision.value,
      {
        correlationId: command.taskRunId,
        timestamp: this.#deps.clock.now().toISOString(),
        actorId: command.actor.id,
      },
    );
    if (!outcome.ok) {
      return err(DomainError.versionConflict(aggregate.version, outcome.actualVersion));
    }

    const receipt: CommandReceipt = {
      commandId: command.commandId,
      taskRunId: command.taskRunId,
      version: aggregate.version + outcome.events.length,
      events: outcome.events,
    };
    if (dedup !== undefined) await dedup.put(receipt);
    return ok(receipt);
  }

  /** Synchronous committed head for decisions sharing an adapter transaction. */
  committedVersion(id: TaskRunId): number | null {
    return this.#deps.log.headVersion?.(id) ?? null;
  }

  /** Enumerate persisted task runs when the adapter supports recovery discovery. */
  async listTaskRuns(): Promise<readonly TaskRunId[]> {
    return this.#deps.log.listTaskRuns?.() ?? [];
  }

  /** Current aggregate state, rebuilt from committed events. */
  async state(taskRunId: TaskRunId): Promise<TaskRunAggregate> {
    return replay(await this.#deps.log.load(taskRunId));
  }

  /** Committed event stream, in order. */
  async events(taskRunId: TaskRunId): Promise<readonly EventEnvelope[]> {
    return this.#deps.log.load(taskRunId);
  }

  /** Convenience command-id generator for callers that do not own identity. */
  nextCommandId(): string {
    return this.#deps.ids.commandId();
  }
}
