import * as fs from 'node:fs';
import type * as childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof childProcess>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
import { captureCodingGitObjects } from './coding-git-backup.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-git-backup-'));
  roots.push(outer);
  const project = join(outer, 'project'),
    root = join(outer, 'task'),
    branch = 'codex/ocean/' + 'a'.repeat(64);
  fs.mkdirSync(project);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  git(project, 'init', '-q', '--object-format=' + objectFormat);
  fs.writeFileSync(join(project, 'file'), 'ancestor');
  git(project, 'add', '.');
  git(
    project,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'ancestor',
  );
  const ancestor = git(project, 'rev-parse', 'HEAD');
  fs.writeFileSync(join(project, 'file'), 'base');
  git(
    project,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qam',
    'base',
  );
  const baseCommit = git(project, 'rev-parse', 'HEAD');
  git(project, 'worktree', 'add', '-qb', branch, root);
  fs.writeFileSync(join(root, 'file'), 'staged');
  git(root, 'add', 'file');
  const staged = git(root, 'rev-parse', ':file');
  fs.writeFileSync(join(root, 'file'), 'working');
  git(project, 'switch', '-qc', 'unrelated');
  fs.writeFileSync(join(project, 'secret'), 'unrelated synthetic secret');
  git(project, 'add', '.');
  git(
    project,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'unrelated',
  );
  const unrelated = git(project, 'rev-parse', 'HEAD:secret');
  const gitCommonDir = join(project, '.git');
  return {
    outer,
    project,
    root,
    git,
    ancestor,
    staged,
    unrelated,
    binding: { root, branch, baseCommit, gitCommonDir, projectRoot: project, taskId: 'task' },
  };
}
it.runIf(process.platform === 'linux')(
  'packs exactly base history and staged objects without source config, hooks or unrelated refs',
  () => {
    const s = setup();
    fs.writeFileSync(join(s.outer, 'malformed-config'), '[invalid');
    fs.appendFileSync(
      join(s.binding.gitCommonDir, 'config'),
      `\n[include]\npath = ${join(s.outer, 'malformed-config')}\n`,
    );
    const captured = captureCodingGitObjects(s.binding);
    expect(captured.baseCommit).toBe(s.binding.baseCommit);
    expect(captured.objectIds).toContain(s.ancestor);
    expect(captured.objectIds).toContain(s.staged);
    expect(captured.objectIds).not.toContain(s.unrelated);
    const restored = join(s.outer, 'restored');
    fs.mkdirSync(restored);
    s.git(restored, 'init', '-q');
    execFileSync('/usr/bin/git', ['-C', restored, 'index-pack', '--stdin'], {
      input: captured.pack,
    });
    expect(s.git(restored, 'cat-file', '-p', s.staged)).toBe('staged');
    expect(() => s.git(restored, 'cat-file', '-e', s.unrelated)).toThrow();
    fs.writeFileSync(join(restored, '.git/index'), captured.index);
    expect(s.git(restored, 'ls-files', '--stage')).toContain(s.staged);
    expect(fs.readFileSync(join(s.root, 'file'), 'utf8')).toBe('working');
  },
);
it.runIf(process.platform === 'linux').each(['alternates', 'symlink', 'hardlink'])(
  'refuses unplanned object storage %s without reading its external target',
  (kind) => {
    const s = setup(),
      objects = join(s.binding.gitCommonDir, 'objects');
    const key = join(s.outer, 'private.key');
    fs.writeFileSync(key, 'synthetic must-not-read');
    if (kind === 'alternates') fs.writeFileSync(join(objects, 'info/alternates'), key + '\n');
    else {
      const directory = join(objects, 'ab');
      fs.mkdirSync(directory, { recursive: true });
      const path = join(directory, 'c'.repeat(38));
      if (kind === 'symlink') fs.symlinkSync(key, path);
      else fs.linkSync(key, path);
    }
    expect(() => captureCodingGitObjects(s.binding)).toThrow('unsupported_coding_git_storage');
    expect(fs.readFileSync(key, 'utf8')).toBe('synthetic must-not-read');
  },
);
it.runIf(process.platform === 'linux')(
  'preserves resolve-undo objects referenced only by the index extension',
  () => {
    const s = setup();
    const ids = ['base conflict', 'ours conflict', 'theirs conflict'].map((text) =>
      execFileSync('/usr/bin/git', ['-C', s.root, 'hash-object', '-w', '--stdin'], {
        input: text,
        encoding: 'utf8',
      }).trim(),
    );
    execFileSync('/usr/bin/git', ['-C', s.root, 'update-index', '--index-info'], {
      input: ids.map((id, index) => `100644 ${id} ${index + 1}\tconflict\n`).join(''),
    });
    fs.writeFileSync(join(s.root, 'conflict'), 'resolved');
    s.git(s.root, 'add', 'conflict');
    expect(s.git(s.root, 'ls-files', '--resolve-undo')).toContain(ids[2]);
    const captured = captureCodingGitObjects(s.binding);
    for (const id of ids) expect(captured.objectIds).toContain(id);
    const restored = join(s.outer, 'resolve-undo-restored');
    fs.mkdirSync(restored);
    s.git(restored, 'init', '-q');
    execFileSync('/usr/bin/git', ['-C', restored, 'index-pack', '--stdin'], {
      input: captured.pack,
    });
    fs.writeFileSync(join(restored, '.git/index'), captured.index);
    s.git(restored, 'checkout', '-m', '--', 'conflict');
    expect(fs.readFileSync(join(restored, 'conflict'), 'utf8')).toContain('<<<<<<<');
    for (const id of ids) expect(s.git(restored, 'cat-file', '-t', id)).toBe('blob');
  },
);
it.runIf(process.platform === 'linux')(
  'captures packed refs and packed source objects and refuses a rebound task branch',
  () => {
    const s = setup();
    s.git(s.project, 'pack-refs', '--all');
    s.git(s.project, 'repack', '-ad');
    const first = captureCodingGitObjects(s.binding),
      second = captureCodingGitObjects(s.binding);
    expect(second.indexSha256).toBe(first.indexSha256);
    expect(second.packSha256).toBe(first.packSha256);
    const restored = join(s.outer, 'packed-restored');
    fs.mkdirSync(restored);
    s.git(restored, 'init', '-q');
    const packed = execFileSync('/usr/bin/git', ['-C', restored, 'index-pack', '--stdin'], {
      input: first.pack,
      encoding: 'utf8',
    })
      .trim()
      .split('\t')
      .at(-1)!;
    const objects = s
      .git(
        restored,
        'verify-pack',
        '-v',
        join(restored, '.git/objects/pack/pack-' + packed + '.idx'),
      )
      .split('\n')
      .filter((row) => /^[a-f0-9]{40} /.test(row))
      .map((row) => row.split(' ')[0]!)
      .sort();
    expect(objects).toEqual(first.objectIds);
    s.git(s.project, 'update-ref', 'refs/heads/' + s.binding.branch, s.ancestor);
    expect(() => captureCodingGitObjects(s.binding)).toThrow('unsupported_coding_git_storage');
  },
);

it.runIf(process.platform === 'linux')(
  'captures SHA-256 objects and raw index under synthesized SHA-256 config',
  () => {
    const s = setup('sha256'),
      captured = captureCodingGitObjects(s.binding);
    expect(captured.objectFormat).toBe('sha256');
    expect(captured.objectIds).toContain(s.staged);
    const restored = join(s.outer, 'sha256-restored');
    fs.mkdirSync(restored);
    s.git(restored, 'init', '-q', '--object-format=sha256');
    execFileSync('/usr/bin/git', ['-C', restored, 'index-pack', '--stdin'], {
      input: captured.pack,
    });
    fs.writeFileSync(join(restored, '.git/index'), captured.index);
    expect(s.git(restored, 'cat-file', '-p', s.staged)).toBe('staged');
    expect(s.git(restored, 'ls-files', '--stage')).toContain(s.staged);
  },
);

it.runIf(process.platform === 'linux')(
  'refuses an index changed after packing without overwriting the changed bytes',
  async () => {
    const s = setup();
    const admin = resolve(s.root, fs.readFileSync(join(s.root, '.git'), 'utf8').slice(8).trim());
    const actual = await vi.importActual<typeof childProcess>('node:child_process');
    let changed = false;
    vi.mocked(execFileSync).mockImplementation(((...args: Parameters<typeof execFileSync>) => {
      const result = actual.execFileSync(...args);
      if (args[1]?.includes('pack-objects')) {
        fs.writeFileSync(join(admin, 'index'), 'changed by user');
        changed = true;
      }
      return result;
    }) as typeof execFileSync);
    try {
      expect(() => captureCodingGitObjects(s.binding)).toThrow('stale_coding_git_storage');
      expect(changed).toBe(true);
      expect(fs.readFileSync(join(admin, 'index'), 'utf8')).toBe('changed by user');
    } finally {
      vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
    }
  },
);

it.runIf(process.platform === 'linux')(
  'refuses an index replaced by a FIFO before descriptor pinning without blocking',
  async () => {
    const s = setup(),
      actual = await vi.importActual<typeof fs>('node:fs');
    const admin = resolve(s.root, fs.readFileSync(join(s.root, '.git'), 'utf8').slice(8).trim());
    const original = fs.readFileSync(join(admin, 'index'));
    let calls = 0;
    vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[0] === 'string' && args[0].endsWith('/index') && ++calls === 2) {
        fs.renameSync(join(admin, 'index'), join(admin, 'index.user'));
        execFileSync('/usr/bin/mkfifo', [join(admin, 'index')]);
        if (typeof args[1] !== 'number' || !(args[1] & fs.constants.O_NONBLOCK))
          throw Error('blocking_index_open');
      }
      return actual.openSync(...args);
    }) as typeof fs.openSync);
    try {
      expect(() => captureCodingGitObjects(s.binding)).toThrow('unsupported_coding_git_storage');
      expect(fs.lstatSync(join(admin, 'index')).isFIFO()).toBe(true);
      expect(fs.readFileSync(join(admin, 'index.user'))).toEqual(original);
    } finally {
      vi.mocked(fs.openSync).mockImplementation(actual.openSync);
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses a malformed branch ref instead of silently repairing it in the captured identity',
  () => {
    const s = setup();
    fs.writeFileSync(
      join(s.binding.gitCommonDir, 'refs/heads', s.binding.branch),
      ' ' + s.binding.baseCommit + '\n',
    );
    expect(() => captureCodingGitObjects(s.binding)).toThrow('unsupported_coding_git_storage');
  },
);
