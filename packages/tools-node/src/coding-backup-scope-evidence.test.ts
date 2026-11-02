import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { withCodingApplyRecovery } from './coding-apply-scope.js';
import { applyCodingFile } from './coding-apply-file.js';
import { captureScopedCodingApplyRecovery } from './index.js';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
const context = {
  ownerId: 'owner',
  taskId: 'task',
  applicationId: 'apply',
  changesetHash: 'a'.repeat(64),
};
const application = {
  id: 'apply',
  taskId: 'task',
  changesetHash: context.changesetHash,
  recoveryProtocol: 2,
  status: 'uncertain',
  files: [{ path: 'file', status: 'uncertain' }],
} as const;
const content = (text: string) => ({
  text,
  mode: '100644' as const,
  sha256: createHash('sha256').update(text).digest('hex'),
});
function source(withFiles: boolean) {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-scoped-evidence-'));
  const common = join(outer, 'common'),
    project = join(outer, 'project');
  fs.mkdirSync(common);
  fs.mkdirSync(project);
  let files = '';
  withCodingApplyRecovery(common, project, context, (scope) => {
    files = scope.path;
    if (withFiles) {
      fs.writeFileSync(join(project, 'file'), 'old');
      applyCodingFile(project, scope, {
        path: 'file',
        before: content('old'),
        after: content('new'),
      });
    }
  });
  const main = fs.readdirSync(files).find((name) => name.endsWith('.json'));
  if (!withFiles) fs.rmdirSync(files);
  return {
    header: join(dirname(files), 'scope.json'),
    record: main ? join(files, main) : undefined,
    project,
    collect: () => captureScopedCodingApplyRecovery(common, project, context, application),
    close: () => fs.rmSync(outer, { recursive: true, force: true }),
  };
}
// Dirty one shared page before capture. A later store to it can change bytes without
// changing mtime/ctime. EOF releases the helper even if the parent terminates.
const writer = `
import mmap, sys
with open(sys.argv[1],'r+b') as f, mmap.mmap(f.fileno(),0,access=mmap.ACCESS_WRITE) as page:
    page[0] = page[0]
    print('ready', flush=True)
    if sys.stdin.buffer.read(1) == b'!':
        page[:] = bytes.fromhex(sys.argv[2])
`;
it
  .runIf(process.platform === 'linux')
  .each([
    'canonical header',
    'opaque header',
    'original',
    'publication intent',
    'publication header',
    'published bytes',
  ])(
  'refuses a mapped write to the %s while inode, size, mtime and ctime stay fixed',
  async (kind) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const publication = kind.startsWith('publication') || kind === 'published bytes';
    const f = source(kind === 'original' || publication);
    const after = f.record?.replace(/\.json$/, '.after');
    if (publication) {
      fs.writeFileSync(
        f.record!,
        fs.readFileSync(f.record!, 'utf8').replace('"completed"', '"started"') + ' ',
      );
      fs.linkSync(join(f.project, 'file'), after!);
    }
    if (kind === 'opaque header') fs.writeFileSync(f.header, '{"partial');
    const target =
      kind === 'publication intent'
        ? f.record!
        : kind === 'publication header'
          ? f.header
          : kind === 'published bytes'
            ? after!
            : (f.record?.replace(/\.json$/, '.before') ?? f.header);
    const prior = fs.readFileSync(target, 'utf8');
    const changed =
      kind === 'publication intent'
        ? prior.trimEnd() + '\t'
        : kind === 'original' || kind === 'published bytes'
          ? 'bad'
          : kind === 'opaque header'
            ? '{"another'
            : prior.replace('"owner"', '"qwner"');
    expect(changed.length).toBe(prior.length);
    const child = spawn(
      '/usr/bin/python3',
      ['-I', '-S', '-c', writer, target, Buffer.from(changed).toString('hex')],
      { env: {} },
    );
    const exited = once(child, 'close');
    try {
      const ready = await Promise.race([once(child.stdout, 'data'), exited]);
      expect(String(ready[0]).trim()).toBe('ready');
      const identity = () => {
        const { ino, size, mtimeNs, ctimeNs } = fs.statSync(target, { bigint: true });
        return [ino, size, mtimeNs, ctimeNs];
      };
      const initial = identity();
      let reads = 0;
      const trigger = kind === 'published bytes' ? target : (f.record ?? f.header),
        boundary = f.record && !publication ? 3 : 1;
      let stagedReads = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const n = actual.readSync(...args);
        if (actual.realpathSync('/proc/self/fd/' + args[0]) === after) stagedReads++;
        if (actual.realpathSync('/proc/self/fd/' + args[0]) === trigger && ++reads === boundary) {
          child.stdin.write('!');
          const deadline = Date.now() + 3000,
            delay = new Int32Array(new SharedArrayBuffer(4));
          while (actual.readFileSync(target, 'utf8') !== changed && Date.now() < deadline)
            Atomics.wait(delay, 0, 0, 1);
          expect(actual.readFileSync(target, 'utf8')).toBe(changed);
        }
        return n;
      }) as typeof fs.readSync);
      let error: unknown;
      try {
        f.collect();
      } catch (thrown) {
        error = thrown;
      }
      expect(reads).toBeGreaterThanOrEqual(boundary);
      if (kind.startsWith('publication')) expect(stagedReads).toBe(0);
      expect(identity()).toEqual(initial);
      expect(actual.readFileSync(target, 'utf8')).toBe(changed);
      expect(error).toEqual(Error('stale_coding_asset'));
    } finally {
      vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      child.stdin.end();
      await exited;
      f.close();
    }
  },
);
it.each([
  ['completed', 'started', false, false],
  ['started', 'completed', true, false],
  ['completed', 'completed', false, false],
  ['started', 'started', false, false],
  ['started', 'completed', false, true],
] as const)(
  'validates main=%s, next=%s, staged=%s against the native v2 write order',
  (main, next, staged, allowed) => {
    const f = source(true);
    try {
      const record = f.record!;
      const intent = JSON.parse(fs.readFileSync(record, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(record, JSON.stringify({ ...intent, status: main }));
      fs.writeFileSync(record + '.next', JSON.stringify({ ...intent, status: next }), {
        mode: 0o600,
      });
      if (staged) fs.writeFileSync(record.replace(/\.json$/, '.after'), 'new');
      if (allowed)
        expect(f.collect()).toMatchObject({
          presence: 'incomplete',
          records: [{ status: 'started', nextOpaque: false, original: 'matching' }],
        });
      else expect(() => f.collect()).toThrow('invalid_coding_apply_recovery');
    } finally {
      f.close();
    }
  },
);

it('refuses a foreign canonical header before reading any record or original', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  const f = source(true),
    readPaths: string[] = [];
  try {
    fs.writeFileSync(f.header, fs.readFileSync(f.header, 'utf8').replace('"owner"', '"qwner"'));
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      readPaths.push(actual.realpathSync('/proc/self/fd/' + args[0]));
      return actual.readSync(...args);
    }) as typeof fs.readSync);
    expect(() => f.collect()).toThrow('invalid_coding_apply_recovery');
    expect(new Set(readPaths)).toEqual(new Set([f.header]));
  } finally {
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
    f.close();
  }
});
