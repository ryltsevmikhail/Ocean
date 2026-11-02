import {
  DomainError,
  err,
  ok,
  type AnyCommand,
  type Result,
  type TaskRunEventDraft,
} from '@runnets/domain';
import {
  commandBinding,
  commandConflict,
  type AppendMeta,
  type AppendOutcome,
  type CommandCommitPort,
  type CommandReceipt,
} from '@runnets/application';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteCommandDedup } from './command-dedup.js';
import { toPromise } from './promise.js';
import { withImmediateTransaction } from './transaction.js';

type Append = (
  command: AnyCommand,
  version: number,
  drafts: readonly TaskRunEventDraft[],
  meta: AppendMeta,
) => AppendOutcome;

/** Commit request-bound receipts and events in the same SQLite write transaction. */
export function sqliteCommands(db: DatabaseSync, append: Append): CommandCommitPort {
  const dedup = new SqliteCommandDedup(db);
  function lookup(command: AnyCommand): Result<CommandReceipt | null> {
    const receipt = dedup.read(command.commandId);
    if (receipt === null) return ok(null);
    const row = db
      .prepare('SELECT request_binding FROM command_receipts WHERE command_id = ?')
      .get(command.commandId);
    // Legacy receipts lack the original request: never guess authorization or payload identity.
    if (row?.['request_binding'] !== commandBinding(command)) return commandConflict();
    return ok(receipt);
  }
  return {
    lookup: (command) => toPromise(() => lookup(command)),
    commit: (command, version, drafts, meta) =>
      toPromise(() =>
        withImmediateTransaction(db, () => {
          // Dedup precedes version checks under the write lock so simultaneous retries replay.
          const previous = lookup(command);
          if (!previous.ok) return previous;
          if (previous.value !== null) return ok(previous.value);
          const binding = commandBinding(command);
          const result = append(command, version, drafts, meta);
          if (!result.ok) return err(DomainError.versionConflict(version, result.actualVersion));
          const receipt: CommandReceipt = {
            commandId: command.commandId,
            taskRunId: command.taskRunId,
            version: version + result.events.length,
            events: result.events,
          };
          dedup.write(receipt);
          db.prepare('UPDATE command_receipts SET request_binding = ? WHERE command_id = ?').run(
            binding,
            command.commandId,
          );
          return ok(Object.freeze(receipt));
        }),
      ),
  };
}
