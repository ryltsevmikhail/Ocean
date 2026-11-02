import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// eslint-disable-next-line no-restricted-imports -- Same-package host fixture outside compiled src.
import { withCodingApplyRecovery } from '../src/coding-apply-scope.js';
// eslint-disable-next-line no-restricted-imports -- Exercise the source package in Vitest.
import { captureScopedCodingApplyRecovery } from '../src/index.js';
export const context = {
  ownerId: 'owner',
  taskId: 'task',
  applicationId: 'apply',
  changesetHash: 'a'.repeat(64),
};
export const app = {
  recoveryProtocol: 2,
  id: 'apply',
  taskId: 'task',
  changesetHash: context.changesetHash,
  status: 'uncertain',
  files: [{ path: 'dir/file', status: 'uncertain' }],
} as const;
export const id = '11111111-1111-1111-1111-111111111111';
const content = (text: string) => ({
  mode: '100644',
  text,
  sha256: createHash('sha256').update(text).digest('hex'),
});
export function publicationFixture(add = false) {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-publication-')),
    common = join(outer, 'common'),
    project = join(outer, 'project');
  fs.mkdirSync(common);
  fs.mkdirSync(join(project, 'dir'), { recursive: true });
  let files = '';
  withCodingApplyRecovery(common, project, context, (scope) => {
    files = scope.path;
  });
  const main = join(files, id + '.json'),
    before = join(files, id + '.before'),
    after = join(files, id + '.after'),
    destination = join(project, 'dir/file');
  const intent = {
    version: 1,
    root: project,
    path: 'dir/file',
    status: 'started',
    backup: id + '.before',
    staged: id + '.after',
    before: add ? null : content('old'),
    after: content('new'),
  };
  fs.writeFileSync(main, JSON.stringify(intent), { mode: 0o600 });
  if (!add) fs.writeFileSync(before, 'old', { mode: 0o640 });
  fs.writeFileSync(after, 'new', { mode: 0o640 });
  fs.linkSync(after, destination);
  return {
    outer,
    project,
    files,
    main,
    before,
    after,
    destination,
    intent,
    leaf: dirname(files),
    collect: () => captureScopedCodingApplyRecovery(common, project, context, app),
    close: () => fs.rmSync(outer, { recursive: true, force: true }),
  };
}
