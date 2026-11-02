import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { codingDiff } from './coding-diff.js';
it('represents empty additions/deletions as valid complete mode-only Git patches', () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-empty-diff-'));
  try {
    execFileSync('/usr/bin/git', ['-C', root, 'init', '-q']);
    const body = { mode: '100644' as const, text: '', sha256: 'empty' };
    const add = codingDiff([{ path: 'empty.txt', before: null, after: body }]);
    expect(add).not.toContain('@@ -0,0 +0,0');
    execFileSync('/usr/bin/git', ['-C', root, 'apply', '--check'], { input: add });
    writeFileSync(join(root, 'empty.txt'), '');
    execFileSync('/usr/bin/git', ['-C', root, 'add', 'empty.txt']);
    const remove = codingDiff([{ path: 'empty.txt', before: body, after: null }]);
    execFileSync('/usr/bin/git', ['-C', root, 'apply', '--check'], { input: remove });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
