import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync), writeSync: vi.fn(actual.writeSync) };
});
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import { GitCodingApplyProject, verifyProfileBackupEnvelope } from '@runnets/tools-node';
import { fullBackupFixture } from '../../test-fixtures/profile-backup.test.js';
import { backupProfile } from './snapshots.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it.each(['tree-replacement', 'git-index', 'configuration', 'recovery', 'mmap', 'output-parent'])(
  'the actual last Desktop archive consumer cannot invalidate earlier %s witnesses',
  async (kind) => {
    const root = fs.mkdtempSync(join(tmpdir(), 'ocean-last-consumer-'));
    roots.push(root);
    for (const name of ['home', 'run', 'userdata', 'output'])
      fs.mkdirSync(join(root, name), { mode: 0o700 });
    vi.stubEnv('HOME', join(root, 'home'));
    vi.stubEnv('XDG_RUNTIME_DIR', join(root, 'run'));
    const f = await fullBackupFixture(root, () => codingWorkflowFixture('direct'), false),
      actual = await vi.importActual<typeof fs>('node:fs');
    let child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown[]> | undefined;
    try {
      let source = join(f.worktree, 'exact.txt');
      if (kind === 'git-index')
        source = join(fs.readFileSync(join(f.worktree, '.git'), 'utf8').slice(8).trim(), 'index');
      if (kind === 'configuration') source = join(f.directory, 'coding-projects.json');
      if (kind === 'recovery') {
        const inventory = readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
        const context = {
          ownerId: inventory.tasks[0]!.ownerId,
          taskId: 'task',
          applicationId: 'scoped',
          changesetHash: f.changeset.hash,
        };
        const writer = new GitCodingApplyProject();
        for (const file of f.changeset.files) await writer.applyFile(f.project, file, context);
        const scopes = join(inventory.worktrees[0]!.gitCommonDir, 'ocean-apply-recovery-v2');
        const files = join(scopes, fs.readdirSync(scopes)[0]!, 'files');
        source = join(
          files,
          fs.readdirSync(files).find((n) => n.endsWith('.before'))!,
        );
        const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
        try {
          db.prepare('INSERT INTO ocean_coding_applications VALUES(?,?)').run(
            'scoped',
            JSON.stringify({
              id: 'scoped',
              taskId: 'task',
              changesetHash: f.changeset.hash,
              expectedBase: f.base,
              status: 'uncertain',
              recoveryProtocol: 2,
              files: f.changeset.files.map((file) => ({ path: file.path, status: 'uncertain' })),
            }),
          );
        } finally {
          db.close();
        }
      }
      if (kind === 'mmap') {
        child = spawn(
          '/usr/bin/python3',
          [
            '-I',
            '-S',
            '-c',
            `import mmap,sys
with open(sys.argv[1],'r+b') as f,mmap.mmap(f.fileno(),0,access=mmap.ACCESS_WRITE) as p:
 p[0]=p[0]
 print('ready',flush=True)
 if sys.stdin.buffer.read(1)==b'!':p[0]=ord('X')`,
            source,
          ],
          { env: { ...process.env } },
        );
        exited = once(child, 'close');
        expect(String((await Promise.race([once(child.stdout!, 'data'), exited]))[0]).trim()).toBe(
          'ready',
        );
      }
      const state = () => {
          const s = actual.statSync(source, { bigint: true });
          return [s.ino, s.size, s.mtimeNs, s.ctimeNs];
        },
        before = state();
      const archive = join(root, 'output', 'backup');
      let changed = false,
        forbidden = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        if (changed && actual.realpathSync('/proc/self/fd/' + args[0]) === source) forbidden++;
        return actual.readSync(...args);
      }) as typeof fs.readSync);
      vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
        const n = actual.writeSync(...args);
        if (
          !changed &&
          actual
            .realpathSync('/proc/self/fd/' + args[0])
            .startsWith(join(archive, 'assets', 'desktop', 'assets', 'blobs') + '/')
        ) {
          if (kind === 'output-parent') {
            actual.renameSync(join(root, 'output'), join(root, 'moved'));
            actual.mkdirSync(join(root, 'output'), { mode: 0o700 });
          } else if (kind === 'tree-replacement') {
            actual.writeFileSync(join(root, 'replacement'), 'forbidden new inode');
            actual.renameSync(join(root, 'replacement'), source);
          } else if (kind === 'mmap') {
            child!.stdin!.write('!');
            const until = Date.now() + 3000,
              pause = new Int32Array(new SharedArrayBuffer(4));
            while (actual.readFileSync(source)[0] !== 88 && Date.now() < until)
              Atomics.wait(pause, 0, 0, 1);
            expect(actual.readFileSync(source)[0]).toBe(88);
            expect(state()).toEqual(before);
          } else actual.appendFileSync(source, 'late Desktop consumer mutation');
          changed = true;
        }
        return n;
      }) as typeof fs.writeSync);
      await expect(
        backupProfile(f.directory, archive, { managedDirectory: join(f.directory, 'worktrees') }),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      if (kind !== 'mmap' && kind !== 'output-parent') expect(forbidden).toBe(0);
      const retained = kind === 'output-parent' ? join(root, 'moved', 'backup') : archive;
      expect(fs.existsSync(join(retained, '.incomplete'))).toBe(true);
      expect(() => verifyProfileBackupEnvelope(retained)).toThrow();
    } finally {
      child?.stdin?.end();
      if (exited) await exited;
      f.close();
    }
  },
);
