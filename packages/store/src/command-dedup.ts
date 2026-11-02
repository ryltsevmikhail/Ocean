/**
 * In-memory command idempotency store.
 *
 * Receipts are keyed by command id and frozen on write. A repeated `put` never
 * replaces an existing receipt: the first committed receipt is the one
 * replayed, so a retried submission cannot rewrite command history.
 */

import type { CommandDedupPort, CommandReceipt } from '@runnets/application';

export class InMemoryCommandDedup implements CommandDedupPort {
  readonly #receipts = new Map<string, CommandReceipt>();

  /** The port is asynchronous; this adapter resolves without scheduling work. */
  get(commandId: string): Promise<CommandReceipt | null> {
    return Promise.resolve(this.#receipts.get(commandId) ?? null);
  }

  put(receipt: CommandReceipt): Promise<void> {
    // First write wins: a concurrent or replayed put must not mask the receipt
    // that actually committed the command.
    if (this.#receipts.has(receipt.commandId)) return Promise.resolve();
    const stored: CommandReceipt = {
      commandId: receipt.commandId,
      taskRunId: receipt.taskRunId,
      version: receipt.version,
      events: Object.freeze([...receipt.events]),
    };
    this.#receipts.set(receipt.commandId, Object.freeze(stored));
    return Promise.resolve();
  }
}
