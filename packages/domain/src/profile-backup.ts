/** Portable backup metadata. Source paths and old operation claims never grant authority. */
export interface ProfileBackupSummary {
  readonly schema: number;
  readonly externalCodingAssets?: number;
  readonly externalDesktopAssets?: number;
  readonly rooms: number;
  readonly messages: number;
  readonly positions: readonly { readonly roomId: string; readonly sequence: number }[];
  readonly pendingEffects: number;
  readonly unfinishedRuns: number;
  readonly heldRooms: number;
}
interface ProfileBackupBase {
  readonly createdAt: string;
  readonly cli: string;
  readonly node: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly summary: ProfileBackupSummary;
}
export interface ProfileBackupAssetIdentity {
  readonly catalog: string;
  readonly codingInventory: string;
  readonly desktopInventory: string;
  readonly worktrees: string;
  readonly recovery: string;
  readonly dependencies: string;
  readonly desktop: string | null;
}
export type ProfileBackupManifest =
  | (ProfileBackupBase & { readonly format: 1 })
  | (ProfileBackupBase & {
      readonly format: 2;
      readonly assets: ProfileBackupAssetIdentity;
      readonly lineage?: ProfileBackupLineage;
    });
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
/** Format 1 retains its historical summary shape; format 2 admits exact bounded fields only. */
export function validProfileBackupManifest(value: unknown): value is ProfileBackupManifest {
  if (
    !object(value) ||
    (value['format'] !== 1 && value['format'] !== 2) ||
    !sha(value['sha256']) ||
    !count(value['bytes']) ||
    value['bytes'] === 0 ||
    typeof value['createdAt'] !== 'string' ||
    !Number.isFinite(Date.parse(value['createdAt'])) ||
    typeof value['cli'] !== 'string' ||
    value['cli'].length > 128 ||
    typeof value['node'] !== 'string' ||
    value['node'].length > 128 ||
    !object(value['summary'])
  )
    return false;
  const summary = value['summary'];
  if (
    !Number.isSafeInteger(summary['schema']) ||
    ![5, 6, 7, 8, 9, 10, 11, 12, 13].includes(Number(summary['schema'])) ||
    !['rooms', 'messages', 'pendingEffects', 'unfinishedRuns', 'heldRooms'].every((k) =>
      count(summary[k]),
    ) ||
    !['externalCodingAssets', 'externalDesktopAssets'].every(
      (k) => summary[k] === undefined || count(summary[k]),
    ) ||
    !Array.isArray(summary['positions']) ||
    summary['positions'].length > 100000 ||
    !summary['positions'].every(
      (p) =>
        object(p) &&
        typeof p['roomId'] === 'string' &&
        p['roomId'].length <= 4096 &&
        count(p['sequence']),
    )
  )
    return false;
  if (value['format'] === 1) return true;
  if (
    value['format'] !== 2 ||
    Number(value['bytes']) > 2147483648 ||
    new Set(summary['positions'].map((p: unknown) => (object(p) ? p['roomId'] : undefined)))
      .size !== summary['positions'].length ||
    summary['positions'].some(
      (p: unknown) => !object(p) || Object.keys(p).sort().join() !== 'roomId,sequence',
    ) ||
    Object.keys(value).sort().join() !==
      (value['lineage'] === undefined
        ? 'assets,bytes,cli,createdAt,format,node,sha256,summary'
        : 'assets,bytes,cli,createdAt,format,lineage,node,sha256,summary') ||
    (value['lineage'] !== undefined && !validProfileBackupLineage(value['lineage'])) ||
    Object.keys(summary).some(
      (k) =>
        ![
          'schema',
          'externalCodingAssets',
          'externalDesktopAssets',
          'rooms',
          'messages',
          'positions',
          'pendingEffects',
          'unfinishedRuns',
          'heldRooms',
        ].includes(k),
    )
  )
    return false;
  const assets = value['assets'];
  return (
    object(assets) &&
    Object.keys(assets).sort().join() ===
      'catalog,codingInventory,dependencies,desktop,desktopInventory,recovery,worktrees' &&
    [
      'catalog',
      'codingInventory',
      'desktopInventory',
      'worktrees',
      'recovery',
      'dependencies',
    ].every((k) => sha(assets[k])) &&
    (assets['desktop'] === null || sha(assets['desktop']))
  );
}
import { validProfileBackupLineage, type ProfileBackupLineage } from './profile-lineage.js';
