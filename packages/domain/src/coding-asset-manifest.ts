/** Portable bytes/modes/relationships; source inode identities are separate capture evidence. */
export type CodingAssetEntry =
  | { readonly path: string; readonly kind: 'directory'; readonly mode: number }
  | {
      readonly path: string;
      readonly kind: 'file';
      readonly mode: number;
      readonly bytes: number;
      readonly sha256: string;
    }
  | { readonly path: string; readonly kind: 'hardlink'; readonly target: string }
  | { readonly path: string; readonly kind: 'symlink'; readonly target: string };
export interface CodingAssetManifest {
  readonly format: 1;
  readonly selectedFiles?: readonly string[];
  readonly entries: readonly CodingAssetEntry[];
  readonly bytes: number;
  readonly hash: string;
}
