import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync) };
});
import { captureCodingAssetTree } from './coding-asset-scan.js';
import { archiveCodingAssetTree } from './coding-asset-archive.js';
it
  .runIf(process.platform === 'linux')
  .each(['.env', 'private.key', '.git-credentials', 'node_modules/package/.npmrc'])(
  'refuses protected worktree path %s before reading its body',
  (name) => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-backup-policy-'));
    fs.mkdirSync(join(outer, ...name.split('/').slice(0, -1)), { recursive: true });
    fs.writeFileSync(join(outer, name), 'synthetic credential');
    vi.mocked(fs.readSync).mockClear();
    try {
      expect(() => captureCodingAssetTree(outer, {}, 'coding-worktree')).toThrow(
        'protected_coding_asset',
      );
      expect(fs.readSync).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === 'linux')(
  'retains policy and lowered limits during archive rechecks',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-policy-recheck-')),
      root = join(outer, 'source');
    fs.mkdirSync(root);
    fs.writeFileSync(join(root, '.git'), 'gitdir: /inert');
    try {
      const captured = captureCodingAssetTree(root, { bytes: 32 }, 'coding-worktree');
      fs.rmSync(join(root, '.git'));
      fs.writeFileSync(join(root, 'private.key'), 'synthetic key');
      vi.mocked(fs.readSync).mockClear();
      expect(() => archiveCodingAssetTree(captured, join(outer, 'archive'))).toThrow(
        'protected_coding_asset',
      );
      expect(fs.readSync).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === 'linux')(
  'preserves lowered byte limits before reading newly added files during archive recheck',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-policy-limits-')),
      root = join(outer, 'source');
    fs.mkdirSync(root);
    try {
      const captured = captureCodingAssetTree(root, { bytes: 1 }, 'coding-worktree');
      fs.writeFileSync(join(root, 'data'), 'xx');
      vi.mocked(fs.readSync).mockClear();
      expect(() => archiveCodingAssetTree(captured, join(outer, 'archive'))).toThrow(
        'coding_asset_limit',
      );
      expect(fs.readSync).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);
it.runIf(process.platform === 'linux')(
  'refuses a protected hardlink alias before reading an earlier unprotected name',
  () => {
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-key-alias-'));
    fs.writeFileSync(join(outer, 'z.key'), 'synthetic credential');
    fs.linkSync(join(outer, 'z.key'), join(outer, 'alias'));
    vi.mocked(fs.readSync).mockClear();
    try {
      expect(() => captureCodingAssetTree(outer, {}, 'coding-worktree')).toThrow(
        'protected_coding_asset',
      );
      expect(fs.readSync).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux')(
  'checks preflight identity before reading a file changed between metadata and content passes',
  async () => {
    const actual = await vi.importActual<typeof fs>('node:fs');
    const outer = fs.mkdtempSync(join(tmpdir(), 'ocean-policy-identity-')),
      path = join(outer, 'file');
    fs.writeFileSync(path, 'old');
    let changed = false;
    vi.mocked(fs.readSync).mockClear();
    vi.mocked(fs.closeSync).mockImplementation((fd) => {
      const target = actual.realpathSync('/proc/self/fd/' + fd);
      actual.closeSync(fd);
      if (!changed && target === path) {
        changed = true;
        fs.writeFileSync(path, 'new');
      }
    });
    try {
      expect(() => captureCodingAssetTree(outer, {}, 'coding-worktree')).toThrow(
        'stale_coding_asset',
      );
      expect(changed).toBe(true);
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(fs.readFileSync(path, 'utf8')).toBe('new');
    } finally {
      vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
      fs.rmSync(outer, { recursive: true, force: true });
    }
  },
);

it.each([
  'leaf-name',
  'credential',
  'link',
  'hardlink',
  'large-header',
  'large-json',
  'large-next',
  'nested',
])('refuses %s in metadata preflight before body reads', (kind) => {
  const leaf = fs.mkdtempSync(join(tmpdir(), 'ocean-scoped-policy-')),
    files = join(leaf, 'files');
  fs.mkdirSync(files, { mode: 0o700 });
  const main = '11111111-1111-1111-1111-111111111111.json',
    record = join(files, main);
  fs.writeFileSync(join(leaf, 'scope.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(record, '{}', { mode: 0o600 });
  fs.writeFileSync(record.replace('.json', '.before'), 'synthetic');
  try {
    switch (kind) {
      case 'leaf-name':
        fs.writeFileSync(join(leaf, 'unknown'), 'synthetic');
        break;
      case 'credential':
        fs.writeFileSync(join(files, 'z.key'), 'synthetic');
        break;
      case 'link':
        fs.symlinkSync(record, join(files, main + '.next'));
        break;
      case 'hardlink':
        fs.linkSync(
          record.replace('.json', '.before'),
          join(files, main.replace('.json', '.after')),
        );
        break;
      case 'large-header':
        fs.truncateSync(join(leaf, 'scope.json'), 65537);
        break;
      case 'large-json':
        fs.truncateSync(record, 2097153);
        break;
      case 'large-next':
        fs.writeFileSync(record + '.next', 'x', { mode: 0o600 });
        fs.truncateSync(record + '.next', 2097153);
        break;
      case 'nested':
        fs.mkdirSync(join(files, 'nested'));
        break;
    }
    vi.mocked(fs.readSync).mockClear();
    expect(() => captureCodingAssetTree(leaf, {}, 'coding-recovery-v2')).toThrow(
      'protected_coding_asset',
    );
    expect(fs.readSync).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(leaf, { recursive: true, force: true });
  }
});
