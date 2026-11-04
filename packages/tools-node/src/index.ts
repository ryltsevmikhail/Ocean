export * from './backend.js';
export * from './definitions.js';
export * from './executor.js';
export * from './native.js';

export * from './project-leases.js';
export * from './local-finalization-client.js';
export * from './coding-project.js';

export * from './coding-worktree.js';
export * from './coding-snapshot.js';
export * from './coding-operation.js';
export { probeSandbox, createSandboxBackend } from './sandbox-probe.js';
export type { SandboxOptions, SandboxQualification } from './sandbox-probe.js';
export { validateMounts } from './sandbox-mounts.js';
export { GitCodingApplyProject } from './coding-apply-project.js';
export {
  captureCodingAssetFiles,
  captureCodingAssetTree,
  CODING_ASSET_LIMITS,
} from './coding-asset-scan.js';
export type {
  CodingAssetCapture,
  CodingAssetLimits,
  CodingAssetPolicy,
} from './coding-asset-scan.js';
export { archiveCodingAssetTree, verifyCodingAssetArchive } from './coding-asset-archive.js';
export { validateCodingAssetLinks, type CodingAssetLinkResolution } from './coding-asset-links.js';
export { restoreCodingAssetTree } from './coding-asset-restore.js';
export { captureCodingGitObjects, type CodingGitObjectCapture } from './coding-git-backup.js';
export {
  captureCodingWorktreeAssets,
  type CodingWorktreeAssetCatalog,
  type CodingWorktreeAssetInput,
  type CodingPartialWorktreeAssetInput,
  type CodingWorktreeAssetRecord,
} from './coding-backup-worktrees.js';
export {
  captureCodingApplyRecovery,
  type CodingApplyRecoveryCapture,
} from './coding-backup-recovery.js';
export { codingApplyRecoverySlot, codingApplyRecoveryScope } from './coding-apply-scope.js';
export {
  captureScopedCodingApplyRecovery,
  type ScopedCodingApplyRecoveryObservation,
} from './coding-backup-scope.js';

export {
  captureCodingRecoveryAssets,
  type CodingRecoveryAssetInput,
  type CodingRecoveryAssetCatalog,
} from './coding-recovery-graph.js';
export * from './local-runtime-paths.js';
export * from './local-runtime-framing.js';
export * from './local-runtime-client.js';
export * from './local-provider-client.js';
export {
  createProviderSecretStore,
  providerCredentialDirectory,
  PROVIDER_SECRET_FILE,
  PROVIDER_CREDENTIAL_SUFFIX,
} from './provider-secret-store.js';

export {
  archivePartialCodingGit,
  verifyPartialCodingGitArchive,
} from './coding-git-partial-archive.js';
export type { CodingPartialGitCapture } from './coding-git-partial.js';
export type { CodingGitAdministration } from './coding-git-administration.js';
export {
  captureCodingDependencyAssets,
  type CodingDependencyCatalog,
  type CodingDependencyInput,
  type CodingDependencyTree,
} from './coding-dependency-graph.js';
export {
  archiveCodingDependencyAssets,
  verifyCodingDependencyArchive,
  restoreCodingDependencyTask,
} from './coding-dependency-archive.js';
export {
  captureDesktopAssets,
  archiveDesktopAssets,
  verifyDesktopAssetArchive,
  restoreDesktopAssets,
  desktopRootIdentity,
} from './desktop-assets.js';
export type { DesktopAssetCapture, DesktopAssetCatalog } from './desktop-assets.js';
export { desktopAssetFiles, desktopLegacyRoot } from './desktop-enrollment.js';
export * from './local-desktop-client.js';

export { captureProfileBackupAssets, type ProfileBackupCapture } from './profile-backup-capture.js';
export { verifyProfileBackupAssets } from './profile-backup-verify.js';
export { restoreProfileBackupAssets } from './profile-backup-restore.js';
export type {
  ProfileBackupSource,
  ProfileBackupAssets,
  ProfileBackupAssetCatalog,
} from './profile-backup-types.js';
export type { ProfileBackupLimits } from './profile-backup-session.js';
export { ProfileBackupOutput } from './profile-backup-output.js';
export {
  profileBackupDatabaseIdentity,
  verifyProfileBackupEnvelope,
  verifyProfileBackupOutput,
} from './profile-backup-envelope.js';

export {
  prepareProfileBackupAssets,
  type PreparedProfileBackup,
} from './profile-backup-prepare.js';

export { copyProfileBackupDatabase } from './profile-backup-copy.js';
export {
  preserveProfileRestoreOrigin,
  preserveProfileRestoreLineage,
} from './profile-restore-origin.js';
export {
  verifyRestoredProfileOrigin,
  verifyRestoredProfileBaseline,
} from './profile-restore-verify.js';
export { RestoredProfileFiles } from './profile-rebind.js';
export {
  prepareProfileLineage,
  inspectLineageIntent,
  lineageIntentOutputs,
  requireLineageOutput,
  type LineageIntentPlan,
  type LineageOutputMode,
  type LineageOutputPlan,
  type PreparedProfileLineage,
  type ProfileLineageInputs,
  type ProfileLineageParent,
  type ProfileLineagePartition,
} from './profile-lineage-preparation.js';
export { captureProfileLineage } from './profile-lineage-capture.js';
export {
  profileTaskSource,
  verifyProfileLineageGraph,
  verifySnapshotGraph,
  type ProfileSnapshotGraph,
  type ProfileSnapshotReader,
} from './profile-lineage-graph.js';
export { deriveLineagePartition } from './profile-lineage-partition.js';
export { verifyLineageArchives } from './profile-lineage-verify.js';
export { readLineageFile, type LineageFileCapture } from './profile-lineage-file.js';
