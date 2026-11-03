import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, it } from 'vitest';
import type { CodingApplyContext } from '@runnets/domain';
import { withCodingApplyRecovery } from './coding-apply-scope.js';
function prepareCodingApplyRecovery(common: string, root: string, context: CodingApplyContext) {
  let path = '';
  withCodingApplyRecovery(common, root, context, (recovery) => {
    path = recovery.path;
  });
  return path;
}
const context = {
  ownerId: 'owner',
  taskId: 'task',
  applicationId: 'apply',
  changesetHash: 'a'.repeat(64),
};
it.runIf(process.platform === 'linux')(
  'durably scopes new recovery assets and reuses only the exact matching operation',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-apply-scope-')),
      common = join(outer, 'git'),
      root = join(outer, 'project');
    fs.mkdirSync(common);
    fs.mkdirSync(root);
    const legacy = join(common, 'ocean-apply-recovery');
    fs.mkdirSync(legacy);
    fs.writeFileSync(join(legacy, 'unknown'), 'legacy evidence');
    try {
      const files = prepareCodingApplyRecovery(common, root, context);
      expect(files).toMatch(/ocean-apply-recovery-v2\/[a-f0-9]{64}\/files$/);
      expect(JSON.parse(fs.readFileSync(join(dirname(files), 'scope.json'), 'utf8'))).toEqual({
        version: 2,
        root,
        ...context,
      });
      expect(fs.statSync(files).mode & 0o777).toBe(0o700);
      expect(prepareCodingApplyRecovery(common, root, context)).toBe(files);
      for (const other of [
        { ...context, ownerId: 'other' },
        { ...context, taskId: 'other' },
        { ...context, applicationId: 'other' },
        { ...context, changesetHash: 'b'.repeat(64) },
      ])
        expect(prepareCodingApplyRecovery(common, root, other)).not.toBe(files);
      expect(fs.readdirSync(legacy)).toEqual(['unknown']);
      expect(fs.readFileSync(join(legacy, 'unknown'), 'utf8')).toBe('legacy evidence');
      fs.writeFileSync(join(dirname(files), 'scope.json'), 'unknown');
      expect(() => prepareCodingApplyRecovery(common, root, context)).toThrow();
      expect(fs.readFileSync(join(dirname(files), 'scope.json'), 'utf8')).toBe('unknown');
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses a missing files directory without repairing the scope or deleting unknown data',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-scope-files-')),
      common = join(outer, 'git'),
      root = join(outer, 'project');
    fs.mkdirSync(common);
    fs.mkdirSync(root);
    try {
      const files = prepareCodingApplyRecovery(common, root, context),
        header = join(dirname(files), 'scope.json'),
        body = fs.readFileSync(header);
      fs.rmdirSync(files);
      fs.writeFileSync(join(dirname(files), 'unknown'), 'preserve');
      expect(() => prepareCodingApplyRecovery(common, root, context)).toThrow();
      expect(fs.existsSync(files)).toBe(false);
      expect(fs.readFileSync(header)).toEqual(body);
      expect(fs.readFileSync(join(dirname(files), 'unknown'), 'utf8')).toBe('preserve');
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses missing scope state and symlinked roots without repairing or deleting them',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-scope-refusal-')),
      common = join(outer, 'git'),
      root = join(outer, 'project');
    fs.mkdirSync(common);
    fs.mkdirSync(root);
    try {
      const files = prepareCodingApplyRecovery(common, root, context);
      fs.rmSync(join(dirname(files), 'scope.json'));
      expect(() => prepareCodingApplyRecovery(common, root, context)).toThrow();
      expect(fs.existsSync(join(dirname(files), 'scope.json'))).toBe(false);
      const linked = join(outer, 'linked');
      fs.symlinkSync(common, linked);
      expect(() => prepareCodingApplyRecovery(linked, root, context)).toThrow();
      expect(() =>
        prepareCodingApplyRecovery(common, root, { ...context, changesetHash: 'bad' }),
      ).toThrow();
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
