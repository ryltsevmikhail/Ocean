import type { ChatTurnExecutionDeps } from '@runnets/application';
import type { RuntimeServices } from './runtime-services.js';
import type { McpServiceTransportOptions } from '@runnets/integrations-mcp';
import type { GrantedToolSource } from '@runnets/application';
/**
 * Public runtime contracts.
 *
 * Split from `runtime.ts` so the composition module stays inside the 300-line
 * source bound; hosts import these types from the entry point unchanged.
 */

import type {
  ServiceCallConfirmationPort,
  ConversationStore,
  DesktopAssetStore,
  ImageAssetResolverPort,
  PluginAccessStorePort,
  PluginAdmissionStorePort,
  PluginCatalogStorePort,
  PluginConnectionStorePort,
  PluginOperationStorePort,
  ProfileRebindStore,
  ProviderConnectionStorePort,
  RoomRuntimeRuns,
  ServicePluginTransportPort,
  TaskRunService,
} from '@runnets/application';
import type {
  Clock,
  CodingTestEvidenceStore,
  CodingFinalizationStore,
  OwnerDecisionStore,
  ToolJournalPort,
  RuntimeRecovery,
} from '@runnets/application';
import type { ProfileReads } from '@runnets/store-sqlite';
import type { EndpointProof } from '@runnets/store-sqlite';
import type { CodingTurnFactoryDeps } from './coding-turn-factory.js';
import type { PluginRuntime } from './plugin-runtime.js';
import type {
  CodingTaskService,
  CodingReviewService,
  CodingApplyService,
  CodingApplyInspectionService,
  CodingApplyResolutionService,
  CodingApprovalService,
  CodingChangesetService,
  ConversationService,
  DirectChatService,
  RoomBroadcastService,
  RoomTaskPersistence,
  ChatReviewService,
} from '@runnets/application';

export interface Runtime {
  readonly codingTools?: NonNullable<ChatTurnExecutionDeps['codingTools']>;
  readonly roomTasks?: RoomTaskPersistence;
  readonly services?: RuntimeServices;
  readonly grantedTools?: GrantedToolSource;
  readonly restored?: boolean;
  openRebindStore?(): ProfileRebindStore;
  readonly desktopAssets?: DesktopAssetStore;
  openProfileReads?(): ProfileReads;
  openEndpointProof?(): EndpointProof;
  readonly ownerDecisions: OwnerDecisionStore;
  openRoomRuns?(): RoomRuntimeRuns;
  readonly coding: CodingTaskService;
  /** Durable finalization store; absent on the ephemeral host. */
  readonly finalization?: CodingFinalizationStore;
  /** Provider connection metadata; durable hosts own the only authoritative copy. */
  readonly providerConnections?: ProviderConnectionStorePort;
  /** Authoritative plugin catalog/connection/grant stores; durable hosts only. */
  readonly plugins?: {
    readonly catalog: PluginCatalogStorePort;
    readonly connections: PluginConnectionStorePort;
    readonly access: PluginAccessStorePort;
    readonly admission: PluginAdmissionStorePort;
    readonly operations: PluginOperationStorePort;
  };
  /** Composed plugin services (owner API, admission, granted tools, operation views). */
  readonly pluginRuntime?: PluginRuntime;
  /** Current durable profile owner identity (lease owner); absent when ephemeral. */
  readonly ownerId?: string;
  readonly codingReview?: CodingReviewService;
  readonly codingApply?: CodingApplyService;
  readonly codingApplyInspection?: CodingApplyInspectionService;
  readonly codingApplyResolution?: CodingApplyResolutionService;
  readonly codingEvidence?: CodingTestEvidenceStore;
  readonly codingApprovals: CodingApprovalService;
  readonly codingChanges: CodingChangesetService;
  readonly service: TaskRunService;
  readonly conversations: ConversationService;
  /** Durable conversation transaction surface used by the broadcast runner. */
  readonly conversationStore?: ConversationStore;
  readonly chat: DirectChatService;
  /** Durable broadcast admission/decisions; absent on the ephemeral host. */
  readonly broadcasts?: RoomBroadcastService;
  readonly reviews: ChatReviewService;
  readonly durable: boolean;
  readonly toolJournal?: ToolJournalPort;
  /** All entry points await recovery before accepting work. */
  readonly ready: Promise<RuntimeRecovery>;
  close(): void;
}
export interface RuntimeOptions {
  readonly serviceConfirmation?: ServiceCallConfirmationPort | undefined;
  readonly serviceTransportOptions?: Omit<McpServiceTransportOptions, 'refreshNeeded'> | undefined;
  /** Runtime image authority factory; the store exists only after composition. */
  readonly imageResolver?: (store: DesktopAssetStore) => ImageAssetResolverPort;
  readonly codingWorktreeDirectory?: string;
  readonly codingTools?: Pick<CodingTurnFactoryDeps, 'sandbox' | 'owner' | 'inspectSandbox'>;
  readonly requireUnpublished?: boolean;
  readonly restoredAccess?: boolean;
  readonly clock?: Clock;
  readonly dbPath?: string | undefined;
  readonly mode?: 'ephemeral' | 'durable' | undefined;
  /**
   * Real qualified service-plugin transport supplied by the host. Absent keeps
   * every profile on the plugin-disabled behavior. Execution is never enabled
   * by this module: the host opens the transport.
   */
  readonly pluginTransport?: ServicePluginTransportPort | undefined;
  /** Environment references for plugin credentials; defaults to `process.env`. */
  readonly pluginEnv?: Readonly<Record<string, string | undefined>> | undefined;
  /** Restore-mode maintenance host: owner plugin reads stay, mutations refuse. */
  readonly pluginMutationsAllowed?: boolean | undefined;
}
