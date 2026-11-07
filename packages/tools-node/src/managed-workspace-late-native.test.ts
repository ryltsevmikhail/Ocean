import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
it
  .runIf(process.env['OCEAN_SANDBOX_NATIVE'] === '1')
  .each(['directory', 'file', 'raw-name', 'utf8'])(
  'checks the actual inherited bind descriptor after preparation and a late %s change',
  async (mode) => {
    const proof = mkdtempSync('/home/ryltsevmg/Projects/Ocean-artifacts/task-19.3/native-');
    const result = await promisify(execFile)(
      '/usr/bin/unshare',
      [
        '--user',
        '--map-root-user',
        '--mount',
        '--propagation',
        'private',
        process.execPath,
        fileURLToPath(
          new URL('../test-fixtures/managed-workspace-late-topology.ts', import.meta.url),
        ),
        proof,
        mode,
      ],
      { env: process.env, timeout: 12000 },
    );
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ mode, startup: mode === 'utf8' ? 1 : 0 });
    expect(
      JSON.parse(readFileSync(join(proof, 'late-namespace-cleanup.json'), 'utf8')),
    ).toMatchObject({ importedUnmounted: true, closed: true });
  },
  15000,
);
