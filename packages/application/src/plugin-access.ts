/**
 * Owner-facing exact plugin access grants.
 *
 * There is no model-facing grant, widen or refresh path: only this owner-facing
 * service composes a scope, and only from one enabled version, one complete
 * discovered schema, one active connection generation and one repository.
 * A grant requires current room membership; for a group room the owner must
 * acknowledge the visibility explanation before confirmation.
 */

import {
  PLUGIN_POLICY_VERSION,
  validPluginGrantScope,
  validPluginRepository,
  type PluginGrantRecord,
  type PluginGrantScope,
} from '@runnets/domain';
import { pluginGrantExplanation } from './plugin-visibility.js';
import {
  PluginRefusedError,
  type PluginAccessStorePort,
  type PluginAccessTransaction,
  type PluginServiceContext,
} from './plugin-ports.js';

export interface PluginAccessServiceOptions extends PluginServiceContext {
  readonly store: PluginAccessStorePort;
}

export interface PluginGrantRequest {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly tools: readonly string[];
  readonly repository: string;
  /** Explicit owner acknowledgement of who will see the group answer. */
  readonly acknowledgeGroupVisibility: boolean;
}

export interface PluginGrantPreview {
  readonly allowed: boolean;
  readonly refusal: string | null;
  /** Owner-visible explanation of exactly who can see the bot's answer. */
  readonly explanation: string;
  readonly groupVisibility: boolean;
  readonly participants: number;
  readonly scope: PluginGrantScope | null;
}

export interface PluginGrantView {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly tools: readonly string[];
  readonly repository: string;
  readonly schemaDigest: string;
  readonly policyVersion: number;
  readonly visibility: string;
  readonly state: 'active' | 'revoked';
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export class PluginAccessService {
  readonly #store: PluginAccessStorePort;
  readonly #context: PluginServiceContext;

  constructor(options: PluginAccessServiceOptions) {
    this.#store = options.store;
    this.#context = {
      clock: options.clock,
      nextId: options.nextId,
      sha256: options.sha256,
      ...(options.mutationsAllowed === undefined
        ? {}
        : { mutationsAllowed: options.mutationsAllowed }),
      ...(options.restored === undefined ? {} : { restored: options.restored }),
    };
  }

  list(
    filter: {
      readonly workspaceId?: string;
      readonly roomId?: string;
      readonly botId?: string;
      readonly pluginId?: string;
    } = {},
  ): readonly PluginGrantView[] {
    return this.#store.grants(filter).map(grantView);
  }

  /** Read-only owner preview: exact scope, refusal reason and group visibility. */
  preview(input: PluginGrantRequest): PluginGrantPreview {
    return this.#store.atomic((tx) => {
      const resolved = this.#resolve(tx, input);
      if (!resolved.allowed)
        return {
          allowed: false,
          refusal: resolved.code,
          explanation: resolved.explanation,
          groupVisibility: resolved.groupVisibility,
          participants: resolved.participants,
          scope: null,
        };
      return {
        allowed: true,
        refusal: null,
        explanation: resolved.explanation,
        groupVisibility: resolved.groupVisibility,
        participants: resolved.participants,
        scope: resolved.scope,
      };
    });
  }

  grant(input: PluginGrantRequest): PluginGrantView {
    this.#mutate();
    return this.#store.atomic((tx) => {
      const resolved = this.#resolve(tx, input);
      if (!resolved.allowed) throw refuse(resolved.code);
      if (resolved.groupVisibility && input.acknowledgeGroupVisibility !== true)
        throw refuse('group_visibility_unacknowledged');
      const record: PluginGrantRecord = {
        id: this.#context.nextId(),
        ...resolved.scope,
        visibility: resolved.explanation,
        state: 'active',
        createdAt: this.#now(),
        revokedAt: null,
      };
      // One checked primitive: revoke the previous active grants for this
      // bot/room/plugin and insert the new exact grant atomically. A separate
      // insert-then-revoke loop cannot express the table CHECK constraint.
      tx.putGrantAndRevokePrevious(record, record.createdAt);
      return grantView(record);
    });
  }

  /** Immediate durable revoke; repeated revoke is idempotent and never re-grants. */
  revoke(grantId: string): PluginGrantView {
    this.#mutate();
    const existing = this.#store.grants().find((grant) => grant.id === grantId);
    if (existing === undefined) throw refuse('grant_unknown');
    this.#store.revoke(grantId, this.#now());
    const current = this.#store.grants().find((grant) => grant.id === grantId)!;
    return grantView(current);
  }

  #resolve(
    tx: PluginAccessTransaction,
    input: PluginGrantRequest,
  ):
    | {
        allowed: false;
        code: string;
        explanation: string;
        groupVisibility: boolean;
        participants: number;
      }
    | {
        allowed: true;
        code: string;
        explanation: string;
        groupVisibility: boolean;
        participants: number;
        scope: PluginGrantScope;
      } {
    const room = tx.room(input.roomId);
    const member = tx.member(input.workspaceId, input.roomId, input.botId);
    const connection = tx.connection(input.connectionId);
    const enabled = tx.enabledVersion(input.pluginId);
    const requested: unknown = input.tools;
    if (
      !Array.isArray(requested) ||
      requested.length === 0 ||
      requested.length > 16 ||
      new Set(requested as unknown[]).size !== requested.length
    )
      return {
        allowed: false,
        code: 'invalid_tools',
        explanation: 'tools are invalid',
        groupVisibility: room?.kind === 'group',
        participants: room?.participantCount ?? 0,
      };
    const tools = requested as readonly string[];
    const baseExplanation = pluginGrantExplanation({
      roomKind: room?.kind ?? 'direct',
      roomTitle: room?.title ?? null,
      participantCount: room?.participantCount ?? 0,
      botId: input.botId,
      connectionName: connection?.name ?? 'unknown',
      accountLabel: connection?.accountLabel ?? null,
      identityLabel: connection?.identityVerified === true ? 'verified' : 'unverified',
      repository: input.repository,
      tools: [...tools],
    });
    const groupVisibility = room?.kind === 'group';
    const participants = room?.participantCount ?? 0;
    const deny = (code: string) => ({
      allowed: false as const,
      code,
      explanation: baseExplanation,
      groupVisibility,
      participants,
    });
    if (!member) return deny('member_required');
    if (room === null) return deny('room_unknown');
    if (connection === null) return deny('connection_unknown');
    if (connection.pluginId !== input.pluginId) return deny('connection_mismatch');
    if (connection.state !== 'active') return deny('connection_inactive');
    if (enabled === null) return deny('plugin_not_enabled');
    if (connection.pluginVersion !== enabled.version) return deny('plugin_version_changed');
    if (connection.schemaDigest === null || connection.tools === null)
      return deny('schema_unavailable');
    if (!validPluginRepository(input.repository)) return deny('invalid_repository');
    const declared = new Set(enabled.manifest.operations.map((operation) => operation.tool));
    const discovered = new Set(connection.tools.map((tool): string => tool.name));
    if (tools.some((tool) => !declared.has(tool) || !discovered.has(tool)))
      return deny('unknown_tool');
    const scope: PluginGrantScope = {
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      botId: input.botId,
      pluginId: input.pluginId,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      tools: [...tools],
      repository: input.repository,
      schemaDigest: connection.schemaDigest,
      policyVersion: PLUGIN_POLICY_VERSION,
    };
    if (!validPluginGrantScope(scope)) return deny('invalid_scope');
    return {
      allowed: true,
      code: 'allowed',
      explanation: baseExplanation,
      groupVisibility,
      participants,
      scope,
    };
  }

  #mutate(): void {
    if (this.#context.mutationsAllowed === false) throw refuse('restore_restricted');
  }

  #now(): string {
    return this.#context.clock.now().toISOString();
  }
}

function grantView(grant: PluginGrantRecord): PluginGrantView {
  return {
    id: grant.id,
    workspaceId: grant.workspaceId,
    roomId: grant.roomId,
    botId: grant.botId,
    pluginId: grant.pluginId,
    connectionId: grant.connectionId,
    connectionGeneration: grant.connectionGeneration,
    tools: [...grant.tools],
    repository: grant.repository,
    schemaDigest: grant.schemaDigest,
    policyVersion: grant.policyVersion,
    visibility: grant.visibility,
    state: grant.state,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
  };
}

function refuse(code: string): PluginRefusedError {
  return new PluginRefusedError(code, 'plugin access refused: ' + code);
}
