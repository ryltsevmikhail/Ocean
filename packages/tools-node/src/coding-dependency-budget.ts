import type { CodingAssetCapture } from './coding-asset-scan.js';
import type { CodingAssetManifest } from '@runnets/domain';
/** Independent stored/logical accounting. Hardlinks charge logical bytes at each retained name. */
export class DependencyBudget {
  bytes = 0;
  entries = 0;
  private logical = 0;
  private metadataBytes = 0;
  metadata(value: unknown): void {
    const n = Buffer.byteLength(JSON.stringify(value));
    this.bytes += n;
    this.logical += n;
    this.metadataBytes += n;
    this.check();
  }
  manifest(manifest: CodingAssetManifest): void {
    this.bytes += manifest.bytes;
    this.entries += manifest.entries.length;
    const sizes = new Map<string, number>();
    for (const e of manifest.entries) {
      if (e.kind === 'file') {
        sizes.set(e.path, e.bytes);
        this.logical += e.bytes;
      }
      if (e.kind === 'hardlink') this.logical += sizes.get(e.target) ?? 2147483649;
    }
    this.metadata(manifest);
    this.check();
  }
  capture(capture: CodingAssetCapture): void {
    this.manifest(capture.manifest);
    this.metadata(capture.sourceEntries);
  }
  private check(): void {
    if (
      this.bytes > 2147483648 ||
      this.logical > 2147483648 ||
      this.entries > 100000 ||
      this.metadataBytes > 33554432
    )
      throw Error('coding_asset_limit');
  }
}
