import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesktopAssetFiles } from '@runnets/application';
import {
  captureDesktopAssets,
  archiveDesktopAssets,
  restoreDesktopAssets,
  desktopRootIdentity,
  checkDesktopCapture,
} from './desktop-assets.js';
import {
  importDesktopFile,
  prepareDesktopFiles,
  desktopRead,
  desktopHash,
  desktopSync,
  readDesktopPreparation,
} from './desktop-file-store.js';
/** Exact trusted native-host selection, independently recomputed by the owner. */
export function desktopLegacyRoot(userData: string, profile: string, profileId: string): string {
  if (
    desktopHash(profile) !== profileId ||
    resolve(userData) !== userData ||
    fs.realpathSync(userData) !== userData ||
    userData.length > 4096
  )
    throw Error('desktop_binding_mismatch');
  desktopRootIdentity(userData);
  const conversation = join(userData, 'conversation');
  return join(
    profile === join(conversation, 'profile')
      ? conversation
      : join(conversation, 'profiles', profileId),
    'attachments',
  );
}
export function desktopAssetFiles(profile: string, profileId: string): DesktopAssetFiles {
  return {
    enroll(userData, inventory) {
      const originalRoot = desktopLegacyRoot(userData, profile, profileId);
      const destination = join(profile, 'desktop-' + randomUUID());
      let binding;
      if (fs.existsSync(originalRoot)) {
        const sourceBinding = {
          profileId,
          root: originalRoot,
          identity: desktopRootIdentity(originalRoot),
          originalRoot,
        };
        const capture = captureDesktopAssets({ ...inventory, binding: sourceBinding });
        const archive = join(profile, 'desktop-import-' + randomUUID());
        archiveDesktopAssets(capture, archive);
        restoreDesktopAssets(archive, destination);
        checkDesktopCapture(capture);
        binding = {
          profileId,
          root: join(destination, 'tree'),
          identity: desktopRootIdentity(join(destination, 'tree')),
          originalRoot,
        };
      } else {
        if (inventory.messages.length) throw Error('desktop_assets_missing');
        fs.mkdirSync(destination, { mode: 0o700 });
        fs.mkdirSync(join(destination, 'tree'), { mode: 0o700 });
        desktopSync(destination);
        binding = {
          profileId,
          root: join(destination, 'tree'),
          identity: desktopRootIdentity(join(destination, 'tree')),
          originalRoot,
        };
      }
      desktopSync(profile);
      return {
        binding,
        preparations: inventory.messages.map((m) => ({
          room: m.roomId,
          requestId: m.requestId,
          receipt: readDesktopPreparation(binding, m.roomId, m.requestId),
        })),
      };
    },
    import: importDesktopFile,
    prepare: prepareDesktopFiles,
    read(binding, room, id) {
      const { info, data } = desktopRead(binding, room, id);
      return { info, data: data.toString('base64') };
    },
  };
}
