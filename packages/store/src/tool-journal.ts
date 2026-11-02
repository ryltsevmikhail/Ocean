import type {
  ToolEffectContext,
  ToolEffectOutcome,
  ToolEffectRecord,
  ToolJournalPort,
} from '@runnets/application';

function identity(id: string, context: ToolEffectContext): string {
  return JSON.stringify([context.taskRunId, context.attemptId, id]);
}

/** Shared process-local claims preserve replay exclusion without claiming restart durability. */
export class InMemoryToolJournal implements ToolJournalPort {
  readonly #records = new Map<string, ToolEffectRecord>();

  /** Claim synchronously before resolving so concurrent callers cannot pass admission together. */
  claim(
    id: string,
    tool: string,
    context: ToolEffectContext,
    fingerprint: string,
  ): Promise<boolean> {
    if (context.taskRunId === '' || context.attemptId === '' || fingerprint === '')
      return Promise.reject(new Error('tool claim requires run, attempt and request identity'));
    const key = identity(id, context);
    if (this.#records.has(key) || [...this.#records.values()].some(unresolved))
      return Promise.resolve(false);
    this.#records.set(
      key,
      Object.freeze({
        id,
        tool,
        taskRunId: context.taskRunId,
        attemptId: context.attemptId,
        fingerprint,
        outcome: 'started',
      }),
    );
    return Promise.resolve(true);
  }

  /** Only a started claim can acquire its first confirmed or uncertain outcome. */
  settle(
    id: string,
    outcome: Exclude<ToolEffectOutcome, 'started'>,
    context?: ToolEffectContext,
  ): Promise<void> {
    if (context === undefined) return Promise.reject(new Error('tool effect context required'));
    const key = identity(id, context);
    const record = this.#records.get(key);
    if (record?.outcome !== 'started')
      return Promise.reject(new Error('tool claim is missing or already settled'));
    this.#records.set(key, Object.freeze({ ...record, outcome }));
    return Promise.resolve();
  }

  /** Return immutable unresolved snapshots across all sessions, optionally restricted to one run. */
  pending(taskRunId?: string): Promise<readonly ToolEffectRecord[]> {
    return Promise.resolve(
      [...this.#records.values()].filter(
        (record) =>
          unresolved(record) && (taskRunId === undefined || record.taskRunId === taskRunId),
      ),
    );
  }

  /** Evidence read without yielding while an acknowledgement is committed. */
  inspectPending(): readonly ToolEffectRecord[] {
    return [...this.#records.values()].filter(unresolved);
  }
  /** Recovery lowers certainty and never removes a claim or authorizes replay. */
  recover(id: string, context: ToolEffectContext): Promise<void> {
    const key = identity(id, context);
    const record = this.#records.get(key);
    if (record?.outcome === 'started')
      this.#records.set(key, Object.freeze({ ...record, outcome: 'uncertain' }));
    return Promise.resolve();
  }
}
function unresolved(record: ToolEffectRecord): boolean {
  return record.outcome === 'started' || record.outcome === 'uncertain';
}
