/**
 * Plugin call admission: one SQLite transaction immediately before the transport.
 *
 * Everything authority-bearing is rechecked in that transaction: current room
 * membership, grant existence and revocation, exact connection generation,
 * published schema digest, enabled/verified plugin version, adapter build and
 * the repository resource constraint. The durable journal claim is written in
 * the same transaction; only after commit does exactly one transport
 * invocation happen. Any refusal before the claim produces zero business
 * requests, and an uncertain outcome is never retried.
 */

import {
  canonicalJson,
  compatiblePluginAdapter,
  pluginToolRepository,
  validPluginSchemaDigest,
  type PluginAdapterIdentity,
} from '@runnets/domain';
import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  SERVICE_PLUGIN_MAX_REQUEST_BYTES,
  type ServicePluginInvokeOutcome,
  type ServicePluginJson,
  type ServicePluginTarget,
  type ServicePluginTransportPort,
} from './service-plugin-transport.js';
import {
  pluginAdapterVersion,
  type PluginAdmissionStorePort,
  type PluginConnectionRecord,
  type PluginCredentialReferencePort,
  type PluginInstalledVersion,
} from './plugin-ports.js';
import type { PluginGrantRecord } from '@runnets/domain';
import { pluginJsonBytes, validServicePluginJson } from './plugin-json.js';

export interface PluginCallClaim {
  readonly invocationId: string;
  readonly taskRunId: string;
  readonly attemptId: string;
}

export interface PluginCallRequest {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly grantId: string;
  readonly tool: string;
  readonly arguments: ServicePluginJson;
  readonly claim: PluginCallClaim;
}

export interface PluginCallResult {
  readonly admitted: boolean;
  /** `admitted` or one stable lowercase denial code. */
  readonly code: string;
  readonly invocationId: string;
  readonly grantId: string | null;
  readonly connectionGeneration: number | null;
  readonly schemaDigest: string | null;
  readonly outcome: ServicePluginInvokeOutcome | null;
  readonly settled: boolean;
}

export interface PluginCallAdmissionOptions {
  readonly store: PluginAdmissionStorePort;
  readonly transport: ServicePluginTransportPort;
  readonly credentials: PluginCredentialReferencePort;
  readonly adapter: PluginAdapterIdentity;
  readonly deadlineMs?: number;
  readonly maxRequestBytes?: number;
}

type Admitted = {
  readonly admitted: true;
  readonly connection: PluginConnectionRecord;
  readonly grant: PluginGrantRecord;
  readonly version: PluginInstalledVersion;
  readonly repository: string;
  readonly fingerprint: string;
};
type Denied = { readonly admitted: false; readonly code: string };
type Decision = Admitted | Denied;

export class PluginCallAdmissionService {
  readonly #store: PluginAdmissionStorePort;
  readonly #transport: ServicePluginTransportPort;
  readonly #credentials: PluginCredentialReferencePort;
  readonly #adapter: PluginAdapterIdentity;
  readonly #deadlineMs: number;
  readonly #maxRequestBytes: number;

  constructor(options: PluginCallAdmissionOptions) {
    this.#store = options.store;
    this.#transport = options.transport;
    this.#credentials = options.credentials;
    this.#adapter = options.adapter;
    this.#deadlineMs = options.deadlineMs ?? SERVICE_PLUGIN_CALL_DEADLINE_MS;
    this.#maxRequestBytes = options.maxRequestBytes ?? SERVICE_PLUGIN_MAX_REQUEST_BYTES;
  }

  /** Recheck + durable claim, then at most one dispatch; denials never dispatch. */
  async call(request: PluginCallRequest): Promise<PluginCallResult> {
    const identity = {
      invocationId: request.claim.invocationId,
      grantId: null as string | null,
      connectionGeneration: null as number | null,
      schemaDigest: null as string | null,
    };
    if (
      request.claim.invocationId.length === 0 ||
      request.claim.taskRunId.length === 0 ||
      request.claim.attemptId.length === 0 ||
      request.tool.length === 0 ||
      request.workspaceId.length === 0 ||
      request.roomId.length === 0 ||
      request.botId.length === 0
    )
      return denied('invalid_arguments', identity);
    if (!validServicePluginJson(request.arguments)) return denied('invalid_arguments', identity);
    let payloadBytes: number;
    try {
      payloadBytes = pluginJsonBytes(request.arguments, canonicalJson);
    } catch {
      return denied('invalid_arguments', identity);
    }
    if (payloadBytes > this.#maxRequestBytes) return denied('arguments_too_large', identity);
    const repository = pluginToolRepository(request.tool, request.arguments);
    if (repository === null) return denied('invalid_arguments', identity);
    const decision = this.#store.atomic((tx): Decision => {
      if (!tx.member(request.workspaceId, request.roomId, request.botId))
        return { admitted: false, code: 'member_required' };
      const connection = tx.connection(request.connectionId);
      if (connection === null) return { admitted: false, code: 'connection_unknown' };
      if (connection.pluginId !== request.pluginId)
        return { admitted: false, code: 'connection_mismatch' };
      if (connection.state !== 'active') return { admitted: false, code: 'connection_inactive' };
      const version = tx.enabledVersion(request.pluginId);
      if (version === null) return { admitted: false, code: 'plugin_not_enabled' };
      if (version.state !== 'installed' || version.verifiedAt === null)
        return { admitted: false, code: 'plugin_not_verified' };
      if (connection.adapterVersion !== pluginAdapterVersion(this.#adapter))
        return { admitted: false, code: 'adapter_changed' };
      if (!compatiblePluginAdapter(version.adapter, this.#adapter))
        return { admitted: false, code: 'adapter_incompatible' };
      if (connection.pluginVersion !== version.version)
        return { admitted: false, code: 'plugin_version_changed' };
      const grant = tx.grant(request.grantId);
      if (grant === null) return { admitted: false, code: 'grant_unknown' };
      if (grant.state !== 'active') return { admitted: false, code: 'grant_revoked' };
      if (connection.schemaDigest === null || !validPluginSchemaDigest(connection.schemaDigest))
        return { admitted: false, code: 'schema_unavailable' };
      if (
        grant.workspaceId !== request.workspaceId ||
        grant.roomId !== request.roomId ||
        grant.botId !== request.botId ||
        grant.pluginId !== request.pluginId ||
        grant.connectionId !== request.connectionId ||
        grant.connectionGeneration !== connection.generation ||
        grant.schemaDigest !== connection.schemaDigest ||
        grant.repository !== repository ||
        !grant.tools.includes(request.tool)
      )
        return { admitted: false, code: 'grant_mismatch' };
      const declared = version.manifest.operations.some(
        (operation) => operation.tool === request.tool,
      );
      if (!declared) return { admitted: false, code: 'tool_not_declared' };
      if (!this.#credentials.available(connection.credentialReference))
        return { admitted: false, code: 'credential_unavailable' };
      const fingerprint = JSON.stringify([
        request.tool,
        repository,
        request.arguments,
        connection.id,
        connection.generation,
        connection.schemaDigest,
        grant.policyVersion,
        request.claim.taskRunId,
        request.claim.attemptId,
      ]);
      if (
        !tx.claim(
          request.claim.invocationId,
          request.tool,
          { taskRunId: request.claim.taskRunId, attemptId: request.claim.attemptId },
          fingerprint,
        )
      )
        return { admitted: false, code: 'journal_refused' };
      return { admitted: true, connection, grant, version, repository, fingerprint };
    });
    if (!decision.admitted) return denied(decision.code, identity);
    identity.grantId = decision.grant.id;
    identity.connectionGeneration = decision.connection.generation;
    identity.schemaDigest = decision.connection.schemaDigest;
    const outcome = await this.#invoke(request, decision);
    const settled = this.#settle(request, outcome);
    return {
      admitted: true,
      code: 'admitted',
      invocationId: request.claim.invocationId,
      grantId: identity.grantId,
      connectionGeneration: identity.connectionGeneration,
      schemaDigest: identity.schemaDigest,
      outcome,
      settled,
    };
  }

  async #invoke(
    request: PluginCallRequest,
    decision: Admitted,
  ): Promise<ServicePluginInvokeOutcome> {
    const target: ServicePluginTarget = {
      integrationId: decision.version.pluginId,
      connectionId: decision.connection.id,
      owner: 'user',
    };
    try {
      return await this.#transport.invoke(
        target,
        {
          invocationId: request.claim.invocationId,
          tool: request.tool,
          arguments: request.arguments,
        },
        { deadlineMs: this.#deadlineMs },
      );
    } catch {
      // A throwing adapter is an unknown effect, never a reason to retry.
      return {
        kind: 'uncertain',
        invocationId: request.claim.invocationId,
        code: 'internal_failure',
        detail: 'transport threw after the durable claim',
      };
    }
  }

  #settle(request: PluginCallRequest, outcome: ServicePluginInvokeOutcome): boolean {
    const outcomeCode =
      outcome.kind === 'observed'
        ? 'completed'
        : outcome.kind === 'uncertain'
          ? 'uncertain'
          : 'not_started';
    try {
      this.#store.settle(request.claim.invocationId, outcomeCode, {
        taskRunId: request.claim.taskRunId,
        attemptId: request.claim.attemptId,
      });
      return true;
    } catch {
      return false;
    }
  }
}

function denied(
  code: string,
  identity: {
    invocationId: string;
    grantId: string | null;
    connectionGeneration: number | null;
    schemaDigest: string | null;
  },
): PluginCallResult {
  return {
    admitted: false,
    code,
    invocationId: identity.invocationId,
    grantId: identity.grantId,
    connectionGeneration: identity.connectionGeneration,
    schemaDigest: identity.schemaDigest,
    outcome: null,
    settled: false,
  };
}

/** Expose the tool-repository rule for tests and Task 6 wiring. */
export { pluginToolRepository };
