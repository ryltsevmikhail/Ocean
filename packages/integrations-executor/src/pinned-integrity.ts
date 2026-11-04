/**
 * Layout-aware pinned integrity proof.
 *
 * Two layouts are qualified, each with its own fail-closed proof:
 *
 * - **source/workspace runs** (tests, `tsc` output): the installed
 *   `@executor-js/sdk` chunk bytes are hashed and compared with the pinned
 *   patched digest (`verifyInstalledSdkChunk`).
 * - **packaged release runs**: the adapter is shipped pre-bundled, so the
 *   build-recorded chunk inventory is verified instead (`verifyBundledAdapter`).
 *
 * Neither path accepts an expected identity from a caller. `admit()` calls this
 * with no arguments; the public `open()` options carry no integrity field, and
 * the entry point exposes no verification seam (the removed host-supplied
 * bypass stays removed).
 */
import { BUNDLE_INTEGRITY_FILE, verifyBundledAdapter } from './bundle-integrity.js';
import { verifyInstalledSdkChunk, type InstalledSdkChunkIdentity } from './pinned-identity.js';

export { BUNDLE_INTEGRITY_FILE };

/**
 * Verify whichever layout this module was loaded from.
 *
 * A present bundle-integrity record is always authoritative: a bad record is a
 * refusal, never a reason to fall back to another check. Only a genuinely
 * absent record (source/workspace layout) selects the installed-chunk proof.
 */
export async function verifyPinnedIntegrity(): Promise<InstalledSdkChunkIdentity> {
  const bundled = await verifyBundledAdapter();
  if (bundled !== null) return bundled;
  return verifyInstalledSdkChunk();
}
