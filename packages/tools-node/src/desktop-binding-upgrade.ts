import { createHash } from 'node:crypto';
import type { DesktopAssetInventory, DesktopBinding } from '@runnets/domain';
import { desktopIdentityMode } from './desktop-identity.js';
import { desktopBindingIdentity, holdDesktopRoot } from './desktop-root.js';
import { captureDesktopAssets, checkDesktopCapture } from './desktop-assets.js';
/** Exclusive host maintenance only. No read, archive verification or historical result migration. */
export function prepareDesktopBindingUpgrade(
  binding: DesktopBinding,
  inventory: () => DesktopAssetInventory,
  profile: string,
) {
  if (!binding || desktopIdentityMode(binding.identity) !== 'legacy-exact') return null;
  if (
    binding.profileId !== createHash('sha256').update(profile).digest('hex') ||
    !binding.root.startsWith(profile + '/') ||
    !/^desktop-[a-f0-9-]{36}\/tree$/.test(binding.root.slice(profile.length + 1))
  )
    return null;
  const held = holdDesktopRoot(binding.root, binding.identity);
  try {
    const identity = desktopBindingIdentity(binding.root);
    held.verify();
    if (desktopIdentityMode(identity) === 'legacy-exact') {
      held.close();
      return null;
    }
    const capture = captureDesktopAssets(inventory());
    const verify = () => {
      held.verify();
      checkDesktopCapture(capture);
    };
    verify();
    return { binding: { ...binding, identity }, verify, close: held.close };
  } catch (error) {
    held.close();
    throw error;
  }
}
