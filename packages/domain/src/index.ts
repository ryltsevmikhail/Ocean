/**
 * @runnets/domain — pure domain model.
 *
 * No I/O, no async, no storage, no transport, no provider SDK. Everything here
 * is a deterministic function of committed events and command input, so the
 * same tests prove the same behavior in every host.
 */

export * from './ids.js';
export * from './errors.js';
export * from './events.js';
export * from './commands.js';
export * from './state.js';
export * from './decide.js';
export * from './evolve.js';
export * from './budget.js';
export * from './side-effect.js';

export * from './conversations.js';
export * from './model-binding.js';

export * from './image-content.js';

export * from './chat-turn.js';

export * from './broadcast.js';

export * from './room-address.js';

export * from './chat-review.js';

export * from './coding-task.js';
export * from './coding-policy.js';
export * from './coding-finalization.js';
export * from './coding-finalization-valid.js';
export * from './coding-finalization-valid-records.js';

export * from './changeset.js';

export * from './coding-approval.js';
export * from './coding-approval-state.js';
export * from './coding-review.js';
export * from './coding-test-evidence.js';
export * from './coding-apply.js';
export * from './coding-apply-state.js';
export * from './coding-apply-observation.js';
export * from './coding-apply-resolution.js';
export * from './coding-backup.js';
export * from './coding-asset-manifest.js';
export { validCodingBackupPolicy, validCodingBackupPresets } from './coding-backup-policy.js';
export * from './desktop-assets.js';
export * from './restore-origin.js';
export * from './profile-rebind.js';
export {
  validProfileBackupManifest,
  type ProfileBackupManifest,
  type ProfileBackupAssetIdentity,
  type ProfileBackupSummary,
} from './profile-backup.js';
export * from './profile-lineage.js';

export * from './plugin-catalog.js';
export * from './plugin-connection.js';
export * from './plugin-grant.js';
export * from './plugin-operation.js';

export * from './plugin-backup.js';

export * from './model-capabilities.js';

export * from './model-dispatch.js';
export { decideModelDispatch } from './model-dispatch-decide.js';
export { evolveModelDispatch } from './model-dispatch-evolve.js';

export { copyActivation as copyModelActivationSnapshot } from './model-dispatch-validation.js';

export * from './room-model-policy.js';

export * from './service-connection.js';
export * from './service-catalog.js';
export * from './owner-scope-grant.js';
export * from './effect-resource-scope.js';
