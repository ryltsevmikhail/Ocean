/**
 * Plugin call admission: one SQLite transaction immediately before the transport.
 *
 * Everything authority-bearing is rechecked in that transaction: current room
 * membership, grant existence and revocation, exact connection generation,
 * published schema digest, enabled/verified plugin version, adapter build and
 * the repository resource constraint. The durable journal claim and the durable
 * operation row are written in the same transaction; only after commit does
 * exactly one transport invocation happen. Any refusal before the claim
 * produces zero business requests, and an uncertain outcome is never retried.
 */

import {
  boundPluginArguments,
  canonicalJson,
  compatiblePluginAdapter,
  pluginToolRepository,
  validPluginSchemaDigest,
  type PluginAdapterIdentity,
  type PluginOperationRecord,
} from '@runnets/domain';
import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  SERVICE_PLUGIN_MAX_REQUEST_BYTES,
  type ServicePluginInvokeOutcome,
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
import type { PluginCallRequest, PluginCallResult } from './plugin-admission-types.js';
export type {
  PluginCallAdmissionOptions,
  PluginCallClaim,
  PluginCallRequest,
  PluginCallResult,
} from './plugin-admission-types.js';
import type { PluginCallAdmissionOptions } from './plugin-admission-types.js';
import type { ToolEffectContext } from './tools.js';
import type { PluginGrantRecord } from '@runnets/domain';
import { pluginJsonBytes, validServicePluginJson } from './plugin-json.js';
import { settlePluginInvocation } from './plugin-admission-settlement.js';

type Admitted = {
  readonly admitted: true;
  readonly connection: PluginConnectionRecord;
  readonly grant: PluginGrantRecord;
  readonly version: PluginInstalledVersion;
  readonly repository: string;
};
type Denied = { readonly admitted: false; readonly code: string };
type Decision = Admitted | Denied;

export class PluginCallAdmissionService {
  readonly #store: PluginAdmissionStorePort;
  readonly #transport: ServicePluginTransportPort;
  readonly #credentials: PluginCredentialReferencePort;
  readonly #adapter: PluginAdapterIdentity;
  readonly #now: () => string;
  readonly #sha256: (text: string) => string;
  readonly #deadlineMs: number;
  readonly #maxRequestBytes: number;

  constructor(options: PluginCallAdmissionOptions) {
    this.#store = options.store;
    this.#transport = options.transport;
    this.#credentials = options.credentials;
    this.#adapter = options.adapter;
    this.#now = options.now;
    this.#sha256 = options.sha256;
    this.#deadlineMs = options.deadlineMs ?? SERVICE_PLUGIN_CALL_DEADLINE_MS;
    this.#maxRequestBytes = options.maxRequestBytes ?? SERVICE_PLUGIN_MAX_REQUEST_BYTES;
  }

  /** Recheck + durable claim + operation row, then at most one dispatch. */
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
    let canonicalArguments: string;
    try {
      payloadBytes = pluginJsonBytes(request.arguments, canonicalJson);
      canonicalArguments = canonicalJson(request.arguments);
    } catch {
      return denied('invalid_arguments', identity);
    }
    if (payloadBytes > this.#maxRequestBytes) return denied('arguments_too_large', identity);
    const repository = pluginToolRepository(request.tool, request.arguments);
    if (repository === null) return denied('invalid_arguments', identity);
    const argumentsDigest = this.#sha256(canonicalArguments);
    const context: ToolEffectContext = {
      taskRunId: request.claim.taskRunId,
      attemptId: request.claim.attemptId,
    };
    const createdAt = this.#now();
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
      if (!tx.claim(request.claim.invocationId, request.tool, context, fingerprint))
        return { admitted: false, code: 'journal_refused' };
      // The durable operation row shares the immediate transaction with the claim.
      const operation: PluginOperationRecord = {
        id: request.claim.invocationId,
        taskRunId: context.taskRunId,
        attemptId: context.attemptId,
        workspaceId: request.workspaceId,
        roomId: request.roomId,
        botId: request.botId,
        pluginId: request.pluginId,
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        endpoint: connection.endpoint,
        tool: request.tool,
        repository,
        schemaDigest: connection.schemaDigest,
        argumentsDigest,
        arguments: boundPluginArguments(canonicalArguments),
        state: 'started',
        outcomeCode: null,
        detail: null,
        resultSummary: null,
        resultBytes: null,
        truncated: false,
        revision: 1,
        createdAt,
        settledAt: null,
        acknowledgedAt: null,
        acknowledgedReason: null,
      };
      tx.beginOperation(operation);
      return { admitted: true, connection, grant, version, repository };
    });
    if (!decision.admitted) return denied(decision.code, identity);
    identity.grantId = decision.grant.id;
    identity.connectionGeneration = decision.connection.generation;
    identity.schemaDigest = decision.connection.schemaDigest;
    const outcome = await this.#invoke(request, decision);
    const settlement = this.#settle(request, outcome, context);
    return {
      admitted: true,
      code: 'admitted',
      invocationId: request.claim.invocationId,
      grantId: identity.grantId,
      connectionGeneration: identity.connectionGeneration,
      schemaDigest: identity.schemaDigest,
      outcome: settlement.outcome,
      settled: settlement.settled,
      summary: settlement.summary,
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

  #settle(
    request: PluginCallRequest,
    outcome: ServicePluginInvokeOutcome,
    context: ToolEffectContext,
  ): {
    readonly outcome: ServicePluginInvokeOutcome;
    readonly settled: boolean;
    readonly summary: string | null;
  } {
    return settlePluginInvocation(
      this.#store,
      this.#now,
      request.claim.invocationId,
      outcome,
      context,
    );
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
    summary: null,
  };
}

/** Expose the tool-repository rule for tests and host wiring. */
export { pluginToolRepository };
