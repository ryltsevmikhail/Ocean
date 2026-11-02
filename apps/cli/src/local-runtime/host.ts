import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
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
import { LOCAL_RUNTIME_MAX_WAIT_MS } from '@runnets/contracts';
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
  /** Host-only composition seam, never accepted over the wire. No provider dispatch in lifecycle v1. */
  readonly provider?: ProviderPort | null;
  /** Future execution supervision must settle before database close; rejection is uncertainty. */
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
  if (existsSync(join(paths.profile, 'restore-guard.json'))) throw Error('restore_restricted');
  const runtime = openOceanProfile(paths.profile);
  let transport: Awaited<ReturnType<typeof listenLocalRuntime>> | undefined;
  let socketOwned: Stats | undefined;
  let descriptorOwned: Stats | undefined;
  try {
    // Refuse stale paths under ownership before recovery or publication; never guess a takeover.
    const recovery = await runtime.ready;
    prepareLocalRuntimePaths(paths);
    const identity: LocalRuntimeIdentity = {
      protocol: 1,
      profileId: paths.profileId,
      instanceId: randomUUID(),
      capabilities: ['status', 'stop'],
    };
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
              options.drain &&
              (await drainBeforeDeadline(options.drain, drainDeadlineMs)) !== 'settled'
            )
              throw Error('stop_incomplete');
            // Node closes/unlinks a listening Unix path. Refuse closing a replaced path.
            if (!socketOwned || !ownsLocalRuntimePath(paths.endpoint, socketOwned))
              throw Error('endpoint_changed');
            runtime.close();
            if (descriptorOwned) unlinkOwnedLocalRuntimePath(paths.descriptor, descriptorOwned);
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
      status: () => host.status(),
      stop: () => host.stop(),
    });
    socketOwned = lstatSync(paths.endpoint);
    const temporary = join(paths.directory, '.connection-' + identity.instanceId);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
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
