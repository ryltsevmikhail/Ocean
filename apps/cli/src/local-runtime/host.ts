import {
  runtimeDesktopAssets,
  desktopSubmitRefusal,
  desktopImageResolver,
} from './desktop-assets.js';
import { RuntimeRestoration } from './restoration.js';
import { LOCAL_RESTORE_METHODS } from '@runnets/contracts';
import { profileCommand } from './profile-commands.js';
import { PROFILE_METHODS } from '@runnets/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { recoverEndpoint, publishEndpoint } from './endpoint.js';
import { profileKey, type EndpointLayout } from './endpoint-files.js';
import type { ImageAssetResolverPort } from '@runnets/application';
import { LOCAL_RUNTIME_MAX_WAIT_MS } from '@runnets/contracts';
import type {
  LocalRuntimeIdentity,
  LocalRuntimeStatus,
  LocalRuntimeStop,
} from '@runnets/contracts';
import { localRuntimePaths } from '@runnets/tools-node';
import { CodingPanelQueries } from './coding-panel.js';
import { RuntimeDecisions } from './decisions.js';
import { registeredCodingTools } from '../ocean/coding-project-host.js';
import { RuntimeTurns } from './turns.js';
import { openOceanProfile } from '../ocean/profile.js';
import { listenLocalRuntime } from './server.js';
import { assertRuntimeDrained } from './drain-supervision.js';
import { RuntimeFinalization } from './finalization.js';
import { LOCAL_FINALIZATION_METHODS } from '@runnets/contracts';
import { LOCAL_PROVIDER_METHODS } from '@runnets/contracts';
import { LOCAL_BROADCAST_METHODS } from '@runnets/contracts';
import { systemClock } from '@runnets/store';
import { RuntimeBroadcasts } from './broadcast.js';
import { runtimeCapabilities } from './capabilities.js';
import { createRestorationCheck, maintenanceRead } from './restoration-check.js';
import { settingsHosts } from './settings-hosts.js';
import { hostPluginTransport } from '../plugin-transport.js';
import type { PluginConnectionStorePort, ServicePluginTransportPort } from '@runnets/application';
import type { LocalRuntimeHost, LocalRuntimeHostOptions } from './host-options.js';
export type { LocalRuntimeHost, LocalRuntimeHostOptions } from './host-options.js';

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
  const checkRestoration = createRestorationCheck(paths, options.restore === true);
  checkRestoration();
  const originalProfile = profileKey(paths);
  let decisions: RuntimeDecisions;
  let images: ImageAssetResolverPort | undefined;
  let pluginConnections: PluginConnectionStorePort | undefined;
  const pluginEnv = options.pluginEnv ?? process.env;
  const pluginTransport: ServicePluginTransportPort = await hostPluginTransport({
    transport: options.pluginTransport,
    env: pluginEnv,
    connections: () => pluginConnections,
    ...(options.pluginEndpointOverride === undefined
      ? {}
      : { endpointOverride: options.pluginEndpointOverride }),
  });
  const runtime = openOceanProfile(paths.profile, false, {
    pluginTransport,
    pluginEnv,
    pluginMutationsAllowed: options.restore !== true,
    // This host alone validates and retires a surviving publication before serving.
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
    // Saved/environment credentials and plugin state are resolved by the runtime, never by a client.
    const { provider, plugins } = settingsHosts({
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
      providerBaseUrl: options.providerBaseUrl,
    });
    pluginConnections = runtime.plugins?.connections;
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
    if (!runtime.desktopAssets) throw Error('durable_runtime_required');
    const desktop = runtimeDesktopAssets(runtime.desktopAssets, paths.profile, paths.profileId);
    const identity: LocalRuntimeIdentity = {
      protocol: 1,
      profileId: paths.profileId,
      instanceId: randomUUID(),
      capabilities: runtimeCapabilities(options.restore === true),
    };
    if (!runtime.openRoomRuns) throw Error('durable_runtime_required');
    const turns = new RuntimeTurns(
      runtime.chat,
      provider.activation,
      runtime.openRoomRuns(),
      identity.instanceId,
    );
    if (!runtime.broadcasts || !runtime.conversationStore) throw Error('durable_runtime_required');
    const broadcasts = new RuntimeBroadcasts({
      service: runtime.broadcasts,
      execution: {
        tasks: runtime.service,
        store: runtime.conversationStore,
        clock: systemClock,
        ...(runtime.pluginRuntime?.tools === null || runtime.pluginRuntime?.tools === undefined
          ? {}
          : { grantedTools: runtime.pluginRuntime.tools }),
      },
      clock: systemClock,
      provider: provider.activation,
      ...(images === undefined ? {} : { images }),
    });
    turns.attachControllers((runId) => broadcasts.controllerFor(runId));
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
                broadcasts,
                options.drain,
                decisions,
                panels,
                restoration,
                finalization,
                provider.settings,
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
        dispatch: (method, params, detached) => {
          if (databaseClosed) return { error: { code: 'runtime_draining' } };
          if (LOCAL_RESTORE_METHODS.some((m) => m === method))
            return restoration.dispatch(method, params);
          if (options.restore && !maintenanceRead(method))
            return { error: { code: 'restore_restricted' } };
          if (LOCAL_FINALIZATION_METHODS.some((m) => m === method))
            return finalization.dispatch(method, params);
          if (LOCAL_PROVIDER_METHODS.some((m) => m === method))
            return provider.settings.dispatch(method, params, detached);
          if (method.startsWith('plugin.')) return plugins.dispatch(method, params);
          // Prepared-attachment admission runs before any submit dispatch, including
          // the broadcast runner: a mismatched marker must never commit a message.
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
          if (method.startsWith('decisions.') || method.startsWith('reviews.'))
            return decisions.dispatch(method, params);
          return turns.dispatch(method, params, detached);
        },
        status: () => host.status(),
        stop: () => host.stop(),
      },
      endpoint,
    );
    checkRestoration();
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
