import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, closeSync } from 'node:fs';
import { recoverEndpoint, publishEndpoint } from './endpoint.js';
import { profileKey, type EndpointLayout } from './endpoint-files.js';
import { join } from 'node:path';
import type { ProviderPort, RuntimeRecovery } from '@runnets/application';
import { LOCAL_RUNTIME_MAX_WAIT_MS, LOCAL_ROOM_METHODS } from '@runnets/contracts';
import type {
  LocalRuntimeIdentity,
  LocalRuntimeStatus,
  LocalRuntimeStop,
} from '@runnets/contracts';
import { localRuntimePaths } from '@runnets/tools-node';
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
  const originalProfile = profileKey(paths);
  let decisions: RuntimeDecisions;
  const runtime = openOceanProfile(paths.profile, false, {
    codingTools: {
      ...(options.codingTools ?? registeredCodingTools(paths.profile)),
      owner: (turn, signal) => decisions.coding(turn, signal),
    },
  });
  let transport: Awaited<ReturnType<typeof listenLocalRuntime>> | undefined;
  let layout: EndpointLayout | undefined;
  let publication: ReturnType<typeof publishEndpoint> | undefined;
  try {
    const recovery = await runtime.ready;
    assertNotRestored(paths.profile);
    const proof = runtime.openEndpointProof?.();
    if (!proof) throw Error('durable_runtime_required');
    const endpoint = (layout = await recoverEndpoint(paths, proof, originalProfile));
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
            endpoint.check();
            if (!transport || !publication || !endpoint.matches('runtime.sock', transport.socketFd))
              throw Error('endpoint_changed');
            if (endpoint.matches('connection.json', publication.fd)) {
              if (endpoint.proof(transport.socketFd, publication.fd) !== publication.digest)
                throw Error('endpoint_changed');
              endpoint.unlink('connection.json', publication.fd);
            }
            endpoint.unlink('runtime.sock', transport.socketFd);
            endpoint.sync();
            proof.retire(publication.digest);
            turns.closeObservers();
            databaseClosed = true;
            transport.server.close(() => resolveClosed());
            runtime.close();
            closeSync(publication.fd);
            closeSync(transport.socketFd);
            endpoint.close();
            for (const client of transport.clients) {
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
    transport = await listenLocalRuntime(
      {
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
      },
      endpoint,
    );
    assertNotRestored(paths.profile);
    publication = publishEndpoint(endpoint, transport.socketFd, descriptor, proof);
    transport.activate();
    return host;
  } catch (error) {
    try {
      if (transport && layout) {
        for (const client of transport.clients) client.destroy();
        await new Promise<void>((resolve) => transport!.server.close(() => resolve()));
        try {
          if (layout.matches('runtime.sock', transport.socketFd))
            layout.unlink('runtime.sock', transport.socketFd);
        } finally {
          closeSync(transport.socketFd);
        }
      }
    } finally {
      layout?.close();
      runtime.close();
    }
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
