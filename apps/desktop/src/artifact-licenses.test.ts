import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stageDesktopThirdPartyLicenses } from './artifact-licenses.js';

it('ships the complete pinned Vue and Zod notices beside bundled Desktop code', () => {
  const stage = mkdtempSync(join(tmpdir(), 'desktop-licenses-'));
  const desktop = new URL('..', import.meta.url).pathname;
  try {
    stageDesktopThirdPartyLicenses(desktop, stage);
    for (const name of ['vue', 'zod']) {
      const upstream = readFileSync(join(desktop, 'node_modules', name, 'LICENSE'), 'utf8');
      const shipped = readFileSync(join(stage, 'THIRD_PARTY_LICENSES', name + '-MIT.txt'), 'utf8');
      expect(shipped).toBe(upstream);
      expect(shipped).toContain('Permission is hereby granted, free of charge');
      expect(shipped).toContain(name === 'vue' ? 'Yuxi (Evan) You' : 'Colin McDonnell');
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
