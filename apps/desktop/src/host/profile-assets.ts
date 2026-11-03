import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Preserve imported attachments only when connecting to their original canonical profile. */
export function profileAssets(userData: string, profile: string, authenticatedId: string) {
  if (createHash('sha256').update(profile).digest('hex') !== authenticatedId)
    throw Error('identity_mismatch');
  const root = join(userData, 'conversation');
  return profile === join(root, 'profile') ? root : join(root, 'profiles', authenticatedId);
}
