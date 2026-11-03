import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { partialFixture } from '../test-fixtures/coding-partial.test.js';
import {
  integrityArchive,
  rewritePack,
  type GitTestManifest,
} from '../test-fixtures/coding-git-integrity.test.js';
import { verifyPartialCodingGitArchive } from './coding-git-partial-archive.js';
it
  .runIf(process.platform === 'linux')
  .each(
    ['sha1', 'sha256'].flatMap((format) =>
      (['ref', 'offset'] as const).map((delta) => ({ format, delta })),
    ),
  )(
  'verifies packed $format history and $delta deltas without source access',
  async ({ format, delta }) => {
    const f = partialFixture('planned', format);
    try {
      for (let n = 0; n < 6; n++) {
        fs.writeFileSync(
          join(f.project, 'large'),
          Array.from(
            { length: 4000 },
            (_, i) => `line ${i}: ${i === n ? 'changed' : 'stable'} contents\n`,
          ).join(''),
        );
        f.git(f.project, 'add', '.');
        f.git(
          f.project,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-qm',
          'history ' + n,
        );
      }
      Object.assign(f.worktree, { baseCommit: f.git(f.project, 'rev-parse', 'HEAD') });
      f.git(f.project, 'repack', '-ad', '--window=50', '--depth=50');
      const sourceIndex = fs
        .readdirSync(join(f.common, 'objects/pack'))
        .find((name) => name.endsWith('.idx'))!;
      expect(
        f
          .git(f.project, 'verify-pack', '-v', join(f.common, 'objects/pack', sourceIndex))
          .split('\n')
          .some((row) => row.split(' ').filter(Boolean).length === 7),
      ).toBe(true);
      const archive = await integrityArchive(f),
        manifest = JSON.parse(
          fs.readFileSync(join(archive, 'manifest.json'), 'utf8'),
        ) as GitTestManifest;
      const replacement = rewritePack(f, archive, manifest.objectIds, delta),
        destination = join(f.outer, 'import');
      fs.mkdirSync(destination);
      f.git(destination, 'init', '-q', '--object-format=' + format);
      execFileSync('/usr/bin/git', ['-C', destination, 'index-pack', '--stdin', '--strict'], {
        env: f.env,
        input: replacement.pack,
      });
      const packed = fs
        .readdirSync(join(destination, '.git/objects/pack'))
        .find((name) => name.endsWith('.idx'))!;
      expect(
        f
          .git(destination, 'verify-pack', '-v', join(destination, '.git/objects/pack', packed))
          .split('\n')
          .some((row) => row.split(' ').filter(Boolean).length === 7),
      ).toBe(true);
      const deltaRows = f
        .git(destination, 'verify-pack', '-v', join(destination, '.git/objects/pack', packed))
        .split('\n')
        .map((row) => row.split(' ').filter(Boolean))
        .filter((row) => row.length === 7);
      expect(
        deltaRows.every(
          (row) => ((replacement.pack[Number(row[4])]! >> 4) & 7) === (delta === 'ref' ? 7 : 6),
        ),
      ).toBe(true);
      expect(f.git(destination, 'cat-file', '-p', f.worktree.baseCommit + ':large')).toContain(
        'line 5: changed',
      );
      expect(f.git(destination, 'cat-file', '-p', f.worktree.baseCommit + '~5:large')).toContain(
        'line 0: changed',
      );
      fs.rmSync(f.project, { recursive: true });
      expect(verifyPartialCodingGitArchive(archive, replacement.hash).objectIds).toEqual(
        manifest.objectIds,
      );
    } finally {
      f.close();
    }
  },
);
