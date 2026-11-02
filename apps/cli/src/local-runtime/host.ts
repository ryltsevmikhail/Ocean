import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import type { ProviderPort, RuntimeRecovery } from '@runnets/application';
import { LOCAL_RUNTIME_MAX_WAIT_MS, LOCAL_ROOM_METHODS } from '@runnets/contracts';
import type {
  LocalRuntimeIdentity,
  LocalRuntimeStatus,
  LocalRuntimeStop,
} from '@runnets/contracts';
import {
  localRuntimePaths,
  prepareLocalRuntimePaths,
  ownsLocalRuntimePath,
  unlinkOwnedLocalRuntimePath,
} from '@runnets/tools-node';
import { CodingPanelQueries } from './coding-panel.js';
import { RuntimeDecisions } from './decisions.js';
import { registeredCodingTools } from '../ocean/coding-project-host.js';
import { LOCAL_DECISION_METHODS } from '@runnets/contracts';
import { RuntimeTurns } from './turns.js';
import { createProviderFromEnv } from '../engine/provider.js';
import type { RuntimeOptions } from '../runtime.js';
import { openOceanProfile } from '../ocean/profile.js';
import { listenLocalRuntime } from './server.js';
export interface LocalRuntimeHost {
  readonly identity: LocalRuntimeIdentity;
  readonly recovery: RuntimeRecovery;
  readonly closed: Promise<void>;
  status(): LocalRuntimeStatus;
  stop(): Promise<LocalRuntimeStop>;
}
export interface LocalRuntimeHostOptions {
  readonly profile: string;
  /** Host-only composition. Providers and coding authority never arrive over the wire. */
  readonly codingTools?: Pick<
    NonNullable<RuntimeOptions['codingTools']>,
    'sandbox' | 'inspectSandbox'
  >;
  readonly provider?: ProviderPort | null;
  /** Additional host supervision joins runtime-owned execution before SQLite close. */
  readonly drain?: () => Promise<'settled' | 'uncertain'>;
  readonly drainDeadlineMs?: number;
}
/** The existing runtime remains the only SQLite owner and recovery/effect journal executor. */
export async function startLocalRuntime(
  options: LocalRuntimeHostOptions,
): Promise<LocalRuntimeHost> {
  const drainDeadlineMs = options.drainDeadlineMs ?? LOCAL_RUNTIME_MAX_WAIT_MS - 1000;
  if (
    !Number.isSafeInteger(drainDeadlineMs) ||
    drainDeadlineMs < 1 ||
    drainDeadlineMs >= LOCAL_RUNTIME_MAX_WAIT_MS
  )
    throw Error('invalid_input');
  const paths = localRuntimePaths(options.profile);
  assertNotRestored(paths.profile);
  let decisions: RuntimeDecisions;
  const runtime = openOceanProfile(paths.profile, false, {
    codingTools: {
      ...(options.codingTools ?? registeredCodingTools(paths.profile)),
      owner: (turn, signal) => decisions.coding(turn, signal),
    },
  });
  let transport: Awaited<ReturnType<typeof listenLocalRuntime>> | undefined;
  let socketOwned: Stats | undefined;
  let descriptorOwned: Stats | undefined;
  try {
    // Refuse stale paths under ownership before recovery or publication; never guess a takeover.
    const recovery = await runtime.ready;
    prepareLocalRuntimePaths(paths);
    decisions = new RuntimeDecisions(runtime.ownerDecisions, runtime.reviews);
    const panels = new CodingPanelQueries(runtime);
    const identity: LocalRuntimeIdentity = {
      protocol: 1,
      profileId: paths.profileId,
      instanceId: randomUUID(),
      capabilities: [
        'status',
        'stop',
        'turns.submit',
        'receipts.get',
        'runs.get',
        ...LOCAL_ROOM_METHODS,
        ...LOCAL_DECISION_METHODS,
        'coding.panel',
      ],
    };
    if (!runtime.openRoomRuns) throw Error('durable_runtime_required');
    const turns = new RuntimeTurns(
      runtime.chat,
      options.provider === undefined ? createProviderFromEnv(process.env) : options.provider,
      runtime.openRoomRuns(),
      identity.instanceId,
    );
    let databaseClosed = false;
    const descriptor = {
      protocol: 1 as const,
      profileId: identity.profileId,
      instanceId: identity.instanceId,
      endpoint: paths.endpoint,
      capability: randomBytes(32).toString('hex'),
    };
    let state: LocalRuntimeStatus['state'] = 'ready';
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let stopping: Promise<LocalRuntimeStop> | undefined;
    const host: LocalRuntimeHost = {
      identity,
      recovery,
      closed,
      status: () => ({ ...identity, state }),
      stop() {
        if (stopping) return stopping;
        state = 'draining';
        stopping = (async (): Promise<LocalRuntimeStop> => {
          try {
            if (
              (await drainBeforeDeadline(async () => {
                const [jobs, extra] = await Promise.all([
                  turns.drain(),
                  options.drain ? options.drain() : 'settled',
                  decisions.drain(),
                  panels.drain(),
                ]);
                return jobs === 'settled' && extra === 'settled' ? 'settled' : 'uncertain';
              }, drainDeadlineMs)) !== 'settled'
            )
              throw Error('stop_incomplete');
            // Node closes/unlinks a listening Unix path. Refuse closing a replaced path.
            if (!socketOwned || !ownsLocalRuntimePath(paths.endpoint, socketOwned))
              throw Error('endpoint_changed');
            // Fallible endpoint cleanup must retain the database owner and listener on failure.
            if (descriptorOwned) unlinkOwnedLocalRuntimePath(paths.descriptor, descriptorOwned);
            turns.closeObservers();
            databaseClosed = true;
            runtime.close();
            // Stop accepting now; closed resolves once existing transports have drained.
            transport!.server.close(() => resolveClosed());
            for (const client of transport!.clients) {
              const timer = setTimeout(() => client.destroy(), 100);
              timer.unref();
            }
            return { instanceId: identity.instanceId, state: 'stopped', outcome: 'complete' };
          } catch {
            state = 'stop_incomplete';
            return {
              instanceId: identity.instanceId,
              state: 'stop_incomplete',
              outcome: 'uncertain',
            };
          }
        })();
        return stopping;
      },
    };
    transport = await listenLocalRuntime({
      descriptor,
      identity,
      dispatch: (method, params, detached) =>
        databaseClosed
          ? { error: { code: 'runtime_draining' } }
          : method === 'coding.panel'
            ? panels.dispatch(params, detached)
            : method.startsWith('decisions.') || method.startsWith('reviews.')
              ? decisions.dispatch(method, params)
              : turns.dispatch(method, params, detached),
      status: () => host.status(),
      stop: () => host.stop(),
    });
    socketOwned = lstatSync(paths.endpoint);
    const temporary = join(paths.directory, '.connection-' + identity.instanceId);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      fchmodSync(fd, 0o600);
      const pinned = fstatSync(fd);
      if (
        !pinned.isFile() ||
        pinned.nlink !== 1 ||
        pinned.uid !== process.getuid?.() ||
        (pinned.mode & 0o777) !== 0o600
      )
        throw Error('insecure_permissions');
      writeFileSync(fd, JSON.stringify(descriptor) + '\n');
      fsyncSync(fd);
      linkSync(temporary, paths.descriptor);
      descriptorOwned = fstatSync(fd);
    } finally {
      closeSync(fd);
      unlinkSync(temporary);
    }
    const directoryFd = openSync(paths.directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    return host;
  } catch (error) {
    if (socketOwned && ownsLocalRuntimePath(paths.endpoint, socketOwned)) transport?.server.close();
    if (descriptorOwned) unlinkOwnedLocalRuntimePath(paths.descriptor, descriptorOwned);
    runtime.close();
    throw error;
  }
}

async function drainBeforeDeadline(
  drain: () => Promise<'settled' | 'uncertain'>,
  deadlineMs: number,
): Promise<'settled' | 'uncertain'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      drain(),
      new Promise<'uncertain'>((resolve) => {
        timer = setTimeout(() => resolve('uncertain'), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertNotRestored(profile: string): void {
  try {
    lstatSync(join(profile, 'restore-guard.json'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw Error('restore_restricted');
}
