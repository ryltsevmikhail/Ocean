/** Host composition: ephemeral state or a single-owner durable runtime with reconciliation. */
import { randomUUID } from 'node:crypto';
import {
  TaskRunService,
  reconcileInterrupted,
  type Clock,
  type CommandDedupPort,
  type EventLogPort,
  type RuntimeRecovery,
  type ToolJournalPort,
} from '@runnets/application';
import { openSqliteStore, ownSqliteRuntime } from '@runnets/store-sqlite';
import {
  InMemoryCommandDedup,
  InMemoryToolJournal,
  InMemoryEventLog,
  SequentialIdGenerator,
  systemClock,
} from '@runnets/store';

export const RUNTIME_ENV_KEY = 'RUNNE_DB';
export interface Runtime {
  readonly service: TaskRunService;
  readonly durable: boolean;
  readonly toolJournal?: ToolJournalPort;
  /** All entry points await recovery before accepting work. */
  readonly ready: Promise<RuntimeRecovery>;
  close(): void;
}
export interface RuntimeOptions {
  readonly clock?: Clock;
  readonly dbPath?: string | undefined;
  readonly mode?: 'ephemeral' | 'durable' | undefined;
}
function serviceOver(
  log: EventLogPort,
  dedup: CommandDedupPort,
  durable: boolean,
  clock: Clock = systemClock,
): TaskRunService {
  return new TaskRunService({
    log,
    dedup,
    clock,
    ids: durable
      ? {
          eventId: () => `ev_${randomUUID().replaceAll('-', '')}`,
          commandId: () => `cm_${randomUUID().replaceAll('-', '')}`,
        }
      : new SequentialIdGenerator(),
  });
}

/** Durable means a persistent database, durable tool claims, and exclusive recovery ownership. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const dbPath = options.dbPath?.trim() ?? '';
  const persistent = dbPath !== '' && dbPath !== ':memory:';
  const mode = options.mode ?? (persistent ? 'durable' : 'ephemeral');
  if (mode === 'durable' && !persistent)
    throw new Error('Durable mode requires a persistent RUNNE_DB file');
  if (mode === 'ephemeral' && persistent)
    throw new Error('Ephemeral mode cannot use a persistent RUNNE_DB file');
  if (mode === 'ephemeral')
    return {
      service: serviceOver(
        new InMemoryEventLog(),
        new InMemoryCommandDedup(),
        false,
        options.clock,
      ),
      durable: false,
      toolJournal: new InMemoryToolJournal(),
      ready: Promise.resolve({ tasks: [], effects: [] }),
      close: () => {},
    };
  const release = ownSqliteRuntime(dbPath);
  try {
    const store = openSqliteStore({ path: dbPath });
    const service = serviceOver(store.log, store.dedup, true, options.clock);
    const ready = reconcileInterrupted(service, store.tools);
    return {
      service,
      durable: true,
      toolJournal: store.tools,
      ready,
      close(): void {
        try {
          store.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Reject invalid storage selections instead of silently reducing recovery guarantees. */
export function createRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Runtime {
  const mode = env['RUNNE_MODE'];
  if (mode !== undefined && mode !== 'ephemeral' && mode !== 'durable')
    throw new Error('RUNNE_MODE must be ephemeral or durable');
  return createRuntime({ dbPath: env[RUNTIME_ENV_KEY], mode });
}
