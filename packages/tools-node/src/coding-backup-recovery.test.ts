import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { applyCodingFile } from './coding-apply-file.js';
import { captureCodingApplyRecovery } from './coding-backup-recovery.js';
import { archiveCodingAssetTree, verifyCodingAssetArchive } from './coding-asset-archive.js';
const content = (text: string) => ({
  text,
  mode: '100644' as const,
  sha256: createHash('sha256').update(text).digest('hex'),
});
function fixture(work: (root: string, recovery: string, outer: string) => void) {
  const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-recovery-backup-')),
    root = join(outer, 'project'),
    recovery = join(outer, 'recovery');
  fs.mkdirSync(root);
  fs.mkdirSync(recovery, { mode: 0o700 });
  try {
    work(root, recovery, outer);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
}
it.runIf(process.platform === 'linux')(
  'captures retained originals and incomplete next-record bytes without replay or source changes',
  () => {
    fixture((root, recovery, outer) => {
      fs.writeFileSync(join(root, 'file'), 'before');
      applyCodingFile(root, recovery, {
        path: 'file',
        before: content('before'),
        after: content('after'),
      });
      const json = fs.readdirSync(recovery).find((name) => name.endsWith('.json'))!;
      fs.writeFileSync(join(recovery, json + '.next'), '{partial', { mode: 0o600 });
      const result = captureCodingApplyRecovery(recovery, [root]);
      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.nextOpaque).toBe(true);
      expect(result.capture.policy).toBe('coding-recovery');
      archiveCodingAssetTree(result.capture, join(outer, 'archive'));
      expect(verifyCodingAssetArchive(join(outer, 'archive')).hash).toBe(
        result.capture.manifest.hash,
      );
      expect(fs.readFileSync(join(root, 'file'), 'utf8')).toBe('after');
      expect(fs.readFileSync(join(recovery, json.replace('.json', '.before')), 'utf8')).toBe(
        'before',
      );
    });
  },
);
it.runIf(process.platform === 'linux')(
  'preserves conflicting original bytes as evidence and refuses missing completed originals',
  () => {
    fixture((root, recovery) => {
      fs.writeFileSync(join(root, 'file'), 'before');
      applyCodingFile(root, recovery, {
        path: 'file',
        before: content('before'),
        after: content('after'),
      });
      const name = fs.readdirSync(recovery).find((name) => name.endsWith('.before'))!;
      fs.writeFileSync(join(recovery, name), 'changed by user');
      expect(
        captureCodingApplyRecovery(recovery, [root]).capture.manifest.entries.some(
          (entry) => entry.path === name,
        ),
      ).toBe(true);
      fs.rmSync(join(recovery, name));
      expect(() => captureCodingApplyRecovery(recovery, [root])).toThrow(
        'invalid_coding_apply_recovery',
      );
    });
  },
);
it.runIf(process.platform === 'linux')(
  'refuses credential names before content reads and rejects foreign or malformed intents',
  () => {
    fixture((root, recovery) => {
      fs.writeFileSync(join(recovery, 'private.key'), 'synthetic credential');
      vi.mocked(fs.readSync).mockClear();
      expect(() => captureCodingApplyRecovery(recovery, [root])).toThrow('protected_coding_asset');
      expect(fs.readSync).not.toHaveBeenCalled();
      fs.rmSync(join(recovery, 'private.key'));
      fs.writeFileSync(join(root, 'file'), 'before');
      applyCodingFile(root, recovery, { path: 'file', before: content('before'), after: null });
      expect(() => captureCodingApplyRecovery(recovery, [join(root, 'foreign')])).toThrow(
        'invalid_coding_apply_recovery',
      );
      const json = fs.readdirSync(recovery).find((name) => name.endsWith('.json'))!;
      fs.writeFileSync(join(recovery, json), 'synthetic malformed private text');
      expect(() => captureCodingApplyRecovery(recovery, [root])).toThrow(
        'invalid_coding_apply_recovery',
      );
    });
  },
);
it.runIf(process.platform === 'linux')('rejects non-string file modes in a recovery intent', () => {
  fixture((root, recovery) => {
    fs.writeFileSync(join(root, 'file'), 'before');
    applyCodingFile(root, recovery, { path: 'file', before: content('before'), after: null });
    const json = fs.readdirSync(recovery).find((name) => name.endsWith('.json'))!;
    const value = JSON.parse(fs.readFileSync(join(recovery, json), 'utf8')) as {
      before: { mode: unknown };
    };
    value.before.mode = 100644;
    fs.writeFileSync(join(recovery, json), JSON.stringify(value));
    expect(() => captureCodingApplyRecovery(recovery, [root])).toThrow(
      'invalid_coding_apply_recovery',
    );
  });
});
it.runIf(process.platform === 'linux')(
  'rejects an array-valued completed status even when its required original is missing',
  () => {
    fixture((root, recovery) => {
      fs.writeFileSync(join(root, 'file'), 'before');
      applyCodingFile(root, recovery, { path: 'file', before: content('before'), after: null });
      const json = fs.readdirSync(recovery).find((name) => name.endsWith('.json'))!;
      const value = JSON.parse(fs.readFileSync(join(recovery, json), 'utf8')) as {
        status: unknown;
      };
      value.status = ['completed'];
      fs.writeFileSync(join(recovery, json), JSON.stringify(value));
      fs.rmSync(join(recovery, json.replace('.json', '.before')));
      expect(() => captureCodingApplyRecovery(recovery, [root])).toThrow(
        'invalid_coding_apply_recovery',
      );
    });
  },
);
it.runIf(process.platform === 'linux')(
  'refuses intent mutation during decoding without replacing user bytes',
  async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    fixture((root, recovery) => {
      fs.writeFileSync(join(root, 'file'), 'before');
      applyCodingFile(root, recovery, { path: 'file', before: content('before'), after: null });
      const json = fs.readdirSync(recovery).find((name) => name.endsWith('.json'))!;
      let reads = 0;
      vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const count = actual.readSync(...args);
        if (fs.realpathSync('/proc/self/fd/' + args[0]).endsWith('/' + json) && ++reads === 3)
          fs.writeFileSync(join(recovery, json), 'user changed record');
        return count;
      }) as typeof fs.readSync);
      try {
        expect(() => captureCodingApplyRecovery(recovery, [root])).toThrow('stale_coding_asset');
        expect(fs.readFileSync(join(recovery, json), 'utf8')).toBe('user changed record');
      } finally {
        vi.mocked(fs.readSync).mockImplementation(actual.readSync);
      }
    });
  },
);
