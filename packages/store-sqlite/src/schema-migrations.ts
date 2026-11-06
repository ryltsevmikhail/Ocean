import { migrateRoomTaskSlices } from './room-task-slice-schema.js';
import { protectRoomTaskHistory } from './room-task-history-schema.js';
import { ROOM_TASK_TABLES, migrateRoomTasks } from './room-task-schema.js';
import { migrateServiceOwnerReceipts } from './service-owner-receipts.js';
import { migrateToolAdmission } from './tool-admission-schema.js';
import { SERVICE_AUTHORITY_TABLES, migrateServiceAuthority } from './service-authority-schema.js';
import { migrateModelPendingRequests } from './model-pending-schema.js';
import { migrateRoomModelPolicies } from './room-model-policy-schema.js';
import { migrateModelQualifications } from './model-qualification-schema.js';
import type { DatabaseSync } from 'node:sqlite';

import { migrateDesktopAssets } from './desktop-schema.js';
import { MODEL_CONNECTION_TABLES, migrateModelConnections } from './model-connection-schema.js';
import { CODING_APPLY_TABLES, migrateCodingApplications } from './coding-apply-schema.js';
import { CODING_REVIEW_TABLES, migrateCodingReviews } from './coding-review-schema.js';
import { CODING_APPROVAL_TABLES, migrateCodingApprovals } from './coding-approval-schema.js';
import { CHANGESET_TABLES, migrateChangesets } from './changeset-schema.js';
import { CODING_TABLES, migrateCoding } from './coding-schema.js';
import { CONVERSATION_TABLES, migrateConversations } from './conversation-schema.js';
import { CHAT_TABLES, migrateChats } from './chat-schema.js';
import { migrateGroups } from './group-schema.js';
import { REVIEW_TABLES, migrateReviews } from './review-schema.js';
import { migrateOwnerDecisions } from './owner-decisions.js';
import { migrateRestoration } from './restore-origin.js';
import { migrateCodingFinalizations } from './coding-finalization-schema.js';
import {
  PROVIDER_CONNECTION_TABLES,
  migrateProviderConnections,
} from './provider-connection-schema.js';
import { BROADCAST_TABLES, migrateBroadcasts } from './broadcast-schema.js';
import { PLUGIN_TABLES, migratePlugins } from './plugin-schema.js';
import { PLUGIN_OPERATION_TABLES, migratePluginOperations } from './plugin-operation-schema.js';
/** Additive migrations from every older supported schema; never guesses effect state. */
export function applyMigrations(
  db: DatabaseSync,
  previousVersion: number,
  existing: ReadonlySet<string>,
): void {
  if (previousVersion === 1) {
    migrateConversations(db);
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0)
      throw new Error('Schema migration failed foreign key check');
  } else {
    for (const table of CONVERSATION_TABLES) {
      if (!existing.has(table)) throw new Error('database schema is missing table ' + table);
    }
  }
  if (previousVersion < 3) migrateChats(db);
  else
    for (const table of CHAT_TABLES) {
      if (!existing.has(table)) throw new Error('database schema is missing table ' + table);
    }
  if (previousVersion < 4) migrateGroups(db);
  if (previousVersion < 5) migrateReviews(db);
  else
    for (const table of REVIEW_TABLES)
      if (!existing.has(table)) throw new Error('database schema is missing table ' + table);
  if (previousVersion < 6) migrateCoding(db);
  else
    for (const table of CODING_TABLES)
      if (!existing.has(table)) throw new Error('database schema is missing table ' + table);
  if (previousVersion < 7) migrateChangesets(db);
  else
    for (const table of CHANGESET_TABLES)
      if (!existing.has(table)) throw new Error('database schema is missing table ' + table);
  if (previousVersion < 8) migrateCodingApprovals(db);
  else
    for (const table of CODING_APPROVAL_TABLES)
      if (!existing.has(table)) throw new Error('database schema is missing table ' + table);
  if (previousVersion < 9) migrateCodingReviews(db);
  else
    for (const table of CODING_REVIEW_TABLES)
      if (!existing.has(table)) throw new Error('database schema is missing table ' + table);
  if (previousVersion < 10) migrateCodingApplications(db);
  else
    for (const table of CODING_APPLY_TABLES)
      if (!existing.has(table)) throw new Error('database schema is missing table ' + table);
  if (previousVersion < 11) migrateOwnerDecisions(db);
  else if (!existing.has('ocean_owner_decisions'))
    throw Error('database schema is missing table ocean_owner_decisions');
  if (previousVersion < 12) migrateDesktopAssets(db);
  else if (
    !existing.has('ocean_desktop_operations') ||
    !existing.has('ocean_desktop_uploads') ||
    !existing.has('ocean_desktop_adopted')
  )
    throw Error('database schema is missing Desktop tables');
  if (previousVersion < 13) migrateRestoration(db);
  else if (
    ![
      'ocean_restore_origin',
      'ocean_profile_rebinds',
      'ocean_execution_epoch',
      'ocean_rebind_observations',
      'ocean_restore_origins',
      'ocean_retired_epochs',
    ].every((name) => existing.has(name))
  )
    throw Error('database schema is missing restoration tables');
  if (previousVersion < 14) migrateCodingFinalizations(db);
  else if (!existing.has('ocean_coding_finalizations'))
    throw Error('database schema is missing finalization tables');
  if (previousVersion < 15) migrateProviderConnections(db);
  else
    for (const table of PROVIDER_CONNECTION_TABLES)
      if (!existing.has(table)) throw Error('database schema is missing table ' + table);
  if (previousVersion < 16) migrateBroadcasts(db);
  else
    for (const table of BROADCAST_TABLES)
      if (!existing.has(table)) throw Error('database schema is missing table ' + table);
  if (previousVersion < 17) migratePlugins(db);
  else
    for (const table of PLUGIN_TABLES)
      if (!existing.has(table)) throw Error('database schema is missing table ' + table);
  if (previousVersion < 18) migratePluginOperations(db);
  else
    for (const table of PLUGIN_OPERATION_TABLES)
      if (!existing.has(table)) throw Error('database schema is missing table ' + table);
  if (previousVersion < 20) migrateModelConnections(db);
  else
    for (const table of MODEL_CONNECTION_TABLES)
      if (!existing.has(table)) throw Error('database schema is missing table ' + table);
  if (previousVersion < 21) migrateModelQualifications(db);
  if (previousVersion < 22) migrateRoomModelPolicies(db);
  else if (!existing.has('ocean_room_model_policies'))
    throw Error('database schema is missing table ocean_room_model_policies');
  if (previousVersion < 23) migrateModelPendingRequests(db);
  if (previousVersion < 24) migrateServiceAuthority(db);
  else
    for (const table of SERVICE_AUTHORITY_TABLES)
      if (!existing.has(table)) throw Error('database schema is missing table ' + table);
  if (previousVersion < 26) migrateServiceOwnerReceipts(db);
  else if (!existing.has('ocean_service_owner_receipts'))
    throw Error('database schema is missing table ocean_service_owner_receipts');
  if (previousVersion < 27) migrateRoomTasks(db);
  else
    for (const table of ROOM_TASK_TABLES)
      if (!existing.has(table)) throw Error('database schema is missing table ' + table);
  if (previousVersion < 28) migrateRoomTaskSlices(db);
  protectRoomTaskHistory(db);
  if (existing.has('tool_invocations_v2')) migrateToolAdmission(db, previousVersion);
}
