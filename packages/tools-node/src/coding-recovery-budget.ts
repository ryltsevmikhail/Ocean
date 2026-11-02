import type { CodingAssetCapture } from './coding-asset-scan.js';
export const recoveryLimit = (): never => {
  throw Error('coding_asset_limit');
};
/** Logical input/output budgets per graph pass. Physical rechecks repeat the same bounded pass. */
export class RecoveryBudget {
  bytes = 2147483648;
  entries = 100000;
  metadata = 16777216;
  jsonBytes = 268435456;
  records = 10000;
  get limits() {
    return { bytes: this.bytes, entries: this.entries };
  }
  json(bytes: number, main: boolean) {
    this.jsonBytes -= bytes;
    if (main) this.records--;
    if (this.jsonBytes < 0 || this.records < 0) recoveryLimit();
  }
  reference(value: unknown) {
    this.metadata -= Buffer.byteLength(JSON.stringify(value)) + 1;
    if (this.metadata < 0) recoveryLimit();
  }
  capture(capture: CodingAssetCapture) {
    this.bytes -= capture.manifest.bytes;
    this.entries -= capture.manifest.entries.length;
    if (this.bytes < 0 || this.entries < 0) recoveryLimit();
    this.reference(capture.manifest);
  }
}
