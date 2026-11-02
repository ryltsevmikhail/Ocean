import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { captureCodingAssetTree } from './coding-asset-scan.js';
import { archiveCodingAssetTree, verifyCodingAssetArchive } from './coding-asset-archive.js';
import { restoreCodingAssetTree } from './coding-asset-restore.js';
it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'retains an interrupted quarantine after real SIGKILL without retrying or changing source',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-restore-kill-')),
      source = join(outer, 'source'),
      archive = join(outer, 'archive'),
      output = join(outer, 'out');
    fs.mkdirSync(source);
    fs.writeFileSync(join(source, 'file'), Buffer.alloc(2 * 1048576, 42));
    const capture = captureCodingAssetTree(source);
    archiveCodingAssetTree(capture, archive);
    const module = process.env['OCEAN_RC_INSTALL']
      ? pathToFileURL(
          join(
            process.env['OCEAN_RC_INSTALL'],
            'node_modules/@runnets/tools-node/dist/coding-asset-restore.js',
          ),
        ).href
      : new URL('../dist/coding-asset-restore.js', import.meta.url).href;
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original=fs.writeSync;
fs.writeSync=function(...args) {
  const count=original(...args);
  if(fs.realpathSync('/proc/self/fd/'+args[0]).endsWith('/tree/file')) process.kill(process.pid,'SIGKILL');
  return count;
};
syncBuiltinESMExports();
const {restoreCodingAssetTree}=await import(process.argv[1]);
restoreCodingAssetTree(process.argv[2],process.argv[3]);
`,
          module,
          archive,
          output,
        ],
        { timeout: 10000, encoding: 'utf8' },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBe('SIGKILL');
      expect(fs.existsSync(join(output, '.incomplete'))).toBe(true);
      const partial = fs.statSync(join(output, 'tree/file')).size;
      expect(partial).toBe(1048576);
      expect(() => restoreCodingAssetTree(archive, output)).toThrow();
      expect(fs.statSync(join(output, 'tree/file')).size).toBe(partial);
      expect(verifyCodingAssetArchive(archive)).toEqual(capture.manifest);
      expect(captureCodingAssetTree(source).manifest).toEqual(capture.manifest);
      expect(restoreCodingAssetTree(archive, join(outer, 'fresh'))).toEqual(capture.manifest);
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
