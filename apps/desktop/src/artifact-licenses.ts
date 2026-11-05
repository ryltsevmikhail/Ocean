/** Packaging adapter: preserve upstream notices beside bundled Desktop code. */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function stageDesktopThirdPartyLicenses(desktop: string, stage: string): void {
  const target = join(stage, 'THIRD_PARTY_LICENSES');
  mkdirSync(target, { recursive: true });
  for (const name of ['vue', 'zod'])
    copyFileSync(join(desktop, 'node_modules', name, 'LICENSE'), join(target, name + '-MIT.txt'));
}
