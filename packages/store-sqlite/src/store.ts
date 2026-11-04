import { desktopAssetStore } from './desktop-assets.js';
import { restoreOriginStore } from './restore-origin.js';
import type { RestoreOriginStore } from '@runnets/application';
import type { ProfileRebindStore } from '@runnets/application';
import { profileRebindStore } from './profile-rebind.js';
import type { DesktopAssetStore } from '@runnets/application';
import { profileReads, type ProfileReads } from './profile-reads.js';
import { openEndpointProof, type EndpointProof } from './endpoint-proof.js';
import { SqliteOwnerDecisions } from './owner-decisions.js';
import { SqliteCodingApplyResolutionStore } from './coding-apply-resolution.js';
import type { CodingApplyResolutionStore } from '@runnets/application';
import { SqliteCodingApplyStore } from './coding-apply-storage.js';
import type { CodingApplyStore } from '@runnets/application';
import { SqliteCodingReviewStore } from './coding-review-storage.js';
import type { CodingReviewStore } from '@runnets/application';
import { SqliteCodingTestEvidenceStore } from './coding-test-evidence.js';
import type { CodingTestEvidenceStore } from '@runnets/application';
import { SqliteCodingApprovalStore } from './coding-approval-storage.js';
import { SqliteCodingStore } from './coding-store.js';
import type { CodingApprovalStore, CodingStore } from '@runnets/application';
import { finalizationStore } from './coding-finalization-store.js';
import { SqliteProviderConnections } from './provider-connection-storage.js';
import type { CodingFinalizationStore, ProviderConnectionStorePort } from '@runnets/application';
/**
 * Public factory for the durable SQLite store.
 *
 * Opening applies the durability profile, verifies the schema version and wires
 * the ports over one connection. Success is reported only after SQLite committed
 * the profile and schema work; an unsupported database throws and is closed
 * again.
 */

import type {
  OwnerDecisionStore,
  CommandDedupPort,
  EventLogPort,
  IdGenerator,
  ToolJournalPort,
  ConversationStore,
} from '@runnets/application';
import type { TaskRunId } from '@runnets/domain';
import type { DatabaseSync } from 'node:sqlite';

import { roomRuntimeReads } from './room-runtime-reads.js';
import type { RoomRunReadPort } from '@runnets/application';
import { SqliteConversationStore } from './conversations.js';

import { SqliteCheckpointStore, type CheckpointStore } from './checkpoints.js';
import { SqliteCommandDedup } from './command-dedup.js';
import { SqliteEventLog } from './event-log.js';
import { SqliteToolJournal } from './tool-journal.js';
import { createDurableIdGenerator } from './id-source.js';
import { createRecovery, type RecoveryResult } from './recovery.js';
import { DEFAULT_BUSY_TIMEOUT_MS, openDatabase } from './schema.js';

export interface OpenSqliteStoreOptions {
  /** `:memory:` for an ephemeral store, or a file path for durability. */
  readonly path: string;
  /** Identity source; defaults to a database-backed sequential generator. */
  readonly ids?: IdGenerator;
  /** Bounded lock wait in milliseconds; defaults to 5000. */
  readonly busyTimeoutMs?: number;
}

export interface SqliteStore {
  readonly providerConnections: ProviderConnectionStorePort;
  readonly restoration: RestoreOriginStore;
  readonly rebind: ProfileRebindStore;
  readonly desktopAssets: DesktopAssetStore;
  openProfileReads(ownerId: string): ProfileReads;
  openEndpointProof(): EndpointProof;
  readonly ownerDecisions: OwnerDecisionStore;
  openRoomReads(now: () => number): RoomRunReadPort;
  readonly coding: CodingStore;
  readonly finalization: CodingFinalizationStore;
  readonly codingApplications: CodingApplyStore;
  readonly codingResolutions: CodingApplyResolutionStore;
  readonly codingReviews: CodingReviewStore;
  readonly codingEvidence: CodingTestEvidenceStore;
  readonly codingApprovals: CodingApprovalStore;
  readonly conversations: ConversationStore;
  readonly log: EventLogPort;
  readonly dedup: CommandDedupPort;
  readonly checkpoints: CheckpointStore;
  readonly tools: ToolJournalPort;
  /** Rebuild aggregate state from the latest checkpoint plus later events. */
  recover(taskRunId: TaskRunId): Promise<RecoveryResult>;
  /** Close the connection; repeated calls are a no-op. */
  close(): void;
}

/**
 * Open a durable store.
 *
 * The returned ports are all bound to one `DatabaseSync` connection; `close`
 * releases it. A file path may be reopened later to recover committed state.
 */
export function openSqliteStore(options: OpenSqliteStoreOptions): SqliteStore {
  if (options.path.trim() === '') {
    throw new TypeError('SQLite store path must not be empty');
  }
  const db = openDatabase(options.path, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  try {
    return buildStore(db, options.ids);
  } catch (error) {
    if (db.isOpen) db.close();
    throw error;
  }
}

function buildStore(db: DatabaseSync, ids: IdGenerator | undefined): SqliteStore {
  // SQLite indexes equal keys by rowid, so a reverse seek finds the latest matching preset.
  db.exec(`CREATE INDEX IF NOT EXISTS ocean_evidence_preset
    ON ocean_coding_test_evidence(task_id,json_extract(payload,'$.presetId'))`);
  const generator = ids ?? createDurableIdGenerator(db);
  const log = new SqliteEventLog(db, generator);
  const dedup = new SqliteCommandDedup(db);
  const checkpoints = new SqliteCheckpointStore(db, log);
  const recovery = createRecovery(log, checkpoints);
  let closed = false;
  const tools = new SqliteToolJournal(db);
  return {
    providerConnections: new SqliteProviderConnections(db),
    restoration: restoreOriginStore(db),
    rebind: profileRebindStore(db, tools),
    desktopAssets: desktopAssetStore(db),
    openProfileReads: (ownerId) => profileReads(db, ownerId),
    openEndpointProof: () => openEndpointProof(db),
    ownerDecisions: new SqliteOwnerDecisions(db),
    openRoomReads: (now) => roomRuntimeReads(db, now),
    coding: new SqliteCodingStore(db),
    finalization: finalizationStore(db, tools),
    codingApplications: new SqliteCodingApplyStore(db),
    codingResolutions: new SqliteCodingApplyResolutionStore(db),
    codingReviews: new SqliteCodingReviewStore(db),
    codingEvidence: new SqliteCodingTestEvidenceStore(db),
    codingApprovals: new SqliteCodingApprovalStore(db),
    conversations: new SqliteConversationStore(db),
    log,
    dedup,
    checkpoints,
    tools,
    recover(taskRunId: TaskRunId): Promise<RecoveryResult> {
      return recovery.recover(taskRunId);
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (db.isOpen) db.close();
    },
  };
}
