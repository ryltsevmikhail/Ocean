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

type Append = (
  command: AnyCommand,
  version: number,
  drafts: readonly TaskRunEventDraft[],
  meta: AppendMeta,
) => AppendOutcome;

/** In-memory commits run synchronously so lookup, append and receipt cannot interleave. */
export function memoryCommands(append: Append): CommandCommitPort {
  const receipts = new Map<string, { binding: string; receipt: CommandReceipt }>();
  function lookup(command: AnyCommand): Result<CommandReceipt | null> {
    const previous = receipts.get(command.commandId);
    if (previous === undefined) return ok(null);
    return previous.binding === commandBinding(command) ? ok(previous.receipt) : commandConflict();
  }
  return {
    lookup: (command) => Promise.resolve(lookup(command)),
    commit(command, version, drafts, meta) {
      const previous = lookup(command);
      if (!previous.ok) return Promise.resolve(previous);
      if (previous.value !== null) return Promise.resolve(ok(previous.value));
      const binding = commandBinding(command);
      const result = append(command, version, drafts, meta);
      if (!result.ok)
        return Promise.resolve(err(DomainError.versionConflict(version, result.actualVersion)));
      const receipt = Object.freeze({
        commandId: command.commandId,
        taskRunId: command.taskRunId,
        version: version + result.events.length,
        events: result.events,
      });
      receipts.set(command.commandId, { binding, receipt });
      return Promise.resolve(ok(receipt));
    },
  };
}
