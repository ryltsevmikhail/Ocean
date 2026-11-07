import { failedStartupDrain } from './service-drain.js';
import { runtimeDesktopAssets } from './desktop-assets.js';
import { desktopSubmitRefusal, desktopImageResolver } from './desktop-assets.js';
import { RuntimeRestoration } from './restoration.js';
import {
  isCodingWorkspaceRead,
  LOCAL_RESTORE_METHODS,
  LOCAL_BROADCAST_METHODS,
  LOCAL_FINALIZATION_METHODS,
  LOCAL_RUNTIME_MAX_WAIT_MS,
  PROFILE_METHODS,
  type LocalRuntimeIdentity,
  type LocalRuntimeStatus,
  type LocalRuntimeStop,
} from '@runnets/contracts';
import { profileCommand } from './profile-commands.js';
import { projectsRead } from './projects-read.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { recoverEndpoint, publishEndpoint } from './endpoint.js';
import { profileKey, type EndpointLayout } from './endpoint-files.js';
import type { ImageAssetResolverPort } from '@runnets/application';
import { localRuntimePaths } from '@runnets/tools-node';
import { CodingPanelQueries } from './coding-panel.js';
import { RuntimeDecisions } from './decisions.js';
import { registeredCodingTools } from '../ocean/coding-project-host.js';
import { RuntimeTurns } from './turns.js';
import { openOceanProfile } from '../ocean/profile.js';
import { listenLocalRuntime } from './server.js';
import { assertRuntimeDrained } from './drain-supervision.js';
import { RuntimeProjectReserve } from './project-reserve.js';
import { RuntimeFinalization } from './finalization.js';
import { hostRoomTasks, wakeRoomTasksAfter } from './host-room-tasks.js';
import { runtimeCapabilities } from './capabilities.js';
import { createRestorationCheck, maintenanceRead } from './restoration-check.js';
import { settingsHosts } from './settings-hosts.js';
import { hostPluginSettings } from './host-plugin.js';
import type { LocalRuntimeHost, LocalRuntimeHostOptions } from './host-options.js';
export type { LocalRuntimeHost, LocalRuntimeHostOptions } from './host-options.js';
/** The existing runtime remains the only SQLite owner and recovery/effect journal executor. */
export async function startLocalRuntime(options: LocalRuntimeHostOptions) {
  const drainDeadlineMs = options.drainDeadlineMs ?? LOCAL_RUNTIME_MAX_WAIT_MS - 1000;
  if (
    !Number.isSafeInteger(drainDeadlineMs) ||
    drainDeadlineMs < 1 ||
    drainDeadlineMs >= LOCAL_RUNTIME_MAX_WAIT_MS
  )
    throw Error('invalid_input');
  const paths = localRuntimePaths(options.profile);
  const checkRestoration = createRestorationCheck(paths, options.restore === true);
  checkRestoration();
  const originalProfile = profileKey(paths);
  let decisions: RuntimeDecisions;
  let images: ImageAssetResolverPort | undefined;
  const plugin = await hostPluginSettings(options);
  const runtime = openOceanProfile(paths.profile, false, {
    ...(options.pluginTransport === undefined ? {} : { pluginTransport: plugin.transport }),
    serviceTransportOptions: options.serviceTransportOptions,
    serviceConfirmation: {
      confirm: (operation, signal, current) => decisions.service(operation, signal, current),
    },
    pluginEnv: plugin.env,
    pluginMutationsAllowed: options.restore !== true,
    requireUnpublished: false,
    imageResolver: (store) =>
      (images = desktopImageResolver(store, paths.profile, paths.profileId)),
    ...(!options.restore && {
      codingTools: {
        ...(options.codingTools ?? registeredCodingTools(paths.profile)),
        owner: (turn, signal) => decisions.coding(turn, signal),
      },
    }),
  });
  let transport: Awaited<ReturnType<typeof listenLocalRuntime>> | undefined;
  let layout: EndpointLayout | undefined;
  let publication: ReturnType<typeof publishEndpoint> | undefined;
  try {
    const recovery = await runtime.ready;
    if (!options.restore && !runtime.restored) await runtime.services?.start();
    checkRestoration();
    const proof = runtime.openEndpointProof?.();
    if (!proof) throw Error('durable_runtime_required');
    const endpoint = (layout = await recoverEndpoint(paths, proof, originalProfile));
    decisions = new RuntimeDecisions(runtime.ownerDecisions, runtime.reviews, options.now);
    if (!runtime.openRebindStore) throw Error('durable_runtime_required');
    const restoration = new RuntimeRestoration(
      paths.profile,
      runtime.openRebindStore(),
      decisions.owner,
      options.now,
    );
    if (!runtime.finalization || !runtime.ownerId || !runtime.openRebindStore)
      throw Error('durable_runtime_required');
    const restored = options.restore === true || runtime.restored === true;
    const settings = settingsHosts({
      profile: paths.profile,
      runtime,
      env: process.env,
      now: options.now,
      restored,
      restore: options.restore === true,
      injected: options.provider === undefined ? null : options.provider,
      disabled: options.provider === null,
      providerSecretStore: options.providerSecretStore,
      credentialDir: options.credentialDir,
      providerHttpClient: options.providerHttpClient,
    });
    const { provider, plugins, models, services } = settings;
    plugin.connections(runtime.plugins?.connections);
    const finalization = new RuntimeFinalization(
      runtime.finalization,
      decisions.owner,
      runtime.ownerId,
      runtime.openRebindStore().active()?.preview.epochId ?? null,
      restored,
      options.now,
    );
    const reads = runtime.openProfileReads?.();
    if (!reads) throw Error('durable_runtime_required');
    const panels = new CodingPanelQueries(runtime, reads);
    const reserve = new RuntimeProjectReserve(paths.profile, runtime, decisions.owner);
    if (!runtime.desktopAssets) throw Error('durable_runtime_required');
    const desktop = runtimeDesktopAssets(runtime.desktopAssets, paths.profile, paths.profileId);
    const identity: LocalRuntimeIdentity = {
      protocol: 1,
      profileId: paths.profileId,
      instanceId: randomUUID(),
      capabilities: runtimeCapabilities(options.restore === true, restored),
    };
    if (!runtime.openRoomRuns) throw Error('durable_runtime_required');
    const turns = new RuntimeTurns(
      runtime.chat,
      provider.resolver,
      runtime.openRoomRuns(),
      identity.instanceId,
    );
    const { broadcasts, roomTasks } = hostRoomTasks(
      runtime,
      provider.resolver,
      identity.instanceId,
      images,
      options.roomTaskCapacity,
      turns.observers,
    );
    turns.attachControllers(
      (runId) => broadcasts.controllerFor(runId) ?? roomTasks.controllerFor(runId),
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
            await assertRuntimeDrained(
              [
                turns,
                services,
                runtime.services,
                broadcasts,
                roomTasks,
                options.drain,
                decisions,
                panels,
                restoration,
                finalization,
                reserve,
                provider.settings,
                models,
                plugins,
              ],
              drainDeadlineMs,
            );
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
            await runtime.pluginRuntime?.shutdown();
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
        dispatch: (method, params, detached, context) => {
          if (databaseClosed) return { error: { code: 'runtime_draining' } };
          if (LOCAL_RESTORE_METHODS.some((m) => m === method))
            return restoration.dispatch(method, params);
          if (options.restore && !maintenanceRead(method))
            return { error: { code: 'restore_restricted' } };
          if (method === 'coding.tasks.prepare')
            return reserve.dispatch(params, state !== 'ready', 'prepare');
          if (method === 'coding.tasks.reserve') return reserve.dispatch(params, state !== 'ready');
          if (isCodingWorkspaceRead(method))
            return projectsRead(paths.profile, reads, method, params, state !== 'ready');
          if (LOCAL_FINALIZATION_METHODS.some((m) => m === method))
            return finalization.dispatch(method, params);
          const configured = settings.dispatch(method, params, detached);
          if (configured) return wakeRoomTasksAfter(configured, method, roomTasks);
          if (method === 'turns.submit' || method === 'broadcasts.submit') {
            const code = desktopSubmitRefusal(
              runtime.desktopAssets!,
              params,
              method === 'broadcasts.submit',
            );
            if (code) return { error: { code } };
          }
          if (LOCAL_BROADCAST_METHODS.some((m) => m === method))
            return broadcasts.dispatch(method, params, detached);
          if (method === 'desktop.assets') return desktop(params, state !== 'ready');
          if (
            method === 'coding.panel' ||
            method === 'coding.diff' ||
            method === 'coding.show' ||
            method === 'coding.inspect-apply'
          )
            return panels.dispatch(method, params, detached);
          if (PROFILE_METHODS.some((m) => m === method))
            return profileCommand(runtime.conversations, reads, method, params, state !== 'ready');
          if (method.startsWith('roomTasks.'))
            return roomTasks.dispatch(method, params, detached, context);
          if (method.startsWith('decisions.') || method.startsWith('reviews.'))
            return decisions.dispatch(method, params, context);
          return turns.dispatch(method, params, detached, context);
        },
        status: () => host.status(),
        stop: () => host.stop(),
      },
      endpoint,
    );
    checkRestoration();
    publication = publishEndpoint(endpoint, transport.socketFd, descriptor, proof);
    transport.activate();
    if (!restored) roomTasks.start();
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
      await failedStartupDrain(runtime, drainDeadlineMs);
    }
    throw error;
  }
}
