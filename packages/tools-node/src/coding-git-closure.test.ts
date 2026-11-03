import * as fs from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { partialFixture } from '../test-fixtures/coding-partial.test.js';
import {
  integrityArchive,
  rewritePack,
  indexRoots,
  type GitTestManifest,
} from '../test-fixtures/coding-git-integrity.test.js';
import { verifyPartialCodingGitArchive } from './coding-git-partial-archive.js';
it
  .runIf(process.platform === 'linux')
  .each(
    ['sha1', 'sha256'].flatMap((format) =>
      ['commit', 'blob'].map((object) => ({ format, object })),
    ),
  )(
  'independent verifier rejects actual/advertised OID mismatch: $format $object',
  async ({ format, object }) => {
    const f = partialFixture('planned', format);
    try {
      const archive = await integrityArchive(f),
        manifest = JSON.parse(
          fs.readFileSync(join(archive, 'manifest.json'), 'utf8'),
        ) as GitTestManifest;
      const oid =
        object === 'commit' ? f.worktree.baseCommit : f.git(f.project, 'rev-parse', 'HEAD:a');
      const path = join(f.common, 'objects', oid.slice(0, 2), oid.slice(2)),
        body = inflateSync(fs.readFileSync(path));
      body[body.length - 2] = body[body.length - 2]! ^ 1;
      fs.chmodSync(path, 0o644);
      fs.writeFileSync(path, deflateSync(body));
      const replacement = rewritePack(f, archive, manifest.objectIds);
      expect(() => verifyPartialCodingGitArchive(archive, replacement.hash)).toThrow();
    } finally {
      f.close();
    }
  },
);
it
  .runIf(process.platform === 'linux')
  .each(
    ['sha1', 'sha256'].flatMap((format) =>
      ['tree', 'blob', 'parent', 'stage', 'REUC'].map((missing) => ({ format, missing })),
    ),
  )(
  'independent verifier rejects a self-consistent manifest/pack missing required $format $missing closure',
  async ({ format, missing }) => {
    const f = partialFixture(['stage', 'REUC'].includes(missing) ? 'indexed' : 'planned', format);
    try {
      let omitted: string;
      if (missing === 'parent') {
        omitted = f.worktree.baseCommit;
        f.git(
          f.project,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '--allow-empty',
          '-qm',
          'child',
        );
        Object.assign(f.worktree, { baseCommit: f.git(f.project, 'rev-parse', 'HEAD') });
      } else if (missing === 'stage' || missing === 'REUC') {
        const roots = indexRoots(f);
        omitted = missing === 'stage' ? roots.staged : roots.reuc;
      } else omitted = f.git(f.project, 'rev-parse', missing === 'tree' ? 'HEAD^{tree}' : 'HEAD:a');
      const archive = await integrityArchive(f),
        manifest = JSON.parse(
          fs.readFileSync(join(archive, 'manifest.json'), 'utf8'),
        ) as GitTestManifest;
      expect(manifest.objectIds).toContain(omitted);
      const replacement = rewritePack(
        f,
        archive,
        manifest.objectIds.filter((id) => id !== omitted),
      );
      expect(() => verifyPartialCodingGitArchive(archive, replacement.hash)).toThrow();
    } finally {
      f.close();
    }
  },
);
