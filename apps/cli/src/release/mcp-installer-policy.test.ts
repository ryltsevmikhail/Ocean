import { malformed } from '../../test-fixtures/mcp-malformed-archive.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { installArchive } from './installer.js';
it.each(['absent', 'format', 'pins', 'identities', 'bundler'])(
  'rejects self-consistent modern %s policy drift before installation writes',
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-install-policy-'));
    try {
      const artifact = malformed(root, mode),
        prefix = join(root, 'prefix');
      expect(() => installArchive(artifact.archive, artifact.checksum, prefix)).toThrow(
        'invalid_manifest',
      );
      expect(existsSync(prefix)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
