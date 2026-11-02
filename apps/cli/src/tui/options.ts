import type { RunBookPort } from './runs.js';
import type { TaskRunId } from '@runnets/domain';
import type { Readable, Writable } from 'node:stream';
import type { ToolExecutorPort, ToolJournalPort, TaskRunService } from '@runnets/application';
import type { ProviderPort } from '@runnets/provider-core';
import type { Size } from './types.js';

export interface TuiAppOptions {
  readonly book?: RunBookPort;
  readonly recovered?: readonly TaskRunId[] | undefined;
  readonly workspace?: string | undefined;
  readonly executor?: ToolExecutorPort | undefined;
  readonly journal?: ToolJournalPort | undefined;
  readonly input: Readable;
  readonly output: Writable;
  readonly service: TaskRunService;
  /** Resolved provider, or null for deterministic turns without credentials. */
  readonly provider: ProviderPort | null;
  /** Size to use when the output stream does not report dimensions. */
  readonly size?: Size | undefined;
}
