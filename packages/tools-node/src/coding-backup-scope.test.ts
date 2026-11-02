import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { CodingBackupInventory } from '@runnets/domain';
import { withCodingApplyRecovery } from './coding-apply-scope.js';
import { applyCodingFile } from './coding-apply-file.js';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import {
  archiveCodingAssetTree,
  codingApplyRecoverySlot,
  captureScopedCodingApplyRecovery,
  restoreCodingAssetTree,
  verifyCodingAssetArchive,
} from './index.js';
type Application = CodingBackupInventory['applications'][number];
const context = {
  ownerId: 'owner',
  taskId: 'task',
  applicationId: 'apply',
  changesetHash: 'a'.repeat(64),
};
const application: Application = {
  id: 'apply',
  taskId: 'task',
  changesetHash: context.changesetHash,
  recoveryProtocol: 2,
  status: 'completed',
  files: [{ path: 'file', status: 'completed' }],
};
const interrupted: Application = {
  ...application,
  status: 'uncertain',
  files: [{ path: 'file', status: 'uncertain' }],
};
const content = (text: string) => ({
  text,
  mode: '100644' as const,
  sha256: createHash('sha256').update(text).digest('hex'),
});
function setup() {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-scoped-source-')),
    common = join(outer, 'common'),
    project = join(outer, 'project');
  fs.mkdirSync(common);
  fs.mkdirSync(project);
  const leaf = join(common, 'ocean-apply-recovery-v2', codingApplyRecoverySlot(project, context)),
    files = join(leaf, 'files');
  const seed = () => {
    fs.writeFileSync(join(project, 'file'), 'old');
    withCodingApplyRecovery(common, project, context, (scope) =>
      applyCodingFile(project, scope, {
        path: 'file',
        before: content('old'),
        after: content('new'),
      }),
    );
    return fs.readdirSync(files).find((name) => name.endsWith('.json'))!;
  };
  return {
    outer,
    common,
    project,
    leaf,
    files,
    seed,
    collect: (app: Application = application) =>
      captureScopedCodingApplyRecovery(common, project, context, app),
    close: () => fs.rmSync(outer, { recursive: true, force: true }),
  };
}
it('round trips one whole scoped operation with actual conflicting original and opaque next bytes', () => {
  const f = setup();
  try {
    const main = f.seed(),
      before = main.replace('.json', '.before');
    fs.writeFileSync(join(f.files, before), 'user edit');
    fs.chmodSync(join(f.files, before), 0o640);
    fs.writeFileSync(join(f.files, main + '.next'), Buffer.from([0xff, 123]), { mode: 0o600 });
    const result = f.collect();
    expect(result).toMatchObject({
      presence: 'scoped',
      context,
      recoveryProtocol: 2,
      records: [{ path: 'file', nextOpaque: true, original: 'conflict' }],
    });
    if (!result.capture) throw Error('missing capture');
    expect(result.capture.policy).toBe('coding-recovery-v2');
    const archive = join(f.outer, 'archive'),
      out = join(f.outer, 'quarantine');
    archiveCodingAssetTree(result.capture, archive);
    expect(verifyCodingAssetArchive(archive)).toEqual(result.capture.manifest);
    expect(restoreCodingAssetTree(archive, out)).toEqual(result.capture.manifest);
    for (const path of [
      'scope.json',
      'files/' + main,
      'files/' + main + '.next',
      'files/' + before,
    ])
      expect(fs.readFileSync(join(out, 'tree', path))).toEqual(fs.readFileSync(join(f.leaf, path)));
    expect(fs.statSync(join(out, 'tree/files', before)).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(join(f.project, 'file'), 'utf8')).toBe('new');
  } finally {
    f.close();
  }
});
it('selects only frozen v2 identity and never falls back to a neighboring or legacy operation', () => {
  const f = setup();
  try {
    f.seed();
    for (const other of [
      { ...context, ownerId: 'other' },
      { ...context, taskId: 'other' },
      { ...context, applicationId: 'other' },
      { ...context, changesetHash: 'b'.repeat(64) },
    ]) {
      const app = {
        ...interrupted,
        taskId: other.taskId,
        id: other.applicationId,
        changesetHash: other.changesetHash,
      };
      expect(captureScopedCodingApplyRecovery(f.common, f.project, other, app)).toMatchObject({
        presence: 'absent',
        capture: null,
        context: other,
      });
    }
    for (const patch of [
      { recoveryProtocol: null },
      { recoveryProtocol: '2' },
      { id: 'other' },
      { taskId: 'other' },
      { changesetHash: 'b'.repeat(64) },
    ]) {
      expect(() => f.collect({ ...application, ...patch } as Application)).toThrow();
    }
    const header = join(f.leaf, 'scope.json');
    fs.writeFileSync(
      header,
      JSON.stringify({ version: 2, root: f.project, ...context, ownerId: 'foreign' }) + '\n',
    );
    expect(() => f.collect()).toThrow();
  } finally {
    f.close();
  }
});
it('preserves absent, empty-leaf, partial-header and header-only interruptions without repair', () => {
  const f = setup();
  try {
    expect(f.collect(interrupted)).toMatchObject({ presence: 'absent', capture: null });
    expect(f.collect({ ...application, files: [] })).toMatchObject({
      presence: 'absent',
      capture: null,
    });
    expect(() => f.collect()).toThrow();
    expect(fs.readdirSync(f.common)).toEqual([]);
    fs.mkdirSync(f.leaf, { recursive: true, mode: 0o700 });
    expect(f.collect(interrupted)).toMatchObject({ presence: 'incomplete' });
    const header = join(f.leaf, 'scope.json');
    fs.writeFileSync(header, '{"version":', { mode: 0o600 });
    expect(f.collect(interrupted)).toMatchObject({ presence: 'incomplete' });
    expect(fs.readFileSync(header, 'utf8')).toBe('{"version":');
    fs.writeFileSync(header, '{}');
    expect(() => f.collect(interrupted)).toThrow();
    const body = JSON.stringify({ version: 2, root: f.project, ...context });
    fs.writeFileSync(header, body);
    expect(f.collect(interrupted)).toMatchObject({ presence: 'incomplete' });
    fs.writeFileSync(header, body + '\n');
    expect(f.collect(interrupted)).toMatchObject({ presence: 'header-only' });
    expect(() => f.collect()).toThrow();
    expect(fs.readdirSync(f.leaf)).toEqual(['scope.json']);
  } finally {
    f.close();
  }
});
it.each([
  'orphan',
  'missing-before',
  'next-missing-before',
  'pending',
  'wrong-path',
  'duplicate',
  'missing-record',
  'main-started',
  'malformed-main',
  'wrong-project',
  'missing-header',
  'partial-header',
])('refuses contradictory scoped evidence: %s', (kind) => {
  const f = setup();
  try {
    const main = f.seed(),
      record = join(f.files, main),
      body = JSON.parse(fs.readFileSync(record, 'utf8')) as Record<string, unknown>;
    let app = application;
    switch (kind) {
      case 'orphan':
        app = interrupted;
        fs.unlinkSync(record);
        break;
      case 'next-missing-before':
        app = interrupted;
        fs.writeFileSync(record + '.next', JSON.stringify(body), { mode: 0o600 });
        fs.writeFileSync(record, JSON.stringify({ ...body, status: 'started' }));
        fs.unlinkSync(record.replace('.json', '.before'));
        break;
      case 'missing-before':
        fs.unlinkSync(record.replace('.json', '.before'));
        break;
      case 'pending':
        app = { ...application, status: 'applying', files: [{ path: 'file', status: 'pending' }] };
        break;
      case 'wrong-path':
        app = { ...application, files: [{ path: 'other', status: 'completed' }] };
        break;
      case 'duplicate': {
        app = interrupted;
        const id = '12345678-1234-1234-1234-123456789123';
        fs.writeFileSync(
          join(f.files, id + '.json'),
          JSON.stringify({
            ...body,
            backup: id + '.before',
            staged: id + '.after',
            status: 'started',
          }),
          { mode: 0o600 },
        );
        break;
      }
      case 'missing-record':
        fs.unlinkSync(record);
        fs.unlinkSync(record.replace('.json', '.before'));
        break;
      case 'main-started':
        fs.writeFileSync(record, JSON.stringify({ ...body, status: 'started' }));
        break;
      case 'wrong-project':
        fs.writeFileSync(record, JSON.stringify({ ...body, root: f.outer }));
        break;
      case 'malformed-main':
        fs.writeFileSync(record, '{');
        break;
      case 'missing-header':
        fs.unlinkSync(join(f.leaf, 'scope.json'));
        break;
      case 'partial-header':
        fs.writeFileSync(join(f.leaf, 'scope.json'), '{');
        break;
    }
    expect(() => f.collect(app)).toThrow();
  } finally {
    f.close();
  }
});
it.each(['leaf', 'files', 'header', 'mutation'])(
  'refuses %s substitution or mutation during record decoding and retains both sources',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const f = setup();
    try {
      const main = f.seed(),
        record = join(f.files, main),
        before = fs.readFileSync(record);
      const target =
        kind === 'leaf' ? f.leaf : kind === 'files' ? f.files : join(f.leaf, 'scope.json');
      const detached = join(f.outer, 'detached');
      let reads = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const count = actual.readSync(...args);
        if (actual.realpathSync('/proc/self/fd/' + args[0]) === record && ++reads === 3) {
          if (kind === 'mutation') fs.writeFileSync(record, 'user edit');
          else {
            fs.renameSync(target, detached);
            fs.cpSync(detached, target, { recursive: true });
          }
        }
        return count;
      }) as typeof fs.readSync);
      expect(() => f.collect()).toThrow();
      expect(reads).toBe(3);
      if (kind === 'mutation') expect(fs.readFileSync(record, 'utf8')).toBe('user edit');
      else {
        expect(fs.existsSync(detached)).toBe(true);
        expect(fs.readFileSync(record)).toEqual(before);
      }
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      f.close();
    }
  },
);
