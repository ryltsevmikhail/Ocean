import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, openSync: vi.fn(actual.openSync), renameSync: vi.fn(actual.renameSync) };
});
import { GitCodingApplyProject } from './coding-apply-project.js';
import { codingApplyRecoverySlot } from './coding-apply-scope.js';
const context = {
  ownerId: 'owner',
  taskId: 'task',
  applicationId: 'apply',
  changesetHash: 'a'.repeat(64),
};
const content = (text: string) => ({
  text,
  mode: '100644' as const,
  sha256: createHash('sha256').update(text).digest('hex'),
});
it.runIf(process.platform === 'linux').each(['scope', 'files', 'header', 'displaced'])(
  'refuses %s substitution and preserves both recovery directories',
  async (boundary) => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-scope-swap-')),
      root = join(outer, 'project');
    fs.mkdirSync(root);
    execFileSync('/usr/bin/git', ['-C', root, 'init', '-q']);
    fs.writeFileSync(join(root, 'file'), 'before');
    const scope = join(
        root,
        '.git/ocean-apply-recovery-v2',
        codingApplyRecoverySlot(root, context),
      ),
      files = join(scope, 'files'),
      saved = scope + '.saved';
    let swapped = false;
    let header: Buffer | undefined;
    const swap = () => {
      swapped = true;
      header = fs.readFileSync(join(scope, 'scope.json'));
      if (boundary === 'header') fs.writeFileSync(join(scope, 'scope.json'), 'wrong header');
      else if (boundary === 'files') {
        actual.renameSync(files, files + '.saved');
        fs.mkdirSync(files, { mode: 0o700 });
        fs.writeFileSync(join(files, 'unknown'), 'preserve');
      } else {
        actual.renameSync(scope, saved);
        fs.mkdirSync(scope, { mode: 0o700 });
        fs.writeFileSync(join(scope, 'scope.json'), 'wrong header', { mode: 0o600 });
        fs.mkdirSync(files, { mode: 0o700 });
        fs.writeFileSync(join(files, 'unknown'), 'preserve');
      }
    };
    vi.mocked(fs.openSync).mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      if (boundary !== 'displaced' && !swapped && args[0] === root && fs.existsSync(files)) swap();
      return actual.openSync(...args);
    }) as typeof fs.openSync);
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      actual.renameSync(from, to);
      if (boundary === 'displaced' && String(to).endsWith('.before')) swap();
    });
    try {
      await expect(
        new GitCodingApplyProject().applyFile(
          root,
          { path: 'file', before: content('before'), after: content('after') },
          context,
        ),
      ).rejects.toThrow();
      expect(swapped).toBe(true);
      if (boundary === 'displaced') {
        expect(fs.existsSync(join(root, 'file'))).toBe(false);
        const retained = join(saved, 'files'),
          entries = fs.readdirSync(retained);
        expect(
          fs.readFileSync(
            join(
              retained,
              entries.find((n) => n.endsWith('.before'))!,
            ),
            'utf8',
          ),
        ).toBe('before');
        expect(
          JSON.parse(
            fs.readFileSync(
              join(
                retained,
                entries.find((n) => n.endsWith('.json'))!,
              ),
              'utf8',
            ),
          ),
        ).toMatchObject({ status: 'started' });
      } else expect(fs.readFileSync(join(root, 'file'), 'utf8')).toBe('before');
      if (boundary === 'header')
        expect(fs.readFileSync(join(scope, 'scope.json'), 'utf8')).toBe('wrong header');
      else {
        expect(fs.readdirSync(files)).toEqual(['unknown']);
        expect(fs.readFileSync(join(files, 'unknown'), 'utf8')).toBe('preserve');
        if (boundary === 'files') expect(fs.readdirSync(files + '.saved')).toEqual([]);
        else {
          expect(fs.readFileSync(join(saved, 'scope.json'))).toEqual(header);
          expect(fs.readFileSync(join(scope, 'scope.json'), 'utf8')).toBe('wrong header');
          if (boundary === 'scope') expect(fs.readdirSync(join(saved, 'files'))).toEqual([]);
        }
      }
    } finally {
      vi.mocked(fs.openSync).mockImplementation(actual.openSync);
      vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
